import { stageDialogueEvidence, resolveEvidenceQuotes } from './stage-graph.js'
import { initializeStageState, readStageState, commitStageTransition } from './stage-store.js'

// Construct a scoped runtime only for a frozen staged scenario. This module is
// not registered globally: the caller must install it in that agent's scope,
// deny every other tool, and restore it from the exact frozen snapshot.
export const STAGE_RULES = '【阶段运行规则】总体目标与阶段网络仅用于主持；不要泄露未来阶段、隐藏条件或引导玩家决策。当前阶段以程序确认状态为准。每次回复前，先检查当前阶段可用的每条转换条件：若本局已显示的对话明确证明某条条件全部成立，必须先调用 trpg_transition，再继续叙事；不得只在心里更新阶段或跳过申请。quotes 引用一条足以体现关键事实的原文连续片段，必要时才增加引用；每条为 8–200 字，必须逐字复制本局已经显示的玩家或主持对话，不能改写、省略中间内容、引用未输出的想法或只写人名。意向、猜测、未兑现的承诺都不等于结果，证据不充分就不要调用或声称切换。若条件是在你本次回复中才发生，先自然叙述使其成为对话事实，在下一次回复前检查并申请。转换失败时根据工具反馈核对，同一回合最多重新申请一次；不要伪称已切换，不要中断游戏或要求玩家处理，根据已有对话自然继续。【逐轮阶段出口核对 v1】'
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
        const reason = error?.message === '工具调用混合隐藏叙述' ? '本次工具调用同条消息中的叙述可能未显示给玩家，即使它出现在你的上下文里，也不能当作玩家已经看到的剧情。不要据此推进或假定玩家已知；如该叙述仍适合当前情境，请在接下来的普通回复中重新清楚呈现，留给玩家回应。'
          : error?.message === '证据引用格式无效' ? '引用格式无效：每条必须是 8–200 字、没有首尾空白的连续原文，且不能重复。'
          : error?.message === '证据未找到或存在歧义，请引用本局唯一原文' ? '引用未找到或不唯一：请从已显示的本局对话逐字复制更完整的连续片段，不要改写或引用尚未输出的内容。'
          : error?.message === '阶段已变化，请重新核对' ? '阶段版本已变化，请先按当前确认状态核对。'
          : '申请条件或当前状态不符。'
        return { ok: false, message: `阶段转换未通过。${reason}不要声称已切换；核对事实后可重试，或继续自然游玩。` }
      }
    },
  }
  return { definition, prompt, current: () => structuredClone(state) }
}
