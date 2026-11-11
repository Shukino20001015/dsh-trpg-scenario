// snapshot; not registered in production and never searches arbitrary paths.
import { inspectDialogue, inspectScenarioReference } from './judge-log.js'
import { readSnapshot, snapshotHash, snapshotPolicy } from './snapshot-store.js'
import { requireId } from './scenario-store.js'
import { STAGE_CORRECTION_CONTRACT } from './stage-tool.js'

export async function prepareFrozenSegmentReview({ root, buffer, loadInstalledSnapshot, allowUncertainMixed = false }) {
  if (typeof root !== 'string' || !root || !Buffer.isBuffer(buffer)) throw new Error('准备输入无效')
  const reference = inspectScenarioReference(buffer)
  if (!reference?.id || !reference?.hash) throw new Error('日志缺少唯一完整开局版本，无法自动匹配快照')
  requireId(reference.id)
  let snapshot, versionSource = 'local-snapshot'
  try { snapshot = await readSnapshot(root, reference.hash) }
  catch (error) {
    // Only a genuinely absent snapshot may fall back. A damaged, unreadable,
    // unsafe or mismatched snapshot is not silently replaced by a live copy.
    if (error?.code !== 'ENOENT' || typeof loadInstalledSnapshot !== 'function') throw new Error('原版快照缺失或无法校验，不能启动分段评分')
    try {
      snapshot = await loadInstalledSnapshot(reference.id)
      if (snapshot?.sc?.meta?.id !== reference.id || snapshotHash(snapshot) !== reference.hash) throw new Error('版本不符')
      versionSource = 'matching-installed-version'
    } catch { throw new Error('原版快照缺失，已安装剧本及插件规则无法匹配原始版本') }
  }
  const { sc, continuity, judgeBase, stageProtocol } = snapshot
  if (sc.meta.id !== reference.id) throw new Error('快照剧本编号与日志不一致')
  if (sc.stageGraph && !stageProtocol) throw new Error('阶段规则未冻结，不能启动分段评分')
  if (!Array.isArray(sc.criteria) || !Array.isArray(sc.scoreBands) || !sc.rubric.trim() || !sc.judge.trim() || !judgeBase.length) throw new Error('原版评分维度、档位或规则不完整')
  const inspected = inspectDialogue(buffer, '游玩记录', sc.stageGraph ? { stageGraph: sc.stageGraph, ...(sc.characterConfig ? { characterConfig: sc.characterConfig } : {}), allowStageCorrections: stageProtocol?.contract === STAGE_CORRECTION_CONTRACT, allowUncertainMixed } : {})
  if (inspected.scenarioId !== reference.id || inspected.versionHash !== reference.hash || inspected.playPolicy !== snapshotPolicy(sc, continuity)) throw new Error('日志与快照的开局版本或游玩规则不一致')
  const dimensions = sc.criteria.map(criterion => ({ name: criterion.name, rubric: sc.rubric, bands: structuredClone(sc.scoreBands.find(item => item.name === criterion.name).bands) }))
  const caveats = ['日志完整性未经系统证明；不要仅凭自然结尾或编号跳号判断完整或截断。']
  if (inspected.internalStageAutoSeqs.length) caveats.push(`记录 ${inspected.internalStageAutoSeqs.join('、')} 为后台阶段候选，不是玩家发言，也不能证明剧情事实；记录来源未经认证，请组织者核对原始日志。`)
  if (inspected.internalCharacterAutoSeqs.length) caveats.push(`记录 ${inspected.internalCharacterAutoSeqs.join('、')} 为后台角色状态候选，不是玩家发言，也不能证明剧情事实；记录来源未经认证，请组织者核对原始日志。`)
  if (inspected.uncertainMixedSeqs.length) caveats.push(`记录 ${inspected.uncertainMixedSeqs.join('、')} 的主持文本与工具调用混合，是否向玩家展示未知；不得视为玩家已知事实或作为评分依据，必须人工核对。`)
  if (inspected.abortedTurnRanges.length) caveats.push(`以下游玩回合中止：${inspected.abortedTurnRanges.map(({ turn, start, end }) => `第 ${turn} 轮${start === undefined ? '（事件范围未知）' : `（原始事件 seq ${start}–${end}）`}`).join('、')}。轮次不是对话记录编号，事件范围包含非对话事件。`)
  if (inspected.interruptedAssistantSeqs.length) caveats.push(`主持回复在记录 ${inspected.interruptedAssistantSeqs.join('、')} 标记中断，不能视为完整回复。`)
  if (inspected.lastPlayerUnanswered) caveats.push('最后一条对话是玩家发言，未见后续主持回复。')
  if (inspected.uncertainToolOutcomes) caveats.push(`有 ${inspected.uncertainToolOutcomes} 次工具结果不确定，不能断定状态是否更新。`)
  if (inspected.stageCorrectionCount) caveats.push(`记录中有 ${inspected.stageCorrectionCount} 次阶段纠正；阶段卡及工具结果只说明记录变化，不能代替原始对话证明事实，须对照更正前后内容人工核对。`)
  const context = { base: [...judgeBase, ...(stageProtocol ? [stageProtocol.overview, stageProtocol.speakers] : [])], judge: sc.judge, opening: sc.opening, player: sc.player, setting: sc.setting, goal: sc.stageGraph?.goal || sc.meta.pressure || '剧本未单独填写公开目标。', caveats }
  return { versionHash: reference.hash, scenarioId: reference.id, versionSource, inspected, dimensions, context }
}
