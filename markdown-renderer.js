// Render untrusted Markdown as React nodes. Never interpret raw HTML or load images.
export function renderMarkdown(h, marked, source) {
  const styles = {
    p: { margin: '0 0 10px', whiteSpace: 'pre-wrap' },
    heading: { margin: '16px 0 8px', lineHeight: 1.4, fontWeight: 650 },
    quote: { margin: '10px 0', padding: '4px 12px', borderLeft: '3px solid #8aa8d5', opacity: 0.88 },
    list: { margin: '6px 0 12px', paddingLeft: 24 },
    table: { borderCollapse: 'collapse', width: '100%', fontSize: '0.95em' },
    cell: { border: '1px solid var(--line, #d7dbe0)', padding: '5px 8px', textAlign: 'left' },
    code: { background: 'rgba(127,127,127,.12)', borderRadius: 4, padding: '1px 4px' },
  }
  const inline = tokens => (tokens || []).map((t, i) => {
    const children = () => inline(t.tokens || [{ type: 'text', text: t.text || '' }])
    switch (t.type) {
      case 'text': return t.tokens ? children() : t.text
      case 'escape': return t.text
      case 'strong': return h('strong', { key: i }, children())
      case 'em': return h('em', { key: i }, children())
      case 'del': return h('del', { key: i }, children())
      case 'codespan': return h('code', { key: i, style: styles.code }, t.text)
      case 'br': return h('br', { key: i })
      case 'link': {
        let safe = false
        try { safe = ['http:', 'https:', 'mailto:'].includes(new URL(t.href).protocol) } catch {}
        return safe ? h('a', { key: i, href: t.href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, children()) : h('span', { key: i }, children())
      }
      case 'image': return h('span', { key: i }, t.text || '图片')
      case 'html': return t.raw
      default: return t.raw || t.text || ''
    }
  })
  const blocks = tokens => (tokens || []).map((t, i) => {
    switch (t.type) {
      case 'space': return null
      case 'heading': return h(`h${Math.min(6, Math.max(1, t.depth))}`, { key: i, style: { ...styles.heading, fontSize: t.depth <= 2 ? 16 : 14 } }, inline(t.tokens))
      case 'paragraph': return h('p', { key: i, style: styles.p }, inline(t.tokens))
      case 'text': return t.tokens ? h('span', { key: i }, inline(t.tokens)) : t.text
      case 'blockquote': return h('blockquote', { key: i, style: styles.quote }, blocks(t.tokens))
      case 'list': return h(t.ordered ? 'ol' : 'ul', { key: i, style: styles.list, ...(t.ordered && Number.isFinite(t.start) ? { start: t.start } : {}) }, t.items.map((item, n) => h('li', { key: n }, blocks(item.tokens))))
      case 'code': return h('pre', { key: i, style: { ...styles.code, overflowX: 'auto', padding: 10, whiteSpace: 'pre-wrap' } }, h('code', null, t.text))
      case 'hr': return h('hr', { key: i })
      case 'table': return h('div', { key: i, style: { overflowX: 'auto', margin: '10px 0' } }, h('table', { style: styles.table }, h('thead', null, h('tr', null, t.header.map((cell, n) => h('th', { key: n, style: styles.cell }, inline(cell.tokens))))), h('tbody', null, t.rows.map((row, n) => h('tr', { key: n }, row.map((cell, k) => h('td', { key: k, style: styles.cell }, inline(cell.tokens))))))))
      case 'html': return h('p', { key: i, style: styles.p }, t.raw)
      default: return h('p', { key: i, style: styles.p }, t.raw || t.text || '')
    }
  })
  try { return blocks(marked.lexer(String(source || ''), { gfm: true })) }
  catch { return [String(source || '')] }
}
