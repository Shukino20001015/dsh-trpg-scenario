import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStageGraph } from '../stage-graph.js'
import { parseCharacterConfig } from '../character-state.js'
import { deriveCombinedToolHistory, verifyCombinedToolHistory, verifyStageToolHistory } from '../stage-history.js'
import { inspectDialogue } from '../judge-log.js'

const graph = parseStageGraph(JSON.stringify({ version: 1, goal: '找到工作', initial: 'search', stages: [{ id: 'search', name: '求职', instruction: '求职' }, { id: 'job', name: '工作', instruction: '工作' }], transitions: [{ id: 'join', from: 'search', to: 'job', condition: '已经入职' }] }))
const config = parseCharacterConfig(JSON.stringify({ version: 1, fields: [{ id: 'energy', label: '精力', initial: '疲惫' }] }))
const message = '李然今天已经入职，跟小林聊天后放松了一些。'
const stageArgs = { transition: 'join', expectedRevision: 0, quotes: [message] }
const characterArgs = { field: 'energy', value: '稍有放松', expectedRevision: 0, quotes: [message] }
const event = (seq, type, data, surfaceOp) => ({ seq, type, ...(surfaceOp ? { surfaceOp } : {}), data })
const tool = (seq, name, args, id) => {
  const serialized = JSON.stringify(args)
  return [event(seq, 'assistant/message', { message: { content: [{ type: 'tool-call', name, id, arguments: serialized }] } }, 'append'), event(seq + 1, 'tool/call', { name, callId: id, arguments: serialized }), event(seq + 2, 'tool/result', { message: { source: { kind: 'tool', callId: id }, toolCallId: id, content: [{ type: 'text', text: JSON.stringify({ ok: true, message: '已完成' }) }], isError: false } }, 'append')]
}
const log = () => [event(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '今天出门去公司报到。' }] }, 'append'), event(1, 'assistant/message', { message: { content: [{ type: 'text', text: message }] } }, 'append'), ...tool(2, 'trpg_transition', stageArgs, 'stage'), ...tool(5, 'trpg_update_character', characterArgs, 'character')]
const stageHistory = [{ from: 'search', to: 'job', transition: 'join', evidence: [1], revision: 1 }]
const characterHistory = [{ revision: 1, field: 'energy', value: '稍有放松', evidence: [1] }]

test('双工具记录逐项重放并与两个独立状态一致', () => {
  assert.equal(verifyCombinedToolHistory(log(), graph, stageHistory, config, characterHistory), true)
  assert.throws(() => verifyStageToolHistory(log(), stageHistory), /不允许/)
})
test('独立评委解析双工具日志但不将工具参数作为玩家对话', () => {
  const input = [...log(), event(8, 'assistant/message', { message: { content: [{ type: 'text', text: '今天的事情告一段落。' }] } }, 'append')]
  const result = inspectDialogue(Buffer.from(input.map(JSON.stringify).join('\n')), '测试组', { stageGraph: graph, characterConfig: config })
  assert.match(result.dialogue, /李然今天已经入职/)
  assert.match(result.dialogue, /今天的事情告一段落/)
  assert.doesNotMatch(result.dialogue, /trpg_update_character|expectedRevision|稍有放松/)
  assert.throws(() => inspectDialogue(Buffer.from(input.map(JSON.stringify).join('\n')), '测试组', { stageGraph: graph }), /阶段工具记录/)
})
test('拒绝未知工具、被篡改的状态以及混入未显示叙述', () => {
  const foreign = log(); foreign[5].data.message.content[0].name = 'bash'
  assert.throws(() => verifyCombinedToolHistory(foreign, graph, stageHistory, config, characterHistory), /不允许/)
  assert.throws(() => verifyCombinedToolHistory(log(), graph, stageHistory, config, [{ ...characterHistory[0], value: '不相干' }]), /不一致/)
  const mixed = log(); mixed[5].data.message.content.unshift({ type: 'text', text: '没有展示的秘密。' })
  assert.throws(() => verifyCombinedToolHistory(mixed, graph, stageHistory, config, characterHistory), /混合隐藏叙述/)
})
test('主角状态工具混合未展示文字且被拒绝时，不应阻止已确认阶段的恢复', () => {
  const mixed = log()
  mixed[5].data.message.content.unshift({ type: 'text', text: '这段可能没有展示。' })
  mixed[7].data.message.content[0].text = JSON.stringify({ ok: false, message: '状态未更新' })
  assert.equal(verifyCombinedToolHistory(mixed, graph, stageHistory, config, []), true)
  assert.deepEqual(deriveCombinedToolHistory(mixed, graph, config), { stages: stageHistory, character: [] })
})
test('状态更新工具未返回明确结果时拒绝将状态当成已确认', () => {
  const broken = log()
  broken[7] = { type: 'tool/result', surfaceOp: 'append', seq: 7, sourceEventSeqs: [6], data: { error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }, message: { id: 'interrupted-tool-result-character-7', source: { kind: 'tool', callId: 'character' }, toolCallId: 'character', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.' }] } } }
  assert.throws(() => verifyCombinedToolHistory(broken, graph, stageHistory, config, characterHistory), /不确定/)
  assert.deepEqual(deriveCombinedToolHistory(broken, graph, config), { stages: stageHistory, character: [] })
  const forged = structuredClone(broken); forged[7].sourceEventSeqs = [5]
  assert.throws(() => deriveCombinedToolHistory(forged, graph, config), /中断记录无效/)
})
