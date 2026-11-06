/**
 * QQ 直发：直接连 NapCat 的 OneBot v11 WebSocket 发私聊。
 *
 * 为什么不走 AstrBot：那边只能同步轮询等结果，DSH 一轮跑几分钟就超时丢结果。
 * 桥这边接住 assistant/message，自己把话发出去，谁也不用等谁。
 *
 * 约束：只用内置 WebSocket 和 setTimeout，不 import 任何宿主包，
 * 也不碰 AstrBot / NapCat 的配置——这样能在 DSH 之外直接单测。
 */

import {
  backoffDelay,
  buildQQSendPayload,
  isEchoOk,
  matchEcho,
  normalizeQQId
} from './pure.js'
import { chunkMarkdownParts } from './markdown-chunks.mjs'

/** WebSocket.OPEN 的字面值，别依赖注入进来的实现有没有这个常量。 */
const OPEN = 1

/** 自动重连最多试几次；再多就等下一次 send 自己连。 */
const MAX_RECONNECT_ATTEMPTS = 8

/**
 * 把 WS 收到的帧转成字符串（Node 给字符串，也可能给 ArrayBuffer/视图）。
 * @param {unknown} data
 * @returns {string}
 */
function frameText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

/**
 * 造一个 QQ 通知器。懒连接：第一次 send 才连；断线指数退避重连。
 *
 * @param {object} options
 * @param {string} options.wsUrl NapCat 的 WS 地址，比如 ws://127.0.0.1:9178
 * @param {string} [options.token] access_token；已经在 URL 里带了就不会重复拼
 * @param {Console | {info?: Function, warn?: Function}} [options.logger]
 * @param {number} [options.timeoutMs] 单条消息等回执的时限
 * @param {number} [options.baseBackoffMs] 重连初始间隔
 * @param {number} [options.maxBackoffMs] 重连最大间隔
 * @param {typeof WebSocket} [options.WebSocketImpl] 测试用：换掉 WebSocket 实现
 */
/**
 * Markdown → 纯文本。QQ 不渲染 Markdown，标记原样发出去只是噪音。
 * 只做"去掉符号、保留内容"，不追求还原排版。
 * @param {string} markdown
 * @returns {string}
 */
