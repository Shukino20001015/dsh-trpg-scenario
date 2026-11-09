import { partitionDialogue } from './segmented-judge.mjs'
import { auditScores } from './score-audit.js'
import { createHash } from 'node:crypto'
import { GlobalReviewFailure } from './global-judge-llm.mjs'

export async function reviewAllDimensions({ inspected, extracted, dimensions, context, review, signal, onProgress, consumeRetry, maxDialogueChars = 240000, timeoutMs = 30000 }) {
  if (!inspected || typeof inspected.dialogue !== 'string' || !Number.isSafeInteger(maxDialogueChars) || maxDialogueChars < 128 || inspected.dialogue.length > maxDialogueChars || !Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 6 || typeof review !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('全局复核输入无效或超过上限；不会静默裁剪')
  if (dimensions.some(d => !d || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 50 || typeof d.rubric !== 'string' || !d.rubric.trim() || d.rubric.length > 10000 || !Array.isArray(d.bands) || !d.bands.length || d.bands.length > 20 || d.bands.some(b => !b || Object.keys(b).sort().join(',') !== 'max,min' || !Number.isFinite(b.min) || !Number.isFinite(b.max) || b.min < 0 || b.max > 100 || b.min > b.max)) || new Set(dimensions.map(d => d.name)).size !== dimensions.length) throw new Error('评分维度或档位无效')
  for (const d of dimensions) for (let i = 0; i < d.bands.length; i++) for (let j = i + 1; j < d.bands.length; j++) if (d.bands[i].min <= d.bands[j].max && d.bands[j].min <= d.bands[i].max) throw new Error('评分档位重叠')
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).sort().join(',') !== 'base,caveats,goal,judge,opening,player,setting' || ['opening', 'player', 'setting', 'judge', 'goal'].some(k => typeof context[k] !== 'string' || context[k].length > 100000) || !context.opening.trim() || !context.judge.trim() || !Array.isArray(context.base) || !context.base.length || context.base.length > 50 || context.base.some(x => typeof x !== 'string' || !x.trim() || x.length > 10000) || !Array.isArray(context.caveats) || context.caveats.length > 50 || context.caveats.some(x => typeof x !== 'string' || !x.trim() || x.length > 10000)) throw new Error('缺少完整评委上下文')
  const frozenDimensions = structuredClone(dimensions), frozenContext = structuredClone(context)
  // Rebuild the trusted record map from original dialogue, not model output.
  const sourceSegments = partitionDialogue(inspected, Math.max(128, inspected.dialogue.length))
  const records = sourceSegments.flatMap(s => s.records)
  const recordMap = new Map(records.map(r => [r.ref, r]))
  if (extracted?.status !== 'ready-for-global-review' || !Array.isArray(extracted.segments) || !extracted.segments.length || extracted.recordCount !== records.length) throw new Error('分段证据未完成')
  const candidates = [], seenRefs = []
  for (let i = 0; i < extracted.segments.length; i++) {
    const segment = extracted.segments[i]
    if (segment?.index !== i + 1 || !Array.isArray(segment.refs) || !segment.refs.length || !Array.isArray(segment.evidence)) throw new Error('分段结果缺失或顺序异常')
    const local = new Set(segment.refs)
    if (local.size !== segment.refs.length) throw new Error('分段记录重复')
    const text = segment.refs.map(ref => {
      const record = recordMap.get(ref)
      if (!record) throw new Error('分段记录不存在')
      const role = record.role === 'player' ? '玩家原始输入' : record.role === 'uncertain' ? '主持混合文本（是否展示未知）' : '主持生成（含人物对话与可能的代写）'
      return `[${ref} · ${role}] ${JSON.stringify(record.text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}`
    }).join('\n\n')
    if (segment.digest !== createHash('sha256').update(text).digest('hex')) throw new Error('分段摘要与原记录不一致')
    seenRefs.push(...segment.refs)
    for (const item of segment.evidence) {
      const original = recordMap.get(item?.ref)
      if (!original || !local.has(item.ref) || item.role !== original.role || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 500 || !original.text.includes(item.quote)) throw new Error('候选证据无法回溯原文')
      candidates.push({ ref: item.ref, role: original.role, quote: item.quote })
    }
  }
  if (seenRefs.length !== records.length || seenRefs.some((ref, i) => ref !== records[i].ref)) throw new Error('分段结果未完整覆盖原记录')
  const results = []
  for (const dimension of frozenDimensions) {
    onProgress?.({ phase: 'review', completed: results.length, total: dimensions.length })
    if (signal?.aborted) return { status: 'incomplete', completed: results.length, total: dimensions.length, reason: 'aborted' }
    let response, output, reason
    for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(onAbort, timeoutMs)
    try {
      if (signal?.aborted) controller.abort()
      const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }))
      if (controller.signal.aborted) return { status: 'incomplete', completed: results.length, total: dimensions.length, reason: 'aborted' }
      const result = await Promise.race([Promise.resolve().then(() => review({ dimension: structuredClone(dimension), context: structuredClone(frozenContext), records: structuredClone(records), candidates: structuredClone(candidates), ...(attempt > 1 ? { retry: true } : {}) }, controller.signal)).then(value => ({ value })), aborted])
      if (result.aborted) return { status: 'incomplete', completed: results.length, total: dimensions.length, reason: signal?.aborted ? 'aborted' : 'timeout' }
      response = result.value
    } catch (error) { return { status: 'incomplete', completed: results.length, total: dimensions.length, reason: signal?.aborted ? 'aborted' : error instanceof GlobalReviewFailure && ['timeout', 'output-limit', 'model-truncated', 'stream-incomplete'].includes(error.reason) ? error.reason : 'review-failed' } }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    if (signal?.aborted) return { status: 'incomplete', completed: results.length, total: dimensions.length, reason: 'aborted' }
    reason = undefined
    if (!response || response.status !== 'complete' || response.name !== dimension.name || typeof response.rationale !== 'string' || !response.rationale.trim() || response.rationale.length > 4000 || !Array.isArray(response.evidence) || response.evidence.length > 100 || response.evidence.some(item => !item || typeof item.ref !== 'string' || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 500 || recordMap.get(item.ref)?.role === 'uncertain' || !recordMap.get(item.ref)?.text.includes(item.quote))) reason = 'invalid-review'
    else {
      output = { name: dimension.name, score: response.score, band: response.band, evidence: response.evidence.map(item => item.ref) }
      if (auditScores({ dimensions: [output], total: null }, [dimension.name], { bands: { [dimension.name]: dimension.bands }, evidence: inspected.recordIds }).length || (output.score === null && output.band != null)) reason = 'invalid-score'
    }
    if (!reason) break
    if (attempt === 2 || typeof consumeRetry !== 'function' || !consumeRetry()) return { status: 'incomplete', completed: results.length, total: dimensions.length, reason }
    onProgress?.({ phase: 'review', completed: results.length, total: dimensions.length, retry: true })
    }
    results.push({ ...output, rationale: response.rationale, quotations: response.evidence.map(item => ({ ref: item.ref, role: recordMap.get(item.ref).role, quote: item.quote })) })
    onProgress?.({ phase: 'review', completed: results.length, total: dimensions.length })
  }
  const hasUncertain = records.some(record => record.role === 'uncertain')
  return { status: 'human-review-required', dimensions: results, total: hasUncertain || results.some(r => r.score === null) ? null : results.reduce((sum, r) => sum + r.score, 0), warning: hasUncertain ? '存在是否展示未知的混合文本，本结果不计算总分；模型可能受其影响，必须由人对照完整记录复核。' : '模型可能遗漏、误解或错用证据；分值、引文与档位必须由人对照完整记录复核。' }
}
