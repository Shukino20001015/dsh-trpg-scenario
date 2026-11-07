import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStageGraph } from '../stage-graph.js'
import { createStageRuntime } from '../stage-tool.js'

test('阶段提醒仅显示当前出口，并随阶段转换更新', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-prompt-test-'))
  try {
    const graph = parseStageGraph(JSON.stringify({ version: 1, goal: '求职', initial: 'interview', stages: [{ id: 'interview', name: '面试', instruction: '面试' }, { id: 'working', name: '工作', instruction: '工作' }], transitions: [{ id: 'start', from: 'interview', to: 'working', condition: '已开始工作' }] }))
    const agent = { session: { id: 'session-00000000-0000-0000-0000-000000000001', log: [{ type: 'assistant/message', surfaceOp: 'append', seq: 2, data: { message: { content: [{ type: 'text', text: '周一你来到公司并正式开始上班。' }] } } }] } }
    const runtime = await createStageRuntime({ root, hash: 'a'.repeat(64), graph, agent })
    assert.match(runtime.prompt(), /本轮阶段核对.*"id":"start"/)
    assert.equal((await runtime.definition.execute({ transition: 'start', expectedRevision: 0, quotes: ['周一你来到公司并正式开始上班'] }, { agent })).ok, true)
    assert.match(runtime.prompt(), /当前确认阶段：\{"id":"working","revision":1\}/)
    assert.match(runtime.prompt(), /可用转换：\[\]/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
