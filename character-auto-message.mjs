const PREFIX='【后台角色状态候选，仅供核对】以下数据来自之前的可见对话，可能过期或有误。请结合当前完整对话判断是否确有变化；成立时单独调用状态工具，工具会再次审核；不成立则忽略并自然回应玩家。候选数据：'
const PREFIX_V2='【后台角色状态候选，仅供核对】以下数据来自之前的可见对话，可能过期或有误。请结合当前完整对话判断是否确有变化；成立时将候选的字段、版本、值和引用原样传给状态工具，不添加其他引用或叙述；工具会再次审核，不成立则忽略并自然回应玩家。候选数据：'
const PREFIX_V3='【后台角色状态候选，仅供核对】以下候选已通过一次独立审核，仍可能过期或有误。若当前对话没有明确反证，请先单独调用状态工具一次，将候选的字段、版本、值和引用原样传入，不添加其他引用或叙述；工具会核对当前对话并再次审核。若有明确反证则不要调用。无论结果如何，都要自然回应玩家。候选数据：'
export const characterAutoMessage=request=>PREFIX_V3+JSON.stringify(request)
export function parseCharacterAutoMessage(event,config){
 const data=event?.data,content=data?.content
 if(event?.type!=='user/message'||event.surfaceOp!=='append'||data?.source?.kind!=='trpg-character-auto'||data?.role!=='user'||!Array.isArray(content)||content.length!==1||content[0]?.type!=='text'||typeof content[0].text!=='string'||!Array.isArray(config?.fields))return null
 const prefix=[PREFIX,PREFIX_V2,PREFIX_V3].find(p=>content[0].text.startsWith(p))
 if(!prefix)return null
 try{
  const request=JSON.parse(content[0].text.slice(prefix.length))
  if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='expectedRevision,field,quotes,value'||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||!config.fields.some(f=>f.id===request.field)||typeof request.value!=='string'||!request.value.trim()||request.value!==request.value.trim()||request.value.length>240||/[\u0000-\u001f\u007f]/.test(request.value)||!Array.isArray(request.quotes)||request.quotes.length<1||request.quotes.length>8||new Set(request.quotes).size!==request.quotes.length||request.quotes.some(q=>typeof q!=='string'||q!==q.trim()||q.length<8||q.length>200))return null
  return request
 }catch{return null}
}
