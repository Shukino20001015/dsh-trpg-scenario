// Experimental preparation only; does not mutate state or perform a commit.
// A verified quotation is not proof that a delta belongs to a field.
import { resolveEvidenceQuotes } from './stage-graph.js'
const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join(',') === [...keys].sort().join(',')
const valid = s => typeof s === 'string' && s === s.trim() && s.length > 0 && s.length <= 160 && !/[\u0000-\u001f\u007f]/.test(s)

export async function prepareCharacterDelta({ config, state, events, suggestion, review, signal, timeoutMs = 15000 }) {
  if (signal?.aborted) return { status: 'not-ready', reason: 'aborted' }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(state?.revision) || !Array.isArray(config?.fields) || !exact(suggestion, ['field', 'addition', 'quote']) || !config.fields.some(x => x.id === suggestion.field) || !valid(suggestion.addition) || typeof review !== 'function') return { status: 'not-ready', reason: 'invalid-input' }
  // Snapshot the entire proposal before yielding to the reviewer. Otherwise a
  // caller could mutate it while review is pending and change the candidate
  // field or evidence after a different claim has been approved.
  const { field: fieldId, addition, quote } = suggestion
  // A conservative formatting gate, not a semantic proof: semicolon-separated
  // claims must be proposed and reviewed separately.
  if (/[；;]/.test(addition)) return { status: 'not-ready', reason: 'compound-delta' }
  const previous = state.values?.[fieldId]
  if (typeof previous !== 'string' || !previous || previous.includes(addition)) return { status: 'not-ready', reason: 'no-change' }
  let evidence
  try { [evidence] = resolveEvidenceQuotes([quote], events) } catch { return { status: 'not-ready', reason: 'invalid-quote' } }
  if (!events.some(e => e.seq === evidence && e.role === 'assistant')) return { status: 'not-ready', reason: 'invalid-quote' }
  const fieldLabel = config.fields.find(x => x.id === fieldId).label
  const revision = state.revision
  const value = previous + (/[。！？；]$/.test(previous) ? ' ' : '；') + addition
  if (value.length > 240) return { status: 'not-ready', reason: 'value-limit' }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once:true })
  const timer = setTimeout(cancel, timeoutMs)
  let judgment
  try {
    if (controller.signal.aborted) return { status:'not-ready', reason:'aborted' }
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ cancelled:true }), { once:true }))
    let outcome
    try { outcome = await Promise.race([Promise.resolve().then(() => review({ field:fieldLabel, previous, addition, quote }, controller.signal)).then(value => ({ value })), cancelled]) }
    catch { return { status:'not-ready', reason:'review-error' } }
    if (outcome.cancelled || controller.signal.aborted) return { status:'not-ready', reason:signal?.aborted ? 'aborted' : 'timeout' }
    judgment = outcome.value
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort() }
  if (!exact(judgment, ['allow']) || judgment.allow !== true) return { status: 'not-ready', reason: judgment?.allow === false ? 'rejected' : 'invalid-review' }
  return { status: 'candidate', expectedRevision: revision, field: fieldId, value, quotes: [quote], evidence }
}
