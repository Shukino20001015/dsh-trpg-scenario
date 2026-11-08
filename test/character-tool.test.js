import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCharacterConfig } from '../character-state.js'
import { createCharacterRuntime } from '../character-tool.js'

const config = parseCharacterConfig(JSON.stringify({ version: 1, fields: [{ id: 'energy', label: '精力', initial: '有些疲惫' }] }))
const session = 'session-00000000-0000-0000-0000-000000000001'
const hash = 'a'.repeat(64)
const message = '和小林聊过之后，他终于放松了一点。'
const request = { expectedRevision: 0, field: 'energy', value: '有所放松', quotes: [message] }
const makeAgent = () => ({ session: { id: session, log: [{ type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { message: { content: [{ type: 'text', text: message }] } } }] } })

test('只允许本会话引用可见对话更新，错误不暴露文件路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trpg-character-tool-'))
  try {
    const agent = makeAgent(), runtime = await createCharacterRuntime({ root, session, hash, config, agent })
    const rejected = await runtime.definition.execute(request, { agent: makeAgent() })
    assert.equal(rejected.ok, false)
    assert.doesNotMatch(rejected.message, /\/tmp/)
    assert.equal((await runtime.definition.execute(request, { agent })).ok, true)
    assert.equal(runtime.current().values.energy, '有所放松')
    assert.match(runtime.prompt(), /有所放松/)
    const duplicate = await runtime.definition.execute(request, { agent })
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.message, /本回合不要重试/)
    assert.match(duplicate.message, /不要重复已有叙述/)
    const resumed = await createCharacterRuntime({ root, session, hash, config, agent, resume: true })
    assert.equal(resumed.current().revision, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同一工具调用混入可能未显示的叙事时拒绝写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trpg-character-mixed-'))
  try {
    const agent = makeAgent(), runtime = await createCharacterRuntime({ root, session, hash, config, agent })
    agent.session.log.push({ type: 'assistant/message', surfaceOp: 'append', seq: 4, data: { message: { content: [{ type: 'text', text: '未显示的剧情。' }, { type: 'tool-call', name: 'trpg_update_character' }] } } })
    assert.equal((await runtime.definition.execute(request, { agent })).ok, false)
    assert.equal(runtime.current().revision, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
