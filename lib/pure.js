/**
 * 纯函数与小工具：不 import 任何宿主包，可以在 DSH 之外单测。
 */

/**
 * 把请求体读成 JSON。解析失败返回 null，不抛异常。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] 字节上限
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (raw.trim().length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 是不是本机回环请求。
 * @param {{socket?: {remoteAddress?: string}}} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 从 assistant/message 事件里取纯文本。
 * @param {any} data 事件数据
 * @returns {string}
 */
export function extractAssistantText(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从 user/message 事件里取纯文本。结构比 assistant 浅一层：content 直接挂在 data 上。
 * @param {any} data 事件数据
 * @returns {string}
 */
export function extractUserText(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 记下「这个会话刚有人说话」，给自动选收件会话用。
 * @param {Map<string, number>} store sessionId → 最后一次真人发言时间
 * @param {string} sessionId
 * @param {number} [now]
 * @returns {boolean}
 */
export function noteActiveSession(store, sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  store.set(sessionId, now)
  return true
}

/**
 * 挑最近有人说话的会话：TTL 内取时间最新的那个，过期的顺手清掉。
 *
 * @param {Map<string, number>} store
 * @param {number} [now]
 * @param {number} [ttlMs] 多久没说话就不算活跃
 * @returns {string} 空串表示没有活跃会话
 */
export function pickRecentSession(store, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  let best = ''
  let bestAt = -1
  for (const [sessionId, at] of store) {
    if (!(now - at < ttlMs)) {
      store.delete(sessionId)
      continue
    }
    if (at > bestAt) {
      best = sessionId
      bestAt = at
    }
  }
  return best
}

/**
 * /state 的 lastReply 该不该给：只给「since 之后」的那条。
 *
 * 为什么在桥里过滤：桌宠的 listen 模式（observe_mode=listen）只是喇叭，
 * 每 1.5 秒问一次「有没有新的」，自己比时间戳容易重复念同一条；
 * 桥这边按 since 一刀切掉，桌宠拿到空的就是没有。
 *
 * @param {{at?: number, text?: string} | null | undefined} entry
 * @param {number} [since] 毫秒时间戳；<=0 表示不过滤
 * @returns {any | null} 有新的就给原对象，没有就 null
 */
export function pickReplySince(entry, since = 0) {
  if (!entry || typeof entry !== 'object') return null
  const at = Number(entry.at) || 0
  const floor = Number(since) || 0
  if (floor > 0 && !(at > floor)) return null
  return entry
}

/**
 * 校验并归一化要投递的文本。
 * @param {unknown} text
 * @param {number} maxChars
 * @returns {{ok: true, text: string} | {ok: false, code: string, message?: string}}
 */export function normalizeOutgoing(text, maxChars) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return { ok: false, code: 'empty-text' }
  if (value.length > maxChars) {
    return { ok: false, code: 'text-too-long', message: `超过 ${maxChars} 字` }
  }
  return { ok: true, text: value }
}

/**
 * resolveAgent 的结果里有没有错误。
 * @param {any} resolved
 * @returns {{error: any} | null}
 */
export function pickResolveError(resolved) {
  if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
    return { error: resolved.error ?? {} }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * QQ 直发：请求解析、待回复登记、判重、OneBot 报文与退避
 * 全是纯函数/只碰传进来的集合，可以在 DSH 之外直接跑测试。
 * ------------------------------------------------------------------ */

/**
 * QQ 号归一化：只收纯数字（5–12 位）。不合法返回空串。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeQQId(value) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim()
  if (!/^\d{5,12}$/.test(raw)) return ''
  return raw
}

/**
 * 解析请求体里的 `notify` 字段。
 * @param {unknown} notify
 * @returns {{ok: true, userId: string} | {ok: false, code: string, message: string}}
 */
export function parseNotify(notify) {
  if (notify === null || notify === undefined) {
    return { ok: false, code: 'no-notify', message: '没有 notify' }
  }
  if (typeof notify !== 'object') {
    return { ok: false, code: 'bad-notify', message: 'notify 必须是对象' }
  }
  const userId = normalizeQQId(notify.qq)
  if (userId.length === 0) {
    return { ok: false, code: 'bad-qq', message: 'notify.qq 不是合法 QQ 号' }
  }
  return { ok: true, userId }
}

/**
 * 登记「这个会话的下一条助手回复要发回哪个 QQ」。
 * 同一个会话再来一条命令就覆盖前一条，反正都是同一个人。
 *
 * `afterTurn` 是登记那一刻会话已经跑到第几轮：只有更大轮次的助手消息才算
 * 这条命令的回答。会话正忙时 followup 是排进下一轮的，光看时间会把当前这轮
 * 的中间消息错当成结果。
 *
 * @param {Map<string, {userId: string, at: number, afterTurn: number}>} store
 * @param {string} sessionId
 * @param {string} userId
 * @param {number} [now]
 * @param {number} [afterTurn] 登记时的当前轮次，-1 表示还不知道
 * @returns {{userId: string, at: number, afterTurn: number} | null}
 */
export function registerPendingNotify(store, sessionId, userId, now = Date.now(), afterTurn = -1) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const entry = {
    userId,
    at: now,
    afterTurn: Number.isInteger(afterTurn) ? afterTurn : -1
  }
  store.set(sessionId, entry)
  return entry
}

/**
 * 记下会话跑到第几轮（取见过的最大值）。
 * @param {Map<string, number>} store sessionId → 轮次
 * @param {string} sessionId
 * @param {unknown} turn 事件里的 turn
 * @returns {number} 记完之后的当前轮次
 */
export function rememberTurn(store, sessionId, turn) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return -1
  const current = store.get(sessionId) ?? -1
  if (!Number.isInteger(turn)) return current
  if (turn > current) {
    store.set(sessionId, turn)
    return turn
  }
  return current
}

