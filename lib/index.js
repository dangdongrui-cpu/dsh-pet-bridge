/**
 * dsh-pet-bridge —— 桌宠聊天桥。
 *
 * 为什么要有它：桌面宠物想直接跟 DSH 里的角色说话，但 DSH 的会话是回合制的，
 * 外部进程没有入口。这里开一个只监听回环的 HTTP 口，把消息投进指定会话、
 * 把最新回复取出来。
 *
 * 关键实现（已核实，不是猜的）：
 *   - `agent.inbox.prepend('next-step', msg)` 在会话空闲时**只排队不唤醒**，不能用。
 *   - 正确姿势是 `sessionController.resolveAgent(sessionId)` 拿到 agent，
 *     再 `agent.followup(message)`；followup 会主动唤醒驱动，空闲时立刻开一轮，
 *     运行中就排进下一轮。
 *   - resolveAgent 要求会话已有持久化 header（含 cwd），否则 session/not-found；
 *     同一会话被别的窗口持有会 session/writer-held。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.js'
import {
  assistantDedupeKey,
  claimPendingNotify,
  extractAssistantText,
  extractQQEventText,
  extractUserText,
  formatQQHistory,
  isLoopback,
  isOwnerPrivateMessage,
  noteActiveSession,
  normalizeOutgoing,
  parseNotify,
  pickRecentSession,
  pickReplySince,
  pickResolveError,
  pickStaleShots,
  readJsonBody,
  registerPendingNotify,
  rememberDelivery,
  rememberTurn,
  shouldRouteToDsh
} from './pure.js'
import { createQQNotifier } from './qq.js'

export const name = 'dsh-pet-bridge'
export { Config }

export const ROUTE_PREFIX = '/api/pet-bridge'

/** 屏幕截图落到这里，消息里只带路径，模型自己去读。 */
export function shotsDir() {
  return join(homedir(), '.dsh', 'pet-shots')
}

