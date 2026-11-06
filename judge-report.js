import { auditScores, safeAuditLabel } from './score-audit.js'

// Some models ignore the requested fence label and use plain `json`. Accept
// that fallback only when it is the sole eligible block and has a groups
// array. Never choose between several blocks or bypass downstream validation.
export function parseScoreReport(text) {
  if (typeof text !== 'string') throw new Error('报告不是文本')
  const blocks = [...text.matchAll(/```(trpg-score-json|json)\s*\n([\s\S]*?)\n```/g)]
  if (blocks.length !== 1 || blocks[0][2].length > 65536) throw new Error('报告缺少唯一有效的结构化评分块')
  let report
  try { report = JSON.parse(blocks[0][2]) } catch { throw new Error('结构化评分块不是有效 JSON') }
  if (!report || typeof report !== 'object' || !Array.isArray(report.groups)) throw new Error('结构化评分块缺少分组清单')
  return report
}

// Some model reports qualify a reference with its group (e.g. 第1组 记录1).
// Normalize only an exact same-group reference found in the frozen index.
// Keep the original report untouched; malformed and cross-group references
// remain invalid and are rejected by the ordinary audit.
export function canonicalizeEvidenceReferences(report, groups) {
  if (!Array.isArray(report?.groups) || !Array.isArray(groups)) return { report, normalizedCount: 0 }
  let normalizedCount = 0
  const normalized = { ...report, groups: report.groups.map(result => {
    if (!result || !Number.isSafeInteger(result.group) || result.group < 1 || !Array.isArray(result.dimensions)) return result
    const trusted = groups[result.group - 1]
    if (!Array.isArray(trusted) || new Set(trusted).size !== trusted.length) return result
    return { ...result, dimensions: result.dimensions.map(item => {
      if (!item || !Array.isArray(item.evidence)) return item
      return { ...item, evidence: item.evidence.map(ref => {
        if (typeof ref !== 'string') return ref
        const match = /^第([1-9]\d{0,14})组 记录([1-9]\d{0,14})$/.exec(ref)
        if (!match || match[1] !== String(result.group)) return ref
        const canonical = `记录 ${match[2]}`
        if (!trusted.includes(canonical)) return ref
        normalizedCount++
        return canonical
      }) }
    }) }
  }) }
  return { report: normalized, normalizedCount }
}

// `groups` and `bands` must come from the plugin's own frozen assessment
// inputs, never from the model's report. This checks syntax, not merit.
export function auditGroupReports(report, groups, bands) {
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(bands) || !bands.length) return ['缺少可信剧本档位或分组记录，无法完成校验']
  if (!report || !Array.isArray(report.groups)) return ['评分结果缺少分组清单']
  const errors = []
  const ids = report.groups.map(group => group?.group)
  const expected = groups.map((_, i) => i + 1)
  if (ids.length !== expected.length || new Set(ids).size !== ids.length || expected.some(id => !ids.includes(id))) errors.push('评分结果与导入的分组不一致')
  const names = bands.map(item => item.name)
  const trustedBands = Object.fromEntries(bands.map(item => [item.name, item.bands]))
  for (const result of report.groups) {
    if (!Number.isSafeInteger(result?.group) || !groups[result.group - 1]) continue
    for (const issue of auditScores(result, names, { bands: trustedBands, evidence: groups[result.group - 1] })) errors.push(`${groups.length === 1 ? '本次游玩' : `第 ${result.group} 组`}：${issue}`)
  }
  return errors
}

