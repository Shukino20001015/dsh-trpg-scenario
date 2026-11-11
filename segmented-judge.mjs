// The validated dialogue comes from inspectDialogue, never directly from ZIP.
import { createHash } from 'node:crypto'
import { SegmentExtractionFailure } from './segmented-judge-llm.mjs'

export function partitionDialogue(inspected, limit = 6000, { maxSingleRecordChars = Math.max(limit, 24000) } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 128 || !Number.isSafeInteger(maxSingleRecordChars) || maxSingleRecordChars < limit || maxSingleRecordChars > 1000000) throw new Error('分段上限无效')
  const { dialogue, recordIds, playerRecordIds } = inspected || {}
  if (typeof dialogue !== 'string' || !Array.isArray(recordIds) || !Array.isArray(playerRecordIds)) throw new Error('缺少已核验的对话及角色索引')
  const entries = dialogue.split('\n\n')
  if (!entries.length || entries.length !== recordIds.length || new Set(recordIds).size !== recordIds.length || new Set(playerRecordIds).size !== playerRecordIds.length) throw new Error('对话与记录索引不一致')
  const players = new Set(playerRecordIds)
  if (playerRecordIds.some(ref => !recordIds.includes(ref))) throw new Error('玩家索引不属于当前记录')
  let previous = -1
  const records = entries.map((entry, index) => {
    const match = /^\[记录 (\d+) · (玩家原始输入|主持生成（含人物对话与可能的代写）|主持混合文本（是否展示未知）)\] (.+)$/.exec(entry)
    if (!match || `记录 ${match[1]}` !== recordIds[index] || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= previous) throw new Error('对话记录编号或格式无效')
    previous = Number(match[1])
    const role = match[2] === '玩家原始输入' ? 'player' : match[2] === '主持混合文本（是否展示未知）' ? 'uncertain' : 'host'
    if ((role === 'player') !== players.has(recordIds[index])) throw new Error('对话角色与索引不一致')
    let text
    try { text = JSON.parse(match[3]) } catch { throw new Error('对话文本不是有效 JSON 字符串') }
    if (typeof text !== 'string' || !text.trim()) throw new Error('对话文本为空或无效')
    return { ref: recordIds[index], role, text, entry }
  })
  const segments = []
  let batch = [], size = 0
  for (const record of records) {
    const cost = record.entry.length + (batch.length ? 2 : 0)
    if (record.entry.length > maxSingleRecordChars) throw new Error(`单条${record.ref}超过分段上限，不能静默截断`)
    // A single long record stays intact in its own segment; limit is a target,
    // not a token estimate. A separate hard bound prevents unbounded input.
    if (record.entry.length > limit) {
      if (batch.length) { segments.push(batch); batch = []; size = 0 }
      segments.push([record])
      continue
    }
    if (size + cost > limit) { segments.push(batch); batch = []; size = 0 }
    size += record.entry.length + (batch.length ? 2 : 0)
    batch.push(record)
  }
  if (batch.length) segments.push(batch)
  return segments.map((items, index) => {
    const text = items.map(item => item.entry).join('\n\n')
    return { index: index + 1, total: segments.length, refs: items.map(item => item.ref), text, digest: createHash('sha256').update(text).digest('hex'), records: items.map(({ ref, role, text }) => ({ ref, role, text })) }
  })
}