/**
 * 取走这个会话的待回复登记（取到就删，一条命令只回一条结果）。
 *
 * 三条都要满足才算：登记过、登记时间不晚于现在、这条助手消息的轮次比登记时更大
 * （拿不到轮次时退化成只看时间）。超过 staleMs 还没等到结果的就作废——命令可能
 * 被丢了，别让第二天的某句话莫名其妙发到 QQ 上。
 *
 * @param {Map<string, {userId: string, at: number, afterTurn: number}>} store
 * @param {string} sessionId
 * @param {number} [now]
 * @param {number} [turn] 这条 assistant 消息的轮次
 * @param {number} [staleMs] 登记多久还没结果就作废
 * @returns {{userId: string, at: number, afterTurn: number} | null}
 */
export function claimPendingNotify(
  store,
  sessionId,
  now = Date.now(),
  turn = undefined,
  staleMs = 2 * 60 * 60 * 1000
) {
  const entry = store.get(sessionId)
  if (entry === undefined) return null
  if (!(now - entry.at <= staleMs)) {
    store.delete(sessionId)
    return null
  }
  if (!(entry.at <= now)) return null
  if (Number.isInteger(turn) && Number.isInteger(entry.afterTurn) && entry.afterTurn >= 0) {
    if (turn <= entry.afterTurn) return null
  }
  store.delete(sessionId)
  return entry
}

/**
 * 给 assistant/message 造一个去重键：优先消息 id，其次事件 seq，兜底 turn/step。
 * @param {any} data 事件数据
 * @param {unknown} [seq] 事件的 seq
 * @returns {string} 空串表示造不出来（那就只能按「没有键」处理）
 */
export function assistantDedupeKey(data, seq) {
  const id = data?.message?.id
  if (typeof id === 'string' && id.length > 0) return `msg:${id}`
  if (Number.isInteger(seq)) return `seq:${seq}`
  const turn = data?.turn
  const step = data?.step
  if (Number.isInteger(turn) && Number.isInteger(step)) return `step:${turn}:${step}`
  return ''
}

/**
 * 把 NapCat 的私聊历史拼成一段可读上下文。
 *
 * 从最新往回凑，超预算就丢最早那条——宁可少给几条，不要把命令本身挤掉。
 *
 * @param {any[]} messages get_friend_msg_history 的 messages
 * @param {object} [opts]
 * @param {number} [opts.selfId] 自己的 QQ 号，用来区分谁说的
 * @param {number} [opts.maxChars] 总字数上限
 * @param {number} [opts.perMessageChars] 单条上限
 * @returns {string} 空串表示没拼出东西
 */
export function formatQQHistory(messages, { selfId = 0, maxChars = 1200, perMessageChars = 200 } = {}) {
  if (!Array.isArray(messages)) return ''
  const lines = []
  for (const m of messages) {
    const senderId = m?.sender?.user_id ?? m?.user_id
    const raw = String(m?.raw_message ?? '').trim()
    if (raw.length === 0) continue
    const who = String(senderId) === String(selfId) ? 'nicai' : '主人'
    const clipped = raw.length > perMessageChars ? `${raw.slice(0, perMessageChars)}…` : raw
    lines.push(`${who}：${clipped}`)
  }
  if (lines.length === 0) return ''
  const kept = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    const cost = line.length + 1
    if (kept.length > 0 && total + cost > maxChars) break
    kept.unshift(line)
    total += cost
  }
  return kept.join('\n')
}

/**
 * 记一条「已经发过」的消息，顺便清掉过期的。
 * @param {Map<string, number>} store 去重键 → 首次发送时间
 * @param {string} key 空串直接放行（没有键就没法判重）
 * @param {number} [now]
 * @param {number} [ttlMs]
 * @returns {boolean} true = 第一次见，可以发；false = 发过了
 */
export function rememberDelivery(store, key, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  pruneDelivered(store, now, ttlMs)
  if (typeof key !== 'string' || key.length === 0) return true
  if (store.has(key)) return false
  store.set(key, now)
  return true
}

/**
 * 清掉超过 TTL 的去重记录，别让这张表无限长。
 * @param {Map<string, number>} store
 * @param {number} [now]
 * @param {number} [ttlMs]
 * @returns {number} 清完后还剩多少条
 */
