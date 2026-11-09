import { resolveEvidenceQuotes, validateTransition } from './stage-graph.js'

// V2 journal entries retain the original transition and append a correction.
// Quotation and ordering checks establish provenance, not semantic truth.
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const evidenceValid = evidence => Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 8 && evidence.every(n => Number.isSafeInteger(n) && n >= 0) && new Set(evidence).size === evidence.length
const transitionKeys = ['from', 'to', 'transition', 'evidence', 'revision']
const correctionKeys = ['kind', 'revision', 'targetRevision', 'from', 'to', 'evidence']

export function replayStageJournal(graph, journal) {
  if (!Array.isArray(journal) || journal.length > 10000) throw new Error('阶段历史无效')
  let current = graph.initial, revision = 0
  for (const item of journal) {
    if (!evidenceValid(item?.evidence) || item.revision !== revision + 1 || item.from !== current) throw new Error('阶段历史损坏')
    if (item.kind === 'correction') {
      const prior = journal[revision - 1]
      if (!exact(item, correctionKeys) || !prior || !exact(prior, transitionKeys) || item.targetRevision !== prior.revision || item.from !== prior.to || item.to !== prior.from || item.evidence.some(seq => seq <= Math.max(...prior.evidence))) throw new Error('阶段纠正记录无效')
    } else {
      if (!exact(item, transitionKeys)) throw new Error('阶段转换记录无效')
      const events = item.evidence.map(seq => ({ seq, role: 'assistant' }))
      const expected = validateTransition(graph, { current, revision }, { transition: item.transition, expectedRevision: revision, evidence: item.evidence }, events)
      if (expected.from !== item.from || expected.to !== item.to) throw new Error('阶段历史与剧本不匹配')
    }
    current = item.to
    revision = item.revision
  }
  return { current, revision, history: structuredClone(journal) }
}

export function prepareStageCorrection({ graph, history, events, expectedRevision, targetRevision, quotes }) {
  const state = replayStageJournal(graph, history)
  if (state.revision !== expectedRevision) throw new Error('阶段已变化，请重新核对')
  if (state.history.length >= 10000) throw new Error('阶段历史已达上限')
  const prior = state.history.at(-1)
  if (!prior || !exact(prior, transitionKeys) || targetRevision !== prior.revision) throw new Error('只能纠正最近一次阶段转换')
  // Older quotes can provide context to the reviewer, but cannot themselves
  // prove a later correction. Persist only the later evidence positions.
  const evidence = resolveEvidenceQuotes(quotes, events).filter(seq => seq > Math.max(...prior.evidence))
  if (!evidence.length) throw new Error('阶段纠正记录无效')
  const entry = { kind: 'correction', revision: state.revision + 1, targetRevision, from: prior.to, to: prior.from, evidence }
  return replayStageJournal(graph, [...state.history, entry])
}

// A corrected transition remains auditable in the private journal, but must
// not be presented to players as a stage they actually passed through.
export function publicStageJournalState(graph, history) {
  const state = replayStageJournal(graph, history)
  const byId = new Map(graph.stages.map(stage => [stage.id, stage.name]))
  const visited = [graph.initial]
  for (const item of state.history) {
    if (item.kind === 'correction') visited.pop()
    else visited.push(item.to)
  }
  return { goal: graph.goal, current: byId.get(state.current), visited: visited.map(id => byId.get(id)) }
}