// A GM response can contain evidence, but may also paraphrase or invent a
// player action. This is a review cue, never proof that the judgment is wrong.
// Missing metadata is normal for old saved judge sessions.
export function playerEvidenceReviewWarnings(report, playerRecords, groupRecords) {
  if (!Array.isArray(playerRecords) || !Array.isArray(report?.groups)) return []
  const warnings = []
  for (const group of report.groups) {
    if (!Number.isSafeInteger(group?.group) || !Array.isArray(group.dimensions)) continue
    const label = report.groups.length === 1 && playerRecords.length === 1 && group.group === 1 ? '本次游玩' : `第 ${group.group} 组`
    const players = playerRecords[group.group - 1]
    if (!Array.isArray(players)) {
      warnings.push(`${label}：缺少记录角色信息，请自行核对玩家发言与智能体叙述。`)
      continue
    }
    let hasMixedEvidence = false, addedHostIntro = false
    // Group record order comes from the validated original dialogue index.
    // The nearest preceding player message is only a navigation hint: a host
    // reply may also depend on earlier turns and may contain its own actions.
    const allRecords = groupRecords?.[group.group - 1]
    const precedingPlayer = new Map()
    const allSet = Array.isArray(allRecords) ? new Set(allRecords) : null
    const playerSet = new Set(players)
    const ordered = Array.isArray(allRecords) && allSet.size === allRecords.length && allRecords.every((ref, i) =>
      typeof ref === 'string' && /^记录 [1-9]\d{0,14}$/.test(ref) &&
      (i === 0 || Number(allRecords[i - 1].slice(3)) < Number(ref.slice(3))))
    const rolesConsistent = playerSet.size === players.length && players.every(ref => allSet?.has(ref))
    if (Array.isArray(allRecords) && (!ordered || !rolesConsistent)) {
      warnings.push(`${label}：记录顺序或角色索引不一致，无法可靠区分玩家和主持记录，请对照原始日志人工核查。`)
      continue
    }
    if (ordered && rolesConsistent) {
      let latestPlayer = null
      for (const ref of allRecords) {
        if (playerSet.has(ref)) latestPlayer = ref
        else if (latestPlayer) precedingPlayer.set(ref, latestPlayer)
      }
    }
    for (const item of group.dimensions) {
      if (!Number.isFinite(item?.score) || typeof item.name !== 'string' || !Array.isArray(item.evidence) || !item.evidence.length) continue
      if (item.evidence.every(ref => typeof ref === 'string' && !players.includes(ref))) {
        const name = safeAuditLabel(item.name)
        warnings.push(`${label}：${name}的结构化引用未包含玩家发言，请对照上下文核实是否把智能体叙述误当玩家行动。`)
      }
      if (item.evidence.some(ref => typeof ref === 'string' && players.includes(ref)) && item.evidence.some(ref => typeof ref === 'string' && !players.includes(ref))) hasMixedEvidence = true
      // Only label IDs from the trusted dialogue index; do not echo arbitrary
      // model-supplied strings or imply that a host record is incorrect.
      const all = groupRecords?.[group.group - 1]
      if (Array.isArray(all)) {
        const validRefs = [...new Set(item.evidence.filter(ref => typeof ref === 'string' && /^记录 [1-9]\d{0,14}$/.test(ref) && all.includes(ref)))]
        const hostRefs = validRefs.filter(ref => !players.includes(ref))
        if (hostRefs.length) {
          const displayRefs = refs => refs.length ? refs.slice(0, 15).join('、') + (refs.length > 15 ? `（另有 ${refs.length - 15} 条，请查看结构化引用）` : '') : '无'
          if (!addedHostIntro) {
            warnings.push(`${label}：下列维度引用了主持记录。请对照玩家原始输入；主持叙述可证明回应或情节，但不自动证明玩家主动选择。`)
            addedHostIntro = true
          }
          warnings.push(`  ${safeAuditLabel(item.name)}：玩家 ${displayRefs(validRefs.filter(ref => players.includes(ref)))}；主持 ${displayRefs(hostRefs)}`)
          const nearby = hostRefs.slice(0, 15).filter(ref => precedingPlayer.has(ref)).map(ref => `${ref} ← 前一条玩家 ${precedingPlayer.get(ref)}`)
          if (nearby.length) warnings.push(`  相邻定位（仅供寻找上下文，不代表完整依据）：${nearby.join('；')}${hostRefs.length > 15 ? '；其余请查看原始记录' : ''}`)
        }
      }
    }
    if (hasMixedEvidence) warnings.push(`${label}：部分评分同时引用玩家发言和智能体回复；请核对玩家实际授权或作出的行为，不能把主持自行补写的经历或决定当成玩家成果。`)
  }
  return warnings
}