// extract is an injected adapter. It must return a completed response with
// exact source quotes; this function never calls a service or assigns scores.
export async function collectEvidence(segments, extract, { signal, expectedRecordIds, expectedDialogue, onProgress, consumeRetry, retryDelayMs = 1000 } = {}) {
  if (!Array.isArray(segments) || !segments.length || typeof extract !== 'function' || !Array.isArray(expectedRecordIds) || !expectedRecordIds.length || typeof expectedDialogue !== 'string') throw new Error('分段、原始对话索引或提取器无效')
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000) throw new Error('重试等待时间无效')
  const allRefs = new Set(), collected = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment.index !== i + 1 || segment.total !== segments.length || !Array.isArray(segment.records) || segment.records.length === 0 || !Array.isArray(segment.refs) || segment.refs.length !== segment.records.length || segment.records.some((r, j) => r.ref !== segment.refs[j] || allRefs.has(r.ref))) throw new Error('分段顺序或覆盖范围无效')
    if (segment.records.some(record => !['player', 'host', 'uncertain'].includes(record.role))) throw new Error('分段角色无效')
    const reconstructed = segment.records.map(record => `[${record.ref} · ${record.role === 'player' ? '玩家原始输入' : record.role === 'uncertain' ? '主持混合文本（是否展示未知）' : '主持生成（含人物对话与可能的代写）'}] ${JSON.stringify(record.text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}`).join('\n\n')
    if (segment.text !== reconstructed || createHash('sha256').update(segment.text).digest('hex') !== segment.digest) throw new Error('分段内容已变化')
    segment.refs.forEach(ref => allRefs.add(ref))
  }
  if (allRefs.size !== expectedRecordIds.length || [...allRefs].some((ref, index) => ref !== expectedRecordIds[index])) throw new Error('分段未完整覆盖原始记录索引')
  if (segments.map(segment => segment.text).join('\n\n') !== expectedDialogue) throw new Error('分段与原始对话不一致')
  for (const segment of segments) {
    onProgress?.({ phase: 'extract', completed: collected.length, total: segments.length })
    if (signal?.aborted) return { status: 'incomplete', completed: collected.length, total: segments.length, reason: 'aborted' }
    const records = new Map(segment.records.map(record => [record.ref, record]))
    let evidence, reason = 'extract-failed', retryIssue
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response
      try { response = await extract({ ...structuredClone(segment), ...(attempt > 1 ? { retry: true, retryIssue } : {}) }, signal) }
      catch (error) { response = null; reason = error instanceof SegmentExtractionFailure && ['timeout', 'output-limit', 'model-truncated', 'stream-incomplete', 'invalid-response'].includes(error.reason) ? error.reason : 'extract-failed' }
      if (signal?.aborted) return { status: 'incomplete', completed: collected.length, total: segments.length, reason: 'aborted' }
      if (response) {
        if (response.status !== 'complete' || response.digest !== segment.digest || !Array.isArray(response.evidence) || response.evidence.length > 100) reason = 'invalid-response'
        else {
          const validated = []
          for (const item of response.evidence) {
            const record = records.get(item?.ref)
            if (!record || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 500 || !record.text.includes(item.quote)) {
              reason = 'invalid-evidence'
              // Pass only a trusted, existing record identifier. Never echo an
              // invalid model-generated quote or an invented identifier.
              retryIssue = record ? { ref: record.ref } : { unknownRef: true }
              break
            }
            validated.push({ ref: record.ref, role: record.role, quote: item.quote })
          }
          if (validated.length === response.evidence.length) { evidence = validated; break }
        }
      }
      // Provider/transport failures can be transient. Give them one extra,
      // bounded retry; malformed evidence and truncated replies retain their
      // original two-attempt limit. Never restart already completed segments.
      if (attempt >= (reason === 'extract-failed' ? 3 : 2) || typeof consumeRetry !== 'function' || !consumeRetry()) break
      onProgress?.({ phase: 'extract', completed: collected.length, total: segments.length, retry: true })
      if (reason === 'extract-failed' && retryDelayMs) {
        await new Promise(resolve => {
          const timer = setTimeout(done, retryDelayMs * attempt)
          function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
          if (signal?.aborted) done()
          else signal?.addEventListener('abort', done, { once: true })
        })
        if (signal?.aborted) return { status: 'incomplete', completed: collected.length, total: segments.length, reason: 'aborted' }
      }
    }
    if (!evidence) return { status: 'incomplete', completed: collected.length, total: segments.length, reason }
    collected.push({ index: segment.index, digest: segment.digest, refs: [...segment.refs], evidence })
    onProgress?.({ phase: 'extract', completed: collected.length, total: segments.length })
  }
  return { status: 'ready-for-global-review', segments: collected, recordCount: allRefs.size, warning: '分段处理完成不代表证据提取充分；必须全局复核原文及反证，不能仅凭此结果评分。' }
}
