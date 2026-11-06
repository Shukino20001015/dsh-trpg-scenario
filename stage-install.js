// Install only into the dedicated agent scope. Restrictions hide inherited
// tools; the guard also blocks other tools registered later in this scope.
// Callers must preserve the returned lifecycle until the agent is disposed.
export function installStageRuntime(agent, runtime, character = null) {
  const tools = agent?.ctx?.tools, prompt = agent?.ctx?.systemPrompt
  if (!tools || typeof tools.register !== 'function' || typeof tools.restrict !== 'function' || typeof tools.guard !== 'function' || typeof tools.schemas !== 'function' || typeof prompt?.section !== 'function') throw new Error('当前 DSH 不支持阶段工具隔离')
  if (runtime?.definition?.name !== 'trpg_transition' || typeof runtime.prompt !== 'function') throw new Error('阶段工具配置无效')
  if (character && (character?.definition?.name !== 'trpg_update_character' || typeof character.prompt !== 'function')) throw new Error('主角状态工具配置无效')
  const dispose = []
  try {
    dispose.push(tools.restrict({ allow: [] }))
    const allowed = character ? ['trpg_transition', 'trpg_update_character'] : ['trpg_transition']
    dispose.push(tools.guard(execution => allowed.includes(execution?.name) && execution?.agent === agent ? undefined : '跑团会话不允许执行其他工具。'))
    dispose.push(tools.register(runtime.definition))
    if (character) dispose.push(tools.register(character.definition))
    const visible = tools.schemas(agent)
    if (!Array.isArray(visible) || visible.length !== allowed.length || new Set(visible.map(item => item?.name)).size !== allowed.length || visible.some(item => !allowed.includes(item?.name))) throw new Error('阶段会话中存在额外可见工具')
    dispose.push(prompt.section({ name: 'trpg/stage', order: 101, text: runtime.prompt, interpolate: false }))
    if (character) dispose.push(prompt.section({ name: 'trpg/character', order: 102, text: character.prompt, interpolate: false }))
    return () => { for (const release of dispose.reverse()) if (typeof release === 'function') release() }
  } catch (error) {
    for (const release of dispose.reverse()) if (typeof release === 'function') release()
    throw error
  }
}
