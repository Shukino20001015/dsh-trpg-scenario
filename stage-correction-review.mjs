import { prepareStageCorrection } from './stage-correction.mjs'

// Semantic review is an additional safeguard, not proof of truth. The caller
// still rechecks the dialogue and stored revision immediately before commit.
export async function reviewStageCorrection({ graph, state, events, request, review, signal }) {
  if (typeof review !== 'function' || signal?.aborted || !request || Object.keys(request).sort().join(',') !== 'action,expectedRevision,quotes,targetRevision' || request.action !== 'correct') return { allow: false }
  try {
    const frozen = structuredClone({ graph, state, events, request })
    const { graph: g, state: s, events: e, request: r } = frozen
    const candidate = prepareStageCorrection({ graph: g, history: s.history, events: e, expectedRevision: r.expectedRevision, targetRevision: r.targetRevision, quotes: r.quotes })
    const previous = s.history.at(-1)
    const edge = g.transitions.find(item => item.id === previous.transition && item.from === previous.from && item.to === previous.to)
    let last = -1
    if (!edge || typeof edge.condition !== 'string' || !edge.condition.trim() || edge.condition.length > 1000 || !Array.isArray(e) || e.some(item => {
      if (!Number.isSafeInteger(item?.seq) || item.seq <= last || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20000) return true
      last = item.seq; return false
    }) || JSON.stringify(e).length > 40000) return { allow: false }
    const ids = new Set([...previous.evidence, ...candidate.history.at(-1).evidence])
    const evidence = e.filter(item => ids.has(item.seq))
    if (evidence.length !== ids.size) return { allow: false }
    const verdict = await review({ condition: edge.condition, dialogue: e, evidence, quotes: r.quotes }, signal)
    return { allow: !signal?.aborted && !!verdict && Object.keys(verdict).join(',') === 'allow' && verdict.allow === true }
  } catch { return { allow: false } }
}
