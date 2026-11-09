import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const SESSION = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_BYTES = 1024 * 1024
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',')

async function directory(root, create) {
  const dir = join(root, '.segmented-jobs')
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('评分任务目录不可用')
  return dir
}
function validateSession(session) { if (typeof session !== 'string' || !SESSION.test(session)) throw new Error('评分任务标识无效') }
async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('评分任务记录无效')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}
async function publish(dir, name, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > MAX_BYTES) throw new Error('评分任务结果过大')
  const temporary = join(dir, `.pending-${randomUUID()}`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let committed = false
  try {
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await link(temporary, join(dir, name)); committed = true
  } finally { try { await unlink(temporary) } catch (error) { if (!committed) throw error } }
}
export async function startSegmentedJob(root, session) {
  validateSession(session)
  const dir = await directory(root, true)
  try { await publish(dir, `${session}.start.json`, { version: 1, session }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('此会话已有评分任务，请新建评分会话重试'); throw error }
}
export async function finishSegmentedJob(root, session, result) {
  validateSession(session)
  if (!result || !['complete', 'failed'].includes(result.status) || typeof result.text !== 'string' || !result.text.trim() || (result.status === 'complete' && !result.text.startsWith('分段评分草稿，必须人工复核'))) throw new Error('评分任务结果无效')
  const dir = await directory(root, false)
  const start = await readJson(join(dir, `${session}.start.json`))
  if (!exact(start, ['version', 'session']) || start.version !== 1 || start.session !== session) throw new Error('评分任务起始记录无效')
  await publish(dir, `${session}.result.json`, { version: 1, session, status: result.status, text: result.text })
}
export async function readSegmentedJob(root, session) {
  validateSession(session)
  let dir, start
  try { dir = await directory(root, false); start = await readJson(join(dir, `${session}.start.json`)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!exact(start, ['version', 'session']) || start.version !== 1 || start.session !== session) throw new Error('评分任务起始记录无效')
  let result
  try { result = await readJson(join(dir, `${session}.result.json`)) }
  catch (error) { if (error.code === 'ENOENT') return { status: 'interrupted' }; throw error }
  if (!exact(result, ['version', 'session', 'status', 'text']) || result.version !== 1 || result.session !== session || !['complete', 'failed'].includes(result.status) || typeof result.text !== 'string' || !result.text.trim() || (result.status === 'complete' && !result.text.startsWith('分段评分草稿，必须人工复核'))) throw new Error('评分任务结果无效')
  return { status: result.status, text: result.text }
}
export async function listSegmentedJobIds(root) {
  let dir
  try { dir = await directory(root, false) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const names = await readdir(dir)
  if (names.length > 10000) throw new Error('评分任务过多，无法列出')
  const records = []
  for (const name of names) {
    if (!name.endsWith('.start.json')) continue
    const session = name.slice(0, -'.start.json'.length)
    if (!SESSION.test(session)) continue
    const info = await lstat(join(dir, name))
    if (!info.isFile() || info.isSymbolicLink()) continue
    records.push({ session, time: info.mtimeMs })
  }
  return records.sort((a,b) => b.time - a.time || a.session.localeCompare(b.session)).slice(0,100).map(item => item.session)
}
