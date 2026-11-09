// Optional experimental review. A model verdict is not proof of semantic truth.
// No stage mutation: the caller must revalidate session, evidence and revision.
import { resolveEvidenceQuotes, validateTransition } from './stage-graph.js'
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',')

export async function reviewStageTransition({ graph, state, events, request, review, signal, timeoutMs = 15000 }) {
  if (signal?.aborted) return { status:'not-ready', reason:'aborted' }
  if (!exact(request,['transition','expectedRevision','quotes']) || typeof review !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return { status:'not-ready', reason:'invalid-input' }
  let frozenGraph, frozenState, frozenEvents, frozenRequest, evidence, entry
  try {
    frozenGraph=structuredClone(graph); frozenState=structuredClone(state); frozenEvents=structuredClone(events); frozenRequest=structuredClone(request)
    evidence=resolveEvidenceQuotes(frozenRequest.quotes, frozenEvents)
    entry=validateTransition(frozenGraph,frozenState,{transition:frozenRequest.transition,expectedRevision:frozenRequest.expectedRevision,evidence},frozenEvents)
  } catch { return { status:'not-ready', reason:'invalid-evidence-or-state' } }
  const edge=frozenGraph.transitions.find(e=>e.id===entry.transition)
  // An isolated quotation can be contradicted or corrected later. Review the
  // entire supplied visible history, in order; never silently truncate it and
  // claim the gate considered all available facts.
  let previous=-1
  if (!Array.isArray(frozenEvents) || frozenEvents.some(e => {
    if (!Number.isSafeInteger(e?.seq) || e.seq <= previous || !['user','assistant'].includes(e.role) || typeof e.text !== 'string' || !e.text.trim()) return true
    previous=e.seq; return false
  })) return {status:'not-ready',reason:'invalid-history'}
  const dialogue=frozenEvents.map(e=>({seq:e.seq,role:e.role,text:e.text}))
  const evidenceRecords=dialogue.filter(e=>evidence.includes(e.seq))
  if(typeof edge?.condition!=='string'||!edge.condition.trim()||edge.condition.length>1000||dialogue.some(e=>e.text.length>20000)||JSON.stringify(dialogue).length>40000) return {status:'not-ready',reason:'review-input-limit'}
  const controller=new AbortController(), cancel=()=>controller.abort()
  if(signal?.aborted) controller.abort(); else signal?.addEventListener('abort',cancel,{once:true})
  const timer=setTimeout(cancel,timeoutMs)
  try {
    if(controller.signal.aborted) return {status:'not-ready',reason:'aborted'}
    const cancelled=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({cancelled:true}),{once:true}))
    let outcome
    try {
      outcome=await Promise.race([Promise.resolve().then(()=>controller.signal.aborted?undefined:review({condition:edge.condition,dialogue,evidence:evidenceRecords,quotes:frozenRequest.quotes},controller.signal)).then(value=>({value})),cancelled])
    } catch { return {status:'not-ready',reason:'review-error'} }
    if(outcome.cancelled||controller.signal.aborted) return {status:'not-ready',reason:signal?.aborted?'aborted':'timeout'}
    if(!exact(outcome.value,['allow'])||outcome.value.allow!==true) return {status:'not-ready',reason:outcome.value?.allow===false?'rejected':'invalid-review'}
    return {status:'candidate',request:frozenRequest,evidence}
  } finally { clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort() }
}
