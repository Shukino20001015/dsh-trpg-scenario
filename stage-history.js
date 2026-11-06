import { advanceStage, resolveEvidenceQuotes, stageDialogueEvidence } from './stage-graph.js'
import { advanceCharacterState } from './character-state.js'

// Verify a staged session's tool transcript against its separately persisted
// history. This checks structural consistency, not truth, tamper resistance or
// whether the cited words semantically satisfy a transition condition.
function scanStageToolHistory(log, onSuccess, onUnknown = () => {}, onCharacter = null, onCharacterUnknown = null) {
  if (!Array.isArray(log)) throw new Error('阶段历史不可核对')
  const pending = new Map(), invoked = new Set(), finished = new Set()
  let success = 0
  for (let index = 0; index < log.length; index++) {
    const event = log[index]
    if (typeof event?.type === 'string' && event.type.startsWith('tool/') && !['tool/call', 'tool/result'].includes(event.type)) throw new Error('存在不允许的工具记录')
    if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content || []) {
        if (!['tool-call', 'tool_call'].includes(block?.type)) continue
        if (block.type !== 'tool-call' || (block.name !== 'trpg_transition' && !(onCharacter && block.name === 'trpg_update_character')) || typeof block.id !== 'string' || !block.id || pending.has(block.id) || finished.has(block.id)) throw new Error('存在不允许或重复的工具调用')
        const mixedText = (event.data?.message?.content || []).some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
        let args
        try { args = JSON.parse(block.arguments) } catch { throw new Error('阶段工具参数损坏') }
        pending.set(block.id, { args, argumentText: block.arguments, index, name: block.name, mixedText })
      }
    }
    if (event?.type === 'tool/call') {
      const id = event.data?.callId, item = pending.get(id)
      if (!item || invoked.has(id) || event.data?.name !== item.name || item.argumentText !== event.data?.arguments) throw new Error('阶段工具调用不匹配')
      invoked.add(id)
      item.callSeq = event.seq
    }
    if (event?.type === 'tool/result') {
      const message = event.data?.message, id = message?.toolCallId, item = pending.get(id)
      // DSH closes an interrupted, not-yet-started call with a canonical
      // synthetic error result, without a preceding tool/call event. It is not
      // proof of a transition and must not make the session unusable. Accept
      // only the exact platform identity and wording, not arbitrary results.
      const notStartedRepair = !invoked.has(id) && event.surfaceOp === 'append' && event.sourceEventSeqs === undefined && Number.isSafeInteger(event.seq) && message?.id === `interrupted-tool-result-${id}-${event.seq}` && message?.isError === true && event.data?.error?.name === 'ToolNotStartedError' && event.data?.error?.code === 'TOOL_NOT_STARTED' && message?.content?.length === 1 && message.content[0]?.type === 'text' && message.content[0]?.text === 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
      if (!item || (!invoked.has(id) && !notStartedRepair) || finished.has(id) || message?.source?.kind !== 'tool' || message.source.callId !== id || typeof message.isError !== 'boolean' || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string') throw new Error('阶段工具结果不匹配')
      if (message.isError === true && event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
        const canonical = event.surfaceOp === 'append' && Number.isSafeInteger(event.seq) && Number.isSafeInteger(item.callSeq) && message.id === `interrupted-tool-result-${id}-${event.seq}` && event.data.error.name === 'ToolOutcomeUnknownError' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1 && event.sourceEventSeqs[0] === item.callSeq && message.content[0].text === 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
        if (!canonical) throw new Error('阶段工具中断记录无效')
        if (item.name === 'trpg_update_character') {
          if (!onCharacterUnknown) throw new Error('主角状态工具结果不确定，不能恢复')
          onCharacterUnknown({ args: item.args, events: stageDialogueEvidence(log.slice(0, item.index)) })
        } else onUnknown({ args: item.args, events: stageDialogueEvidence(log.slice(0, item.index)), revision: success + 1, mixedText: item.mixedText })
      }
      if (message.isError !== true) {
        let result
        try { result = JSON.parse(message.content[0].text) } catch { throw new Error('阶段工具结果损坏') }
        if (typeof result?.ok !== 'boolean' || typeof result?.message !== 'string') throw new Error('阶段工具结果无效')
        if (result.ok) {
          // Neither runtime can commit a call mixed with text that DSH may
          // hide. Replaying it as successful would accept a history the real
          // gate forbids, even when its quotation points to older visible text.
          // A recorded failure remains safe and must not prevent recovery.
          if (item.mixedText) throw new Error('成功工具调用混合隐藏叙述')
          const events = stageDialogueEvidence(log.slice(0, item.index))
          const evidence = resolveEvidenceQuotes(item.args?.quotes, events)
          if (item.name === 'trpg_update_character') onCharacter({ args: item.args, evidence, events })
          else { onSuccess({ args: item.args, evidence, events, revision: success + 1 }); success++ }
        }
      }
      pending.delete(id)
      finished.add(id)
    }
  }
  if (pending.size) throw new Error('阶段工具记录不完整')
  return success
}

