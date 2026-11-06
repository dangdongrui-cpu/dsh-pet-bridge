import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assistantDedupeKey,
  backoffDelay,
  buildQQSendPayload,
  claimPendingNotify,
  extractAssistantText,
  extractQQEventText,
  extractUserText,
  formatQQHistory,
  isOwnerPrivateMessage,
  shouldRouteToDsh,
  isEchoOk,
  isLoopback,
  matchEcho,
  noteActiveSession,
  normalizeOutgoing,
  normalizeQQId,
  parseNotify,
  pickRecentSession,
  pickReplySince,
  pickResolveError,
  pickStaleShots,
  pruneDelivered,
  readJsonBody,
  registerPendingNotify,
  rememberDelivery,
  rememberTurn
} from '../lib/pure.js'

/** 造一个最小的可读流假体。 */
function fakeReq(chunks, { errorAfter = -1 } = {}) {
  const handlers = {}
  const req = {
    on(name, fn) {
      handlers[name] = handlers[name] ?? []
      handlers[name].push(fn)
      return req
    },
    destroy() {
      handlers.error?.forEach((fn) => fn(new Error('destroyed')))
    },
    socket: { remoteAddress: '127.0.0.1' }
  }
  setImmediate(() => {
    chunks.forEach((chunk, index) => {
      if (errorAfter >= 0 && index === errorAfter) {
        handlers.error?.forEach((fn) => fn(new Error('boom')))
        return
      }
      handlers.data?.forEach((fn) => fn(Buffer.from(chunk)))
    })
    handlers.end?.forEach((fn) => fn())
  })
  return req
}

test('readJsonBody：正常解析', async () => {
  const body = await readJsonBody(fakeReq(['{"text":"你好"}']))
  assert.deepEqual(body, { text: '你好' })
})

test('readJsonBody：分片拼接', async () => {
  const body = await readJsonBody(fakeReq(['{"a":', '1,', '"b":"x"}']))
  assert.deepEqual(body, { a: 1, b: 'x' })
})

test('readJsonBody：空体返回空对象', async () => {
  const body = await readJsonBody(fakeReq([]))
  assert.deepEqual(body, {})
})

test('readJsonBody：坏 JSON 返回 null', async () => {
  const body = await readJsonBody(fakeReq(['{not json']))
  assert.equal(body, null)
})

test('readJsonBody：超限返回 null', async () => {
  const body = await readJsonBody(fakeReq(['{"x":"' + 'a'.repeat(500) + '"}']), 100)
  assert.equal(body, null)
})

test('isLoopback：认本机地址', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false)
  assert.equal(isLoopback({}), false)
})

test('extractAssistantText：从 assistant/message 的 data.message 取文本', () => {
  const text = extractAssistantText({
    message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }
  })
  assert.equal(text, '第一段\n第二段')
})

test('extractAssistantText：也认 data.content', () => {
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: 'hi' }] }), 'hi')
})

test('extractAssistantText：非文本块被忽略', () => {
  const text = extractAssistantText({
    content: [{ type: 'image', url: 'x' }, { type: 'text', text: '只剩这句' }]
  })
  assert.equal(text, '只剩这句')
})

test('extractAssistantText：脏数据不炸', () => {
  assert.equal(extractAssistantText(null), '')
  assert.equal(extractAssistantText({}), '')
  assert.equal(extractAssistantText({ content: 'not-array' }), '')
})

test('normalizeOutgoing：空文本拒收', () => {
  assert.equal(normalizeOutgoing('   ', 100).code, 'empty-text')
})

test('normalizeOutgoing：超长拒收并带提示', () => {
  const result = normalizeOutgoing('a'.repeat(50), 10)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'text-too-long')
  assert.ok(result.message.includes('10'))
})

test('normalizeOutgoing：正常文本去首尾空白', () => {
  const result = normalizeOutgoing('  你好  ', 100)
  assert.equal(result.ok, true)
  assert.equal(result.text, '你好')
})

test('pickResolveError：有 error 字段就算失败', () => {
  assert.notEqual(pickResolveError({ error: { code: 'session/not-found' } }), null)
  assert.equal(pickResolveError({ agent: {} }), null)
  assert.equal(pickResolveError(null), null)
})

/* ---------------- QQ 直发：请求解析、待回复登记、判重 ---------------- */

test('normalizeQQId：只认 5–12 位纯数字', () => {
  assert.equal(normalizeQQId('123456789'), '123456789')
  assert.equal(normalizeQQId(123456789), '123456789')
  assert.equal(normalizeQQId(' 123456789 '), '123456789')
  assert.equal(normalizeQQId('1234'), '')
  assert.equal(normalizeQQId('1234567890123'), '')
  assert.equal(normalizeQQId('abc1234567'), '')
  assert.equal(normalizeQQId(''), '')
  assert.equal(normalizeQQId(null), '')
})

