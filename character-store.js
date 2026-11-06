import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { advanceCharacterState, restoreCharacterState } from './character-state.js'

const SESSION = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const filename = revision => `${String(revision).padStart(6, '0')}.json`
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const configDigest = config => createHash('sha256').update(JSON.stringify(config)).digest('hex')

async function directory(path, create) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('主角状态目录不安全')
}

async function characterDirectory(root, session, hash, create = false) {
  if (typeof session !== 'string' || !SESSION.test(session) || typeof hash !== 'string' || !HASH.test(hash)) throw new Error('主角状态标识无效')
  const parent = join(root, '.characters')
  await directory(parent, create)
  const dir = join(parent, `${session}-${hash}`)
  await directory(dir, create)
  return dir
}

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 16384) throw new Error('主角状态文件无效')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function publish(dir, name, value, signal) {
  const pending = join(dir, `.pending-${randomUUID()}`)
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let committed = false
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    if (signal?.aborted) throw new Error('主角状态更新已中止')
    try { await link(pending, join(dir, name)); committed = true }
    catch (error) { if (error.code === 'EEXIST') throw new Error('主角状态已变化，请重新核对'); throw error }
  } finally {
    try { await unlink(pending) } catch (error) { if (!committed) throw error }
  }
}

export async function readCharacterState(root, session, hash, config) {
  const dir = await characterDirectory(root, session, hash)
  const names = (await readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort()
  if (!names.length || names.length > 10001 || names.some((name, index) => name !== filename(index))) throw new Error('主角状态记录缺失或不连续')
  const header = await readJson(join(dir, names[0]))
  if (!exact(header, ['version', 'session', 'hash', 'configDigest']) || header.version !== 1 || header.session !== session || header.hash !== hash || header.configDigest !== configDigest(config)) throw new Error('主角状态记录与开局不匹配')
  const history = []
  for (const name of names.slice(1)) history.push(await readJson(join(dir, name)))
  return restoreCharacterState(config, history)
}

export async function initializeCharacterState(root, session, hash, config) {
  const dir = await characterDirectory(root, session, hash, true)
  try { await publish(dir, filename(0), { version: 1, session, hash, configDigest: configDigest(config) }) }
  catch (error) { if (error.message !== '主角状态已变化，请重新核对') throw error }
  return readCharacterState(root, session, hash, config)
}

export async function commitCharacterUpdate(root, session, hash, config, request, events, signal) {
  if (signal?.aborted) throw new Error('主角状态更新已中止')
  const state = await readCharacterState(root, session, hash, config)
  const next = advanceCharacterState(config, state.history, request, events)
  const dir = await characterDirectory(root, session, hash)
  await publish(dir, filename(next.revision), next.history.at(-1), signal)
  return next
}
