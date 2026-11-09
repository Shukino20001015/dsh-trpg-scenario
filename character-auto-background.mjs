import {createHash} from 'node:crypto'
import {discoverCharacterCandidate} from './character-auto-candidate.mjs'
const digest=events=>createHash('sha256').update(JSON.stringify(events)).digest('hex')
function visible(events){
 if(!Array.isArray(events)||!events.length||events.length>100000)throw Error('invalid history')
 let prev=-1
 return events.map(e=>{if(!Number.isSafeInteger(e?.seq)||e.seq<=prev||!['user','assistant'].includes(e.role)||typeof e.text!=='string'||!e.text.trim())throw Error('invalid history');prev=e.seq;return {seq:e.seq,role:e.role,text:e.text}})
}
export function createCharacterAutoBackground({extract,review,timeoutMs=90000,maxSessions=8}){
 if(typeof extract!=='function'||typeof review!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>100)throw Error('invalid background settings')
 const jobs=new Map();let closed=false
 function cancel(session){const job=jobs.get(session);if(!job)return false;jobs.delete(session);clearTimeout(job.timer);job.controller.abort();return true}
 function start({session,config,state,events}){
  if(closed||typeof session!=='string'||!session||!Number.isSafeInteger(state?.revision)||state.revision<0||jobs.has(session)||jobs.size>=maxSessions)return false
  let frozen;try{frozen=structuredClone({config,state,events:visible(events)})}catch{return false}
  const job={revision:frozen.state.revision,lastSeq:frozen.events.at(-1).seq,anchor:digest(frozen.events),controller:new AbortController(),status:'running',deliveries:0,timer:null}
  jobs.set(session,job);job.timer=setTimeout(()=>cancel(session),timeoutMs)
  Promise.resolve().then(()=>{if(jobs.get(session)!==job||job.controller.signal.aborted)return;return discoverCharacterCandidate({...frozen,extract,review,signal:job.controller.signal,timeoutMs})}).then(result=>{
   if(jobs.get(session)!==job||job.controller.signal.aborted)return
   job.status='ready';job.result=result;clearTimeout(job.timer);job.timer=setTimeout(()=>cancel(session),timeoutMs)
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
  if(result?.status!=='candidate'||++job.deliveries>=2)cancel(session)
  return {status:'ready',result}
 }
 function close(){closed=true;for(const session of jobs.keys())cancel(session)}
 return {start,take,cancel,close}
}