test('parseNotify：好 notify 拿到 userId', () => {
  const result = parseNotify({ qq: '123456789' })
  assert.equal(result.ok, true)
  assert.equal(result.userId, '123456789')
})

test('parseNotify：缺的、非对象、坏号各给各的 code', () => {
  assert.equal(parseNotify(undefined).code, 'no-notify')
  assert.equal(parseNotify('123456789').code, 'bad-notify')
  assert.equal(parseNotify({}).code, 'bad-qq')
  assert.equal(parseNotify({ qq: 'not-a-qq' }).code, 'bad-qq')
})

test('pendingNotify：登记后能取走，取一次就没了（一条命令只回一条）', () => {
  const store = new Map()
  const at = registerPendingNotify(store, 'session-a', '123456789', 1000)
  assert.deepEqual(at, { userId: '123456789', at: 1000, afterTurn: -1 })
  assert.equal(store.size, 1)

  assert.deepEqual(claimPendingNotify(store, 'session-a', 1000), { userId: '123456789', at: 1000, afterTurn: -1 })
  assert.equal(store.size, 0)
  assert.equal(claimPendingNotify(store, 'session-a', 1000), null)
})

test('pendingNotify：别的会话、早于登记的回复都不认', () => {
  const store = new Map()
  registerPendingNotify(store, 'session-a', '123456789', 5000)
  assert.equal(claimPendingNotify(store, 'session-b', 5000), null)
  assert.equal(claimPendingNotify(store, 'session-a', 4999), null)
  assert.equal(store.size, 1, '不算数的时候不能删')
  assert.notEqual(claimPendingNotify(store, 'session-a', 5000), null)
})

test('pendingNotify：同会话再来一条命令就覆盖前一条', () => {
  const store = new Map()
  registerPendingNotify(store, 'session-a', '11111', 100)
  registerPendingNotify(store, 'session-a', '22222', 200)
  assert.equal(store.size, 1)
  assert.equal(claimPendingNotify(store, 'session-a', 300).userId, '22222')
})

test('pendingNotify：空会话 id 不登记', () => {
  const store = new Map()
  assert.equal(registerPendingNotify(store, '', '123456789'), null)
  assert.equal(store.size, 0)
})

test('pendingNotify：旧轮次的助手消息不算这条命令的回答', () => {
  const store = new Map()
  // 登记时会话正跑到第 3 轮；那条命令会排进第 4 轮
  registerPendingNotify(store, 'session-a', '123456789', 1000, 3)
  assert.equal(claimPendingNotify(store, 'session-a', 1500, 3), null, '同一轮不算')
  assert.equal(claimPendingNotify(store, 'session-a', 1500, 2), null, '更早的轮次不算')
  assert.equal(store.size, 1, '不算数的时候不能删')
  const claimed = claimPendingNotify(store, 'session-a', 1500, 4)
  assert.equal(claimed.afterTurn, 3)
  assert.equal(store.size, 0)
})

test('pendingNotify：拿不到轮次就退回只看时间', () => {
  const store = new Map()
  registerPendingNotify(store, 'session-a', '123456789', 1000, 9)
  assert.notEqual(claimPendingNotify(store, 'session-a', 1000), null)
})

test('pendingNotify：太久没结果的登记作废，不会误发', () => {
  const store = new Map()
  registerPendingNotify(store, 'session-a', '123456789', 1000)
  assert.equal(claimPendingNotify(store, 'session-a', 1000 + 2 * 60 * 60 * 1000 + 1), null)
  assert.equal(store.size, 0, '作废的登记要清掉')

  registerPendingNotify(store, 'session-a', '123456789', 1000)
  assert.notEqual(claimPendingNotify(store, 'session-a', 1000 + 60 * 60 * 1000), null)
})

test('rememberTurn：只记最大值，脏数据不炸', () => {
  const store = new Map()
  assert.equal(rememberTurn(store, 'session-a', 2), 2)
  assert.equal(rememberTurn(store, 'session-a', 1), 2)
  assert.equal(rememberTurn(store, 'session-a', 5), 5)
  assert.equal(rememberTurn(store, 'session-a', undefined), 5)
  assert.equal(rememberTurn(store, 'session-a', 'x'), 5)
  assert.equal(rememberTurn(store, '', 7), -1)
  assert.equal(store.size, 1)
})

