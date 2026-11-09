import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { advanceStage, restoreStageState, validateTransition } from './stage-graph.js'
import { prepareStageCorrection, replayStageJournal } from './stage-correction.mjs'

const validSession = value => typeof value === 'string' && /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const MAX_ENTRY_BYTES = 16384

async function directory(path, create) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('阶段记录目录不安全')
}

async function stageDirectory(root, session, hash, create = false) {
  if (!validSession(session) || !validHash(hash)) throw new Error('阶段记录标识无效')
  const parent = join(root, '.stages')
  await directory(parent, create)
  const dir = join(parent, `${session}-${hash}`)
  await directory(dir, create)
  return dir
}

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_ENTRY_BYTES) throw new Error('阶段记录文件无效')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

// Publish a completely written revision with an exclusive link. Concurrent
// writers of the same revision cannot overwrite one another; a crash before
// linking may leave a private temporary file, which is not a committed entry.
async function publish(dir, name, value, signal) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > MAX_ENTRY_BYTES) throw new Error('阶段记录过大')
  const temp = join(dir, `.pending-${randomUUID()}`)
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let committed = false
  try {
    try { await file.writeFile(bytes); await file.sync() }
    finally { await file.close() }
    if (signal?.aborted) throw new Error('阶段申请已中止')
    try { await link(temp, join(dir, name)); committed = true }
    catch (error) { if (error.code === 'EEXIST') throw new Error('阶段已变化，请重新核对'); throw error }
  } finally {
    // A cleanup error after publication must not misreport a committed state
    // as rejected. The private orphan is ignored on replay; report cleanup
    // failures normally if nothing was committed.
    try { await unlink(temp) } catch (error) { if (!committed) throw error }
  }
}

const filename = revision => `${String(revision).padStart(6, '0')}.json`

// A conversation may continue while its gate is unavailable. Never silently
// re-enable it later merely because its old sidecar reappears.
export async function stageSuspended(root, session, hash) {
  if (!validSession(session) || !validHash(hash)) throw new Error('阶段记录标识无效')
  const dir = join(root, '.stage-suspensions')
  try { await directory(dir, false) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  let marker
  try { marker = await readJson(join(dir, `${session}-${hash}.json`)) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!marker || Object.keys(marker).sort().join(',') !== 'hash,session,version' || marker.version !== 1 || marker.session !== session || marker.hash !== hash) throw new Error('阶段暂停记录无效')
  return true
}

export async function suspendStage(root, session, hash) {
  if (!validSession(session) || !validHash(hash)) throw new Error('阶段记录标识无效')
  const dir = join(root, '.stage-suspensions')
  await directory(dir, true)
  try { await publish(dir, `${session}-${hash}.json`, { version: 1, session, hash }) }
  catch (error) { if (error.message !== '阶段已变化，请重新核对') throw error }
  if (!await stageSuspended(root, session, hash)) throw new Error('阶段暂停记录不可用')
}

export async function readStageState(root, session, hash, graph, { allowCorrections = false } = {}) {
  const dir = await stageDirectory(root, session, hash)
  const names = (await readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort()
  if (!names.length || names.length > 10001 || names.some((name, i) => name !== filename(i))) throw new Error('阶段记录缺失或不连续')
  const header = await readJson(join(dir, names[0]))
  if (!header || Object.keys(header).sort().join(',') !== 'hash,initial,session,version' || header.version !== 1 || header.session !== session || header.hash !== hash || header.initial !== graph.initial) throw new Error('阶段记录与开局不匹配')
  const history = []
  for (const name of names.slice(1)) history.push(await readJson(join(dir, name)))
  return allowCorrections ? replayStageJournal(graph, history) : restoreStageState(graph, history)
}

export async function initializeStageState(root, session, hash, graph) {
  const dir = await stageDirectory(root, session, hash, true)
  try { await publish(dir, filename(0), { version: 1, session, hash, initial: graph.initial }) }
  catch (error) { if (error.message !== '阶段已变化，请重新核对') throw error }
  return readStageState(root, session, hash, graph)
}

export async function commitStageTransition(root, session, hash, graph, request, events, signal) {
  if (signal?.aborted) throw new Error('阶段申请已中止')
  const state = await readStageState(root, session, hash, graph)
  const next = advanceStage(graph, state.history, request, events)
  const dir = await stageDirectory(root, session, hash)
  await publish(dir, filename(next.revision), next.history.at(-1), signal)
  return next
}

// Deliberately not wired into the live tool yet. The caller must also record
// a corresponding DSH tool call/result and verify that transcript on recovery.
export async function commitStageCorrection(root, session, hash, graph, request, events, signal) {
  if (signal?.aborted) throw new Error('阶段申请已中止')
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'expectedRevision,quotes,targetRevision') throw new Error('阶段纠正申请格式无效')
  const state = await readStageState(root, session, hash, graph, { allowCorrections: true })
  const next = prepareStageCorrection({ graph, history: state.history, events, expectedRevision: request.expectedRevision, targetRevision: request.targetRevision, quotes: request.quotes })
  const dir = await stageDirectory(root, session, hash)
  await publish(dir, filename(next.revision), next.history.at(-1), signal)
  return next
}

export async function commitStageJournalTransition(root, session, hash, graph, request, events, signal) {
  if (signal?.aborted) throw new Error('阶段申请已中止')
  const state = await readStageState(root, session, hash, graph, { allowCorrections: true })
  if (state.history.length >= 10000) throw new Error('阶段历史已达上限')
  const entry = validateTransition(graph, state, request, events)
  const next = replayStageJournal(graph, [...state.history, entry])
  const dir = await stageDirectory(root, session, hash)
  await publish(dir, filename(next.revision), entry, signal)
  return next
}
