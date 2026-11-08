import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveStageToolHistory, interruptedStageRecovery, verifyStageToolHistory } from '../stage-history.js'
import { parseStageGraph } from '../stage-graph.js'
import { inspectDialogue } from '../judge-log.js'

const args = JSON.stringify({ transition: 'join', expectedRevision: 0, quotes: ['我下周一正式入职'] })
const transcript = () => [
  { type: 'user/message', surfaceOp: 'append', seq: 22, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我下周一正式入职' }] } },
  { type: 'assistant/message', surfaceOp: 'append', seq: 23, data: { message: { content: [{ type: 'tool-call', id: 'call-stage-01', name: 'trpg_transition', arguments: args }] } } },
  { type: 'tool/call', seq: 24, data: { callId: 'call-stage-01', name: 'trpg_transition', arguments: args } },
  { type: 'tool/result', surfaceOp: 'append', seq: 25, data: { message: { source: { kind: 'tool', callId: 'call-stage-01' }, toolCallId: 'call-stage-01', content: [{ type: 'text', text: JSON.stringify({ ok: true, message: '已确认进入' }) }], isError: false } } },
]
const history = () => [{ from: 'search', to: 'job', transition: 'join', evidence: [22], revision: 1 }]
const graph = parseStageGraph(JSON.stringify({ version: 1, goal: '找工作', initial: 'search', stages: [{ id: 'search', name: '求职', instruction: '寻找' }, { id: 'job', name: '入职', instruction: '入职' }], transitions: [{ id: 'join', from: 'search', to: 'job', condition: '已入职' }] }))

test('阶段调用与已提交历史和对话证据逐项匹配', () => {
  assert.equal(verifyStageToolHistory(transcript(), history()), true)
  assert.equal(verifyStageToolHistory([], []), true)
})
test('同条叙事与工具调用不能用作玩家可见阶段证据', () => {
  const log = transcript()
  const text = '你今天正式到了公司开始工作。'
  const mixedArgs = JSON.stringify({ transition: 'join', expectedRevision: 0, quotes: [text] })
  log[1].data.message.content = [{ type: 'text', text }, { type: 'tool-call', id: 'call-stage-01', name: 'trpg_transition', arguments: mixedArgs }]
  log[2].data.arguments = mixedArgs
  const saved = [{ ...history()[0], evidence: [23] }]
  assert.throws(() => verifyStageToolHistory(log, saved), /混合隐藏叙述/)
  assert.throws(() => deriveStageToolHistory(log, graph), /混合隐藏叙述/)
  const scoring = inspectDialogue(Buffer.from(log.map(JSON.stringify).join('\n')), '第一组', { stageGraph: graph })
  assert.equal(scoring.uncertainToolOutcomes, 1)
  assert.deepEqual(scoring.mixedHostSeqs, [23])
  assert.match(scoring.dialogue, /你今天正式到了公司开始工作/)
  const later = structuredClone(log)
  later[1].data.message.content.reverse()
  assert.throws(() => verifyStageToolHistory(later, saved), /混合隐藏叙述/)
})
test('引用既有可见文字也不能伪造混合隐藏叙述的成功；失败记录允许恢复', () => {
  const log = transcript()
  log[1].data.message.content.unshift({ type: 'text', text: '这段可能未对玩家显示。' })
  assert.throws(() => verifyStageToolHistory(log, history()), /混合隐藏叙述/)
  assert.throws(() => deriveStageToolHistory(log, graph), /混合隐藏叙述/)
  log[3].data.message.content[0].text = JSON.stringify({ ok: false, message: '未通过' })
  assert.equal(verifyStageToolHistory(log, []), true)
  assert.deepEqual(deriveStageToolHistory(log, graph), [])
})
test('同条未展示叙事的未知结果不能作为保守恢复证据', () => {
  const log = transcript()
  const text = '你今天正式到了公司开始工作。'
  const mixedArgs = JSON.stringify({ transition: 'join', expectedRevision: 0, quotes: [text] })
  log[1].data.message.content = [{ type: 'text', text }, { type: 'tool-call', id: 'call-stage-01', name: 'trpg_transition', arguments: mixedArgs }]
  log[2].data.arguments = mixedArgs
  log[3] = { type: 'tool/result', surfaceOp: 'append', seq: 25, sourceEventSeqs: [24], data: { error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }, message: { id: 'interrupted-tool-result-call-stage-01-25', source: { kind: 'tool', callId: 'call-stage-01' }, toolCallId: 'call-stage-01', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.' }] } } }
  const maybeWritten = [{ ...history()[0], evidence: [23] }]
  assert.throws(() => verifyStageToolHistory(log, maybeWritten))
  assert.throws(() => interruptedStageRecovery(log, graph, maybeWritten), /混合隐藏叙述/)
  assert.deepEqual(deriveStageToolHistory(log, graph), [])
})
test('拒绝其他工具、伪造关联、缺失结果和不一致状态', () => {
  const cases = []
  const badTool = transcript(); badTool[1].data.message.content[0].name = 'bash'; cases.push(badTool)
  const badResult = transcript(); badResult[3].data.message.source.callId = 'other'; cases.push(badResult)
  const badArgs = transcript(); badArgs[2].data.arguments = '{}'; cases.push(badArgs)
  const unknown = transcript(); unknown.push({ type: 'tool/ptc-dispatch' }); cases.push(unknown)
  cases.push(transcript().slice(0, 3))
  for (const log of cases) assert.throws(() => verifyStageToolHistory(log, history()))
  assert.throws(() => verifyStageToolHistory(transcript(), []))
  assert.throws(() => verifyStageToolHistory(transcript(), [{ ...history()[0], evidence: [99] }]))
})
test('未成功的阶段申请不会被误算为状态变化', () => {
  const log = transcript()
  log[3].data.message.content[0].text = JSON.stringify({ ok: false, message: '未通过' })
  assert.equal(verifyStageToolHistory(log, []), true)
  assert.throws(() => verifyStageToolHistory(log, history()))
})
test('DSH 的未开始中断修复可恢复原阶段，但伪造或不一致的修复不能通过', () => {
  const log = transcript().slice(0, 2)
  log.push({ type: 'tool/result', surfaceOp: 'append', seq: 25, data: { error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' }, message: { id: 'interrupted-tool-result-call-stage-01-25', source: { kind: 'tool', callId: 'call-stage-01' }, toolCallId: 'call-stage-01', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.' }] } } })
  assert.equal(verifyStageToolHistory(log, []), true)
  assert.deepEqual(deriveStageToolHistory(log, graph), [])
  assert.throws(() => verifyStageToolHistory(log, history()))
  const forged = structuredClone(log); forged[2].data.message.id = 'other'
  assert.throws(() => verifyStageToolHistory(forged, []))
  const altered = structuredClone(log); altered[2].data.message.content[0].text = 'not started'
  assert.throws(() => verifyStageToolHistory(altered, []))
})
test('写入后工具结果丢失仅允许可核对的中断记录降级，不能确认该阶段', () => {
  const log = transcript()
  log[3] = { type: 'tool/result', surfaceOp: 'append', seq: 25, sourceEventSeqs: [24], data: { error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }, message: { id: 'interrupted-tool-result-call-stage-01-25', source: { kind: 'tool', callId: 'call-stage-01' }, toolCallId: 'call-stage-01', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.' }] } } }
  assert.throws(() => verifyStageToolHistory(log, history()))
  assert.deepEqual(interruptedStageRecovery(log, graph, history()), { confirmed: [] })
  assert.throws(() => interruptedStageRecovery(log, graph, []))
  assert.throws(() => interruptedStageRecovery(log, graph, [{ ...history()[0], evidence: [99] }]))
  const forged = structuredClone(log); forged[3].sourceEventSeqs = [23]
  assert.throws(() => interruptedStageRecovery(forged, graph, history()))
  const foreign = structuredClone(log); foreign.push({ type: 'tool/ptc-dispatch' })
  assert.throws(() => interruptedStageRecovery(foreign, graph, history()))
  const mixed = structuredClone(log)
  mixed[1].data.message.content.unshift({ type: 'text', text: '这段文本未必对玩家展示。' })
  assert.equal(verifyStageToolHistory(mixed, []), true)
  assert.throws(() => interruptedStageRecovery(mixed, graph, history()), /混合隐藏叙述/)
})
test('工具已启动但尚未写入时，中断后可从原阶段重试且不重复计数', () => {
  const log = transcript()
  log[3] = { type: 'tool/result', surfaceOp: 'append', seq: 25, sourceEventSeqs: [24], data: { error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }, message: { id: 'interrupted-tool-result-call-stage-01-25', source: { kind: 'tool', callId: 'call-stage-01' }, toolCallId: 'call-stage-01', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.' }] } } }
  assert.equal(verifyStageToolHistory(log, []), true)
  assert.deepEqual(deriveStageToolHistory(log, graph), [])
  const retry = transcript().slice(1)
  retry[0].seq = 26
  retry[0].data.message.content[0].id = 'retry'
  retry[1].seq = 27
  retry[1].data.callId = 'retry'
  retry[2].seq = 28
  retry[2].data.message.toolCallId = 'retry'
  retry[2].data.message.source.callId = 'retry'
  log.push(...retry)
  assert.equal(verifyStageToolHistory(log, history()), true)
  assert.deepEqual(deriveStageToolHistory(log, graph), history())
})
test('实际 DSH 恢复器生成的中断记录可进入保守恢复', { skip: !process.env.TRPG_DSH_SESSION_MODULE }, async () => {
  const { interruptedTurnClosers } = await import(process.env.TRPG_DSH_SESSION_MODULE)
  const items = transcript().slice(0, 3)
  items[1].data.turn = 1; items[1].data.step = 1
  items[2].data.turn = 1; items[2].data.step = 1
  items.forEach(event => { event.time = 0 })
  const log = [{ type: 'turn/start', seq: 20, time: 0, data: { turn: 1 } }, { type: 'step/start', seq: 21, time: 0, data: { turn: 1, step: 1 } }, ...items]
  log.push(...interruptedTurnClosers(log))
  assert.deepEqual(interruptedStageRecovery(log, graph, history()), { confirmed: [] })
  const notStarted = log.slice(0, 4)
  notStarted.push(...interruptedTurnClosers(notStarted))
  assert.equal(verifyStageToolHistory(notStarted, []), true)
})
test('评委设备从本组原始记录重建阶段调用，不把工具内容当成游玩对话', () => {
  const log = transcript()
  log.push({ type: 'assistant/message', surfaceOp: 'append', seq: 26, data: { message: { content: [{ type: 'text', text: '欢迎第一天来上班。' }] } } })
  assert.deepEqual(deriveStageToolHistory(log, graph), history())
  const data = Buffer.from(log.map(JSON.stringify).join('\n'))
  const result = inspectDialogue(data, '第一组', { stageGraph: graph })
  assert.deepEqual(result.recordIds, ['记录 22', '记录 26'])
  assert.match(result.dialogue, /欢迎第一天来上班/)
  assert.doesNotMatch(result.dialogue, /trpg_transition|已确认进入|call-stage-01/)
  assert.throws(() => inspectDialogue(data, '第一组'))
  const corrupted = transcript(); corrupted[2].data.name = 'bash'
  assert.throws(() => inspectDialogue(Buffer.from(corrupted.map(JSON.stringify).join('\n')), '第一组', { stageGraph: graph }), /阶段工具记录/)
})

test('阶段局的两组记录分别解析，证据和工具内容不跨组混入', () => {
  const first = transcript()
  first.push({ type: 'assistant/message', surfaceOp: 'append', seq: 26, data: { message: { content: [{ type: 'text', text: '第一组到达岗位。' }] } } })
  const second = transcript()
  const secondText = '我下周二正式入职'
  second[0].data.content[0].text = secondText
  const secondArgs = JSON.stringify({ transition: 'join', expectedRevision: 0, quotes: [secondText] })
  second[1].data.message.content[0].arguments = secondArgs
  second[2].data.arguments = secondArgs
  second.push({ type: 'assistant/message', surfaceOp: 'append', seq: 26, data: { message: { content: [{ type: 'text', text: '第二组到达岗位。' }] } } })
  const parse = (log, name) => inspectDialogue(Buffer.from(log.map(JSON.stringify).join('\n')), name, { stageGraph: graph })
  const a = parse(first, '第一组'), b = parse(second, '第二组')
  assert.match(a.dialogue, /第一组到达岗位/)
  assert.doesNotMatch(a.dialogue, /第二组到达岗位|下周二|trpg_transition/)
  assert.match(b.dialogue, /第二组到达岗位/)
  assert.doesNotMatch(b.dialogue, /第一组到达岗位|下周一|trpg_transition/)
  assert.deepEqual(a.recordIds, ['记录 22', '记录 26'])
  assert.deepEqual(b.recordIds, ['记录 22', '记录 26'])
  // Relative IDs may coincide across devices; references are scoped to the
  // corresponding group's own input, not evidence of shared state.
  assert.deepEqual(deriveStageToolHistory(first, graph), history())
  assert.deepEqual(deriveStageToolHistory(second, graph), history())
})
