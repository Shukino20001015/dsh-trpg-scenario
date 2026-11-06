import { inflateRawSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStageGraph } from './stage-graph.js'
import { parseCharacterConfig } from './character-state.js'

export const REQUIRED = ['manifest.yaml', 'system.md', 'setting.md', 'opening.md', 'rubric.md', 'judge.md']
export const OPTIONAL = ['player.md', 'criteria.json', 'score-bands.json', 'stages.json', 'character.json']
const MAX_ZIP = 8 * 1024 * 1024
const MAX_FILE = 1024 * 1024
const MAX_TOTAL = 4 * 1024 * 1024
const validId = (id) => typeof id === 'string' && /^[\p{L}\p{N}_-]{1,80}$/u.test(id) && id !== '.' && id !== '..'
export function requireId(id) {
  if (!validId(id)) throw new Error('剧本编号只能包含文字、数字、下划线或连字符，且长度不超过80。')
  return id
}
export function parseManifest(text) {
  const out = Object.create(null)
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}
export function parsePublicCriteria(text) {
  let value
  try { value = JSON.parse(text) } catch { throw new Error('公开评分维度 criteria.json 不是有效的 JSON。') }
  if (!Array.isArray(value) || value.length < 3 || value.length > 6) throw new Error('公开评分维度须包含 3 至 6 项。')
  const names = new Set()
  return value.map(item => {
    if (!item || Array.isArray(item) || typeof item !== 'object' || Object.keys(item).some(key => !['name', 'description'].includes(key)) || typeof item.name !== 'string' || typeof item.description !== 'string') throw new Error('每项公开评分维度只接受名称和说明。')
    const name = item.name.trim(), description = item.description.trim()
    if (!name || name.length > 50 || !description || description.length > 200 || names.has(name)) throw new Error('公开评分维度名称或说明为空、过长或重复。')
    names.add(name)
    return { name, description }
  })
}
export function parseScoreBands(text, criteria) {
  let value
  try { value = JSON.parse(text) } catch { throw new Error('score-bands.json 不是有效的 JSON。') }
  if (!criteria || !Array.isArray(value) || value.length !== criteria.length) throw new Error('评分档位必须与公开评分维度逐项对应。')
  const seen = new Set()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['name', 'bands'].includes(k)) || typeof item.name !== 'string' || !criteria.some(c => c.name === item.name) || seen.has(item.name) || !Array.isArray(item.bands) || !item.bands.length || item.bands.length > 20) throw new Error('评分档位名称或格式无效。')
    seen.add(item.name)
    const bands = item.bands.map(band => {
      if (!band || typeof band !== 'object' || Array.isArray(band) || Object.keys(band).some(k => !['min', 'max'].includes(k)) || !Number.isFinite(band.min) || !Number.isFinite(band.max) || band.min < 0 || band.max > 100 || band.min > band.max) throw new Error('评分档位边界无效。')
      return { min: band.min, max: band.max }
    })
    for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length; j++) if (bands[i].min <= bands[j].max && bands[j].min <= bands[i].max) throw new Error('评分档位数值范围不得重叠。')
    return { name: item.name, bands }
  })
}
export function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
// Read only the six expected regular files; never extract paths from an archive.
export function readPack(buffer) {
  if (buffer.length > MAX_ZIP || buffer.length < 22) throw new Error('压缩包大小不符合要求。')
  let end = -1
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { end = p; break }
  }
  if (end < 0) throw new Error('无法读取 ZIP 目录。')
  const disk = buffer.readUInt16LE(end + 4), diskDir = buffer.readUInt16LE(end + 6)
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16)
  if (disk || diskDir || count !== buffer.readUInt16LE(end + 8) || count > 32 || start + size > end) throw new Error('不支持分卷、ZIP64或过大的 ZIP 目录。')
  let pos = start, total = 0
  const files = new Map(), paths = new Set()
  let fileParent
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP 目录损坏。')
    const made = buffer.readUInt16LE(pos + 4), flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10)
    const crc = buffer.readUInt32LE(pos + 16), compressed = buffer.readUInt32LE(pos + 20), length = buffer.readUInt32LE(pos + 24)
    const nl = buffer.readUInt16LE(pos + 28), extra = buffer.readUInt16LE(pos + 30), comment = buffer.readUInt16LE(pos + 32)
    const external = buffer.readUInt32LE(pos + 38), local = buffer.readUInt32LE(pos + 42), next = pos + 46 + nl + extra + comment
    if (next > start + size) throw new Error('ZIP 条目不完整。')
    const path = buffer.subarray(pos + 46, pos + 46 + nl).toString('utf8')
    pos = next
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(x => x === '..' || x === '.') || paths.has(path)) throw new Error('ZIP 包含不安全或重复的路径。')
    paths.add(path)
    const unixMode = (made >>> 8) === 3 ? (external >>> 16) : 0
    const type = unixMode & 0o170000
    if (type && type !== 0o100000 && type !== 0o040000) throw new Error('ZIP 不允许链接或特殊文件。')
    if ((type === 0o040000 && !path.endsWith('/')) || (type === 0o100000 && path.endsWith('/'))) throw new Error('ZIP 条目类型与文件名不一致。')
    if (path.endsWith('/')) continue
    const parts = path.split('/')
    if (parts.length > 2 || ![...REQUIRED, ...OPTIONAL].includes(parts.at(-1)) || files.has(parts.at(-1))) throw new Error('ZIP 只允许指定的剧本文件，且不能重复。')
    const parent = parts.length === 2 ? parts[0] : ''
    if (fileParent !== undefined && parent !== fileParent) throw new Error('剧本文件必须位于同一目录。')
    fileParent = parent
    if ((flags & 1) || ![0, 8].includes(method) || length > MAX_FILE || (total += length) > MAX_TOTAL) throw new Error('ZIP 使用不支持的格式或内容过大。')
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 本地条目损坏。')
    const localName = buffer.readUInt16LE(local + 26), localExtra = buffer.readUInt16LE(local + 28)
    const dataAt = local + 30 + localName + localExtra
    if (dataAt + compressed > start || buffer.subarray(local + 30, local + 30 + localName).toString('utf8') !== path) throw new Error('ZIP 条目边界或名称不一致。')
    let data
    try { data = method === 0 ? buffer.subarray(dataAt, dataAt + compressed) : inflateRawSync(buffer.subarray(dataAt, dataAt + compressed), { maxOutputLength: MAX_FILE }) }
    catch { throw new Error('ZIP 解压失败或内容过大。') }
    if (data.length !== length || crc32(data) !== crc) throw new Error('ZIP 条目长度或校验值不正确。')
    let decoded
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(data) }
    catch { throw new Error(`剧本文件 ${parts.at(-1)} 必须是有效的 UTF-8 文本。`) }
    if (!decoded.trim()) throw new Error(`剧本文件 ${parts.at(-1)} 不能为空。`)
    if (parts.at(-1) === 'criteria.json') {
      if (data.length > 16384) throw new Error('公开评分维度文件过大。')
      parsePublicCriteria(decoded)
    }
    if (parts.at(-1) === 'stages.json') parseStageGraph(decoded)
    if (parts.at(-1) === 'character.json') parseCharacterConfig(decoded)
    files.set(parts.at(-1), data)
  }
  if (pos !== start + size || REQUIRED.some(f => !files.has(f))) throw new Error('剧本包缺少必需文件或目录不完整。')
  if (files.has('character.json') && !files.has('stages.json')) throw new Error('主角状态配置需要阶段配置。')
  if (files.has('score-bands.json')) {
    if (files.get('score-bands.json').length > 16384) throw new Error('评分档位文件过大。')
    const criteria = files.has('criteria.json') ? parsePublicCriteria(files.get('criteria.json').toString('utf8')) : null
    parseScoreBands(files.get('score-bands.json').toString('utf8'), criteria)
  }
  const id = requireId(parseManifest(files.get('manifest.yaml').toString('utf8')).id)
  return { id, files }
}
export async function importPack(root, buffer) {
  const { id, files } = readPack(buffer)
  // Scenario files include GM-only material. Apply private defaults to newly
  // created paths; do not change permissions of an existing user directory.
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(root, '.import-'))
  try {
    for (const [name, data] of files) await writeFile(join(temp, name), data, { flag: 'wx', mode: 0o600 })
    // An exclusive reservation prevents silently replacing an existing scenario.
    const destination = join(root, id)
    try { await mkdir(destination, { mode: 0o700 }) } catch (e) { if (e.code === 'EEXIST') throw new Error(`剧本 ${id} 已存在，未覆盖。`); throw e }
    try {
      for (const name of files.keys()) await rename(join(temp, name), join(destination, name))
    } catch (e) { await rm(destination, { recursive: true, force: true }); throw e }
    return id
  } finally { await rm(temp, { recursive: true, force: true }) }
}
export async function removeScenario(root, id) {
  requireId(id)
  const path = join(root, id), info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('剧本目录不合法。')
  await rm(path, { recursive: true })
}
export async function listScenarios(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && validId(e.name)).map(e => e.name).sort() }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
