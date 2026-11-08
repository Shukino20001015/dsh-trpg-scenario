import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStageGraph, resolveEvidenceQuotes } from '../stage-graph.js'
import { createStageRuntime } from '../stage-tool.js'

test('阶段提醒仅显示当前出口，并随阶段转换更新', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-prompt-test-'))
  try {
    const graph = parseStageGraph(JSON.stringify({ version: 1, goal: '求职', initial: 'interview', stages: [{ id: 'interview', name: '面试', instruction: '面试' }, { id: 'working', name: '工作', instruction: '工作' }], transitions: [{ id: 'start', from: 'interview', to: 'working', condition: '已开始工作' }] }))
    const agent = { session: { id: 'session-00000000-0000-0000-0000-000000000001', log: [{ type: 'assistant/message', surfaceOp: 'append', seq: 2, data: { message: { content: [{ type: 'text', text: '周一你来到公司并正式开始上班。' }] } } }] } }
    const runtime = await createStageRuntime({ root, hash: 'a'.repeat(64), graph, agent })
    assert.match(runtime.prompt(), /本轮阶段核对.*"id":"start"/)
    const legacy = await createStageRuntime({ root, hash: 'b'.repeat(64), graph, agent: { session: { id: 'session-00000000-0000-0000-0000-000000000002', log: [] } }, rules: '旧的冻结规则' })
    assert.doesNotMatch(legacy.prompt(), /本轮阶段核对/)
    assert.equal((await runtime.definition.execute({ transition: 'start', expectedRevision: 0, quotes: ['周一你来到公司并正式开始上班'] }, { agent })).ok, true)
    assert.match(runtime.prompt(), /当前确认阶段：\{"id":"working","revision":1\}/)
    assert.match(runtime.prompt(), /可用转换：\[\]/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('模型添加一对引号时保留本局唯一原文校验', () => {
  const events = [{ seq: 8, role: 'user', text: '团队不大，主要是产品和开发一起沟通。' }]
  assert.deepEqual(resolveEvidenceQuotes(['“团队不大，主要是产品和开发一起沟通。”'], events), [8])
  assert.throws(() => resolveEvidenceQuotes(['“团队很大，主要是产品和开发一起沟通。”'], events), /未找到/)
  assert.throws(() => resolveEvidenceQuotes(['“团队不大，主要是产品和开发一起沟通。”'], [...events, { ...events[0], seq: 9 }]), /歧义/)
  assert.throws(() => resolveEvidenceQuotes(['“团队不大，主要是产品和开发一起沟通。”'], []), /未找到/)
  assert.throws(() => resolveEvidenceQuotes(['“一二三四五六七”'], [{ seq: 1, role: 'user', text: '一二三四五六七' }]), /未找到/)
})

test('混合工具和叙事仍被拒绝，失败提示不要求重述', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-mixed-guidance-'))
  try {
    const graph = parseStageGraph(JSON.stringify({ version: 1, goal: '求职', initial: 'interview', stages: [{ id: 'interview', name: '面试', instruction: '面试' }, { id: 'working', name: '工作', instruction: '工作' }], transitions: [{ id: 'start', from: 'interview', to: 'working', condition: '已开始工作' }] }))
    const agent = { session: { id: 'session-00000000-0000-0000-0000-000000000004', log: [
      { type: 'assistant/message', surfaceOp: 'append', seq: 2, data: { message: { content: [{ type: 'text', text: '周一你来到公司并正式开始上班。' }] } } },
      { type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { message: { content: [{ type: 'text', text: '办公室的灯亮了。' }, { type: 'tool-call', name: 'trpg_transition' }] } } },
    ] } }
    const runtime = await createStageRuntime({ root, hash: 'c'.repeat(64), graph, agent })
    const result = await runtime.definition.execute({ transition: 'start', expectedRevision: 0, quotes: ['周一你来到公司并正式开始上班'] }, { agent })
    assert.equal(result.ok, false)
    assert.equal(runtime.current().revision, 0)
    assert.match(result.message, /不要重述/)
    assert.match(result.message, /本回合不要重试/)
    assert.doesNotMatch(result.message, /重新清楚呈现/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