test('assistantDedupeKey：优先消息 id，其次 seq，再次 turn/step', () => {
  assert.equal(assistantDedupeKey({ message: { id: 'm1' } }), 'msg:m1')
  assert.equal(assistantDedupeKey({ message: {} }, 42), 'seq:42')
  assert.equal(assistantDedupeKey({ turn: 2, step: 1 }), 'step:2:1')
  assert.equal(assistantDedupeKey({}, 'x'), '')
})

test('delivered：同一条消息只认一次，空键直接放行', () => {
  const store = new Map()
  assert.equal(rememberDelivery(store, 'msg:m1', 1000), true)
  assert.equal(rememberDelivery(store, 'msg:m1', 1001), false)
  assert.equal(rememberDelivery(store, 'msg:m2', 1002), true)
  assert.equal(rememberDelivery(store, '', 1003), true)
  assert.equal(store.size, 2)
})

test('delivered：过 TTL 的记录会被清掉', () => {
  const store = new Map()
  rememberDelivery(store, 'msg:m1', 1000, 500)
  assert.equal(pruneDelivered(store, 1400, 500), 1)
  assert.equal(pruneDelivered(store, 1600, 500), 0)
})

test('buildQQSendPayload：OneBot v11 报文形状', () => {
  const payload = buildQQSendPayload('123456789', '结果来了', 'pet-1')
  assert.equal(payload.action, 'send_private_msg')
  assert.equal(payload.params.user_id, 123456789)
  assert.equal(payload.params.message, '结果来了')
  assert.equal(payload.echo, 'pet-1')
})

test('matchEcho：只认自己那个 echo', () => {
  assert.equal(matchEcho({ echo: 'pet-1', retcode: 0 }, 'pet-1'), true)
  assert.equal(matchEcho({ echo: 'pet-2', retcode: 0 }, 'pet-1'), false)
  assert.equal(matchEcho({ retcode: 0 }, 'pet-1'), false)
  assert.equal(matchEcho(null, 'pet-1'), false)
  assert.equal(matchEcho({ echo: 'pet-1' }, ''), false)
})

test('isEchoOk：retcode 0 / status ok 才算成功', () => {
  assert.equal(isEchoOk({ status: 'ok', retcode: 0 }), true)
  assert.equal(isEchoOk({ status: 'failed', retcode: 1200 }), false)
  assert.equal(isEchoOk({ status: 'ok' }), true)
  assert.equal(isEchoOk({ status: 'failed' }), false)
  assert.equal(isEchoOk(null), false)
})

test('backoffDelay：指数涨、封顶不疯', () => {
  assert.equal(backoffDelay(0), 1000)
  assert.equal(backoffDelay(1), 2000)
  assert.equal(backoffDelay(3), 8000)
  assert.equal(backoffDelay(10), 30000)
  assert.equal(backoffDelay(-1), 1000)
})

test('extractUserText：user/message 的 content 浅一层', () => {
  const data = { content: [{ type: 'text', text: ' 你好 ' }, { type: 'image' }], role: 'user' }
  assert.equal(extractUserText(data), '你好')
  assert.equal(extractUserText({ message: { content: [{ type: 'text', text: 'x' }] } }), '')
  assert.equal(extractUserText(null), '')
})

test('formatQQHistory：分清谁说的', () => {
  const messages = [
    { sender: { user_id: 123456789 }, raw_message: '在吗' },
    { sender: { user_id: 987654321 }, raw_message: '在' }
  ]
  assert.equal(
    formatQQHistory(messages, { selfId: 987654321 }),
    '主人：在吗\nnicai：在'
  )
})

test('formatQQHistory：空列表 / 空文本返回空串', () => {
  assert.equal(formatQQHistory([], { selfId: 1 }), '')
  assert.equal(formatQQHistory(null), '')
  assert.equal(formatQQHistory([{ sender: { user_id: 2 }, raw_message: '   ' }], { selfId: 1 }), '')
})

test('formatQQHistory：超预算先丢最早那条', () => {
  const messages = [
    { sender: { user_id: 2 }, raw_message: 'A'.repeat(100) },
    { sender: { user_id: 2 }, raw_message: 'B'.repeat(100) }
  ]
  const out = formatQQHistory(messages, { selfId: 1, maxChars: 120 })
  assert.ok(out.includes('B'.repeat(100)))
  assert.ok(!out.includes('A'.repeat(100)))
})

test('formatQQHistory：单条太长会被截断加省略号', () => {
  const messages = [{ sender: { user_id: 2 }, raw_message: 'X'.repeat(300) }]
  const out = formatQQHistory(messages, { selfId: 1, perMessageChars: 100 })
  assert.ok(out.startsWith('主人：'))
  assert.ok(out.includes('…'))
  assert.ok(out.length < 200)
})

