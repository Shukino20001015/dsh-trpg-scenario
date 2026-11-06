import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCharacterConfig } from '../character-state.js'
import { initializeCharacterState, readCharacterState, commitCharacterUpdate } from '../character-store.js'

const config = parseCharacterConfig(JSON.stringify({ version: 1, fields: [{ id: 'energy', label: '精力', initial: '有些疲惫' }] }))
const session = 'session-00000000-0000-0000-0000-000000000001'
const other = 'session-00000000-0000-0000-0000-000000000002'
const hash = 'a'.repeat(64)
const request = { expectedRevision: 0, field: 'energy', value: '有所放松', quotes: ['和小林聊过之后，他终于放松了一点。'] }
const events = [{ seq: 3, role: 'assistant', text: '和小林聊过之后，他终于放松了一点。' }]

test('会话隔离、重启读取、竞争写入和中止', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trpg-character-store-'))
  try {
    await Promise.all([initializeCharacterState(root, session, hash, config), initializeCharacterState(root, session, hash, config)])
    await initializeCharacterState(root, other, hash, config)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(commitCharacterUpdate(root, session, hash, config, request, events, aborted.signal), /中止/)
    const results = await Promise.allSettled([commitCharacterUpdate(root, session, hash, config, request, events), commitCharacterUpdate(root, session, hash, config, request, events)])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter(item => item.status === 'rejected').length, 1)
    assert.equal((await readCharacterState(root, session, hash, config)).values.energy, '有所放松')
    assert.equal((await readCharacterState(root, other, hash, config)).values.energy, '有些疲惫')
    const changed = parseCharacterConfig(JSON.stringify({ version: 1, fields: [{ id: 'energy', label: '精力', initial: '很有精神' }] }))
    await assert.rejects(readCharacterState(root, session, hash, changed), /不匹配/)
    const dir = join(root, '.characters', `${session}-${hash}`)
    assert.equal((await stat(dir)).mode & 0o077, 0)
    assert.equal((await stat(join(dir, '000001.json'))).mode & 0o077, 0)
    await writeFile(join(dir, '.pending-fixture'), '{')
    assert.equal((await readCharacterState(root, session, hash, config)).revision, 1)
    await assert.rejects(commitCharacterUpdate(root, session, hash, config, request, events), /版本已变化/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('损坏、不连续、越界标识及符号链接均拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trpg-character-store-bad-'))
  try {
    await initializeCharacterState(root, session, hash, config)
    const dir = join(root, '.characters', `${session}-${hash}`)
    await writeFile(join(dir, '000002.json'), '{}')
    await assert.rejects(readCharacterState(root, session, hash, config), /不连续/)
    await assert.rejects(initializeCharacterState(root, '../outside', hash, config), /标识/)
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, '.characters', `${other}-${hash}`))
    await assert.rejects(initializeCharacterState(root, other, hash, config), /不安全/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
