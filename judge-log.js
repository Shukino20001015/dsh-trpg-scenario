import { inflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { crc32 } from './scenario-store.js'
import { deriveCombinedToolHistory, deriveStageToolHistory } from './stage-history.js'
import { stageDialogueEvidence, resolveEvidenceQuotes } from './stage-graph.js'
import { parseStageAutoMessage } from './stage-auto-message.mjs'
import { parseCharacterAutoMessage } from './character-auto-message.mjs'

const MAX_ARCHIVE = 40 * 1024 * 1024
const MAX_JSONL = 20 * 1024 * 1024
const MAX_DIALOGUE = 240000
const INITIAL_PLAY_MESSAGE = '【接下来是 AI 跑团的剧本设定。请读完，然后照此扮演。】\n\n请按照已载入的剧本规则，从开场场景开始游玩。'
const PLAY_START = '【TRPG 游玩规则开始】', PLAY_END = '【TRPG 游玩规则结束】'

// Read a single top-level DSH session log without unpacking any archive paths.
function readSessionZip(buf) {
  if (buf.length > MAX_ARCHIVE || buf.length < 22) throw new Error('日志压缩包过大或无效。')
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { end = i; break }
  }
  if (end < 0 || buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6)) throw new Error('不支持此 ZIP。')
  const count = buf.readUInt16LE(end + 10), size = buf.readUInt32LE(end + 12), start = buf.readUInt32LE(end + 16)
  if (count !== buf.readUInt16LE(end + 8) || count > 512 || start + size > end) throw new Error('ZIP 目录无效。')
  let pos = start, result
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP 目录损坏。')
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16), compressed = buf.readUInt32LE(pos + 20), length = buf.readUInt32LE(pos + 24)
    const nl = buf.readUInt16LE(pos + 28), extra = buf.readUInt16LE(pos + 30), comment = buf.readUInt16LE(pos + 32), offset = buf.readUInt32LE(pos + 42)
    const next = pos + 46 + nl + extra + comment
    if (next > start + size) throw new Error('ZIP 条目损坏。')
    const name = buf.subarray(pos + 46, pos + 46 + nl).toString('utf8')
    pos = next
    if (name !== 'session.v4.jsonl') continue
    if (result || (flags & 1) || ![0, 8].includes(method) || length > MAX_JSONL || offset + 30 > start || buf.readUInt32LE(offset) !== 0x04034b50) throw new Error('日志条目不受支持或重复。')
    const localName = buf.readUInt16LE(offset + 26), localExtra = buf.readUInt16LE(offset + 28)
    const dataAt = offset + 30 + localName + localExtra
    if (dataAt + compressed > start || buf.subarray(offset + 30, offset + 30 + localName).toString('utf8') !== name) throw new Error('日志条目边界无效。')
    try { result = method === 0 ? buf.subarray(dataAt, dataAt + compressed) : inflateRawSync(buf.subarray(dataAt, dataAt + compressed), { maxOutputLength: MAX_JSONL }) }
    catch { throw new Error('日志解压失败或超过大小限制。') }
    if (result.length !== length || crc32(result) !== crc) throw new Error('日志条目长度或校验值不符。')
  }
  if (pos !== start + size || !result) throw new Error('ZIP 中没有顶层 session.v4.jsonl。')
  return result
}

// A completed begin is only a routing hint. Full log and version validation
// still happens after selecting the candidate scenario.
export function inspectScenarioReference(buffer) {
  const data = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? readSessionZip(buffer) : buffer
  if (data.length > MAX_JSONL) throw new Error('日志超过 20 MB。')
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { throw new Error('日志不是有效的 UTF-8。') }
  const runs = new Map(), completed = []
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { throw new Error('日志不是有效的 DSH JSONL。') }
    if (event?.type === 'command/run' && event.data?.name === 'trpg' && typeof event.data?.commandId === 'string') {
      const match = /^\s*begin\s+([^\s]+)\s+([a-f0-9]{64})\s*$/.exec(event.data.args || '')
      if (match) runs.set(event.data.commandId, { id: match[1], hash: match[2] })
    }
    if (event?.type === 'command/done' && event.data?.kind === 'success' && runs.has(event.data.commandId)) completed.push(runs.get(event.data.commandId))
  }
  return completed.length === 1 ? completed[0] : null
}

