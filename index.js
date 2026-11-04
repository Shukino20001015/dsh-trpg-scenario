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

  async function cmdPlay(rawName) {
    const nm = rawName.trim()
    if (!nm) return err('用法：/trpg play <名称>')
    const dir = join(root, nm)
    let sc
    try {
      sc = await loadScenario(dir)
    } catch {
      return err(`剧本 ${nm} 不存在或缺少文件，先 /trpg list 看看。`)
    }

    const handle = await ctx.agents.create({
      sessionId: nextSessionId('play'),
      agentOptions: { provider: config.provider, model: config.model },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({
          name: 'trpg/rules',
          order: 100,
          text: sc.system,
        })
        agentCtx.systemPrompt.section({
          name: 'trpg/world',
          order: 110,
          text: sc.setting,
        })
        agentCtx.systemPrompt.section({
          name: 'trpg/opening',
          order: 120,
          text: `【开场场景】\n${sc.opening}`,
        })
      },
    })

    return ok(
      `已开启剧本「${sc.meta.title ?? nm}」。\n\n开场：\n${sc.opening}\n\n直接说你的第一句话即可开始。`,
    )
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
    async handler({ rawInput }) {
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
          return cmdPlay(arg)
        case 'judge':
          return cmdJudge(arg)
        default:
          return err('未知子命令。用 /trpg list|import|remove|play|judge')
      }
    },
  }))
}
