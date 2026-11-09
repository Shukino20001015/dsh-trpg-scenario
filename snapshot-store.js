import { constants } from 'node:fs'
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parsePublicCriteria, parseScoreBands } from './scenario-store.js'
import { parseStageGraph } from './stage-graph.js'
import { parseCharacterConfig } from './character-state.js'
import { openRegularRead } from './safe-read.js'

// Snapshots may contain GM-only material. They are local, private, immutable
// and content-addressed by the existing opening/version hash. Never trust the
// JSON on disk without reconstructing and checking the complete frozen input.
const MAX_BYTES = 8 * 1024 * 1024
const START = '【TRPG 游玩规则开始】', END = '【TRPG 游玩规则结束】'
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)

export function snapshotPolicy(sc, continuity) {
  return [START, continuity, ...(sc.stageGraph ? ['【TRPG 阶段化剧本】'] : []), sc.system, '【背景与角色】', sc.setting, ...(sc.player ? ['【玩家须知】', sc.player] : []), '【开场】', sc.opening, END].join('\n\n')
}

export function snapshotHash(snapshot) {
  const { sc, continuity, judgeBase, stageProtocol, characterProtocol } = snapshot ?? {}
  if (!sc || typeof sc !== 'object' || Array.isArray(sc) || !sc.meta || typeof sc.meta !== 'object' || Array.isArray(sc.meta) ||
      ['system', 'setting', 'opening', 'rubric', 'judge', 'player'].some(k => typeof sc[k] !== 'string') ||
      typeof continuity !== 'string' || !Array.isArray(judgeBase) || judgeBase.some(item => typeof item !== 'string')) throw new Error('快照格式无效。')
  const markers = [START, END, '【背景与角色】', '【玩家须知】', '【开场】', '【TRPG 阶段化剧本】']
  if ([continuity, sc.system, sc.setting, sc.player, sc.opening].some(text => markers.some(marker => text.includes(marker)))) throw new Error('剧本包含保留的快照分隔符。')
  // Version hashes use optional positional values. Strictly validate the
  // shapes so an optional rubric cannot be reinterpreted as public criteria.
  if (sc.criteria != null && JSON.stringify(parsePublicCriteria(JSON.stringify(sc.criteria))) !== JSON.stringify(sc.criteria)) throw new Error('快照公开评分维度无效。')
  if (sc.scoreBands != null && (!sc.criteria || JSON.stringify(parseScoreBands(JSON.stringify(sc.scoreBands), sc.criteria)) !== JSON.stringify(sc.scoreBands))) throw new Error('快照评分档位无效。')
  if (sc.stageGraph != null && JSON.stringify(parseStageGraph(JSON.stringify(sc.stageGraph))) !== JSON.stringify(sc.stageGraph)) throw new Error('快照阶段网络无效。')
  if (stageProtocol != null && (!sc.stageGraph || !stageProtocol || typeof stageProtocol !== 'object' || Array.isArray(stageProtocol) || Object.keys(stageProtocol).sort().join(',') !== 'contract,overview,rules,speakers' || Object.values(stageProtocol).some(value => typeof value !== 'string' || !value.trim() || value.length > 10000))) throw new Error('快照阶段运行规则无效。')
  if (sc.characterConfig != null && (!sc.stageGraph || JSON.stringify(parseCharacterConfig(JSON.stringify(sc.characterConfig))) !== JSON.stringify(sc.characterConfig))) throw new Error('快照主角状态配置无效。')
  if (Boolean(sc.characterConfig) !== Boolean(characterProtocol) || (characterProtocol && (typeof characterProtocol !== 'object' || Array.isArray(characterProtocol) || Object.keys(characterProtocol).sort().join(',') !== 'contract,rules' || Object.values(characterProtocol).some(value => typeof value !== 'string' || !value.trim() || value.length > 10000)))) throw new Error('快照主角状态运行规则无效。')
  const frozen = [sc.meta, snapshotPolicy(sc, continuity), judgeBase, sc.rubric, sc.judge]
  if (sc.criteria) frozen.push(sc.criteria)
  if (sc.scoreBands) frozen.push(sc.scoreBands)
  // Tag the extra field so it cannot be confused with older optional arrays.
  // Legacy snapshots do not append anything and retain their existing hash.
  if (sc.stageGraph) frozen.push({ stageGraph: sc.stageGraph })
  // A stage graph alone is insufficient to compare games: freeze the stage
  // tool contract, host prompt and shared review instructions as well. Older
  // snapshots omit this field and remain readable under their original hash.
  if (stageProtocol) frozen.push({ stageProtocol })
  if (sc.characterConfig) frozen.push({ characterConfig: sc.characterConfig, characterProtocol })
  return createHash('sha256').update(JSON.stringify(frozen)).digest('hex')
}

async function snapshotDir(root, create = false) {
  const dir = join(root, '.snapshots')
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('快照目录不安全。')
  return dir
}

export async function readSnapshot(root, hash) {
  if (!validHash(hash)) throw new Error('快照标识无效。')
  const dir = await snapshotDir(root)
  const file = await openRegularRead(join(dir, `${hash}.json`))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('快照大小或类型无效。')
    const value = JSON.parse(await file.readFile({ encoding: 'utf8' }))
    if (snapshotHash(value) !== hash) throw new Error('快照校验失败。')
    return value
  } finally { await file.close() }
}

export async function saveSnapshot(root, hash, snapshot) {
  if (!validHash(hash) || snapshotHash(snapshot) !== hash) throw new Error('快照版本不匹配。')
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
  if (bytes.length > MAX_BYTES) throw new Error('快照过大。')
  const dir = await snapshotDir(root, true)
  const target = join(dir, `${hash}.json`)
  const temporary = join(dir, `.writing-${randomUUID()}`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await file.writeFile(bytes); await file.sync() }
    finally { await file.close() }
    try { await link(temporary, target) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    // Also verifies a concurrently-created or pre-existing target; never replace it.
    await readSnapshot(root, hash)
  } finally { await unlink(temporary) }
}
