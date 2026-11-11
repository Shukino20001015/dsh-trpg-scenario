// Experimental discovery only: no state writes. A caller must recheck the
// current session, evidence and revision, and use the regular character tool.
import { prepareCharacterDelta } from './character-delta.mjs'
import { prepareCharacterCorrection } from './character-correction.mjs'
import { hasUnsupportedKinship } from './character-fact-guard.mjs'
const exact=(x,keys)=>x && typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',')

export async function discoverCharacterCandidate({config,state,events,extract,review,signal,excluded=[],timeoutMs=60000}) {
 if(!Array.isArray(config?.fields)||!config.fields.length||!Number.isSafeInteger(state?.revision)||state.revision<0||!Array.isArray(events)||!Array.isArray(excluded)||excluded.length>16||excluded.some(x=>!x||typeof x.field!=='string'||!Number.isSafeInteger(x.evidence)||x.evidence<0)||typeof extract!=='function'||typeof review!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000) return {status:'incomplete',reason:'invalid-input'}
 let frozen
 try {frozen=structuredClone({config,state,events})} catch {return {status:'incomplete',reason:'invalid-input'}}
 const fields=frozen.config.fields.map(({id,label})=>({id,label,value:frozen.state.values?.[id]}))
 if(fields.some(f=>typeof f.id!=='string'||typeof f.label!=='string'||typeof f.value!=='string')) return {status:'incomplete',reason:'invalid-input'}
 let previous=-1
 if(frozen.events.some(e=>{if(!Number.isSafeInteger(e?.seq)||e.seq<=previous||!['user','assistant'].includes(e.role)||typeof e.text!=='string'||!e.text.trim()||e.text.length>20000)return true;previous=e.seq;return false})||JSON.stringify(frozen.events).length>120000) return {status:'incomplete',reason:'invalid-history'}
 if(!frozen.events.length)return {status:'incomplete',reason:'no-evidence'}
 const controller=new AbortController(),cancel=()=>controller.abort()
 if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',cancel,{once:true})
 const timer=setTimeout(cancel,timeoutMs)
 try {
  if(controller.signal.aborted)return {status:'incomplete',reason:'aborted'}
  const aborted=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({aborted:true}),{once:true}))
  let output
  try {output=await Promise.race([Promise.resolve().then(()=>controller.signal.aborted?undefined:extract({fields,dialogue:frozen.events,excluded},controller.signal)).then(value=>({value})),aborted])}catch{return {status:'incomplete',reason:'extract-error'}}
  if(output.aborted||controller.signal.aborted)return {status:'incomplete',reason:signal?.aborted?'aborted':'timeout'}
  if(!exact(output.value,['updates'])||!Array.isArray(output.value.updates)||output.value.updates.length>4)return {status:'incomplete',reason:'invalid-output'}
  if(!output.value.updates.length)return {status:'no-candidate'}
  const items=output.value.updates
  if(items.some(item=>!item||!['add','correct'].includes(item.operation)||!exact(item,item.operation==='add'?['operation','field','addition','quote']:['operation','field','oldText','newText','quote'])||typeof item.field!=='string')||new Set(items.map(item=>item.field)).size!==items.length)return {status:'incomplete',reason:'invalid-output'}
  const results=await Promise.all(items.map(async item=>{
   const {operation,...suggestion}=item
   const prepare=operation==='add'?prepareCharacterDelta:prepareCharacterCorrection
   // A stalled review of one field must not consume the entire shared job
   // budget and discard other independently accepted candidates.
   const checked=await prepare({config:frozen.config,state:frozen.state,events:frozen.events,suggestion,signal:controller.signal,timeoutMs:Math.min(timeoutMs,60000),review:(input,innerSignal)=>review({...input,dialogue:frozen.events},innerSignal)})
   if(checked.status==='candidate' && excluded.some(x=>x.field===checked.field&&x.evidence===checked.evidence))return {status:'not-ready',reason:'recently-delivered'}
   const citedHost=frozen.events.find(event=>event.seq===checked.evidence&&event.role==='assistant')
   if(checked.status==='candidate' && hasUnsupportedKinship(frozen.state.values[checked.field],checked.value,citedHost?[citedHost.text]:[]))return {status:'not-ready',reason:'unsupported-kinship'}
   return checked
  }))
  if(controller.signal.aborted)return {status:'incomplete',reason:signal?.aborted?'aborted':'timeout'}
  // An out-of-date value can contradict the story; resolve it before an
  // optional addition. Within the same operation preserve chronological order.
  const candidates=results.map((result,index)=>({result,operation:items[index].operation})).filter(({result})=>result.status==='candidate').sort((a,b)=>(a.operation==='correct'?0:1)-(b.operation==='correct'?0:1)||a.result.evidence-b.result.evidence)
  return candidates[0]?.result || {status:'incomplete',reason:results[0]?.reason||'invalid-output'}
 } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort()}
}