// Validate only the structurally confirmed dual-tool history when tracking has
// already been suspended. Unknown outcomes are never promoted to successes.
export function deriveCombinedToolHistory(log, graph, config, onUnknown = () => {}) {
  let stages = [], character = []
  scanStageToolHistory(log, ({ args, evidence, events }) => {
    stages = advanceStage(graph, stages, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events).history
  }, () => onUnknown('stage'), ({ args, events }) => {
    character = advanceCharacterState(config, character, args, events).history
  }, () => onUnknown('character'))
  return { stages, character }
}

// New staged/character sessions may contain precisely two scoped tools. Replay
// both against their frozen definitions and compare with both sidecars; never
// permit unknown tools or treat a model's claimed result as semantic proof.
export function verifyCombinedToolHistory(log, graph, stageHistory, config, characterHistory) {
  if (!Array.isArray(stageHistory) || !Array.isArray(characterHistory)) throw new Error('跑团历史不可核对')
  let stages = [], character = []
  scanStageToolHistory(log, ({ args, evidence, events }) => {
    stages = advanceStage(graph, stages, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events).history
  }, () => { throw new Error('阶段工具结果不确定，不能恢复') }, ({ args, events }) => {
    character = advanceCharacterState(config, character, args, events).history
  })
  if (JSON.stringify(stages) !== JSON.stringify(stageHistory) || JSON.stringify(character) !== JSON.stringify(characterHistory)) throw new Error('跑团工具记录与保存状态不一致')
  return true
}

export function verifyStageToolHistory(log, history) {
  if (!Array.isArray(history)) throw new Error('阶段历史不可核对')
  const count = scanStageToolHistory(log, ({ args, evidence, revision }) => {
    const entry = history[revision - 1]
    if (!entry || entry.transition !== args.transition || args.expectedRevision !== revision - 1 || entry.revision !== revision || JSON.stringify(entry.evidence) !== JSON.stringify(evidence)) throw new Error('阶段记录与工具结果不一致')
  })
  if (count !== history.length) throw new Error('阶段工具记录与保存状态不一致')
  return true
}

// A crash can leave one sidecar revision durably written while DSH records an
// unknown tool outcome. Only this tightly matched case may continue without a
// gate; arbitrary corrupt or foreign-tool history remains rejected. Never
// treat the unconfirmed write as a successful transition.
export function interruptedStageRecovery(log, graph, history) {
  if (!Array.isArray(history)) throw new Error('阶段历史不可核对')
  let confirmed = [], unknown = null
  scanStageToolHistory(log, ({ args, evidence, events }) => {
    if (unknown) throw new Error('中断后存在其他阶段转换')
    confirmed = advanceStage(graph, confirmed, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events).history
  }, ({ args, events, mixedText }) => {
    if (unknown) throw new Error('存在多个未确认阶段转换')
    if (mixedText) throw new Error('中断工具调用混合隐藏叙述，不能推断已写入')
    const evidence = resolveEvidenceQuotes(args?.quotes, events)
    unknown = advanceStage(graph, confirmed, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events).history
  })
  if (!unknown || history.length !== confirmed.length + 1 || JSON.stringify(history) !== JSON.stringify(unknown)) throw new Error('阶段中断记录与状态不一致')
  return { confirmed }
}

// Judge devices have the frozen graph and exported log, but not the play
// device's private state files. Rebuild only structural transition history;
// the resulting labels are not proof that events or outcomes are true.
export function deriveStageToolHistory(log, graph, onUnknown = () => {}) {
  let history = []
  scanStageToolHistory(log, ({ args, evidence, events }) => {
    history = advanceStage(graph, history, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events).history
  }, () => onUnknown('stage'))
  return history
}
