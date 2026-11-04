window.__ModuleLoader__.load({
  id: 'dsh-trpg-scenario',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      wrap: {
        margin: '0 auto 10px',
        maxWidth: 760,
        width: '100%',
        border: '1px solid var(--line, #e3e6ea)',
        borderRadius: 12,
        background: 'var(--panel, #f7f8fa)',
        padding: '16px 18px 14px 20px',
        position: 'relative',
        overflow: 'hidden',
        fontSize: 14,
        lineHeight: 1.7,
      },
      bar: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        background: '#2f6fed',
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 15,
        fontWeight: 600,
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
      pressure: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px dashed var(--line, #e3e6ea)',
      },
      hint: { marginTop: 12, fontSize: 12, opacity: 0.55 },
    }

    function OpeningCard(props, ctx) {
      const [note, setNote] = React.useState('')
      const start = React.useCallback(async () => {
        const bridge = ctx.remote?.commands
        const current = props?.sessionId
        if (!bridge?.execute || !current) {
          setNote('桥不可用')
          return
        }
        setNote('载入剧本…')
        try {
          const res = await bridge.execute(current, '/trpg play zhaopinhui', [])
          setNote(res?.ok ? '已载入，直接说你要做什么' : `失败：${res?.error?.message ?? ''}`)
        } catch (e) {
          setNote(`异常：${String(e?.message ?? e)}`)
        }
      }, [props?.sessionId])
      return h(
        'div',
        { style: styles.wrap, 'data-trpg': 'opening-card' },
        h('div', { style: styles.bar }),
        h(
          'div',
          { style: styles.head },
          '招聘会',
          h('span', { style: styles.meta }, '就业 · 90 分钟'),
        ),
        h('div', { style: styles.stamp }, '14:20　园区招聘会 · 三层走廊'),
        h(
          'div',
          { style: styles.scene },
          '你站在走廊尽头，手里是改了七版的简历。知行科技的展位前还排着四个人，其中两个已经在低头改手机上的简历。',
        ),
        h('div', { style: styles.pressure }, '闭场前，你需要至少拿到一个面试机会。'),
        h('div', { style: styles.hint }, '说你要做什么。没有选项，也没有标准答案。'),
        h('button', { style: btn, type: 'button', onClick: start, 'data-trpg': 'start' }, '开一局'),
        note ? h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 6 } }, note) : null,
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

    return {
      inject: ['slots', 'uiWorkspace', 'remote', 'remote.commands'],
      apply(ctx) {
        const Card = (props) => OpeningCard(props, ctx)
        Card.displayName = 'TrpgOpeningCard'
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'trpg-opening-card', order: 5 },
            Card,
          ),
        )
      },
    }
  },
})
