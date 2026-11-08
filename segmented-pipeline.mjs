import { prepareFrozenSegmentReview } from './frozen-segment-prepare.mjs'
import { partitionDialogue, collectEvidence } from './segmented-judge.mjs'
import { makeSegmentExtractor } from './segmented-judge-llm.mjs'
import { reviewAllDimensions } from './segmented-global-review.mjs'
import { makeGlobalReviewer } from './global-judge-llm.mjs'

export async function runSegmentedPipeline({ root, buffer, llm, provider, model, reasoningEffort, loadInstalledSnapshot, allowUncertainMixed = false, signal, onProgress, segmentChars = 6000, maxCalls = 100, timeoutMs = 120000, maxInputChars = 500000 }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 200) throw new Error('模型调用上限无效')
  const prepared = await prepareFrozenSegmentReview({ root, buffer, loadInstalledSnapshot, allowUncertainMixed })
  const segments = partitionDialogue(prepared.inspected, segmentChars)
  if (segments.length + prepared.dimensions.length > maxCalls) return { status: 'incomplete', phase: 'prepare', reason: 'call-budget', requiredCalls: segments.length + prepared.dimensions.length }
  let retryBudget = maxCalls - segments.length - prepared.dimensions.length
  const extract = makeSegmentExtractor({ llm, provider, model, reasoningEffort, criteria: prepared.dimensions.map(d => d.name), timeoutMs })
  const review = makeGlobalReviewer({ llm, provider, model, reasoningEffort, timeoutMs, maxInputChars })
  const records = segments.flatMap(segment => segment.records)
  if (prepared.dimensions.some(dimension => JSON.stringify({ dimension, context: prepared.context, records, candidates: [] }).length > maxInputChars)) return { status: 'incomplete', phase: 'prepare', reason: 'global-input-limit' }
  const indexed = await collectEvidence(segments, extract, { signal, onProgress, consumeRetry: () => retryBudget > 0 && (--retryBudget >= 0), expectedRecordIds: prepared.inspected.recordIds, expectedDialogue: prepared.inspected.dialogue })
  if (indexed.status !== 'ready-for-global-review') return { status: 'incomplete', phase: 'extract', reason: indexed.reason, completed: indexed.completed, total: indexed.total }
  const result = await reviewAllDimensions({ inspected: prepared.inspected, extracted: indexed, dimensions: prepared.dimensions, context: prepared.context, review, signal, onProgress, timeoutMs })
  if (result.status !== 'human-review-required') return { ...result, phase: 'global-review' }
  return { ...result, scenarioId: prepared.scenarioId, versionHash: prepared.versionHash, versionSource: prepared.versionSource, recordCount: prepared.inspected.recordIds.length, segmentCount: segments.length, caveats: prepared.context.caveats }
}
