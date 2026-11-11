import {createHash} from 'node:crypto'
import {discoverCharacterCandidate} from './character-auto-candidate.mjs'
const digest=events=>createHash('sha256').update(JSON.stringify(events)).digest('hex')
function visible(events){
 if(!Array.isArray(events)||!events.length||events.length>100000)throw Error('invalid history')
 let prev=-1
 return events.map(e=>{if(!Number.isSafeInteger(e?.seq)||e.seq<=prev||!['user','assistant'].includes(e.role)||typeof e.text!=='string'||!e.text.trim())throw Error('invalid history');prev=e.seq;return {seq:e.seq,role:e.role,text:e.text}})
}
export function createCharacterAutoBackground({extract,review,timeoutMs=120000,readyTtlMs=1800000,maxSessions=8}){
 if(typeof extract!=='function'||typeof review!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(readyTtlMs)||readyTtlMs<1||readyTtlMs>7200000||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>100)throw Error('invalid background settings')
 const jobs=new Map(),cooldowns=new Map();let closed=false
 function cancel(session){const job=jobs.get(session);if(!job)return false;jobs.delete(session);clearTimeout(job.timer);job.controller.abort();return true}
 function start({session,config,state,events}){
  if(closed||typeof session!=='string'||!session||!Number.isSafeInteger(state?.revision)||state.revision<0)return false
  let frozen;try{frozen=structuredClone({config,state,events:visible(events)})}catch{return false}
  const previous=jobs.get(session)
  // A completed negative result describes its old snapshot only. If a new
  // turn arrived while that result was waiting, check the new dialogue now;
  // otherwise it would consume another turn before discovery can restart.
  // Keep accepted candidates and in-flight reviews on their existing path.
  if(previous){
   if(previous.status!=='ready'||previous.result?.status==='candidate'||frozen.events.at(-1).seq<=previous.lastSeq)return false
   cancel(session)
  }
  if(jobs.size>=maxSessions)return false
  let cooldown=cooldowns.get(session)
  if(cooldown&&(cooldown.revision!==frozen.state.revision||cooldown.expires<=Date.now())){cooldowns.delete(session);cooldown=null}
  const excluded=(cooldown?.items||[]).filter(item=>{const event=frozen.events.find(e=>e.seq===item.evidence);return event&&digest([event])===item.anchor}).map(({field,evidence})=>({field,evidence}))
  const job={revision:frozen.state.revision,lastSeq:frozen.events.at(-1).seq,anchor:digest(frozen.events),events:frozen.events,controller:new AbortController(),status:'running',deliveries:0,timer:null}
  jobs.set(session,job);job.timer=setTimeout(()=>cancel(session),timeoutMs)
  Promise.resolve().then(()=>{if(jobs.get(session)!==job||job.controller.signal.aborted)return;return discoverCharacterCandidate({...frozen,excluded,extract,review,signal:job.controller.signal,timeoutMs})}).then(result=>{
   if(jobs.get(session)!==job||job.controller.signal.aborted)return
   job.status='ready';job.result=result;clearTimeout(job.timer);job.timer=setTimeout(()=>cancel(session),readyTtlMs)
  }).catch(()=>{if(jobs.get(session)===job)cancel(session)})
  return true
 }
 function take({session,state,events}){
  const job=jobs.get(session);if(!job)return {status:'missing'}
  let anchor;try{anchor=digest(visible(events).filter(e=>e.seq<=job.lastSeq))}catch{anchor=''}
  if(state?.revision!==job.revision||anchor!==job.anchor){cancel(session);return {status:'stale'}}
  if(job.status!=='ready')return {status:'pending'}
  const result=job.result
  // If the narrator ignores a valid suggestion, allow one more delivery on a
  // later turn. A changed revision or prefix cancels it above, the timer bounds
  // retention, and the normal tool still rechecks the entire current dialogue.
  if(result?.status==='candidate'&&++job.deliveries>=2){
   const evidence=job.events.find(e=>e.seq===result.evidence)
   if(evidence){
    let cooldown=cooldowns.get(session)
    if(!cooldown||cooldown.revision!==job.revision||cooldown.expires<=Date.now())cooldown={revision:job.revision,expires:Date.now()+300000,items:[]}
    cooldown.items=cooldown.items.filter(item=>item.field!==result.field||item.evidence!==result.evidence)
    cooldown.items.push({field:result.field,evidence:result.evidence,anchor:digest([evidence])});cooldown.items=cooldown.items.slice(-16)
    if(!cooldowns.has(session)&&cooldowns.size>=maxSessions)cooldowns.delete(cooldowns.keys().next().value)
    cooldowns.set(session,cooldown)
   }
   cancel(session)
  }else if(result?.status!=='candidate')cancel(session)
  return {status:'ready',result}
 }
 function close(){closed=true;for(const session of jobs.keys())cancel(session);cooldowns.clear()}
 return {start,take,cancel,close}
}
