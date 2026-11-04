import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const REQUIRED = ['manifest.yaml', 'system.md', 'setting.md', 'opening.md', 'rubric.md', 'judge.md']

export const name = 'dsh-trpg-scenario'
export const inject = ['commands', 'agents']

function parseManifest(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

export function apply(ctx, config = {}) {
  const root = config.root ?? join(homedir(), '.dsh', 'trpg', 'scenarios')
  const ok = (text) => ({ kind: 'success', text })
  const err = (text) => ({ kind: 'error', text })

  async function installedNames() {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  async function loadScenario(dir) {
    const meta = parseManifest(await readFile(join(dir, 'manifest.yaml'), 'utf8'))
    const [system, setting, opening, rubric, judge] = await Promise.all(
      ['system.md', 'setting.md', 'opening.md', 'rubric.md', 'judge.md'].map((f) =>
        readFile(join(dir, f), 'utf8'),
      ),
    )
    return { meta, system, setting, opening, rubric, judge }
  }

  async function cmdList() {
    const names = await installedNames()
    if (!names.length) return ok(`剧本库为空：${root}\n用 /trpg import <zip 路径> 导入。`)
    const lines = []
    for (const n of names) {
      try {
        const { meta } = await loadScenario(join(root, n))
        lines.push(`· ${n}　${meta.title ?? ''}　${meta.kind ?? ''}　${meta.minutes ?? ''} 分钟`)
      } catch {
        lines.push(`· ${n}　（损坏，缺少文件）`)
      }
    }
    return ok(`剧本库（${root}）\n${lines.join('\n')}`)
  }

  async function cmdImport(rawPath) {
    const zip = rawPath.trim().replace(/^["']|["']$/g, '')
    if (!zip) return err('用法：/trpg import <zip 路径>')
    try {
      await stat(zip)
    } catch {
      return err(`找不到文件：${zip}`)
    }

    const tmp = join(root, '.incoming')
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })

    try {
      await run('unzip', ['-o', '-q', zip, '-d', tmp])
    } catch (e) {
      await rm(tmp, { recursive: true, force: true })
      return err(`解压失败：${e.message}`)
    }

    // 兼容压缩包里多套一层目录
    let base = tmp
    const top = await readdir(tmp, { withFileTypes: true })
    if (top.length === 1 && top[0].isDirectory()) base = join(tmp, top[0].name)

    const missing = []
    for (const f of REQUIRED) {
      try {
        await stat(join(base, f))
      } catch {
        missing.push(f)
      }
    }
    if (missing.length) {
      await rm(tmp, { recursive: true, force: true })
      return err(`剧本包缺少文件：${missing.join('、')}\n需要的文件：${REQUIRED.join('、')}`)
    }

    let meta
    try {
      meta = parseManifest(await readFile(join(base, 'manifest.yaml'), 'utf8'))
    } catch {
      meta = {}
    }
    const slug = (meta.id ?? meta.name ?? 'scenario').replace(/[^\w\u4e00-\u9fa5-]/g, '-')

    const dest = join(root, slug)
    await rm(dest, { recursive: true, force: true })
    await run('mv', [base, dest])
    await rm(tmp, { recursive: true, force: true })

    return ok(`已导入：${slug}${meta.title ? `（${meta.title}）` : ''}\n用 /trpg play ${slug} 开局。`)
  }

  async function cmdRemove(rawName) {
    const nm = rawName.trim()
    if (!nm) return err('用法：/trpg remove <名称>')
    const dest = join(root, nm)
    if (!dest.startsWith(root)) return err('名称不合法')
    try {
      await stat(dest)
    } catch {
      return err(`没有这个剧本：${nm}`)
    }
    await rm(dest, { recursive: true, force: true })
    return ok(`已删除：${nm}`)
  }

  function nextSessionId(kind) {
    const rand = Math.random().toString(36).slice(2, 8)
    return `trpg-${kind}-${Date.now().toString(36)}-${rand}`
  }

  function renderCard(sc) {
    const m = sc.meta ?? {}
    const head = [m.title ?? '未命名剧本', m.kind ? `· ${m.kind}` : '', m.minutes ? `· ${m.minutes} 分钟` : '']
      .filter(Boolean)
      .join(' ')
    return [
      `┌ 开场卡 · ${head}`,
      `│ ${m.time ?? ''}　${m.place ?? ''}`.trimEnd(),
      `│ ${sc.opening.trim()}`,
      `│ ${m.pressure ?? ''}`.trimEnd(),
      `└ 说你要做什么。没有选项，也没有标准答案。`,
    ].join('\n')
  }

  async function cmdPlay(rawName, agent) {
    let nm = rawName.trim()
    if (!nm) {
      const names = await installedNames()
      if (!names.length) return err('剧本库是空的，先用 /trpg import <zip> 导入。')
      nm = names[names.length - 1]
    }
    let sc
    try {
      sc = await loadScenario(join(root, nm))
    } catch {
      return err(`剧本 ${nm} 不存在或缺少文件，先 /trpg list 看看。`)
    }
    if (!agent?.session?.append) return err('当前会话不可用，先在一个会话里再点开一局。')

    // 摘掉这个 agent 的全部工具：游玩只需要说话，不需要 bash / read / 编码工具。
    // 注意：只对"还没跑过工具调用"的干净会话有效。会话历史里已有 tool_calls 时再摘工具，
    // 平台会因 role:'tool' 消息找不到对应定义而报 400，所以这里只在工具仍可见时尝试。
    try {
      const visible = agent.ctx?.tools?.schemas?.(agent.ctx)
      if (Array.isArray(visible) && visible.length > 0) {
        agent.ctx.tools.restrict({ allow: [] })
      }
    } catch (e) {
      ctx.logger?.warn?.('[trpg] restrict 失败：' + String(e?.message ?? e))
    }

    const brief = [
      '【接下来是 AI 跑团的剧本设定。请读完，然后照此扮演。】',
      '',
      sc.system,
      '',
      sc.setting,
      '',
      '【开场场景】',
      sc.opening,
      '',
      '【你要怎么做】',
      '你是这场游戏的叙述者。',
      '- 玩家用自然语言说他要做什么，你就描述世界里发生的事、别人的反应、他能看到听到的细节。',
      '- 只写叙事正文，100–250 字，写完就停，等玩家下一句。',
      '- 不替玩家做决定，不给建议，不列选项，不写"你可以……"这类提示。',
      '- 不要输出思考过程、不要解释你在做什么、不要用 markdown 标题。',
    ].join('\n')

    agent.session.append(
      'user/message',
      {
        content: [{ type: 'text', text: brief }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    )

    return ok(renderCard(sc))
  }

  async function cmdJudge(rawName) {
    const nm = rawName.trim()
    if (!nm) return err('用法：/trpg judge <名称>')
    let sc
    try {
      sc = await loadScenario(join(root, nm))
    } catch {
      return err(`剧本 ${nm} 不存在或缺少文件。`)
    }

    await ctx.agents.create({
      sessionId: nextSessionId('judge'),
      agentOptions: { provider: config.provider, model: config.model },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: 'trpg/judge', order: 100, text: sc.judge })
        agentCtx.systemPrompt.section({ name: 'trpg/rubric', order: 110, text: sc.rubric })
        agentCtx.systemPrompt.section({ name: 'trpg/world', order: 120, text: sc.setting })
      },
    })

    return ok(`已开启评分会话（${sc.meta.title ?? nm}）。\n把各组导出的 Session 日志拖进来，或告诉我存档路径。`)
  }

  const register = ctx.effect ?? ((fn) => fn())
  register(() => ctx.commands.register({
    name: 'trpg',
    description: 'AI 跑团：列出剧本、导入剧本包、开局、评分',
    input: { hint: 'list | import <zip> | remove <名称> | play <名称> | judge <名称>' },
    async handler({ agent, rawInput }) {
      const line = String(rawInput ?? '').trim()
      const [sub, ...rest] = line.split(/\s+/)
      const arg = rest.join(' ')
      switch ((sub || 'list').toLowerCase()) {
        case 'list':
          return cmdList()
        case 'import':
          return cmdImport(arg)
        case 'remove':
        case 'rm':
          return cmdRemove(arg)
        case 'play':
          return cmdPlay(arg, agent)
        case 'judge':
          return cmdJudge(arg)
        default:
          return err('未知子命令。用 /trpg list|import|remove|play|judge')
      }
    },
  }))
}