// Narrow text-origin cue only. Explicitly quoted player speech is checked for
// exact occurrence in that group's original player inputs; a mismatch may be
// legitimate paraphrase, punctuation or a played role, so it is a review cue,
// not a score error. Never echo the quote or infer semantic truth.
export function playerQuoteReviewWarnings(text, playerInputs) {
  if (typeof text !== 'string' || !Array.isArray(playerInputs) || !playerInputs.length) return []
  // Suppress fenced/inline examples, including an unclosed fence, in a single
  // linear pass; matching an unclosed fence with a nested regex is quadratic.
  let fenced = false
  const body = text.split('\n').map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return '' }
    return fenced ? '' : line.replace(/`[^`\n]*`/g, '')
  }).join('\n')
  const headers = [...body.matchAll(/^#{1,3}\s+第\s*([1-6一二三四五六])\s*组(?:\s*$|\s*[：:—-]|\s*(?:评审|评分|报告|评析|过程))/gm)]
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const headerIds = headers.map(h => chinese[h[1]] || Number(h[1]))
  if (playerInputs.length > 1 && (headers.length !== playerInputs.length || new Set(headerIds).size !== playerInputs.length || headerIds.some(id => id < 1 || id > playerInputs.length))) return []
  const playerQuotes = value => [...value.matchAll(/(?:本组玩家|玩家)(?:明确|直接|主动|当场|曾经|曾|又|继续|随后|实际|还|则|则又|说|表示|写|回复|回答|称|提出|表达|提到|问|追问|询问|了|地|的|[，：:、\s]){0,30}[“「]([^”」\n]{4,120})[”」]/g)]
    .filter(match => !/(?:对|向|被|替|给|建议|要求|请)(?:本组)?$/.test(value.slice(Math.max(0, match.index - 5), match.index)))
  const warnings = []
  for (let i = 0; i < playerInputs.length; i++) {
    const inputs = playerInputs[i]
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some(value => typeof value !== 'string')) continue
    const header = headers.find(item => (chinese[item[1]] || Number(item[1])) === i + 1)
    if (playerInputs.length > 1 && !header) continue
    const next = header && headers.find(item => item.index > header.index)
    let scope = header ? body.slice(header.index, next?.index ?? body.length) : body
    if (playerInputs.length > 1 && !next) {
      const summary = /^(?:#{1,3}\s*|\s*)(?:\*\*)?(?:总结|总述|各组比较|总体比较|综合比较|结语|附录)(?:\*\*)?\s*(?:[：:]|$)/m.exec(scope)
      if (summary) scope = scope.slice(0, summary.index)
    }
    const quotes = playerQuotes(scope)
    const notInAnyInput = quotes.some(match => !Object.values(inputs).some(input => input.includes(match[1])))
    // A specific record can narrow an explicitly attributed player's quote;
    // merely citing a player record on the same line does not identify the
    // speaker (the quoted words might belong to an NPC).
    const mismatchedSpecificRecord = scope.split('\n').some(line => {
      if (/记录\s*\d+\s*(?:[、,，–—→-]|至|到|和|与|及|跟|以及)\s*(?:记录\s*)?\d+/.test(line)) return false
      const refs = [...line.matchAll(/记录\s*(\d+)/g)].map(match => `记录 ${match[1]}`)
      if (refs.length !== 1 || !Object.hasOwn(inputs, refs[0])) return false
      const citedQuotes = playerQuotes(line)
      return citedQuotes.some(match => !inputs[refs[0]].includes(match[1]))
    })
    if (notInAnyInput || mismatchedSpecificRecord) warnings.push(`${playerInputs.length === 1 ? '本次游玩' : `第 ${i + 1} 组`}：报告中有归属于玩家的引文未在对应玩家原始输入中逐字找到；可能是转述、代写或截取差异，请对照上下文人工核对。`)
  }
  return warnings
}

// Call only after auditGroupReports returned no issues. This is a comparison
// aid, not an alternative to the evidence and rubric.
export function formatAuditedScores(report) {
  return report.groups.map(group => {
    const lines = group.dimensions.map(item => {
      const name = safeAuditLabel(item.name)
      return item.score === null ? `  ${name}：无法评定` : `  ${name}：${item.score} 分（${item.band.min}–${item.band.max} 档）`
    })
    return [report.groups.length === 1 ? '本次游玩' : `第 ${group.group} 组`, ...lines, `  总分：${group.total == null ? '未给出' : `${group.total} 分`}`].join('\n')
  }).join('\n\n')
}

// This is a review prompt, not a finding that the model is wrong: a declared
// complete record may still contain genuine evidence of truncation.
export function completenessReviewWarning(text, confirmedComplete) {
  if (confirmedComplete !== true || typeof text !== 'string') return null
  const withoutJson = text.replace(/```trpg-score-json\s*\n[\s\S]*?\n```/g, '')
  if (!/^\s*(?:[-*>]\s*)?(?:\*\*)?完整性(?:\*\*)?\s*[：:]\s*(?:\*\*)?无法判断/m.test(withoutJson)) return null
  return '组织者已声明逐份核对全程，但报告中有“完整性：无法判断”。请核对报告是否指出具体的截断或冲突证据；声明不等于系统验证，也不应忽略实际异常。'
}

// A narrow wording cue, not proof of contradiction: an incomplete record
// may contain an uncited claim about the entire game. Skip quoted examples and
// code blocks, and never echo the source text in the warning.
export function coverageClaimReviewWarning(text, confirmedComplete) {
  if (typeof text !== 'string') return null
  let fenced = false
  const body = text.split('\n').map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return '' }
    return fenced ? '' : line.replace(/`[^`\n]*`|“[^”\n]*”|「[^」\n]*」/g, '')
  }).join('\n')
  // A human declaration is not proof when the report itself raises doubts.
  if (confirmedComplete === true && !/完整性[^\n]{0,30}(?:无法判断|未确认|不完整|存疑)/.test(body)) return null
  if (!/(?:全程|整局|从头到尾)(?:都|均|也)?(?:没有|未曾|从未|没(?:有)?)/.test(body)) return null
  return '记录覆盖全程尚未确认或报告存在疑问，但报告使用了“全程没有”等表述；请核对是否把记录中未见误写成整局未发生。该提示不判断结论真假。'
}

