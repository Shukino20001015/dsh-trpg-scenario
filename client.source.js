window.__ModuleLoader__.load({
  id: 'dsh-trpg-scenario',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /*__MARKDOWN_BUILD__*/

    // The card already names the scenario and its background section. Omit
    // only a redundant first heading; retain all other authored headings.
    function playerBody(text) {
      return String(text || '').replace(/^#\s+(?:玩家须知|剧本背景)(?:[ \t]*[·：:—|｜-][^\r\n]*)?[ \t]*(?:\r?\n|$)/, '')
    }

    function readableError(error) {
      const message = typeof error?.message === 'string' ? error.message : ''
      if (/background upload transport failed/i.test(message)) return '文件上传未完成，请检查 DSH 连接后重新选择文件。'
      return message || '操作未完成，请重试。'
    }

    async function readViewResponse(response) {
      const type = response.headers.get('content-type') || ''
      if (!type.toLowerCase().includes('application/json')) {
        const error = new Error('跑团服务未就绪或与当前 DSH 版本不兼容，请检查插件是否启用并重启 DSH。')
        error.trpgService = true
        throw error
      }
      try { return await response.json() }
      catch { const error = new Error('跑团服务返回的数据无法读取，请重启 DSH 后重试。'); error.trpgService = true; throw error }
    }

    const styles = {
      wrap: {
        margin: '0 auto 10px',
        maxWidth: 760,
        width: '100%',
        border: '1px solid var(--line, #e3e6ea)',
        borderRadius: 16,
        background: 'var(--panel, #f7f8fa)',
        padding: '20px 22px',
        position: 'relative',
        maxHeight: 'min(58vh, 620px)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
        boxShadow: '0 8px 28px rgba(30, 50, 80, 0.07)',
        fontSize: 14,
        lineHeight: 1.7,
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap',
        fontSize: 19,
        fontWeight: 700,
      },
      meta: {
        marginLeft: 'auto',
        fontSize: 11,
        opacity: 0.6,
        fontFamily: 'ui-monospace, Menlo, monospace',
      },
      stamp: {
        marginTop: 8,
        fontSize: 11.5,
        opacity: 0.6,
        fontFamily: 'ui-monospace, Menlo, monospace',
      },
      scene: { marginTop: 6 },
      select: { maxWidth: '100%', padding: '7px 10px', border: '1px solid var(--line, #d7dbe0)', borderRadius: 8, background: 'transparent', color: 'inherit', fontSize: 13 },
      pressure: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px dashed var(--line, #e3e6ea)',
      },
      hint: { marginTop: 12, fontSize: 12, opacity: 0.55 },
    }

    function Criteria({ items }) {
      if (!Array.isArray(items) || !items.length) return h('div', { style: styles.hint }, '此剧本尚未提供公开评分维度，请向组织者确认。')
      return h('section', { 'aria-label': '评分维度', style: { marginTop: 18 } },
        h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 8 } }, '评分维度'),
        h('div', { style: { fontSize: 12, opacity: 0.65, marginBottom: 10 } }, '这些是本剧本关注的方面；具体评分依据以组织者提供的规则为准。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 8 } },
          items.map((item, index) => h('div', { key: index, style: { border: '1px solid var(--line, #e3e6ea)', borderRadius: 10, padding: '10px 12px', background: 'rgba(80, 110, 160, 0.035)' } },
            h('div', { style: { fontWeight: 650 } }, item.name),
            h('div', { style: { fontSize: 12.5, lineHeight: 1.55, opacity: 0.75, marginTop: 4 } }, item.description)))))
    }

    function StageInfo({ stage, unavailable = false }) {
      if (unavailable) return h('div', { role: 'status', style: styles.hint }, '阶段追踪暂不可用，请以当前对话为准。')
      if (!stage || typeof stage.goal !== 'string' || typeof stage.current !== 'string' || !Array.isArray(stage.visited)) return null
      return h('section', { 'aria-label': '剧本目标与阶段', 'aria-live': 'polite', style: { marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(80, 110, 160, 0.07)', fontSize: 13, lineHeight: 1.6 } },
        h('div', null, h('strong', null, '总体目标：'), stage.goal),
        h('div', null, h('strong', null, '当前记录的阶段：'), stage.current),
        h('div', { style: { opacity: 0.7, fontSize: 12 } }, '阶段由 AI 根据剧情申请更新，可能延迟或有误；如与剧情不符，可直接告诉主持。'),
        stage.visited.length > 1 ? h('details', null,
          h('summary', { style: { cursor: 'pointer', opacity: 0.8 } }, '已走过的阶段'),
          h('ol', { style: { margin: '6px 0 0', paddingLeft: 20 } }, stage.visited.map((name, i) => h('li', { key: i }, name)))) : null)
    }

    function CharacterInfo({ character, unavailable = false }) {
      if (unavailable) return h('div', { role: 'status', style: styles.hint }, '主角状态暂不可核对，请以对话为准；发现不一致可直接告诉主持。')
      if (!character || !Array.isArray(character.fields) || !character.fields.length) return null
      // Preserve the original stored state for replay, but make direction and
      // line controls visible instead of letting them reorder the card.
      const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
      const visible = value => String(value ?? '').replace(controls, ch => `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
      const hasControls = character.fields.some(field => [field.label, field.value].some(value => typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)))
      return h('details', { 'aria-label': '主角状态', style: { marginTop: 8, padding: '10px 13px', borderRadius: 10, background: 'rgba(80, 110, 160, 0.07)', fontSize: 13, lineHeight: 1.6 } },
        h('summary', { style: { cursor: 'pointer', fontWeight: 650 } }, '主角状态'),
        h('div', { style: { opacity: 0.7, fontSize: 12, marginTop: 5 } }, '明显变化时更新；若与对话不符，可以直接告诉主持。'),
        hasControls ? h('div', { role: 'status', style: { fontSize: 12 } }, '状态包含不可见控制字符，已用字符编号显示；原记录未修改，请核对。') : null,
        h('dl', { style: { margin: '8px 0 0' } }, character.fields.map((field, i) => h('div', { key: i, style: { display: 'flex', gap: 8, marginTop: 4 } },
          h('dt', { style: { fontWeight: 600 } }, `${visible(field.label)}：`), h('dd', { style: { margin: 0 } }, visible(field.value))))))
    }

    // The running conversation normally collapses the operation card. Keep the
    // public stage independently visible. Some DSH versions do not publish a
    // reliable running/updatedAt change after a tool commits; an idle refresh
    // is therefore required too, otherwise the UI can indefinitely show the
    // prior confirmed stage until the player changes views.
    function StageBanner({ props, ctx }) {
      const sessions = React.useSyncExternalStore(React.useCallback(notify => ctx.sessions.list.subscribe(notify), [ctx]), React.useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]))
      const binding = ctx.sessions.binding(props.sessionId)?.session
      const live = React.useSyncExternalStore(React.useCallback(notify => binding ? binding.subscribe(notify) : () => {}, [binding]), React.useCallback(() => binding ? binding.getSnapshot() : EMPTY_SESSION_SNAPSHOT, [binding]))
      const running = !!(live.running || live.pendingSubmissions?.length)
      const updated = sessions?.byId?.[props.sessionId]?.updatedAt
      const [result, setResult] = React.useState(null)
      React.useEffect(() => {
        let active = true, pending = false
        const refresh = async (force = false) => {
          if (pending || (!force && document.visibilityState === 'hidden')) return
          pending = true
          try {
            const response = await fetch(`api/trpg.view?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
            const data = await readViewResponse(response)
            if (!response.ok) throw new Error('unavailable')
            if (active) setResult({ id: props.sessionId, stage: data.current?.stage || null, unavailable: data.current?.stageUnavailable === true, character: data.current?.character || null, characterUnavailable: data.current?.characterUnavailable === true })
          } catch { if (active) setResult(previous => previous?.id === props.sessionId && (previous.stage || previous.character) ? { id: props.sessionId, stage: null, unavailable: !!previous.stage, character: null, characterUnavailable: !!previous.character } : null) }
          finally { pending = false }
        }
        // Hydrate on mount even if Electron reports the window as hidden;
        // only recurring polling should be suppressed in the background.
        refresh(true)
        const timer = setInterval(() => refresh(), running ? 1500 : 5000)
        const onVisibilityChange = () => { if (document.visibilityState === 'visible') refresh() }
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisibilityChange) }
      }, [props.sessionId, running, updated])
      if (!result || result.id !== props.sessionId) return null
      return h(React.Fragment, null, h(StageInfo, { stage: result.stage, unavailable: result.unavailable }), h(CharacterInfo, { character: result.character, unavailable: result.characterUnavailable }))
    }

    const EMPTY_SESSION_SNAPSHOT = Object.freeze({ running: false, pendingSubmissions: [] })
    function OpeningCard(props, ctx) {
      const sessionList = React.useSyncExternalStore(
        React.useCallback(notify => ctx.sessions.list.subscribe(notify), [ctx]),
        React.useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
      )
      const [note, setNote] = React.useState('')
      React.useEffect(() => {
        if (!note.startsWith('已导入：')) return
        const timer = setTimeout(() => setNote(current => current === note ? '' : current), 8000)
        return () => clearTimeout(timer)
      }, [note])
      const [catalog, setCatalog] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [current, setCurrent] = React.useState(undefined)
      const [isJudge, setIsJudge] = React.useState(false)
      const [revision, setRevision] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [pendingMeta, setPendingMeta] = React.useState({})
      const [pendingError, setPendingError] = React.useState('')
      const [pendingSelected, setPendingSelected] = React.useState('')
      const [confirmedComplete, setConfirmedComplete] = React.useState(false)
      const judgeSession = sessionList?.byId?.[props?.sessionId]
      const liveSession = ctx.sessions.binding(props?.sessionId)?.session
      const liveSnapshot = React.useSyncExternalStore(
        React.useCallback(notify => liveSession ? liveSession.subscribe(notify) : () => {}, [liveSession]),
        React.useCallback(() => liveSession ? liveSession.getSnapshot() : EMPTY_SESSION_SNAPSHOT, [liveSession]),
      )
      const judgeRunning = !!(liveSnapshot.running || liveSnapshot.pendingSubmissions?.length)
      const judgeStamp = JSON.stringify([props?.sessionId, judgeSession?.updatedAt, judgeRunning])
      const judgeStampRef = React.useRef(judgeStamp)
      judgeStampRef.current = judgeStamp
      React.useEffect(() => { if (isJudge) setNote('') }, [isJudge, judgeStamp])
      React.useEffect(() => { setConfirmedComplete(false) }, [selected])
      React.useEffect(() => {
        let live = true
        if (!props?.sessionId) return
        setCurrent(undefined)
        fetch(`api/trpg.view?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' }).then(async res => {
          const data = await readViewResponse(res)
          if (!res.ok) throw new Error(data.error || '读取跑团信息失败')
          if (!live) return
          setCurrent(data.current)
          setIsJudge(data.judge === true)
          const items = data.catalog
          if (!Array.isArray(items)) throw new Error('剧本列表格式错误')
          setCatalog(items)
          setSelected(previous => items.some(item => item.id === previous) ? previous : items[0]?.id || '')
        }).catch(error => { if (live) { setCurrent({ error: error.message, serviceError: error.trpgService === true }); setNote('') } })
        return () => { live = false }
      }, [props?.sessionId, revision])
      const scenario = catalog.find(item => item.id === selected)
      const pendingCandidates = (sessionList?.ids || []).filter(id => id !== props?.sessionId && sessionList.byId[id]?.blank)
      const candidateKey = JSON.stringify(pendingCandidates.slice(0, 100).sort())
      React.useEffect(() => {
        let live = true
        const abort = new AbortController()
        if (current !== null) return () => abort.abort()
        setPendingMeta({})
        setPendingError('')
        Promise.all(JSON.parse(candidateKey).map(async id => {
          const response = await fetch(`api/trpg.view?sessionId=${encodeURIComponent(id)}&pending=1`, { cache: 'no-store', signal: abort.signal })
          const value = await readViewResponse(response)
          if (response.status === 409) return [id, { error: value.error || '原剧本不可用' }]
          if (!response.ok) throw new Error('部分会话无法读取')
          return [id, value.current]
        })).then(rows => { if (live) setPendingMeta(Object.fromEntries(rows)) })
          .catch(error => { if (live && error.name !== 'AbortError') setPendingError('部分待继续会话无法读取，请检查插件或稍后重试。') })
        return () => { live = false; abort.abort() }
      }, [candidateKey, current === null])
      const pendingGames = pendingCandidates.map(id => ({ ...sessionList.byId[id], game: pendingMeta[id] })).filter(item => item.game)
      const newSession = React.useCallback(async (title, preset = 'trpg') => {
        const current = ctx.sessions.list.getSnapshot().byId[props?.sessionId]
        const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(props?.sessionId))
        const binding = ctx.sessions.binding(props.sessionId)
        if (!binding) throw new Error('无法读取当前会话的模型设置，已取消开始。')
        const selection = binding.session.projections.faceOf('modelSelection').getSnapshot()?.next
        const options = { agentPreset: preset, ...(workspace ? { workspaceId: workspace.workspaceId } : current?.cwd ? { cwd: current.cwd } : {}) }
        const session = await ctx.sessions.create(options)
        // Pin a neutral title before sending any dialogue to prevent the DSH
        // automatic title generator from forwarding it in a second LLM call.
        if (typeof ctx.remote?.session?.rename !== 'function') throw new Error('当前 DSH 不支持预先设置会话名称，无法避免自动命名发送对话。')
        const renamed = await ctx.remote.session.rename({ sessionId: session, title })
        if (!renamed?.ok) throw new Error(renamed?.error?.message || '无法设置会话名称，已取消开始。')
        if (selection) {
          const selected = await ctx.remote.session.selectModel({ sessionId: session, ...selection })
          if (!selected?.ok) throw new Error(selected?.error?.message || '无法在新会话设置所选模型，已取消开始。')
        }
        return session
      }, [props?.sessionId])
      const importFile = React.useCallback(async e => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file || !props?.sessionId) return
        if (file.size > 8 * 1024 * 1024) { setNote('剧本包不能超过 8 MB'); return }
        setBusy(true)
        try {
          const upload = await ctx.fileUpload.upload(props.sessionId, file, file.name)
          if (!upload?.ok || !upload.value?.receiptId) throw new Error(upload?.error?.message || '上传失败')
          const res = await ctx.remote.commands.execute(props.sessionId, '/trpg import', [{ type: 'file', receiptId: upload.value.receiptId }])
          const result = res?.value?.result
          if (!res?.ok || result?.kind !== 'success') throw new Error(result?.text || '导入失败')
          const importedId = /^已导入：([^\n]+)(?:\n|$)/.exec(result.text || '')?.[1]
          if (importedId) setSelected(importedId)
          setNote(result.text)
          setRevision(n => n + 1)
        } catch (error) { const message = readableError(error); setNote(message.startsWith('导入失败：') ? message : `导入失败：${message}`) }
        finally { setBusy(false) }
      }, [props?.sessionId])
      const remove = React.useCallback(async () => {
        if (!selected || !window.confirm(`确定删除剧本“${scenario?.title || selected}”？`)) return
        setBusy(true)
        try {
          const res = await ctx.remote.commands.execute(props.sessionId, `/trpg remove ${selected}`, [])
          const result = res?.value?.result
          if (!res?.ok || result?.kind !== 'success') throw new Error(result?.text || '删除失败')
          setNote(result.text)
          setRevision(n => n + 1)
        } catch (error) { setNote(`删除失败：${error.message}`) }
        finally { setBusy(false) }
      }, [props?.sessionId, selected, scenario?.title])
      const judgeFiles = React.useCallback(async e => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        if (!selected || !files.length || !props?.sessionId) return
        if (files.length > 6 || files.some(file => file.size > 40 * 1024 * 1024)) { setNote('请选择不超过 6 份、每份不超过 40 MB 的日志'); return }
        setBusy(true)
        try {
          const judgeSession = await newSession('AI 跑团 · 独立评分')
          const receipts = []
          for (const file of files) {
            const upload = await ctx.fileUpload.upload(judgeSession, file, file.name)
            if (!upload?.ok || !upload.value?.receiptId) throw new Error(upload?.error?.message || `${file.name} 上传失败`)
            receipts.push({ type: 'file', receiptId: upload.value.receiptId })
          }
          const res = await ctx.remote.commands.execute(judgeSession, `/trpg judge ${selected}${confirmedComplete ? ' --confirmed-complete' : ''}`, receipts)
          const result = res?.value?.result
          if (!res?.ok || result?.kind !== 'success') throw new Error(result?.text || '评分准备失败')
          // Warnings otherwise remain hidden in a collapsed command entry once
          // we navigate to the judge session. Make them visible to the person.
          if (result.text?.includes('\n注意：')) window.alert(`评分记录需要人工核对：\n\n${result.text}`)
          ctx.uiWorkspace.openSession(judgeSession)
          setNote(result.text)
        } catch (error) { const message = readableError(error); setNote(message.startsWith('评分准备失败：') ? message : `评分准备失败：${message}`) }
        finally { setBusy(false); setConfirmedComplete(false) }
      }, [props?.sessionId, selected, newSession, confirmedComplete])
      const start = React.useCallback(async () => {
        const bridge = ctx.remote?.commands
        const current = props?.sessionId
        if (!bridge?.execute || !current || !selected) {
          setNote('桥不可用')
          return
        }
        setBusy(true)
        setNote('载入剧本…')
        try {
          if (!scenario?.versionHash) throw new Error('无法确认剧本版本，请刷新后重试。')
          const displayTitle = String(scenario.title || selected).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) || selected
          const playSession = await newSession(`AI 跑团 · 游玩 · ${displayTitle}`)
          const res = await bridge.execute(playSession, `/trpg begin ${selected} ${scenario.versionHash}`, [])
          const result = res?.value?.result
          if (!res?.ok || result?.kind !== 'success') throw new Error(result?.text ?? res?.error?.message ?? '未知错误')
          ctx.uiWorkspace.openSession(playSession)
          setNote('已载入，直接说你要做什么')
        } catch (e) {
          setNote(`异常：${String(e?.message ?? e)}`)
        } finally { setBusy(false) }
      }, [props?.sessionId, selected, scenario?.versionHash, scenario?.title, newSession])
      if (current === undefined) return h('div', { style: styles.hint }, '正在读取跑团会话…')
      if (isJudge && !current) return h('div', { style: styles.wrap, 'data-trpg': 'judge-audit' },
        h('div', { style: styles.head }, '评分结果核对'),
        h('div', { style: styles.hint }, '报告生成后，可检查结构化评分中的档位、记录编号和加总。结果仅对应检查时的报告；继续对话后请重新检查。文字理由与实际证据仍须人工复核。'),
        h('button', { type: 'button', style: btn, disabled: busy || !judgeSession || !liveSession || judgeRunning, onClick: async () => {
          setBusy(true)
          const requestedStamp = judgeStampRef.current
          try {
            const res = await fetch(`api/trpg.view?sessionId=${encodeURIComponent(props.sessionId)}&audit=1`, { cache: 'no-store' })
            const data = await readViewResponse(res)
            setNote(judgeStampRef.current === requestedStamp ? (data?.result?.text || data?.error || '核对未完成，请人工复核。') : '会话内容已变化，请在回复完成后重新检查。')
          } catch (error) { setNote(`核对失败：${error.message}`) }
          finally { setBusy(false) }
        } }, '检查评分结果'),
        note ? h('div', { role: 'status', style: { marginTop: 12, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, note) : null)
      if (current) return h('div', { style: styles.wrap, 'data-trpg': 'fixed-opening' },
        h('div', { style: styles.head }, current.serviceError ? '跑团服务不可用' : current.title || '跑团开场'),
        current.error ? h(React.Fragment, null,
          h('div', { role: 'alert' }, current.error),
          current.serviceError ? h('button', { type: 'button', style: btn, onClick: () => setRevision(n => n + 1) }, '重试') : h(React.Fragment, null,
          h('div', { style: styles.hint }, '为避免改变原来的剧本或评分规则，此会话不会强行继续。原记录仍保留；可返回剧本选择，或找组织者恢复原版本。'),
          h('button', { type: 'button', style: btn, disabled: busy, onClick: async () => {
            setBusy(true)
            try { ctx.uiWorkspace.openSession(await newSession('AI 跑团 · 选择剧本')) }
            catch (error) { setNote(`无法返回剧本选择：${error.message}`) }
            finally { setBusy(false) }
          } }, '返回剧本选择'),
          note ? h('div', { role: 'alert', style: styles.hint }, note) : null)) : h(React.Fragment, null,
          current.versionWarning ? h('div', { role: 'alert', style: { marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(190, 125, 30, 0.1)', fontSize: 13, lineHeight: 1.6 } }, current.versionWarning) : null,
          current.player ? h('details', { open: true, style: { marginTop: 12 } },
            h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '剧本背景'),
            h('div', { 'data-trpg-markdown': 'player', style: { lineHeight: 1.7 } }, renderMarkdown(h, marked, playerBody(current.player)))) : null,
          current.criteriaUnverified ? null : h(Criteria, { items: current.criteria }),
          h('div', { style: { fontWeight: 600, marginTop: 14 } }, '固定开场'),
          h('div', { 'data-trpg-markdown': 'opening', style: { lineHeight: 1.7 } }, renderMarkdown(h, marked, current.opening)),
          h('div', { style: styles.hint }, '以上是本剧本的固定开场。请在下方输入第一步行动。'),
          h('button', { type: 'button', style: btn, disabled: busy, onClick: async () => {
            setBusy(true)
            try { ctx.uiWorkspace.openSession(await newSession('AI 跑团 · 选择剧本')) }
            catch (error) { setNote(`无法创建新会话：${error.message}`) }
            finally { setBusy(false) }
          } }, '另开一局'),
          note ? h('div', { role: 'alert', style: styles.hint }, note) : null))
      return h(
        'div',
        { style: styles.wrap, 'data-trpg': 'opening-card' },
        h('div', { role: 'status', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(190, 125, 30, 0.12)', fontSize: 13, lineHeight: 1.6 } },
          '尚未开局：请选择剧本并点击“开一局”。看到新会话中的固定开场后，再在输入框中输入玩家行动。'),
        h(
          'div',
          { style: styles.head },
          scenario?.title || '选择剧本',
          h('span', { style: styles.meta }, scenario ? `${scenario.kind} · ${scenario.minutes} 分钟` : ''),
        ),
        h('select', { value: selected, onChange: e => setSelected(e.target.value), 'aria-label': '选择剧本', disabled: !catalog.length || busy, style: styles.select },
          catalog.length ? catalog.map(item => h('option', { key: item.id, value: item.id }, catalog.filter(other => other.title === item.title).length > 1 ? `${item.title}（${item.id}）` : item.title)) : h('option', { value: '' }, '暂无剧本，请先导入')),
        h('label', { style: { ...btn, display: 'inline-block', marginLeft: 8, cursor: busy ? 'wait' : 'pointer' } }, '导入剧本',
          h('input', { type: 'file', accept: '.zip,application/zip', onChange: importFile, disabled: busy, style: { width: 1, height: 1, opacity: 0, position: 'absolute' }, 'aria-label': '导入剧本 ZIP' })),
        h('button', { style: { ...btn, marginLeft: 8 }, type: 'button', onClick: remove, disabled: !selected || busy }, '删除剧本'),
        pendingGames.length ? h('div', { style: { marginTop: 16, padding: '12px 14px', borderRadius: 10, background: 'rgba(80, 110, 160, 0.06)' } },
          h('div', { style: { fontWeight: 600 } }, '继续尚未行动的跑团'),
          h('select', { 'aria-label': '选择待继续的跑团', value: pendingGames.some(item => item.id === pendingSelected) ? pendingSelected : '', onChange: e => setPendingSelected(e.target.value), style: { ...styles.select, marginTop: 8 } },
            h('option', { value: '' }, '选择一个待继续的会话'),
            pendingGames.map(item => h('option', { key: item.id, value: item.id },
              `${item.title && !item.title.startsWith('AI 跑团 · 游玩') ? `${item.title}${item.game.title ? `（${item.game.title}）` : ''}` : item.game.title || '无法读取的开局'} · ${item.id.slice(-8)}${item.game.error ? '（需核对）' : ''}`))),
          h('button', { type: 'button', style: { ...btn, marginLeft: 8 }, disabled: !pendingGames.some(item => item.id === pendingSelected), onClick: () => ctx.uiWorkspace.openSession(pendingSelected) }, '继续'),
          h('div', { style: styles.hint }, '如打开后未显示开场，请在该会话选择 AI 跑团模式。')) : null,
        pendingError ? h('div', { role: 'alert', style: styles.hint }, pendingError) : null,
        pendingCandidates.length > 100 ? h('div', { role: 'alert', style: styles.hint }, '未行动会话过多，当前只检查前 100 个；请先处理其他未行动会话。') : null,
        h('div', { style: styles.stamp }, scenario ? `${scenario.time}　${scenario.place}` : ''),
        h(StageInfo, { stage: scenario?.stage }),
        scenario?.player ? h('details', { open: true, style: { marginTop: 12 } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '剧本背景'),
          h('div', { 'data-trpg-markdown': 'player', style: { marginTop: 8, lineHeight: 1.7 } }, renderMarkdown(h, marked, playerBody(scenario.player))))
          : h('div', { style: styles.hint }, '此剧本尚未提供玩家背景，请向组织者了解角色与玩法。'),
        h(Criteria, { items: scenario?.criteria }),
        scenario ? h('div', { style: { fontWeight: 600, marginTop: 14 } }, '开场场景') : null,
        h(
          'div',
          { 'data-trpg-markdown': 'opening', style: styles.scene },
          renderMarkdown(h, marked, scenario?.opening || ''),
        ),
        h('div', { style: styles.pressure }, scenario?.pressure || ''),
        h('div', { style: styles.hint }, '这是开局预览；开始后再输入行动。没有选项，也没有标准答案。'),
        h('button', { style: btn, type: 'button', onClick: start, disabled: !selected || busy, 'data-trpg': 'start' }, '开一局'),
        h('div', { style: { marginTop: 12, fontSize: 12.5, lineHeight: 1.6 } },
          h('label', null,
            h('input', { type: 'checkbox', checked: confirmedComplete, onChange: e => setConfirmedComplete(e.target.checked), disabled: busy }),
          ' 我已逐份核对上传的记录，确认每份都覆盖对应的整局游玩（可选）')),
        h('label', { style: { ...btn, display: 'inline-block', marginLeft: 8, opacity: !selected || busy ? 0.5 : 1 } }, '上传对话日志评分',
          h('input', { type: 'file', accept: '.zip,.jsonl,application/zip', multiple: true, onChange: judgeFiles, disabled: !selected || busy, style: { width: 1, height: 1, opacity: 0, position: 'absolute' }, 'aria-label': '上传对话日志评分' })),
        h('div', { style: styles.hint }, '每份日志对应一次游玩，可上传一份单独评分，也可上传多份进行比较（最多 6 份）。开局与评分分别创建独立会话，沿用当前会话所选模型。评分前请检查日志中的个人信息；AI 评分可能误用证据或给出不合理分数，须对照原始记录和评分标准复核。'),
        // The card can be taller than its scroll viewport; keep errors and
        // results visible after file upload even when the user is near the top.
        note ? h('div', { role: 'status', 'aria-live': 'polite', style: { position: 'sticky', bottom: 0, zIndex: 2, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line, #d7dbe0)', background: 'var(--panel, #f7f8fa)', boxShadow: '0 -4px 16px rgba(30, 50, 80, 0.08)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 8 } }, note) : null,
      )
    }

    const btn = {
      marginTop: 10,
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--line, #d7dbe0)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }

    function GameEntry(props, Card, ctx) {
      const blank = props.session?.blank === true
      // The session projection follows preset changes in an existing blank
      // session; a one-time header read would miss mode switches.
      const preset = props.useProjection('agentPreset')
      const [expanded, setExpanded] = React.useState(blank)
      const previous = React.useRef({ sessionId: props.sessionId, blank })
      React.useEffect(() => {
        const old = previous.current
        if (old.sessionId !== props.sessionId) setExpanded(blank)
        else if (old.blank && !blank) setExpanded(false)
        previous.current = { sessionId: props.sessionId, blank }
      }, [props.sessionId, blank])
      if (preset !== 'trpg') return null
      return h('section', { style: { width: '100%', marginTop: 8 }, 'aria-label': 'AI 跑团' },
        h(StageBanner, { props, ctx }),
        h('button', { type: 'button', style: { ...btn, fontWeight: 600, marginTop: 0, marginBottom: 6 }, onClick: () => setExpanded(value => !value), 'aria-expanded': expanded },
          expanded ? '收起 AI 跑团操作' : 'AI 跑团 · 导入剧本 / 开局 / 评分'),
        expanded ? h(Card, props) : null)
    }

    return {
      inject: ['slots', 'uiWorkspace', 'sessions', 'workspaces', 'remote', 'remote.commands', 'remote.session', 'fileUpload'],
      apply(ctx) {
        const Card = (props) => OpeningCard(props, ctx)
        const Entry = (props) => GameEntry(props, Card, ctx)
        Card.displayName = 'TrpgOpeningCard'
        Entry.displayName = 'TrpgGameEntry'
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'trpg-game-entry', order: 50 }, Entry),
        )
      },
    }
  },
})