/** 截图文件名：shot-20261024-083015.png */
export function shotFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `shot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
}

/**
 * 只留最新的 keep 张截图，其余删掉。
 *
 * 为什么要清：观战模式（桌宠的 observe_mode=game）10 秒一包，一包两百多 KB，
 * 一小时就是 90 MB —— C 盘本来就紧。旧的 shot 图模型早看完了，留着没意义。
 */
export function pruneShots(keep = 60) {
  try {
    const dir = shotsDir()
    const drop = pickStaleShots(readdirSync(dir), keep)
    for (const name of drop) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // 删不掉就算了，下次再删
      }
    }
    return drop.length
  } catch {
    return 0
  }
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {Record<string, unknown>} rawConfig 配置
 */
export function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? console
  const config = Config(rawConfig ?? {})

  if (!config.enabled) {
    logger.info('dsh-pet-bridge: disabled by config')
    return
  }

  /** sessionId → { text, at } 最近一条助手回复。 */
  const lastReply = new Map()
  /** sessionId → { text, at } 最近一次投递。 */
  const lastRequest = new Map()
  /**
   * sessionId → { userId, at }：这个会话跑完这一轮要把结果发回哪个 QQ。
   * 只有请求里带了 notify 才登记；发出去就删，一条命令只回一条。
   */
  const pendingNotify = new Map()
  /** sessionId → 会话跑到第几轮。登记 notify 时记下，判断哪一轮才是这条命令的回答。 */
  const turnState = new Map()
  /** sessionId → 最后一次真人说话的时间。请求没指定会话时，投最近说话的那个。 */
  const activeSessions = new Map()
  /** assistant 消息去重键 → 首次发送时间。防同一条消息发两次。 */
  const delivered = new Map()
  /** 主动搭话用的专属会话（惰性创建，桥重启后重开一个）。 */
  let observeSessionId = ''

  /** 直听回调：inject 里拿到会话服务后才赋值，之前来的事件一律丢掉。 */
  let onQQEvent = null
  /** 路由复核用的小模型服务；宿主没挂 llm 就是 null，复核直接跳过。 */
  let llmRef = null
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (svc) => {
      llmRef = svc.llm ?? null
      logger.info('dsh-pet-bridge: 路由复核模型已挂上')
    })
  }

  /** QQ 直发器：平时懒连接，第一次真发才连 NapCat；直听模式下启动就连。 */
  const notifier = config.qqEnabled
    ? createQQNotifier({
      wsUrl: config.qqWsUrl,
      token: config.qqToken,
      logger,
      onEvent: (event) => {
        if (onQQEvent !== null) onQQEvent(event)
      }
    })
    : null

  /**
   * 取请求里的 notify。没带 → { requested:false }；带了但不合法 → 带 code 的失败。
   * @param {any} body 请求体
   */
  function readNotify(body) {
    const raw = body?.notify
    if (raw === null || raw === undefined) return { requested: false }
    return { requested: true, ...parseNotify(raw) }
  }

  /**
   * 记一条「这个会话刚有人说话」，给自动选收件会话用。
   *
   * 桥自己投进去的那条不算：否则第一次投递就把那个会话锁成「最近活跃」，
   * 之后你在别的窗口说话也抢不回来。判断靠 lastRequest 记下的原文。
   *
   * @param {string} sessionId
   * @param {any} data user/message 事件的 data
   */
  function noteUserActivity(sessionId, data) {
    const text = extractUserText(data)
    const last = lastRequest.get(sessionId)
    if (last !== undefined && text.length > 0 && last.text === text) return
    noteActiveSession(activeSessions, sessionId)
  }

  /**
   * 这句话投给哪个会话：显式指定的 > 最近有人说话的 > 配置里的默认。
   *
   * 「最近」是指在 recentTtlMinutes 内有人说过话；都没有就退回配置，
   * 再没有就让调用方报 no-session。
   *
   * @param {string} [explicit] 请求里显式指定的会话 id
   * @returns {string}
   */
  function resolveTargetSession(explicit = '') {
    const requested = typeof explicit === 'string' ? explicit.trim() : ''
    if (requested.length > 0) return requested
    const recent = pickRecentSession(activeSessions, Date.now(), config.recentTtlMinutes * 60 * 1000)
    if (recent.length > 0) return recent
    return config.sessionId
  }

  /**
   * 让一个小模型复核：这句话是不是在给本机的助手派活。
   *
   * 只在关键词没命中时用。判不出来（没有 llm、超时、报错）一律当「不是」，
   * 宁可漏一次，也别把闲聊也塞进 DSH 跑一轮。
   *
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function judgeRouteWithModel(text) {
    if (llmRef === null || typeof llmRef.stream !== 'function') return false
    const prompt = [
      '你是消息路由器。判断用户这句话是不是在给一台电脑上的编程助手派活：',
      '改代码、看文件、跑命令、装插件、重启服务、查项目状态、处理报错，算「是」；',
      '闲聊、问候、情绪、与电脑无关的问题，算「不是」。',
      '只输出 YES 或 NO，不要解释。'
    ].join('')
    let out = ''
    try {
      for await (const chunk of llmRef.stream({
        provider: config.qqJudgeProvider,
        model: config.qqJudgeModel,
        messages: [
          { role: 'system', content: [{ type: 'text', text: prompt }] },
          {
            role: 'user',
            content: [{ type: 'text', text: String(text).slice(0, config.qqJudgeChars) }]
          }
        ]
      })) {
        if (chunk?.type === 'text-delta') out += String(chunk.text ?? '')
        if (chunk?.type === 'finish' && chunk.kind !== undefined && chunk.kind !== 'done') {
          // 出错就按「不是」处理
          if (chunk.kind === 'error' || chunk.kind === 'aborted') return false
        }
      }
    } catch (error) {
      logger.warn('dsh-pet-bridge: 复核判断失败（%s）', error?.message ?? error)
      return false
    }
    const verdict = out.trim().toUpperCase()
    if (verdict.startsWith('YES')) return true
    if (verdict.startsWith('NO')) return false
    logger.info('dsh-pet-bridge: 复核输出没看懂（%s），当不是', out.trim().slice(0, 40))
    return false
  }

  /**
   * 直听模式的事件处理在 inject 回调里定义（要用 pushWithNotify），
   * 这里只留个引用挂上去。
   */
  function bindQQListener(handler) {
    onQQEvent = handler
  }

  /**
   * 这条助手回复要不要顺手发回 QQ。
   *
   * 触发条件：这个会话登记过 notify，且这条消息没发过。
   * 发完就把登记删掉——一条命令只回一条结果。
   * 发送失败只记日志：DSH 那一轮已经跑完了，重来一遍太贵。
   *
   * @param {string} sessionId
   * @param {any} event 会话事件
   * @param {string} text 助手回复的纯文本
   */
  function deliverToQQ(sessionId, event, text) {
    if (notifier === null) return
    // 被替换/改写的副本（surfaceOp 不是 append）不是这句新话，别发回去
    if (event?.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    const now = Date.now()
    // 判重放在前面：同一条 assistant 消息只认一次，哪怕登记被中途改过
    const key = assistantDedupeKey(event?.data, event?.seq)
    if (!rememberDelivery(delivered, key, now)) {
      logger.info('dsh-pet-bridge: 这条消息已经发过 QQ，跳过（%s）', key || '(无键)')
      return
    }
    if (!pendingNotify.has(sessionId)) return
    const entry = claimPendingNotify(pendingNotify, sessionId, now, event?.data?.turn)
    if (entry === null) return
    notifier.send(entry.userId, text).then((result) => {
      logger.info(
        'dsh-pet-bridge: 已直发 QQ %s（%d 字，messageId=%s）',
        entry.userId,
        text.length,
        String(result?.messageId ?? '-')
      )
    }).catch((error) => {
      logger.warn('dsh-pet-bridge: 发 QQ %s 失败：%s', entry.userId, error?.message ?? error)
    })
  }

  /**
   * 一轮跑完了，登记却还没被认领——说明这轮没有可发的正文。
   *
   * 最典型的是只出了 reasoning 块、正文一个字没写：assistant/message 里没有
   * text，deliverToQQ 按规矩跳过，QQ 那边就永远等不到结果。至少回一句，
   * 别让人干等，也别让登记烂在 map 里。
   *
   * @param {string} sessionId
   * @param {unknown} turn
   */
  function warnSilentTurn(sessionId, turn) {
    if (notifier === null) return
    const entry = claimPendingNotify(pendingNotify, sessionId, Date.now(), turn)
    if (entry === null) return
    notifier.send(entry.userId, '唔，这轮我只在脑子里转了一圈，正文忘了写，所以没话可发。')
      .then((result) => {
        logger.info(
          'dsh-pet-bridge: 空正文兜底已发 QQ %s（messageId=%s）',
          entry.userId,
          String(result?.messageId ?? '-')
        )
      })
      .catch((error) => {
        logger.warn('dsh-pet-bridge: 空正文兜底发 QQ %s 失败：%s', entry.userId, error?.message ?? error)
      })
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        // 顺手记会话跑到第几轮，登记 notify 时要用（见 claimPendingNotify）
        if (typeof event?.data?.turn === 'number') {
          rememberTurn(turnState, sessionId, event.data.turn)
        }
        if (event?.type === 'turn/end') {
          warnSilentTurn(sessionId, event?.data?.turn)
          return
        }
        if (event?.type === 'user/message') {
          noteUserActivity(sessionId, event?.data)
          return
        }
        if (event?.type !== 'assistant/message') return
        const text = extractAssistantText(event.data)
        if (text.length === 0) return
        lastReply.set(sessionId, { text, at: Date.now() })
        deliverToQQ(sessionId, event, text)
      } catch (error) {
        logger.warn('dsh-pet-bridge: session/event 处理失败：%s', error?.message ?? error)
      }
    })
  }

  ctx.inject(['sessionController', 'agents', 'webServer'], (svc) => {
    const { sessionController, agents, webServer } = svc

    function reply(res, status, body) {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(JSON.stringify(body))
    }

    /**
     * 往指定会话投一句话，并唤醒它。
     * @param {string} sessionId
     * @param {string} text
     */
    async function push(sessionId, text) {
      const normalized = normalizeOutgoing(text, config.maxTextChars)
      if (!normalized.ok) return normalized

      let resolved
      try {
        resolved = await agents.withoutInitiator(() => sessionController.resolveAgent(sessionId))
      } catch (error) {
        return { ok: false, code: 'resolve-failed', message: String(error?.message ?? error) }
      }
      const failure = pickResolveError(resolved)
      if (failure !== null) {
        return {
          ok: false,
          code: failure.error?.code ?? 'resolve-failed',
          message: String(failure.error?.message ?? '拿不到会话')
        }
      }
      const agent = resolved?.agent
      if (agent === undefined || agent === null) return { ok: false, code: 'no-agent' }

      const message = createUserMessage({
        content: [{ type: 'text', text: normalized.text }],
        source: { kind: config.sourceKind }
      })
      try {
        agent.followup(message)
      } catch (error) {
        return { ok: false, code: 'followup-failed', message: String(error?.message ?? error) }
      }

      lastRequest.set(sessionId, { text: normalized.text, at: Date.now() })
      logger.info('dsh-pet-bridge: 投递成功（%s，%d 字）', sessionId, normalized.text.length)
      return { ok: true, messageId: message.id ?? null }
    }

    /**
     * 拉最近几条 QQ 私聊当上下文。
     *
     * 只有 QQ 来的命令才拉；心跳那种主动搭话不该把整段 QQ 记录再喂一遍。
     * 拉不到就返回空串，绝不因此挡住投递。
     *
     * @param {string} userId
     * @returns {Promise<string>}
     */
    async function fetchQQContext(userId) {
      if (notifier === null || config.qqContextCount <= 0) return ''
      let data
      try {
        data = await notifier.call('get_friend_msg_history', {
          user_id: Number(userId),
          count: config.qqContextCount
        })
      } catch (error) {
        logger.warn('dsh-pet-bridge: 拉 QQ 历史失败（%s）', error?.message ?? error)
        return ''
      }
      const messages = Array.isArray(data?.messages) ? data.messages : []
      const selfId = messages[0]?.self_id ?? 0
      const body = formatQQHistory(messages, { selfId, maxChars: config.qqContextChars })
      if (body.length === 0) return ''
      logger.info('dsh-pet-bridge: 已带上 QQ 上下文（%d 字）', body.length)
      return `（以下是你在 QQ 上最近的对话，拿它当上下文，别重复问已经说过的事：）\n${body}\n（以上是 QQ 上下文）`
    }

    /**
     * 投递一条消息，顺带登记「结果回哪个 QQ」。
     *
     * 登记放在投递之前：登记时记下当前轮次，之后只有更大轮次的助手消息才算
     * 这条命令的回答。会话正忙时 followup 排进下一轮，这样就不会把当前这轮的
     * 中间消息错当成结果发出去。
     *
     * @param {string} target
     * @param {string} text
     * @param {{ok: boolean, userId?: string}} notify
     * @param {boolean} [wantQQContext] 要不要把 QQ 最近几句话拼在命令前面
     */
    async function pushWithNotify(target, text, notify, wantQQContext = true) {
      let payload = text
      if (notify.ok && wantQQContext) {
        const context = await fetchQQContext(notify.userId)
        if (context.length > 0) payload = `${context}\n\n${text}`
      }
      const entry = notify.ok
        ? registerPendingNotify(
          pendingNotify,
          target,
          notify.userId,
          Date.now(),
          turnState.get(target) ?? -1
        )
        : null
      const result = await push(target, payload)
      if (!result.ok && entry !== null && pendingNotify.get(target) === entry) {
        pendingNotify.delete(target)
      }
      return result
    }

    /**
     * 直听模式：NapCat 推过来一条事件，判断要不要转给 DSH。
     *
     * 和 AstrBot 的分工是「不重叠」：带 /dsh 前缀的交给它那边，这里只接
     * 没带前缀但一看就是干活的话（路径、代码、项目名之类）。
     *
     * @param {any} event OneBot v11 事件
     */
    async function handleQQListenEvent(event) {
      if (!config.qqListen || notifier === null) return
      if (!isOwnerPrivateMessage(event, config.qqOwner)) return
      const text = extractQQEventText(event)
      if (text.length === 0) return
      // 带 /dsh 的是 AstrBot 那边的活，连复核都不该走，不然会被捞成重复一份
      if (/^\/?dsh\b/i.test(text)) return
      const keywords = String(config.qqTriggers ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      let route = shouldRouteToDsh(text, keywords)
      if (!route && config.qqJudge) {
        route = await judgeRouteWithModel(text)
        if (route) logger.info('dsh-pet-bridge: 关键词没命中，模型复核判定该转')
      }
      if (!route) return
      const target = resolveTargetSession('')
      if (target.length === 0) {
        logger.warn('dsh-pet-bridge: 直听到一条要干活的，但没有可用会话')
        return
      }
      const result = await pushWithNotify(
        target,
        `（从 QQ 直听来的，没经过 AstrBot）${text}`,
        { ok: true, userId: String(event?.user_id ?? '') },
        true
      )
      logger.info('dsh-pet-bridge: 直听投递%s（%s）', result.ok ? '成功' : '失败', target)
    }

    bindQQListener(handleQQListenEvent)

    if (config.qqListen && notifier !== null) {
      notifier.open().then(() => {
        logger.info('dsh-pet-bridge: 直听 QQ 已连上（%s）', config.qqWsUrl)
      }).catch((error) => {
        logger.warn('dsh-pet-bridge: 直听 QQ 连不上（%s）', error?.message ?? error)
      })
    }

    /**
     * 拿主动搭话用的专属会话：有就复用，没有（或已经没了）就新建一个。
     *
     * 为什么单独开一个：截屏搭话每几分钟一条，全塞进主对话里很快就没法看了。
     * 新建走 `sessionController.create({})`——GUI 的「新建会话」就是这条 API，
     * 建完 Agent 已经 publish，可以直接 followup，不用等落盘。
     */
    async function ensureObserveSession() {
      if (observeSessionId.length > 0) {
        try {
          const probe = await agents.withoutInitiator(
            () => sessionController.resolveAgent(observeSessionId))
          if (pickResolveError(probe) === null) return { ok: true, sessionId: observeSessionId }
        } catch {
          // 旧的那个没了，下面重建
        }
        observeSessionId = ''
      }
      try {
        const created = await sessionController.create({})
        const sessionId = String(created?.sessionId ?? '')
        if (sessionId.length === 0) return { ok: false, code: 'create-returned-empty' }
        observeSessionId = sessionId
        logger.info('dsh-pet-bridge: 新建搭话会话 %s', sessionId)
        return { ok: true, sessionId }
      } catch (error) {
        return { ok: false, code: 'create-failed', message: String(error?.message ?? error) }
      }
    }

    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req)) return reply(res, 403, { ok: false, code: 'loopback-only' })

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const action = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const querySession = url.searchParams.get('sessionId') ?? ''
        // 截屏搭话仍然认「配置里的默认会话」，别跟着最近活跃跑，免得塞进你正在用的窗口
        const configuredSession = querySession || config.sessionId
        // /chat 的收件会话：没显式指定就跟最近有人说话的那个
        const sessionIdParam = resolveTargetSession(querySession)

        if (req.method === 'GET' && action === '/health') {
          return reply(res, 200, {
            ok: true,
            sessionId: sessionIdParam,
            qq: { enabled: notifier !== null, connected: notifier?.connected ?? false }
          })
        }

        if (req.method === 'GET' && action === '/state') {
          // since=<毫秒>：只要 at 比它新的那条 lastReply。桌宠的 listen 模式
          // （只念、不抓帧）靠这个去重，免得同一条回复反复念。
          const since = Number(url.searchParams.get('since') ?? '') || 0
          return reply(res, 200, {
            ok: true,
            sessionId: sessionIdParam,
            since,
            lastReply: pickReplySince(lastReply.get(sessionIdParam), since),
            lastRequest: lastRequest.get(sessionIdParam) ?? null,
            pendingNotify: pendingNotify.get(sessionIdParam) ?? null
          })
        }

        if (req.method === 'POST' && action === '/observe') {
          // 桌宠截了张屏幕：存成文件，再把「路径 + 看看我在干嘛」投进会话。
          // 不在消息里塞 base64——图片块格式容易变，走文件路径稳。
          const body = await readJsonBody(req, config.maxImageBytes * 2)
          if (body === null) {
            return reply(res, 400, { ok: false, code: 'bad-json-or-too-large' })
          }
          const notify = readNotify(body)
          if (notify.requested && !notify.ok) return reply(res, 400, notify)
          const requested = typeof body.sessionId === 'string' && body.sessionId.length > 0
            ? body.sessionId
            : configuredSession
          // 默认开一个专属会话装搭话，主对话别被几分钟一条的截图塞满。
          // 想投回主对话就在请求里带 sessionId 或把 observeIsolated 关掉。
          let target = requested
          if (config.observeIsolated && (target.length === 0 || target === config.sessionId)) {
            const ensured = await ensureObserveSession()
            if (!ensured.ok) return reply(res, 500, ensured)
            target = ensured.sessionId
          }
          if (typeof target !== 'string' || target.length === 0) {
            return reply(res, 400, { ok: false, code: 'no-session' })
          }

          const raw = String(body.image ?? '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '')
          if (raw.length === 0) return reply(res, 400, { ok: false, code: 'no-image' })
          let bytes
          try {
            bytes = Buffer.from(raw, 'base64')
          } catch {
            return reply(res, 400, { ok: false, code: 'bad-base64' })
          }
          if (bytes.length === 0) return reply(res, 400, { ok: false, code: 'empty-image' })
          if (bytes.length > config.maxImageBytes) {
            return reply(res, 413, {
              ok: false,
              code: 'image-too-large',
              message: `${bytes.length} 字节，上限 ${config.maxImageBytes}`
            })
          }

          const dir = shotsDir()
          const filePath = join(dir, shotFileName())
          try {
            mkdirSync(dir, { recursive: true })
            writeFileSync(filePath, bytes)
          } catch (error) {
            return reply(res, 500, {
              ok: false,
              code: 'write-failed',
              message: String(error?.message ?? error)
            })
          }

          const customNote = typeof body.note === 'string' && body.note.trim().length > 0
            ? body.note.trim()
            : ''
          // 自定义 note 也必须把路径带上：桥只把图存成文件，模型靠路径去读。
          // 光有 note 没有路径，模型会以为「图没传上来」（2026-11-04 实测踩过）。
          const note = customNote.length > 0
            ? `${customNote}\n（画面存在 ${filePath}，${Math.round(bytes.length / 1024)} KB，用读图工具看这张。）`
            : `我自己截了张屏幕，存在 ${filePath}（${Math.round(bytes.length / 1024)} KB）。你读一下这张图，看看我现在在干嘛，然后随口跟我说句话。`
          pruneShots()
          // 截屏搭话不看 QQ 历史：那是「我主动看一眼」，不是回谁的话
          const result = await pushWithNotify(target, note, notify, false)
          if (!result.ok) return reply(res, 409, result)
          return reply(res, 200, {
            ...result,
            path: filePath,
            bytes: bytes.length,
            sessionId: target,
            isolated: target === observeSessionId,
            notify: notify.ok ? { qq: notify.userId } : null
          })
        }

        if (req.method === 'POST' && action === '/chat') {
          const body = await readJsonBody(req)
          if (body === null) return reply(res, 400, { ok: false, code: 'bad-json' })
          const notify = readNotify(body)
          if (notify.requested && !notify.ok) return reply(res, 400, notify)
          const target = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
            ? body.sessionId.trim()
            : sessionIdParam
          if (typeof target !== 'string' || target.length === 0) {
            return reply(res, 400, {
              ok: false,
              code: 'no-session',
              message: '没有指定会话，也没等到最近活跃会话，配置里也没有默认 sessionId'
            })
          }
          const wantContext = body.context !== 'none'
          const result = await pushWithNotify(target, body.text, notify, wantContext)
          if (!result.ok) return reply(res, 409, result)
          return reply(res, 200, {
            ...result,
            notify: notify.ok ? { qq: notify.userId } : null
          })
        }

        return reply(res, 404, { ok: false, code: 'unknown-route', action })
      }
    })

    logger.info(
      'dsh-pet-bridge ready (route=%s, sessionId=%s, sourceKind=%s, qq=%s)',
      ROUTE_PREFIX,
      config.sessionId || '(未配置，需请求里带)',
      config.sourceKind,
      notifier === null ? 'off' : config.qqWsUrl
    )
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      lastReply.clear()
      lastRequest.clear()
      pendingNotify.clear()
      turnState.clear()
      activeSessions.clear()
      delivered.clear()
      notifier?.close()
    })
  }
}