export function inspectDialogue(buffer, name = '', options = {}) {
  const data = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? readSessionZip(buffer) : buffer
  if (data.length > MAX_JSONL) throw new Error('日志超过 20 MB。')
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { throw new Error(`${name} 不是有效的 UTF-8 日志。`) }
  const lines = source.split(/\r?\n/), dialogue = [], recordIds = [], playerRecordIds = []
  let stagedHistory = null, stagedEvents = null
  let uncertainToolOutcomes = 0
  if (options.stageGraph) {
    try { stagedEvents = lines.filter(line => line.trim()).map(line => JSON.parse(line)) }
    catch { throw new Error(`${name} 不是有效的 DSH JSONL 日志。`) }
    const noteUnknown = () => { uncertainToolOutcomes++ }
    try { stagedHistory = options.characterConfig ? deriveCombinedToolHistory(stagedEvents, options.stageGraph, options.characterConfig, noteUnknown).stages : deriveStageToolHistory(stagedEvents, options.stageGraph, noteUnknown) }
    catch { throw new Error(`${name} 的阶段工具记录不完整或与剧本规则不一致，请人工核对。`) }
  }
  const dialogueHash = createHash('sha256')
  let sawFirstDialogue = false
  const interruptedAssistantSeqs = []
  const uncertainMixedSeqs = []
  const internalStageAutoSeqs = []
  const internalCharacterAutoSeqs = []
  const assistantTurns = new Map(), abortedTurns = new Set()
  const turnStarts = new Map(), turnEnds = new Map()
  let lastParticipantRole = null
  let lastDialogueSeq = -1
  const playCommands = new Map(), completedPlays = []
  const priorEvents = []
  let playPolicy = null
  for (const line of lines) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { throw new Error(`${name} 不是有效的 DSH JSONL 日志。`) }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(`${name} 含无效的日志记录。`)
    // Only physical predecessors may support an internal candidate; a forged
    // later event must not become prior evidence merely by using a low seq.
    const predecessorCount = priorEvents.length
    if (options.stageGraph) priorEvents.push(event)
    if ((event.type === 'turn/start' || event.type === 'turn/end') && Number.isSafeInteger(event.data?.turn)) {
      const map = event.type === 'turn/start' ? turnStarts : turnEnds
      const entries = map.get(event.data.turn) || []
      entries.push(event.seq)
      map.set(event.data.turn, entries)
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'aborted' && Number.isSafeInteger(event.data?.turn)) abortedTurns.add(event.data.turn)
    if (event.type === 'system/message' && !Array.isArray(event.data?.message?.content)) throw new Error(`${name} 的系统记录格式无效。`)
    if (event.type === 'system/message') for (const block of event.data.message.content) {
      if (!block || typeof block !== 'object') throw new Error(`${name} 的系统记录格式无效。`)
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      let offset = 0, start
      while ((start = block.text.indexOf(PLAY_START, offset)) >= 0) {
        const end = block.text.indexOf(PLAY_END, start + PLAY_START.length)
        if (end < 0) throw new Error(`${name} 的游玩规则记录不完整，不能自动评分。`)
        const observed = block.text.slice(start, end + PLAY_END.length)
        if (playPolicy !== null && playPolicy !== observed) throw new Error(`${name} 的游玩规则在会话中不一致，不能自动比较或评分。`)
        playPolicy = observed
        offset = end + PLAY_END.length
      }
    }
    if (event.type === 'command/run' && event.data?.name === 'trpg' && typeof event.data?.commandId === 'string') {
      const match = /^\s*(?:play(?:\s+(\S+))?|begin\s+(\S+)\s+([a-f0-9]{64}))\s*$/.exec(event.data.args || '')
      if (match) playCommands.set(event.data.commandId, { id: match[1] || match[2] || null, hash: match[3] || null })
    }
    if (event.type === 'command/done' && event.data?.kind === 'success' && playCommands.has(event.data.commandId)) completedPlays.push(playCommands.get(event.data.commandId))
    if (event?.type === 'tool/result' && event.surfaceOp === 'append' && !options.stageGraph) throw new Error(`${name} 含工具结果，不能自动还原完整游玩证据，请人工核对。`)
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      // DSH 的 replace 是供模型使用的压缩上下文，不是新发生的对话。
      // 原始 append 记录才构成人实际看到的完整过程。
      if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') continue
      if (event.surfaceOp !== 'append') throw new Error(`${name} 含无法识别的对话记录格式，无法可靠还原游玩过程。`)
    }
    // DSH writes a runtime-environment snapshot as a user-role message; it is
    // not dialogue and may contain local paths, so never send it to a judge.
    if (event.type === 'user/message' && event.data?.source?.kind === 'runtime-context' && event.data.source.form === 'snapshot') continue
    if (event.type === 'user/message' && event.data?.source?.kind === 'trpg-stage-auto') {
      const request = options.stageGraph && parseStageAutoMessage(event,options.stageGraph)
      try {
        if (!request || !Number.isSafeInteger(event.seq)) throw Error('invalid')
        const prior=priorEvents.slice(0,predecessorCount).filter(e=>Number.isSafeInteger(e?.seq)&&e.seq<event.seq)
        resolveEvidenceQuotes(request.quotes,stageDialogueEvidence(prior))
      } catch { throw new Error(`${name} 的后台阶段候选记录无效，请人工核对。`) }
      internalStageAutoSeqs.push(event.seq)
      continue
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'trpg-character-auto') {
      const request = options.characterConfig && parseCharacterAutoMessage(event,options.characterConfig)
      try {
        if (!request || !Number.isSafeInteger(event.seq)) throw Error('invalid')
        const prior=priorEvents.slice(0,predecessorCount).filter(e=>Number.isSafeInteger(e?.seq)&&e.seq<event.seq)
        const events=stageDialogueEvidence(prior)
        const ids=resolveEvidenceQuotes(request.quotes,events)
        if(!ids.some(id=>events.some(e=>e.seq===id&&e.role==='assistant')))throw Error('invalid')
      } catch {throw new Error(`${name} 的后台角色候选记录无效，请人工核对。`)}
      internalCharacterAutoSeqs.push(event.seq)
      continue
    }
    if (event.type === 'user/message' && event.data?.source?.kind !== 'user') {
      throw new Error(`${name} 含来源不明或非玩家发言，不能静默忽略，请人工核对。`)
    }
    let role, blocks
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') { role = '玩家'; blocks = event.data.content }
    else if (event.type === 'assistant/message') { role = '游玩智能体'; blocks = event.data?.message?.content }
    else continue
    if (!Array.isArray(blocks)) throw new Error(`${name} 的对话内容格式无效。`)
    if (role === '游玩智能体' && Number.isSafeInteger(event.data?.turn) && Number.isSafeInteger(event.seq)) {
      const seqs = assistantTurns.get(event.data.turn) || []
      seqs.push(event.seq)
      assistantTurns.set(event.data.turn, seqs)
    }
    if (role === '游玩智能体' && event.data?.message?.interrupted === true) {
      if (!Number.isSafeInteger(event.seq)) throw new Error(`${name} 的中断回复记录编号无效。`)
      interruptedAssistantSeqs.push(event.seq)
    }
    if (blocks.some(block => !block || typeof block !== 'object' || (role === '玩家' && block.type !== 'text') || (role === '游玩智能体' && !['text', 'reasoning', ...(options.stageGraph ? ['tool-call'] : [])].includes(block.type)))) throw new Error(`${name} 含图片、附件或工具等非文本内容，不能自动还原完整游玩证据，请人工核对。`)
    if (blocks.some(block => block.type === 'text' && typeof block.text !== 'string')) throw new Error(`${name} 的文本记录格式无效。`)
    const text = (blocks || []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    // DSH's conversation view can hide text belonging to an assistant message
    // that also calls a tool. Do not silently score unseen narration as play.
    const mixed = role === '游玩智能体' && text.trim() && blocks.some(block => block.type === 'tool-call')
    if (mixed && !options.allowUncertainMixed) throw new Error(`${name} 含与工具调用混合的主持文本；桌面可能未展示该文本，无法自动确认玩家看到的内容，请人工核对。`)
    if (mixed) {
      if (!Number.isSafeInteger(event.seq)) throw new Error(`${name} 的混合文本记录编号无效。`)
      uncertainMixedSeqs.push(event.seq)
    }
    if (!mixed && (!options.stageGraph || text.trim())) lastParticipantRole = role
    if (!text.trim()) continue
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastDialogueSeq) throw new Error(`${name} 的对话记录编号缺失或顺序无效。`)
    lastDialogueSeq = event.seq
    // Only the exact plugin-generated initial instruction is omitted. A later
    // player message sharing its prefix is evidence and must not disappear.
    const isFirst = !sawFirstDialogue
    sawFirstDialogue = true
    if (isFirst && role === '玩家' && text === INITIAL_PLAY_MESSAGE) continue
    // JSON string encoding keeps a player's newlines and quotes inside one
    // evidence record, so they cannot create a second apparent record header.
    // It is not a guarantee that an LLM will ignore malicious instructions.
    const encoded = JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    // Preserve the original record identity and JSON-string boundary, while
    // making the provenance visible at each turn. A host message can contain
    // NPC dialogue or text it authored on the player's behalf; neither is a
    // verbatim player instruction merely because the character says it.
    const provenance = mixed ? '主持混合文本（是否展示未知）' : role === '玩家' ? '玩家原始输入' : '主持生成（含人物对话与可能的代写）'
    dialogue.push(`[记录 ${event.seq} · ${provenance}] ${encoded}`)
    // Record sequence numbers vary between exports; compare exact roles and
    // content without them to flag likely duplicate uploads for human review.
    dialogueHash.update(JSON.stringify([mixed ? '展示未知' : role, text]) + '\n')
    recordIds.push(`记录 ${event.seq}`)
    if (role === '玩家') playerRecordIds.push(`记录 ${event.seq}`)
  }
  const text = dialogue.join('\n\n')
  for (const turn of abortedTurns) for (const seq of assistantTurns.get(turn) || []) if (!interruptedAssistantSeqs.includes(seq)) interruptedAssistantSeqs.push(seq)
  interruptedAssistantSeqs.sort((a, b) => a - b)
  if (!text) throw new Error(`${name} 中没有可评分的游玩对话。`)
  if (text.length > MAX_DIALOGUE) throw new Error(`${name} 的对话过长；为避免遗漏证据，本次不会自动截断。`)
  const ids = new Set(completedPlays.map(x => x.id).filter(Boolean))
  if (ids.size > 1) throw new Error(`${name} 包含多个不同剧本的开局记录，请人工核对。`)
  const abortedTurnRanges = [...abortedTurns].map(turn => {
    const starts = turnStarts.get(turn) || [], ends = turnEnds.get(turn) || []
    return starts.length === 1 && ends.length === 1 && Number.isSafeInteger(starts[0]) && Number.isSafeInteger(ends[0]) && starts[0] <= ends[0]
      ? { turn, start: starts[0], end: ends[0] } : { turn }
  })
  return { dialogue: text, dialogueFingerprint: dialogueHash.digest('hex'), recordIds, playerRecordIds, uncertainMixedSeqs, internalStageAutoSeqs, internalCharacterAutoSeqs, interruptedAssistantSeqs, abortedTurns: [...abortedTurns], abortedTurnRanges, lastPlayerUnanswered: lastParticipantRole === '玩家', scenarioId: completedPlays.length === 1 ? completedPlays[0].id : null, versionHash: completedPlays.length === 1 ? completedPlays[0].hash : null, playPolicy, ...(stagedHistory ? { stagedTransitionCount: stagedHistory.length, uncertainToolOutcomes } : {}) }
}