export function toPlainText(markdown) {
  const lines = String(markdown ?? '').split('\n')
  const out = []
  let inFence = false

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')

    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(`  ${line}`)
      continue
    }

    if (/^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')) continue

    const text = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '· ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^\s*\|(.+)\|\s*$/, (_, cells) =>
        cells.split('|').map((cell) => cell.trim()).join('  '))

    out.push(text.replace(/\s+$/, ''))
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function createQQNotifier({
  wsUrl = '',
  token = '',
  logger = console,
  timeoutMs = 15000,
  baseBackoffMs = 1000,
  maxBackoffMs = 30000,
  chunkDelayMs = 800,
  WebSocketImpl = globalThis.WebSocket,
  onEvent = null
} = {}) {
  const Impl = WebSocketImpl ?? globalThis.WebSocket

  /** 当前连着的 socket；没连上是 null。 */
  let socket = null
  /** 正在连的那次 Promise，避免并发 send 各连一条。 */
  let connecting = null
  /** 用户主动关了就别再连。 */
  let closed = false
  /** 成功连上过一次才自动重连；从没连上就等下一次 send。 */
  let everConnected = false
  /** 连续重连次数，用来算退避。 */
  let attempt = 0
  /** 挂着的重连定时器。 */
  let reconnectTimer = null
  /** echo 序号，保证同进程内不撞。 */
  let seq = 0
  /** echo → 等回执的 { resolve, reject, timer }。 */
  const waiting = new Map()

  /** 拼 WS 地址：token 没在 URL 里就补成查询参数。 */
  function endpoint() {
    if (typeof wsUrl !== 'string' || wsUrl.length === 0) return ''
    if (typeof token !== 'string' || token.length === 0) return wsUrl
    try {
      const url = new URL(wsUrl)
      if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token)
      return url.toString()
    } catch {
      return wsUrl
    }
  }

  /** 把所有等回执的请求一并失败掉，避免永远挂着。 */
  function rejectWaiting(error) {
    for (const [echo, waiter] of waiting) {
      clearTimeout(waiter.timer)
      waiting.delete(echo)
      waiter.reject(error)
    }
  }

  /** 收到一帧：先看是不是外部事件，再找对上待发 echo 的回执。 */
  function onFrame(raw) {
    let reply
    try {
      reply = JSON.parse(raw)
    } catch {
      return
    }
    // OneBot 的事件上报没有 echo；直听 QQ 消息靠它，不配就一律忽略
    if (reply?.echo === undefined && typeof onEvent === 'function') {
      try {
        onEvent(reply)
      } catch (error) {
        logger?.warn?.('dsh-pet-bridge: 处理 QQ 事件失败：%s', error?.message ?? error)
      }
    }
    for (const echo of waiting.keys()) {
      if (!matchEcho(reply, echo)) continue
      const waiter = waiting.get(echo)
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      waiting.delete(echo)
      if (isEchoOk(reply)) {
        const messageId = reply?.data?.message_id ?? reply?.data?.messageId ?? null
        waiter.resolve({ ok: true, messageId, echo, raw: reply })
      } else {
        const error = new Error(
          `NapCat 回绝了：retcode=${String(reply?.retcode ?? '-')} ${String(reply?.message ?? reply?.wording ?? '')}`.trim()
        )
        error.code = 'qq-rejected'
        error.retcode = reply?.retcode
        waiter.reject(error)
      }
      return
    }
  }

  /** 断线后按退避排一次重连；从没连上过就不排（等下一次 send 再试）。 */
  function scheduleReconnect() {
    if (closed || !everConnected || reconnectTimer !== null) return
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      logger?.warn?.('dsh-pet-bridge: QQ WS 重连试了 %d 次都失败，先停手，下次发消息再连', attempt)
      return
    }
    const delay = backoffDelay(attempt, baseBackoffMs, maxBackoffMs)
    attempt += 1
    logger?.warn?.('dsh-pet-bridge: QQ WS 断了，%d ms 后第 %d 次重连', delay, attempt)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      connect().catch(() => {
        // 连不上会走 close 事件，那儿会再排一次
      })
    }, delay)
  }

  /**
   * 连上 NapCat。已经连着就直接返回，正在连就复用那次 Promise。
   * @returns {Promise<WebSocket>}
   */
  function connect() {
    if (closed) {
      return Promise.reject(Object.assign(new Error('QQ 通知器已关闭'), { code: 'closed' }))
    }
    if (socket !== null && socket.readyState === OPEN) return Promise.resolve(socket)
    if (connecting !== null) return connecting
    if (typeof Impl !== 'function') {
      return Promise.reject(
        Object.assign(new Error('当前环境没有内置 WebSocket'), { code: 'no-websocket' })
      )
    }
    const url = endpoint()
    if (url.length === 0) {
      return Promise.reject(Object.assign(new Error('没配 qqWsUrl'), { code: 'no-ws-url' }))
    }

    const promise = new Promise((resolve, reject) => {
      let ws
      try {
        ws = new Impl(url)
      } catch (error) {
        reject(Object.assign(new Error(`建不了 QQ WS：${error?.message ?? error}`), { code: 'ws-create-failed' }))
        return
      }

      let opened = false
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      ws.onopen = () => {
        opened = true
        socket = ws
        everConnected = true
        attempt = 0
        settle(resolve, ws)
      }
      ws.onmessage = (event) => {
        try {
          onFrame(frameText(event?.data))
        } catch (error) {
          logger?.warn?.('dsh-pet-bridge: 处理 QQ WS 帧失败：%s', error?.message ?? error)
        }
      }
      ws.onerror = () => {
        // 具体原因在 close 里统一处理；没开起来就把这次连接判失败
        if (!opened) {
          settle(reject, Object.assign(new Error('连 NapCat 时出错'), { code: 'ws-error' }))
        }
      }
      ws.onclose = () => {
        if (socket === ws) socket = null
        if (!opened) {
          settle(reject, Object.assign(new Error('连不上 NapCat'), { code: 'ws-closed' }))
        }
        rejectWaiting(Object.assign(new Error('QQ WS 已断开'), { code: 'ws-closed' }))
        scheduleReconnect()
      }
    })

    connecting = promise
    promise.then(
      () => { connecting = null },
      () => {
        connecting = null
        // 同步失败（地址写错之类）不会走 close 事件，这里补一次退避
        if (everConnected) scheduleReconnect()
      }
    )
    return promise
  }

  /**
   * 发一条 QQ 私聊。
   * @param {string | number} userId QQ 号
   * @param {string} text 正文
   * @returns {Promise<{ok: true, messageId: unknown, echo: string}>}
   */
  /**
   * 发一条（不分片）。send 内部用，也方便单测。
   * @param {string} qq 已归一化的 QQ 号
   * @param {string} body 正文
   */
  async function sendOne(qq, body) {
    const ws = await connect()
    seq += 1
    const echo = `pet-${Date.now().toString(36)}-${seq}`
    const payload = buildQQSendPayload(qq, body, echo)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(echo)
        reject(Object.assign(new Error(`等 QQ 回执超时（${timeoutMs}ms）`), { code: 'timeout' }))
      }, timeoutMs)
      waiting.set(echo, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        waiting.delete(echo)
        reject(Object.assign(new Error(`发 QQ 失败：${error?.message ?? error}`), { code: 'send-failed' }))
      }
    })
  }

  /**
   * 发一条 QQ 私聊。长文按结构边界切成多条，逐条发、条间留间隔，
   * 代码块/表格不会被切断，发出去的是一律纯文本（QQ 不渲染 Markdown）。
   *
   * @param {string | number} userId QQ 号
   * @param {string} text 正文
   * @returns {Promise<{ok: true, messageId: unknown, messageIds: unknown[], chunks: number}>}
   */
  async function send(userId, text) {
    if (closed) {
      throw Object.assign(new Error('QQ 通知器已关闭'), { code: 'closed' })
    }
    const qq = normalizeQQId(userId)
    if (qq.length === 0) {
      throw Object.assign(new Error(`不是合法 QQ 号：${String(userId)}`), { code: 'bad-qq' })
    }
    const body = String(text ?? '').trim()
    if (body.length === 0) {
      throw Object.assign(new Error('空消息，不发'), { code: 'empty-text' })
    }

    const chunks = chunkMarkdownParts(body)
      .map((part) => toPlainText(String(part.plain ?? '')).trim())
      .filter((part) => part.length > 0)
    if (chunks.length === 0) {
      throw Object.assign(new Error('分片后没有可发内容'), { code: 'empty-text' })
    }

    const results = []
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0 && chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs))
      }
      results.push(await sendOne(qq, chunk))
    }

    return {
      ok: true,
      messageId: results[0]?.messageId ?? null,
      messageIds: results.map((item) => item.messageId),
      chunks: chunks.length,
      echo: results[results.length - 1]?.echo ?? ''
    }
  }

  /** 关掉通知器：清定时器、把等回执的请求全失败、断开 socket。 */
  function close() {
    if (closed) return
    closed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    rejectWaiting(Object.assign(new Error('QQ 通知器已关闭'), { code: 'closed' }))
    const current = socket
    socket = null
    if (current !== null) {
      try {
        current.close()
      } catch {
        // 关不掉就算了，进程退出会收尾
      }
    }
  }

  /**
   * 调一个 OneBot 动作，等回执拿 data。
   *
   * 和 send 共用同一条 WS：发消息、拉历史不必各开一条连接。
   * 失败一律抛带 code 的 Error，调用方自己决定降级。
   *
   * @param {string} action 动作名，比如 get_friend_msg_history
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} 回执里的 data
   */
  async function call(action, params = {}, timeoutMs = 6000) {
    if (closed) {
      throw Object.assign(new Error('QQ 通知器已关闭'), { code: 'closed' })
    }
    if (typeof action !== 'string' || action.length === 0) {
      throw Object.assign(new Error('没给 action'), { code: 'bad-action' })
    }
    const ws = await connect()
    seq += 1
    const echo = `pet-${Date.now().toString(36)}-${seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(echo)
        reject(Object.assign(new Error(`等 ${action} 回执超时（${timeoutMs}ms）`), { code: 'timeout' }))
      }, timeoutMs)
      waiting.set(echo, {
        resolve: (result) => resolve(result.raw?.data ?? null),
        reject,
        timer
      })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        waiting.delete(echo)
        reject(Object.assign(new Error(`发 ${action} 失败：${error?.message ?? error}`), { code: 'send-failed' }))
      }
    })
  }

  /** 主动建连：直听模式要用，不然只有发消息时才连。 */
  async function open() {
    await connect()
    return true
  }

  return {
    send,
    call,
    open,
    close,
    get connected() {
      return socket !== null && socket.readyState === OPEN
    }
  }
}
