/**
 * 直发器的行为测试：用假的 WebSocket 顶替 NapCat，不联网、不碰宿主包。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createQQNotifier } from '../lib/qq.js'

const WS = 'ws://127.0.0.1:9178'

/** 测试里不需要日志噪音。 */
const silent = { info() {}, warn() {} }

/** 假 WebSocket：能开、能收、能发、能断。 */
class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.closed = false
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    FakeWebSocket.instances.push(this)
    this.openTimer = setImmediate(() => {
      if (this.closed) return
      this.readyState = 1
      this.onopen?.({})
    })
  }

  send(raw) {
    if (this.readyState !== 1) throw new Error('还没连上')
    const payload = JSON.parse(raw)
    this.sent.push(payload)
    this.onSend?.(payload, this)
  }

  /** 服务端回一帧。 */
  reply(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  /** 主动关闭（客户端调 close）。 */
  close() {
    if (this.closed) return
    this.closed = true
    clearImmediate(this.openTimer)
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({}))
  }

  /** 模拟服务端掉线。 */
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到条件成立，最多等 tries 轮事件循环。 */
async function until(check, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true
    await tick()
  }
  return check()
}

/** 统一用假 WS + 静音日志造通知器。 */
function makeNotifier(options = {}) {
  return createQQNotifier({
    wsUrl: WS,
    WebSocketImpl: FakeWebSocket,
    logger: silent,
    ...options
  })
}

function reset() {
  FakeWebSocket.instances.length = 0
}

test('qq：懒连接，第一次 send 才连，URL 自动补 token', async () => {
  reset()
  const notifier = makeNotifier({ token: 'YOUR_TOKEN_HERE' })
  assert.equal(FakeWebSocket.instances.length, 0, '构造时不该连')

  const pending = notifier.send('123456789', '你好')
  assert.equal(await until(() => FakeWebSocket.instances.length === 1), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(ws.url, 'ws://127.0.0.1:9178/?access_token=YOUR_TOKEN_HERE')

  assert.equal(await until(() => ws.sent.length === 1), true)
  ws.reply({ status: 'ok', retcode: 0, echo: ws.sent[0].echo, data: { message_id: 77 } })
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.messageId, 77)
  assert.equal(ws.sent[0].action, 'send_private_msg')
  assert.equal(ws.sent[0].params.user_id, 123456789)
  assert.equal(ws.sent[0].params.message, '你好')
  notifier.close()
})

test('qq：token 已经在 URL 里就不重复拼', async () => {
  reset()
  const notifier = makeNotifier({ wsUrl: 'ws://127.0.0.1:9178/?access_token=abc', token: 'YOUR_TOKEN_HERE' })
  const pending = notifier.send('123456789', '嗨')
  assert.equal(await until(() => FakeWebSocket.instances.length === 1), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(ws.url, 'ws://127.0.0.1:9178/?access_token=abc')
  assert.equal(await until(() => ws.sent.length === 1), true)
  ws.reply({ status: 'ok', retcode: 0, echo: ws.sent[0].echo, data: { message_id: 1 } })
  await pending
  notifier.close()
})

test('qq：等不到回执就超时拒绝', async () => {
  reset()
  const notifier = makeNotifier({ timeoutMs: 30 })
  const pending = notifier.send('123456789', '这条没人回')
  await assert.rejects(pending, (error) => error.code === 'timeout')
  notifier.close()
})

test('qq：对不上 echo 的响应不影响等着的那条', async () => {
  reset()
  const notifier = makeNotifier({ timeoutMs: 200 })
  const pending = notifier.send('123456789', '正文')
  assert.equal(await until(() => FakeWebSocket.instances.length === 1), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(await until(() => ws.sent.length === 1), true)

  ws.reply({ status: 'ok', retcode: 0, echo: '别家的-echo', data: { message_id: 1 } })
  ws.onmessage?.({ data: '这不是 JSON' })
  ws.reply({ status: 'ok', retcode: 0, echo: ws.sent[0].echo, data: { message_id: 99 } })
  const result = await pending
  assert.equal(result.messageId, 99)
  notifier.close()
})

test('qq：NapCat 回绝就拒绝并带上 retcode', async () => {
  reset()
  const notifier = makeNotifier({ timeoutMs: 200 })
  const pending = notifier.send('123456789', '发不出去')
  assert.equal(await until(() => FakeWebSocket.instances.length === 1), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(await until(() => ws.sent.length === 1), true)
  ws.reply({ status: 'failed', retcode: 1200, echo: ws.sent[0].echo })
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'qq-rejected')
    assert.equal(error.retcode, 1200)
    return true
  })
  notifier.close()
})

test('qq：坏 QQ 号 / 空文本不发', async () => {
  reset()
  const notifier = makeNotifier()
  await assert.rejects(notifier.send('abc', '正文'), (error) => error.code === 'bad-qq')
  await assert.rejects(notifier.send('123456789', '   '), (error) => error.code === 'empty-text')
  assert.equal(FakeWebSocket.instances.length, 0, '不该连')
  notifier.close()
})

test('qq：close 之后不再发，进行中的请求一并失败', async () => {
  reset()
  const notifier = makeNotifier({ timeoutMs: 500 })
  const pending = notifier.send('123456789', '还在等')
  assert.equal(await until(() => notifier.connected), true)
  notifier.close()
  await assert.rejects(pending, (error) => error.code === 'closed')
  await assert.rejects(notifier.send('123456789', '再来'), (error) => error.code === 'closed')
  assert.equal(notifier.connected, false)
})

test('qq：断线后按退避自动重连', async () => {
  reset()
  const notifier = makeNotifier({ baseBackoffMs: 10, maxBackoffMs: 40, timeoutMs: 300 })
  const first = notifier.send('123456789', '第一条')
  assert.equal(await until(() => FakeWebSocket.instances.length === 1), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(await until(() => ws.sent.length === 1), true)
  ws.reply({ status: 'ok', retcode: 0, echo: ws.sent[0].echo, data: { message_id: 5 } })
  await first

  ws.drop()
  assert.equal(notifier.connected, false)
  // 退避是真实定时器，等一等
  await sleep(60)
  assert.equal(FakeWebSocket.instances.length, 2, '应该自己重连')

  const second = FakeWebSocket.instances[1]
  assert.equal(await until(() => second.readyState === 1), true)
  const pending = notifier.send('123456789', '重连之后')
  assert.equal(await until(() => second.sent.length === 1), true)
  second.reply({ status: 'ok', retcode: 0, echo: second.sent[0].echo, data: { message_id: 6 } })
  assert.equal((await pending).messageId, 6)
  notifier.close()
})
