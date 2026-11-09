// Experiment only: prepare a single exact replacement; never write a card.
// Quote matching and an independent reviewer cannot prove semantic correctness.
import { resolveEvidenceQuotes } from './stage-graph.js'

const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',')
const validText = (s, max = 160) => typeof s === 'string' && s === s.trim() && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s)

export async function prepareCharacterCorrection({ config, state, events, suggestion, review, signal, timeoutMs = 15000 }) {
  if (signal?.aborted) return { status: 'not-ready', reason: 'aborted' }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(state?.revision) || state.revision < 0 || !Array.isArray(config?.fields) || !exact(suggestion, ['field', 'oldText', 'newText', 'quote']) || typeof review !== 'function') return { status: 'not-ready', reason: 'invalid-input' }
  const { field: fieldId, oldText, newText, quote } = suggestion
  const field = config.fields.find(item => item?.id === fieldId)
  const previous = state.values?.[fieldId], revision = state.revision, label = field?.label
  if (!field || !validText(label, 40) || !validText(oldText) || !validText(newText) || typeof previous !== 'string' || !previous || oldText === newText) return { status: 'not-ready', reason: 'invalid-input' }
  const index = previous.indexOf(oldText)
  if (index < 0 || previous.indexOf(oldText, index + 1) !== -1) return { status: 'not-ready', reason: 'ambiguous-old-text' }
  const value = previous.slice(0, index) + newText + previous.slice(index + oldText.length)
  if (!validText(value, 240)) return { status: 'not-ready', reason: 'value-limit' }
  let evidence
  try { [evidence] = resolveEvidenceQuotes([quote], events) } catch { return { status: 'not-ready', reason: 'invalid-quote' } }
  if (!events.some(event => event.seq === evidence && event.role === 'assistant')) return { status: 'not-ready', reason: 'invalid-quote' }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, timeoutMs)
  try {
    if (controller.signal.aborted) return { status: 'not-ready', reason: 'aborted' }
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }))
    let outcome
    try {
      outcome = await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) return undefined
        return review({ field: label, previous, oldText, newText, value, quote }, controller.signal)
      }).then(value => ({ value })), cancelled])
    } catch { return { status: 'not-ready', reason: 'review-error' } }
    if (outcome.cancelled || controller.signal.aborted) return { status: 'not-ready', reason: signal?.aborted ? 'aborted' : 'timeout' }
    if (!exact(outcome.value, ['allow']) || outcome.value.allow !== true) return { status: 'not-ready', reason: outcome.value?.allow === false ? 'rejected' : 'invalid-review' }
    return { status: 'candidate', expectedRevision: revision, field: fieldId, value, quotes: [quote], evidence }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort() }
}
