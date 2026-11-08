// DSH 0.2.2 exposes events() instead of inspect(). Always read a complete,
// consistent cut: partial history could misrepresent a game or its score.
export async function readSessionEvents(controller, id, signal) {
  if (typeof controller?.inspect === 'function') {
    const result = await controller.inspect(id, signal)
    if (!Array.isArray(result?.events)) throw new Error('会话记录格式异常')
    return result.events
  }
  if (typeof controller?.events !== 'function') throw new Error('当前版本不支持读取会话记录')
  const pages = []
  let throughSeq, beforeSeq, total = 0
  for (let n = 0; n < 200; n++) {
    const request = { address: { kind: 'session', sessionId: id }, maxMessages: 500,
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }) }
    const page = await controller.events(request, signal)
    if (!Number.isSafeInteger(page?.cursor) || page.cursor < -1 || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('会话记录分页格式异常')
    if (throughSeq === undefined) throughSeq = page.cursor
    else if (page.cursor !== throughSeq) throw new Error('会话记录读取版本发生变化')
    const events = page.records.map(record => {
      if (record?.type !== 'event' || !Number.isSafeInteger(record.event?.seq) || record.event.seq < 0 || record.event.seq > throughSeq) throw new Error('会话记录条目异常')
      return record.event
    })
    for (let i = 1; i < events.length; i++) if (events[i - 1].seq >= events[i].seq) throw new Error('会话记录顺序异常')
    if (beforeSeq !== undefined && events.some(event => event.seq >= beforeSeq)) throw new Error('会话记录分页重叠')
    if ((total += events.length) > 100000) throw new Error('会话记录过长，无法完整读取')
    pages.unshift(events)
    if (!page.hasMore) return pages.flat()
    if (!events.length || (beforeSeq !== undefined && events[0].seq >= beforeSeq)) throw new Error('会话记录分页未前进')
    beforeSeq = events[0].seq
  }
  throw new Error('会话记录过长，无法完整读取')
}
