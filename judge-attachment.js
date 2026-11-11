// Read only the validated dialogue attachments belonging to this judge.
// The model cannot choose paths or access arbitrary files.
export function installJudgeAttachmentReader(agent, attachments, refs) {
  const tools = agent?.ctx?.tools
  if (!tools || typeof tools.register !== 'function' || typeof tools.restrict !== 'function' || typeof tools.guard !== 'function' || typeof tools.schemas !== 'function' || typeof attachments?.readFileStream !== 'function' || !Array.isArray(refs) || !refs.length || refs.length > 6) throw new Error('当前 DSH 不支持评分附件读取')
  const release = [], name = 'trpg_read_judge_attachment'
  try {
    release.push(tools.restrict({ allow: [] }))
    release.push(tools.guard(execution => execution?.name === name && execution?.agent === agent ? undefined : '评委会话只能读取本次评分附件。'))
    release.push(tools.register({
      name,
      description: '完整读取一份本次上传并校验过的游玩记录附件。每份附件必须各读取一次，不能根据文件名猜测内容。',
      parameters: { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'integer', minimum: 1, maximum: refs.length, description: '附件序号，从 1 开始' } } },
      output: { schema: { type: 'object', additionalProperties: false, required: ['ok', 'text'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (exec?.agent !== agent || exec?.signal?.aborted || !Number.isInteger(args?.group) || args.group < 1 || args.group > refs.length || Object.keys(args).join(',') !== 'group') return { ok: false, text: '无法读取评分附件。' }
        try {
          const chunks = []; let size = 0
          for await (const chunk of attachments.readFileStream(refs[args.group - 1], exec.signal)) {
            size += chunk.length
            if (size > 2 * 1024 * 1024) throw new Error('评分附件过大')
            chunks.push(Buffer.from(chunk))
          }
          return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
        } catch { return { ok: false, text: '读取失败或附件不完整；不能给出成绩，请重新上传。' } }
      },
    }))
    const visible = tools.schemas(agent)
    if (!Array.isArray(visible) || visible.length !== 1 || visible[0]?.name !== name) throw new Error('评委会话中存在额外工具')
    return () => { for (const stop of release.reverse()) if (typeof stop === 'function') stop() }
  } catch (error) {
    for (const stop of release.reverse()) if (typeof stop === 'function') stop()
    throw error
  }
}

// A draft is auditable only if every attached group was actually read.
export function completedJudgeAttachments(log, groupCount) {
  if (!Array.isArray(log) || !Number.isInteger(groupCount) || groupCount < 1 || groupCount > 6) return null
  const calls = new Map(), groups = new Map()
  for (const event of log) {
    if (event?.type === 'tool/call' && event.data?.name === 'trpg_read_judge_attachment' && typeof event.data.callId === 'string') {
      try {
        const args = JSON.parse(event.data.arguments)
        if (Object.keys(args).join(',') === 'group' && Number.isInteger(args.group) && args.group >= 1 && args.group <= groupCount) calls.set(event.data.callId, args.group)
      } catch { /* malformed calls cannot establish a successful read */ }
    }
    if (event?.type === 'tool/result') {
      const message = event.data?.message, group = calls.get(message?.toolCallId)
      if (!group || message?.isError || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text') continue
      try {
        const result = JSON.parse(message.content[0].text)
        if (result?.ok === true && typeof result.text === 'string' && result.text.startsWith(`【第 ${group} 份游玩记录；`)) groups.set(group, result.text)
      } catch { /* incomplete or invalid result */ }
    }
  }
  return groups.size === groupCount ? Array.from({ length: groupCount }, (_, i) => groups.get(i + 1)).join('\n\n') : null
}