export function pruneDelivered(store, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  for (const [key, at] of store) {
    if (!(now - at < ttlMs)) store.delete(key)
  }
  return store.size
}

/**
 * 造一条 OneBot v11 发私聊的报文。
 * @param {string} userId QQ 号
 * @param {string} text 正文
 * @param {string} echo 回执标识
 * @returns {Record<string, unknown>}
 */
export function buildQQSendPayload(userId, text, echo) {
  const id = /^\d+$/.test(String(userId)) ? Number(userId) : String(userId)
  return {
    action: 'send_private_msg',
    params: { user_id: id, message: text },
    echo
  }
}

/**
 * 这条响应是不是我等的那个 echo。
 * @param {unknown} reply 解析后的响应
 * @param {string} expectedEcho
 * @returns {boolean}
 */
export function matchEcho(reply, expectedEcho) {
  if (typeof expectedEcho !== 'string' || expectedEcho.length === 0) return false
  if (reply === null || typeof reply !== 'object') return false
  return reply.echo === expectedEcho
}

/**
 * 响应是不是「发成功了」。OneBot 失败给非 0 retcode，成功给 status=ok。
 * @param {unknown} reply
 * @returns {boolean}
 */
export function isEchoOk(reply) {
  if (reply === null || typeof reply !== 'object') return false
  if (typeof reply.retcode === 'number') return reply.retcode === 0
  return reply.status === 'ok'
}

/**
 * 指数退避：1s、2s、4s……封顶 maxMs，别疯狂重连。
 * @param {number} attempt 第几次重试（0 起）
 * @param {number} [baseMs]
 * @param {number} [maxMs]
 * @returns {number} 毫秒
 */
export function backoffDelay(attempt, baseMs = 1000, maxMs = 30000) {
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  const raw = baseMs * Math.pow(2, n)
  return Math.min(maxMs, Math.max(baseMs, raw))
}

/** 默认的「这活儿该 DSH 干」关键词。命中就转，命中不了就让 AstrBot 自己聊。 */
export const DEFAULT_DSH_TRIGGERS = [
  '桌宠', '插件', '桥', 'DSH', 'dsh', '项目', '代码', '脚本', '文件',
  '安装', '重启', '部署', 'git', '日志', '端口', '会话', '打包', '编译', '报错', '终端'
]

/**
 * 这条事件是不是主人发来的私聊。
 * @param {any} event OneBot 事件
 * @param {string} [ownerId] 主人 QQ；空串表示不校验
 * @returns {boolean}
 */
export function isOwnerPrivateMessage(event, ownerId = '') {
  if (event?.post_type !== 'message') return false
  if (event?.message_type !== 'private') return false
  const sender = String(event?.user_id ?? event?.sender?.user_id ?? '')
  if (sender.length === 0) return false
  if (ownerId.length > 0 && sender !== String(ownerId)) return false
  return true
}

/**
 * 从 OneBot 消息事件里取纯文本（图片、表情直接丢）。
 * @param {any} event
 * @returns {string}
 */
export function extractQQEventText(event) {
  const segments = Array.isArray(event?.message) ? event.message : []
  const parts = []
  for (const seg of segments) {
    if (seg?.type === 'text' && typeof seg?.data?.text === 'string') parts.push(seg.data.text)
  }
  return parts.join('').trim()
}

/**
 * 这句话要不要转给 DSH 干。
 *
 * 先排除 /dsh 开头的——那条走 AstrBot 的插件，别两边都投一遍。
 * 剩下靠关键词和「像路径/像代码」的特征粗筛，宁可多转一点，也别让它自己瞎答。
 *
 * @param {string} text
 * @param {string[]} [keywords]
 * @returns {boolean}
 */
export function shouldRouteToDsh(text, keywords = DEFAULT_DSH_TRIGGERS) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return false
  if (/^\/?dsh\b/i.test(value)) return false
  for (const keyword of keywords) {
    const k = String(keyword ?? '').trim()
    if (k.length > 0 && value.includes(k)) return true
  }
  if (/[A-Za-z]:[\\/]/.test(value)) return true
  if (value.includes('```')) return true
  if (/[\\/]/.test(value) && /\.[A-Za-z0-9]{1,5}\b/.test(value)) return true
  return false
}

/**
 * 截图目录该删哪几张：只留最新的 keep 张。
 *
 * 为什么放这儿：观战模式（桌宠 observe_mode=game）10 秒一包、一包两百多 KB，
 * 一小时能堆 90 MB。真正删文件那步在 index.js（要碰 fs），挑哪几张在这儿好单测。
 *
 * @param {string[]} names 目录里的文件名
 * @param {number} [keep] 留几张
 * @returns {string[]} 该删的文件名，老的在前
 */
export function pickStaleShots(names, keep = 60) {
  const shots = (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string'
      && name.startsWith('shot-') && name.endsWith('.png'))
    .sort()
  const limit = Math.max(0, Number(keep) || 0)
  return shots.slice(0, Math.max(0, shots.length - limit))
}