// Conservative best-effort check for an explicit contradiction observed in
// model outputs. Unrecognized layouts and all other contradictions still need
// human review; never interpret absence of a warning as semantic validation.
export function findExplicitTextConflicts(text, report) {
  if (typeof text !== 'string' || !Array.isArray(report?.groups) || !report.groups.length) return []
  // Code blocks are quoted material, not report headings or conclusions.
  const body = text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '')
  const groupHeaders = [...body.matchAll(/^#{1,3}\s+第\s*(\d+|[一二三四五六七八九十])\s*组(?:\s*$|\s*[：:—-]|\s*(?:评审|评分|报告))/gm)]
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const warnings = []
  for (const group of report.groups) {
    if (!Number.isSafeInteger(group?.group) || !Array.isArray(group.dimensions)) continue
    const matching = groupHeaders.filter(header => (chinese[header[1]] ?? Number(header[1])) === group.group)
    // An ambiguous or unlabelled multi-group report cannot be safely scoped.
    if (report.groups.length > 1 && (matching.length !== 1 || groupHeaders.length !== report.groups.length)) continue
    const header = matching[0]
    const start = header ? header.index + header[0].length : 0
    const nextGroup = header && groupHeaders.find(next => next.index > header.index)
    const scoped = body.slice(start, nextGroup?.index ?? body.length)
    const sections = [...scoped.matchAll(/^#{1,6}\s+[^\n]+/gm)]
    for (const item of group.dimensions) {
      if (typeof item?.name !== 'string' || (item.score !== null && !Number.isFinite(item.score))) continue
      const headings = sections.filter(section => section[0].includes(item.name))
      if (headings.length !== 1) continue
      const heading = headings[0]
      const next = sections.find(section => section.index > heading.index)
      const content = scoped.slice(heading.index + heading[0].length, next?.index ?? scoped.length)
      if (Number.isFinite(item.score) && /结论\s*[：:]\s*(?:\*\*\s*)?无法评定/.test(content)) warnings.push(`${report.groups.length === 1 ? '本次游玩' : `第 ${group.group} 组`}：${safeAuditLabel(item.name)}在文字结论中写“无法评定”，结构化结果却给出分数`)
      // Only match a direct numeric conclusion, not an example or a band range.
      const numeric = /结论\s*[：:]\s*(?:\*\*\s*)?(?:给\s*)?(\d+(?:\.\d+)?)\s*(?:分|\s*\/\s*\d+)/.exec(content)
      if (numeric && item.score === null) warnings.push(`${report.groups.length === 1 ? '本次游玩' : `第 ${group.group} 组`}：${safeAuditLabel(item.name)}在文字结论中给出分数，结构化结果却写无法评定`)
      else if (numeric && Number.isFinite(item.score) && Number(numeric[1]) !== item.score) warnings.push(`${report.groups.length === 1 ? '本次游玩' : `第 ${group.group} 组`}：${safeAuditLabel(item.name)}的文字结论与结构化结果分数不同`)
    }
  }
  return warnings
}
