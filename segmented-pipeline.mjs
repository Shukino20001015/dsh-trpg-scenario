import { prepareFrozenSegmentReview } from './frozen-segment-prepare.mjs'
import { partitionDialogue, collectEvidence } from './segmented-judge.mjs'
import { makeSegmentExtractor } from './segmented-judge-llm.mjs'
import { reviewAllDimensions } from './segmented-global-review.mjs'
import { makeGlobalReviewer } from './global-judge-llm.mjs'

// A navigation aid only: text matching cannot decide whether a correction is
// valid, whether the host accepted it, or whether a score should change.
export function possiblePlayerCorrections(records) {
  if (!Array.isArray(records)) throw new Error('缺少对话记录')
  const cue = /(?:更正|纠正|误写|写错|说错|不是我说|我(?:刚才|之前|上次|当时|今晚)?[^。！？\n]{0,40}?(?:没有|没|未)(?:说|讲|发|回复|同意|答应|签|做|选择|要求|提出|表示))/u
  let hasEarlierHost = false
  const refs = []
  for (const record of records) {
    if (record?.role === 'host') hasEarlierHost = true
    if (hasEarlierHost && record?.role === 'player' && /^记录 \d+$/.test(record.ref) && typeof record.text === 'string' && cue.test(record.text)) refs.push(record.ref)
  }
  return refs
}

// This is a narrow review aid, not a spoiler filter. Only flag quoted text
// appearing in hidden judge materials but not in any known public source.
export function dimensionsWithUnseenQuotedMaterial(dimensions, context, records) {
  if (!Array.isArray(dimensions) || !context || !Array.isArray(records)) throw new Error('缺少报告或对话')
  const visible = [context.opening, context.player, context.goal, ...records.filter(r => r?.role === 'player' || r?.role === 'host').map(r => r.text)].filter(v => typeof v === 'string')
  const hidden = [context.setting, context.judge, ...dimensions.map(d => d.rubric)].filter(v => typeof v === 'string')
  return dimensions.filter(d => {
    if (typeof d?.rationale !== 'string') return false
    const quotes = d.rationale.matchAll(/“([^”\n]{4,200})”|「([^」\n]{4,200})」|"([^"\n]{4,200})"/gu)
    for (const match of quotes) {
      const quote = match[1] || match[2] || match[3]
      if (hidden.some(text => text.includes(quote)) && !visible.some(text => text.includes(quote))) return true
    }
    return false
  }).map(d => d.name)
}

export async function runSegmentedPipeline({ root, buffer, llm, provider, model, reasoningEffort, loadInstalledSnapshot, allowUncertainMixed = false, signal, onProgress, segmentChars = 6000, maxCalls = 100, timeoutMs = 120000, maxInputChars = 500000 }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 200) throw new Error('模型调用上限无效')
  const prepared = await prepareFrozenSegmentReview({ root, buffer, loadInstalledSnapshot, allowUncertainMixed })
  const segments = partitionDialogue(prepared.inspected, segmentChars)
  if (segments.length + prepared.dimensions.length > maxCalls) return { status: 'incomplete', phase: 'prepare', reason: 'call-budget', requiredCalls: segments.length + prepared.dimensions.length }
  let retryBudget = maxCalls - segments.length - prepared.dimensions.length
  const extract = makeSegmentExtractor({ llm, provider, model, reasoningEffort, criteria: prepared.dimensions.map(d => d.name), timeoutMs })
  const review = makeGlobalReviewer({ llm, provider, model, reasoningEffort, timeoutMs, maxInputChars })
  const records = segments.flatMap(segment => segment.records)
  const corrections = possiblePlayerCorrections(records)
  if (corrections.length) prepared.context.caveats.push(`玩家发言中${corrections.slice(0, 30).join('、')}${corrections.length > 30 ? ` 等共 ${corrections.length} 条` : ''}含可能的更正或否认；请对照前后对话和主持回应人工核对。仅按措辞定位，可能误报或漏报，不自动认定事实或修改分数。`)
  if (prepared.dimensions.some(dimension => JSON.stringify({ dimension, context: prepared.context, records, candidates: [] }).length > maxInputChars)) return { status: 'incomplete', phase: 'prepare', reason: 'global-input-limit' }
  const consumeRetry = () => retryBudget > 0 && (--retryBudget >= 0)
  const indexed = await collectEvidence(segments, extract, { signal, onProgress, consumeRetry, expectedRecordIds: prepared.inspected.recordIds, expectedDialogue: prepared.inspected.dialogue })
  if (indexed.status !== 'ready-for-global-review') return { status: 'incomplete', phase: 'extract', reason: indexed.reason, completed: indexed.completed, total: indexed.total }
  const result = await reviewAllDimensions({ inspected: prepared.inspected, extracted: indexed, dimensions: prepared.dimensions, context: prepared.context, review, signal, onProgress, consumeRetry, timeoutMs })
  if (result.status !== 'human-review-required') return { ...result, phase: 'global-review' }
  const riskDimensions = dimensionsWithUnseenQuotedMaterial(result.dimensions.map(d => ({ ...d, rubric: prepared.dimensions.find(p => p.name === d.name)?.rubric })), prepared.context, records)
  if (riskDimensions.length) prepared.context.caveats.push(`可能涉及未公开剧本内容的引文：${riskDimensions.join('、')}。请组织者核对后再分享；文字匹配可能误报或漏报，未提示不代表没有剧透。`)
  return { ...result, scenarioId: prepared.scenarioId, versionHash: prepared.versionHash, versionSource: prepared.versionSource, recordCount: prepared.inspected.recordIds.length, segmentCount: segments.length, caveats: prepared.context.caveats }
}
