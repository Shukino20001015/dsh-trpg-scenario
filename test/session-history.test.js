import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSessionEvents } from '../session-history.js'
import { apply } from '../index.js'

const entry = seq => ({ type: 'event', event: { seq, type: 'user/message', data: {} } })
test('0.2.2 events 分页固定 cursor 并按时间顺序还原完整事件', async () => {
  const calls = []
  const controller = { async events(request) {
    calls.push(request)
    return calls.length === 1
      ? { cursor: 6, hasMore: true, records: [entry(4), entry(6)] }
      : { cursor: 6, hasMore: false, records: [entry(0), entry(2)] }
  } }
  const result = await readSessionEvents(controller, 'session-test', new AbortController().signal)
  assert.deepEqual(result.map(e => e.seq), [0, 2, 4, 6])
  assert.deepEqual(calls[0], { address: { kind: 'session', sessionId: 'session-test' }, maxMessages: 500 })
  assert.equal(calls[1].throughSeq, 6)
  assert.equal(calls[1].beforeSeq, 4)
})
test('分页异常、未前进或版本不一致必须失败', async () => {
  for (const second of [
    { cursor: 4, hasMore: true, records: [] },
    { cursor: 5, hasMore: false, records: [entry(0)] },
    { cursor: 4, hasMore: false, records: [entry(4)] },
  ]) {
    let i = 0
    await assert.rejects(readSessionEvents({ events: async () => ++i === 1 ? { cursor: 4, hasMore: true, records: [entry(4)] } : second }, 'id', new AbortController().signal))
  }
})
test('旧版 inspect 优先且不会调用 events', async () => {
  const events = [{ type: 'test' }]
  assert.equal(await readSessionEvents({ inspect: async () => ({ events }), events: () => { throw Error('should not call') } }, 'id'), events)
})
test('只有 0.2.2 events 时注册路由并能查询空会话', async () => {
  let route
  const ctx = {
    effect: fn => fn(),
    connection: { fetch: { register: value => { route = value; return () => {} } } },
    sessionController: { events: async () => ({ cursor: -1, hasMore: false, records: [] }) },
    commands: { register: () => () => {} },
  }
  apply(ctx, { root: '/tmp/trpg-empty-route-unit-test-nonexistent' })
  assert.equal(route.path, '/api/trpg.view')
  const invalid = await route.fetch(new Request('http://localhost/api/trpg.view?sessionId=test'))
  assert.equal(invalid.status, 400)
  const response = await route.fetch(new Request('http://localhost/api/trpg.view?sessionId=session-00000000-0000-0000-0000-000000000000'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.current, null)
  assert.ok(Array.isArray(body.catalog))
})
