import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectScenarioReference } from '../judge-log.js'
import { selectJudgeScenario } from '../index.js'

const hash = 'a'.repeat(64)
const event = value => JSON.stringify(value)
const log = (...values) => Buffer.from(values.map(event).join('\n'))
const run = (id, commandId = '1') => ({ type: 'command/run', data: { name: 'trpg', commandId, args: `begin ${id} ${hash}` } })
const done = (commandId = '1', kind = 'success') => ({ type: 'command/done', data: { commandId, kind } })

test('routes from a completed begin only', () => {
  assert.deepEqual(inspectScenarioReference(log(run('old'), done())), { id: 'old', hash })
  assert.equal(inspectScenarioReference(log(run('old'), done('1', 'error'))), null)
  assert.equal(inspectScenarioReference(log(run('old'), done(), run('new', '2'), done('2'))), null)
})
test('loads original when selected scenario differs', async () => {
  const result = await selectJudgeScenario('new', [{ id: 'old', hash }], async id => ({ id }))
  assert.deepEqual(result, { id: 'old', scenario: { id: 'old' }, switched: true })
})
test('missing original gives a useful recovery instruction', async () => {
  await assert.rejects(selectJudgeScenario('new', [{ id: 'old', hash }], async () => { throw new Error('missing') }), /请先导入该局使用的原版剧本/)
})
test('different scenarios cannot be mixed', async () => {
  await assert.rejects(selectJudgeScenario('new', [{ id: 'old' }, { id: 'new' }], async () => ({})), /不同剧本/)
})
test('unknown reference falls back to selected; invalid identifiers are rejected', async () => {
  assert.equal((await selectJudgeScenario('new', [null], async id => ({ id }))).id, 'new')
  await assert.rejects(selectJudgeScenario('new', [{ id: '../escape' }], async () => ({})))
})