export function extractDialogue(buffer, name = '') { return inspectDialogue(buffer, name).dialogue }

// Reconstruct only the original player text already present in the prepared
// judge request. The record number must agree with the independently frozen
// role index. JSON-string boundaries prevent a player's text from introducing
// another record or group. Missing/ambiguous inputs disable this optional cue.
export function playerInputsFromJudgeRequest(request, trustedPlayerRecords) {
  if (typeof request !== 'string' || request.length > 1100000 || !Array.isArray(trustedPlayerRecords) || trustedPlayerRecords.length < 1 || trustedPlayerRecords.length > 6) return null
  const groups = Array.from({ length: trustedPlayerRecords.length }, () => new Map())
  const seenGroups = new Set()
  let current = -1
  for (const line of request.split('\n')) {
    const header = /^【第 ([1-6]) (?:组|份游玩记录)；文件名仅供识别：("(?:[^"\\]|\\.)*")】$/.exec(line)
    if (header) {
      const index = Number(header[1]) - 1
      if (index >= groups.length || seenGroups.has(index)) return null
      try { if (typeof JSON.parse(header[2]) !== 'string') return null } catch { return null }
      seenGroups.add(index); current = index; continue
    }
    const row = /^\[记录 (\d+) · (?:玩家原始输入|玩家)\] ("(?:[^"\\]|\\.)*")$/.exec(line)
    if (!row) continue
    if (current < 0) return null
    const id = `记录 ${row[1]}`
    if (!Array.isArray(trustedPlayerRecords[current]) || !trustedPlayerRecords[current].includes(id) || groups[current].has(id)) return null
    let text
    try { text = JSON.parse(row[2]) } catch { return null }
    if (typeof text !== 'string') return null
    groups[current].set(id, text)
  }
  if (seenGroups.size !== groups.length || groups.some((group, i) => !Array.isArray(trustedPlayerRecords[i]) || group.size !== trustedPlayerRecords[i].length || trustedPlayerRecords[i].some(id => !group.has(id)))) return null
  return groups.map(group => Object.fromEntries(group))
}
