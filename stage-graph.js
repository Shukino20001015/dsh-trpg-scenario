// Scenario-provided graph is untrusted data. Validation here checks structure,
// not whether a cited dialogue actually proves a transition.
const ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_TEXT = 1000
const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT
const isId = value => typeof value === 'string' && ID.test(value)
const only = (obj, allowed) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => allowed.includes(k))

export function parseStageGraph(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 131072) throw new Error('阶段配置过大或格式无效')
  let graph
  try { graph = JSON.parse(source) } catch { throw new Error('阶段配置不是有效 JSON') }
  if (!only(graph, ['version', 'goal', 'initial', 'stages', 'transitions']) || graph.version !== 1 || !isText(graph.goal) || !isId(graph.initial) || !Array.isArray(graph.stages) || graph.stages.length < 1 || graph.stages.length > 32 || !Array.isArray(graph.transitions) || graph.transitions.length > 128) throw new Error('阶段配置结构无效')
  const ids = new Set()
  for (const stage of graph.stages) {
    if (!only(stage, ['id', 'name', 'instruction']) || !isId(stage.id) || ids.has(stage.id) || !isText(stage.name) || stage.name.length > 80 || !isText(stage.instruction)) throw new Error('阶段定义无效或重复')
    ids.add(stage.id)
  }
  if (!ids.has(graph.initial)) throw new Error('初始阶段不存在')
  const transitions = new Set()
  for (const transition of graph.transitions) {
    if (!only(transition, ['id', 'from', 'to', 'condition']) || !isId(transition.id) || transitions.has(transition.id) || !ids.has(transition.from) || !ids.has(transition.to) || transition.from === transition.to || !isText(transition.condition)) throw new Error('阶段转换无效或重复')
    transitions.add(transition.id)
  }
  const reachable = new Set([graph.initial])
  let previous
  do {
    previous = reachable.size
    for (const edge of graph.transitions) if (reachable.has(edge.from)) reachable.add(edge.to)
  } while (reachable.size !== previous)
  if (reachable.size !== ids.size) throw new Error('阶段网络包含不可到达的阶段')
  return graph
}

