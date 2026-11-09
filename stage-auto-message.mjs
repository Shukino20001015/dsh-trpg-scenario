const PREFIX='【后台阶段候选，仅供核对】以下数据来自之前的可见对话，可能过期或有误。请结合当前完整对话判断条件是否全部成立；成立时单独调用阶段工具并引用原文，工具会再次审核；不成立则忽略并自然回应玩家。候选数据：'
export const stageAutoMessage = request => PREFIX + JSON.stringify(request)
export function parseStageAutoMessage(event,graph) {
 const data=event?.data, content=data?.content
 if(event?.type!=='user/message'||event.surfaceOp!=='append'||data?.source?.kind!=='trpg-stage-auto'||data?.role!=='user'||!Array.isArray(content)||content.length!==1||content[0]?.type!=='text'||typeof content[0].text!=='string'||!content[0].text.startsWith(PREFIX)||!Array.isArray(graph?.transitions)) return null
 try {
  const request=JSON.parse(content[0].text.slice(PREFIX.length))
  if(!request || Array.isArray(request) || Object.keys(request).sort().join(',')!=='expectedRevision,quotes,transition' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision<0 || !graph.transitions.some(e=>e.id===request.transition) || !Array.isArray(request.quotes) || request.quotes.length<1 || request.quotes.length>8 || new Set(request.quotes).size!==request.quotes.length || request.quotes.some(q=>typeof q!=='string'||q!==q.trim()||q.length<8||q.length>200)) return null
  return request
 } catch {return null}
}