test('isOwnerPrivateMessage：只认主人的私聊消息', () => {
  const base = { post_type: 'message', message_type: 'private', user_id: 123456789 }
  assert.equal(isOwnerPrivateMessage(base, '123456789'), true)
  assert.equal(isOwnerPrivateMessage(base, '999'), false)
  assert.equal(isOwnerPrivateMessage({ ...base, message_type: 'group' }, '123456789'), false)
  assert.equal(isOwnerPrivateMessage({ ...base, post_type: 'message_sent' }, '123456789'), false)
  assert.equal(isOwnerPrivateMessage(base, ''), true)
  assert.equal(isOwnerPrivateMessage(null, ''), false)
})

test('extractQQEventText：拼 text 段，丢掉图片', () => {
  const event = {
    message: [
      { type: 'text', data: { text: '帮我看看' } },
      { type: 'image', data: { file: 'x.png' } },
      { type: 'text', data: { text: ' 桌宠' } }
    ]
  }
  assert.equal(extractQQEventText(event), '帮我看看 桌宠')
  assert.equal(extractQQEventText({ message: [] }), '')
  assert.equal(extractQQEventText(null), '')
})

test('shouldRouteToDsh：命中关键词就转', () => {
  assert.equal(shouldRouteToDsh('桌宠那个窗口有点问题'), true)
  assert.equal(shouldRouteToDsh('帮我重启一下'), true)
  assert.equal(shouldRouteToDsh('今天天气不错'), false)
})

test('shouldRouteToDsh：带 /dsh 的交给 AstrBot，不重复接', () => {
  assert.equal(shouldRouteToDsh('/dsh 看看桌宠'), false)
  assert.equal(shouldRouteToDsh('dsh 看看桌宠'), false)
})

test('shouldRouteToDsh：路径和代码块默认就算干活', () => {
  assert.equal(shouldRouteToDsh('看下 D:\\projects\\demo 里那个'), true)
  assert.equal(shouldRouteToDsh('```js\nconst a = 1\n```'), true)
  assert.equal(shouldRouteToDsh(''), false)
})

test('shouldRouteToDsh：自定义关键词生效', () => {
  assert.equal(shouldRouteToDsh('帮我画画', ['画画']), true)
  assert.equal(shouldRouteToDsh('帮我重启', []), false)
})

test('noteActiveSession：没 id 不记，有 id 记时间', () => {
  const store = new Map()
  assert.equal(noteActiveSession(store, '', 1000), false)
  assert.equal(noteActiveSession(store, 's1', 1000), true)
  assert.equal(store.get('s1'), 1000)
})

test('pickRecentSession：取 TTL 内最新的那个', () => {
  const store = new Map([
    ['old', 1000],
    ['mid', 5000],
    ['new', 8000]
  ])
  assert.equal(pickRecentSession(store, 9000, 5000), 'new')
  assert.equal(pickRecentSession(store, 9000, 10000), 'new')
  assert.equal(store.has('old'), false)
})

test('pickRecentSession：全都过期就回空，顺手清表', () => {
  const store = new Map([
    ['a', 1000],
    ['b', 2000]
  ])
  assert.equal(pickRecentSession(store, 100000, 1000), '')
  assert.equal(store.size, 0)
})

test('pickStaleShots：只留最新几张，老的和别的文件不动', () => {
  const names = [
    'shot-20260104-000000.png',
    'shot-20260101-000000.png',
    'readme.txt',
    'shot-20260103-000000.png',
    'shot-20260102-000000.png'
  ]
  assert.deepEqual(pickStaleShots(names, 3), ['shot-20260101-000000.png'])
  assert.deepEqual(pickStaleShots(names, 2), [
    'shot-20260101-000000.png',
    'shot-20260102-000000.png'
  ])
  assert.deepEqual(pickStaleShots(names, 10), [])
  assert.deepEqual(pickStaleShots([], 3), [])
  assert.deepEqual(pickStaleShots(['readme.txt'], 0), [])
})

test('pickReplySince：只给 since 之后的那条', () => {
  const entry = { at: 5000, text: '这波稳' }
  assert.deepEqual(pickReplySince(entry, 4000), entry)
  assert.equal(pickReplySince(entry, 5000), null)     // 同一毫秒不算新的
  assert.equal(pickReplySince(entry, 6000), null)
  assert.deepEqual(pickReplySince(entry, 0), entry)    // 不传 since 就是老行为
  assert.deepEqual(pickReplySince(entry, NaN), entry)
  assert.equal(pickReplySince(null, 0), null)
  assert.equal(pickReplySince(undefined, 100), null)
  assert.equal(pickReplySince({ text: '没时间戳' }, 100), null)
})
