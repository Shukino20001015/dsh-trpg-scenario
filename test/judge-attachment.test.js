import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completedJudgeAttachments, installJudgeAttachmentReader } from '../judge-attachment.js'

test('评分工具只能读取本会话指定的附件并完整返回内容', async () => {
  let definition, guard
  const agent = { ctx: { tools: {
    restrict() { return () => {} }, guard(fn) { guard = fn; return () => {} },
    register(value) { definition = value; return () => {} },
    schemas() { return [{ name: definition.name }] },
  } } }
  const attachments = { async *readFileStream(ref) { yield Buffer.from(ref.data) } }
  installJudgeAttachmentReader(agent, attachments, [{ data: '记录一' }, { data: '记录二' }])
  assert.equal(guard({ name: definition.name, agent }), undefined)
  assert.ok(guard({ name: 'shell', agent }))
  assert.ok(guard({ name: definition.name, agent: {} }))
  assert.deepEqual(await definition.execute({ group: 2 }, { agent }), { ok: true, text: '记录二' })
  assert.equal((await definition.execute({ group: 3 }, { agent })).ok, false)
  assert.equal((await definition.execute({ group: 1, path: '/secret' }, { agent })).ok, false)
  assert.equal((await definition.execute({ group: 1 }, { agent: {} })).ok, false)
})

test('仅完整成功读取所有附件后允许核验', () => {
  const call = (id, group) => ({type:'tool/call',data:{name:'trpg_read_judge_attachment',callId:id,arguments:JSON.stringify({group})}})
  const result = (id, group, ok = true) => ({type:'tool/result',data:{message:{toolCallId:id,isError:false,content:[{type:'text',text:JSON.stringify({ok,text:`【第 ${group} 份游玩记录；文件名仅供识别："组"】\n内容`})}]}}})
  const rows = [call('a',1),result('a',1),call('b',2),result('b',2)]
  assert.match(completedJudgeAttachments(rows,2),/第 2 份游玩记录/)
  assert.equal(completedJudgeAttachments(rows.slice(0,-1),2),null)
  assert.equal(completedJudgeAttachments([call('a',1),result('a',1,false)],1),null)
  assert.equal(completedJudgeAttachments([result('a',1)],1),null)
})
