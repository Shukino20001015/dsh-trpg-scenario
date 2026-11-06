// Mechanical checks only: these do not establish whether the chosen band or
// the cited facts are correct. The organiser must review the source material.
export const safeAuditLabel = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
export function auditScores(report, expectedNames, reference = {}) {
  const errors = []
  if (!Array.isArray(expectedNames) || expectedNames.length === 0 || new Set(expectedNames).size !== expectedNames.length || expectedNames.some(x => typeof x !== 'string' || !x.trim())) throw new TypeError('评分维度清单无效')
  if (!report || typeof report !== 'object' || !Array.isArray(report.dimensions)) return ['评分结果缺少维度清单']
  const names = report.dimensions.map(item => item?.name)
  if (names.length !== expectedNames.length || new Set(names).size !== names.length || expectedNames.some(name => !names.includes(name))) errors.push('评分维度与剧本不一致')
  const trustedBands = reference.bands
  const trustedEvidence = reference.evidence
  if (!trustedBands || typeof trustedBands !== 'object' || !Array.isArray(trustedEvidence)) errors.push('缺少可信评分档位或记录编号，无法完成校验')
  let total = 0, complete = true
  for (const item of report.dimensions) {
    const rawName = typeof item?.name === 'string' ? item.name : '未知维度'
    const name = safeAuditLabel(rawName)
    if (item?.score === null) {
      complete = false
      // An unassessed dimension need not cite evidence, but if it does, do
      // not describe nonexistent or malformed references as verified.
      if (item.evidence != null) {
        if (!Array.isArray(item.evidence) || item.evidence.some(x => typeof x !== 'string' || !x.trim())) errors.push(`${name}：证据引用格式无效`)
        else if (Array.isArray(trustedEvidence) && item.evidence.some(x => !trustedEvidence.includes(x))) errors.push(`${name}：引用的记录编号不存在`)
      }
      continue
    }
    const { score, band } = item || {}
    if (!Number.isFinite(score) || !band || !Number.isFinite(band.min) || !Number.isFinite(band.max) || band.min < 0 || band.min > band.max || score < band.min || score > band.max) {
      errors.push(`${name}：分数不在声明的档位范围内`)
      complete = false
      continue
    }
    if (trustedBands && (!Array.isArray(trustedBands[rawName]) || !trustedBands[rawName].some(entry => entry?.min === band.min && entry?.max === band.max))) errors.push(`${name}：声明的档位不属于剧本评分表`)
    if (!Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.some(x => typeof x !== 'string' || !x.trim())) errors.push(`${name}：缺少证据引用`)
    else if (Array.isArray(trustedEvidence) && item.evidence.some(x => !trustedEvidence.includes(x))) errors.push(`${name}：引用的记录编号不存在`)
    total += score
  }
  if (!complete && report.total !== null && report.total !== undefined) errors.push('存在无法评定或分数不合规的维度，不应给总分')
  if (complete && report.total !== null && report.total !== undefined && (!Number.isFinite(report.total) || Math.abs(report.total - total) > 1e-9)) errors.push('总分与各维度之和不一致')
  return errors
}
