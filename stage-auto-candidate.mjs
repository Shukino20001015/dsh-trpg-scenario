// Experimental automatic discovery. It creates only a candidate, never writes
// a stage. Callers must bind the candidate to the current session and recheck
// the complete transcript and revision before presenting or committing it.
import { reviewStageTransition } from './stage-semantic-review.mjs'
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).sort().join(',')===[...keys].sort().join(',')

export async function discoverStageCandidate({graph,state,events,extract,review,signal,timeoutMs=45000}) {
 if (!graph || !Array.isArray(graph.transitions) || !state || !Number.isSafeInteger(state.revision) || state.revision<0 || !Array.isArray(events) || typeof extract!=='function' || typeof review!=='function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000) return {status:'incomplete',reason:'invalid-input'}
 let copy
 try { copy=structuredClone({graph,state,events}) } catch { return {status:'incomplete',reason:'invalid-input'} }
 const transitions=copy.graph.transitions.filter(e=>e.from===copy.state.current)
 if (transitions.some(e=>typeof e.id!=='string'||typeof e.condition!=='string'||!e.condition.trim()||e.condition.length>1000)) return {status:'incomplete',reason:'invalid-input'}
 let prev=-1
 if (copy.events.some(e=>{if(!Number.isSafeInteger(e?.seq)||e.seq<=prev||!['user','assistant'].includes(e.role)||typeof e.text!=='string'||!e.text.trim()||e.text.length>20000) return true;prev=e.seq;return false}) || JSON.stringify(copy.events).length>40000) return {status:'incomplete',reason:'invalid-history'}
 if (!transitions.length) return {status:'no-candidate'}
 const controller=new AbortController(), cancel=()=>controller.abort()
 if(signal?.aborted) controller.abort(); else signal?.addEventListener('abort',cancel,{once:true})
 const timer=setTimeout(cancel,timeoutMs)
 try {
  if(controller.signal.aborted) return {status:'incomplete',reason:'aborted'}
  const aborted=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({aborted:true}),{once:true}))
  let output
  try {
   output=await Promise.race([Promise.resolve().then(()=>controller.signal.aborted?undefined:extract({transitions:transitions.map(({id,condition})=>({id,condition})),dialogue:copy.events.map(({seq,role,text})=>({seq,role,text}))},controller.signal)).then(value=>({value})),aborted])
  } catch { return {status:'incomplete',reason:'extract-error'} }
  if(output.aborted||controller.signal.aborted) return {status:'incomplete',reason:signal?.aborted?'aborted':'timeout'}
  const proposal=output.value
  if(!exact(proposal,['transition','quotes']) || !(proposal.transition===null || typeof proposal.transition==='string') || !Array.isArray(proposal.quotes)) return {status:'incomplete',reason:'invalid-output'}
  if(proposal.transition===null) return proposal.quotes.length ? {status:'incomplete',reason:'invalid-output'} : {status:'no-candidate'}
  if(!transitions.some(e=>e.id===proposal.transition)) return {status:'incomplete',reason:'invalid-output'}
  const result=await reviewStageTransition({graph:copy.graph,state:copy.state,events:copy.events,request:{transition:proposal.transition,expectedRevision:copy.state.revision,quotes:proposal.quotes},review,signal:controller.signal,timeoutMs})
  if(result.status!=='candidate') return {status:'incomplete',reason:result.reason}
  return result
 } finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); controller.abort() }
}