// events are trusted, host-provided normalized conversation positions, not
// model-provided text. Caller must scope them to the current session.
export function validateTransition(graph, state, request, events) {
  if (!only(request, ['transition', 'expectedRevision', 'evidence']) || !isId(request.transition) || !Number.isSafeInteger(request.expectedRevision) || !Array.isArray(request.evidence) || request.evidence.length < 1 || request.evidence.length > 8 || new Set(request.evidence).size !== request.evidence.length || request.evidence.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('阶段申请格式无效')
  if (!state || !isId(state.current) || !Number.isSafeInteger(state.revision) || state.revision !== request.expectedRevision) throw new Error('阶段已变化，请重新核对')
  const edge = graph.transitions.find(item => item.id === request.transition)
  if (!edge || edge.from !== state.current) throw new Error('当前阶段不允许该转换')
  if (!Array.isArray(events) || request.evidence.some(n => !events.some(event => event.seq === n && (event.role === 'user' || event.role === 'assistant')))) throw new Error('证据不属于本局对话')
  return { from: edge.from, to: edge.to, transition: edge.id, evidence: [...request.evidence], revision: state.revision + 1 }
}

// The model sees dialogue text but not necessarily the host event sequence.
// Resolve its exact quotation against the current session's normalized text;
// never accept a model-supplied sequence number as evidence of its own accord.
// An ambiguous quote must not silently select the wrong occurrence.
export function resolveEvidenceQuotes(quotes, events) {
  if (!Array.isArray(quotes) || quotes.length < 1 || quotes.length > 8 || new Set(quotes).size !== quotes.length || quotes.some(q => typeof q !== 'string' || q.trim() !== q || q.length < 8 || q.length > 200)) throw new Error('证据引用格式无效')
  if (!Array.isArray(events) || events.length > 100000) throw new Error('本局对话不可用')
  const resolved = []
  for (const quote of quotes) {
    const matches = events.filter(event => Number.isSafeInteger(event.seq) && event.seq >= 0 && (event.role === 'user' || event.role === 'assistant') && typeof event.text === 'string' && event.text.includes(quote))
    if (matches.length !== 1) throw new Error('证据未找到或存在歧义，请引用本局唯一原文')
    if (!resolved.includes(matches[0].seq)) resolved.push(matches[0].seq)
  }
  return resolved
}

// Extract only completed, original player/host text from the host's current
// session log. Runtime snapshots, compacted replacements, tool calls/results,
// interrupted model output and malformed/non-text messages are never proof.
// Callers must still make sure `log` belongs to the active session.
export function stageDialogueEvidence(log) {
  if (!Array.isArray(log) || log.length > 100000) throw new Error('本局对话不可用')
  const aborted = new Set(log.filter(e => e?.type === 'turn/end' && e.data?.reason?.kind === 'aborted' && Number.isSafeInteger(e.data?.turn)).map(e => e.data.turn))
  const result = []
  let lastSeq = -1
  for (const event of log) {
    if (!event || event.surfaceOp !== 'append' || !['user/message', 'assistant/message'].includes(event.type)) continue
    const user = event.type === 'user/message'
    if (user && event.data?.source?.kind !== 'user') continue
    if (!user && (event.data?.message?.interrupted === true || aborted.has(event.data?.turn))) continue
    const blocks = user ? event.data?.content : event.data?.message?.content
    // DSH may hide pre-tool text in a mixed assistant message in its normal
    // conversation view. Do not use it as player-visible stage evidence.
    if (!Array.isArray(blocks) || blocks.some(block => !block || !['text', ...(!user ? ['reasoning'] : [])].includes(block.type) || (block.type === 'text' && typeof block.text !== 'string'))) continue
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (!text.trim()) continue
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) throw new Error('本局对话编号无效')
    lastSeq = event.seq
    result.push({ seq: event.seq, role: user ? 'user' : 'assistant', text })
  }
  return result
}

export function initialStageState(graph) {
  return { current: graph.initial, revision: 0, history: [] }
}

// History must be derived from the saved scenario graph, not trusted as a
// display list. Replaying validates every edge and monotonically increasing
// revision, so corrupt or mismatched state is never silently presented.
export function restoreStageState(graph, history) {
  if (!Array.isArray(history) || history.length > 10000) throw new Error('阶段历史无效')
  const state = initialStageState(graph)
  for (const item of history) {
    if (!only(item, ['from', 'to', 'transition', 'evidence', 'revision']) || !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 8 || item.evidence.some(n => !Number.isSafeInteger(n) || n < 0) || new Set(item.evidence).size !== item.evidence.length || item.revision !== state.revision + 1 || item.from !== state.current) throw new Error('阶段历史损坏')
    const edge = graph.transitions.find(candidate => candidate.id === item.transition)
    if (!edge || edge.from !== item.from || edge.to !== item.to) throw new Error('阶段历史与剧本不匹配')
    state.current = item.to
    state.revision = item.revision
    state.history.push({ ...item, evidence: [...item.evidence] })
  }
  return state
}

export function advanceStage(graph, history, request, events) {
  const state = restoreStageState(graph, history)
  const entry = validateTransition(graph, state, request, events)
  return { current: entry.to, revision: entry.revision, history: [...state.history, entry] }
}

// Never expose the graph, conditions, instructions, or future stage labels.
export function publicStageState(graph, history) {
  const state = restoreStageState(graph, history)
  const byId = new Map(graph.stages.map(stage => [stage.id, stage.name]))
  return { goal: graph.goal, current: byId.get(state.current), visited: [graph.initial, ...state.history.map(item => item.to)].map(id => byId.get(id)) }
}
