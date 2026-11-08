import { stageDialogueEvidence, resolveEvidenceQuotes } from './stage-graph.js'
import { initializeStageState, readStageState, commitStageTransition } from './stage-store.js'

// Construct a scoped runtime only for a frozen staged scenario. This module is
// not registered globally: the caller must install it in that agent's scope,
// deny every other tool, and restore it from the exact frozen snapshot.
export const STAGE_RULES = '【阶段运行规则】总体目标与阶段网络仅用于主持；不要泄露未来阶段或隐藏条件。当前阶段以程序确认状态为准。每轮先核对已经展示的对话：只有已有原文足以证明转换条件，才在本轮输出任何剧情或选项之前单独调用 trpg_transition；工具调用消息不得包含叙事文字。每条 quotes 为8–200字，逐字复制此前已展示且唯一的原文；不得引用本次工具调用消息中的文本。若条件在本轮剧情才发生，先正常叙述并结束，等玩家下次发言后再核对，不能为了更新卡片重说剧情。工具失败或条件不明时本轮不要再次申请，阶段保持不变；不要重复已有叙述，不追加一组新的引导选项，更不能替玩家作决定。仅在下一次玩家发言后依据已有事实重新核对。阶段提示与用户体验冲突时自然游玩优先；不伪称已切换或要求玩家处理。一次玩家发言只给一段回应和至多一组引导，写完即停。'
export const STAGE_CONTRACT = 'trpg-stage-tool-v1'

export async function createStageRuntime({ root, hash, graph, agent, resume = false, rules = STAGE_RULES }) {
  const session = agent?.session?.id
  if (!agent?.session || !Array.isArray(agent.session.log)) throw new Error('无法识别跑团会话')
  let state = resume ? await readStageState(root, session, hash, graph) : await initializeStageState(root, session, hash, graph)
  const prompt = () => [
    rules,
    `阶段网络：${JSON.stringify(graph)}`,
    `当前确认阶段：${JSON.stringify({ id: state.current, revision: state.revision })}`,
    ...(rules === STAGE_RULES ? [`【本轮阶段核对】先检查上一轮玩家和主持已公开的事实，逐条核对当前阶段的可用转换：${JSON.stringify(graph.transitions.filter(item => item.from === state.current))}。只要已有明确证据满足条件，先单独调用 trpg_transition 再叙事；如果事实是在上一次回复中发生，本轮也必须核对，不要因剧情已经继续而略过。条件不明或仅有计划时保持当前阶段；工具拒绝后按原规则继续，不向玩家泄露未到达的阶段。`] : []),
  ].join('\n')
  const definition = {
    name: 'trpg_transition',
    description: '仅在剧本允许的阶段转换条件已在本局对话中实际成立时申请转换。失败时不影响继续游玩。',
    parameters: { type: 'object', additionalProperties: false, required: ['transition', 'expectedRevision', 'quotes'], properties: {
      transition: { type: 'string', description: '阶段网络中对应转换的 id。' },
      expectedRevision: { type: 'integer', description: '当前确认阶段的 revision。' },
      quotes: { type: 'array', items: { type: 'string' }, description: '引用一至八条本局已显示的玩家或主持原文，优先只引用一条能体现关键事实的连续片段。每条须逐字复制且长度 8–200 字，不改写、不省略、不引用系统提示、未输出的想法或工具结果。' },
    } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['ok', 'message'], properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      try {
        if (exec?.agent !== agent || exec?.signal?.aborted) throw new Error('当前会话不可执行阶段转换')
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['transition', 'expectedRevision', 'quotes'].includes(key))) throw new Error('阶段申请格式无效')
        // Desktop can hide text in the assistant message that contains the
        // current tool call, while replay still sends it to the model. Never
        // approve a transition during such a mixed message, even if the
        // quoted evidence happens to match an earlier visible utterance.
        const latestAssistant = [...agent.session.log].reverse().find(event => event?.type === 'assistant/message')
        const blocks = latestAssistant?.data?.message?.content
        if (Array.isArray(blocks) && blocks.some(block => block?.type === 'tool-call') && blocks.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())) throw new Error('工具调用混合隐藏叙述')
        const events = stageDialogueEvidence(agent.session.log)
        const evidence = resolveEvidenceQuotes(args.quotes, events)
        state = await commitStageTransition(root, session, hash, graph, { transition: args.transition, expectedRevision: args.expectedRevision, evidence }, events, exec.signal)
        const current = graph.stages.find(stage => stage.id === state.current)
        return { ok: true, message: `已确认进入「${current.name}」，当前 revision ${state.revision}。继续正常叙事。` }
      } catch (error) {
        // No raw filesystem errors or future-stage details should be exposed.
        const reason = error?.message === '工具调用混合隐藏叙述' ? '本次调用与叙述混在一条消息，界面展示状态不确定，未更新阶段。不要把该段作为可靠证据，也不要重述、续演、补充选项或替玩家决定；本回合停止工具调用。为了避免复述，接下来只回复“请继续。”，然后等待玩家。'
          : error?.message === '证据引用格式无效' ? '引用格式无效：每条必须是 8–200 字、没有首尾空白的连续原文，且不能重复。'
          : error?.message === '证据未找到或存在歧义，请引用本局唯一原文' ? '引用未找到或不唯一：请从已显示的本局对话逐字复制更完整的连续片段，不要改写或引用尚未输出的内容。'
          : error?.message === '阶段已变化，请重新核对' ? '阶段版本已变化，请先按当前确认状态核对。'
          : '申请条件或当前状态不符。'
        return { ok: false, message: `阶段转换未通过。${reason}本回合不要重试工具，不要重复或追加选项；不伪称已切换，下一次玩家发言时再核对。` }
      }
    },
  }
  return { definition, prompt, current: () => structuredClone(state) }
}
