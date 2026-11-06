import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCharacterConfig, initialCharacterState, advanceCharacterState, restoreCharacterState, publicCharacterState } from '../character-state.js'
import { stageDialogueEvidence } from '../stage-graph.js'

const config = () => parseCharacterConfig(JSON.stringify({ version: 1, fields: [{ id: 'energy', label: '精力', initial: '有些疲惫' }, { id: 'friends', label: '朋友关系', initial: '和小林有联系' }] }))
const events = () => [{ seq: 3, role: 'assistant', text: '和小林聊过之后，他终于放松了一点。' }, { seq: 4, role: 'user', text: '我想先回家好好休息一晚上。' }]
const request = () => ({ expectedRevision: 0, field: 'energy', value: '有所放松', quotes: ['和小林聊过之后，他终于放松了一点。'] })

test('公开字段明确、数目有限，拒绝额外字段、重复编号和超长', () => {
  assert.equal(config().fields.length, 2)
  for (const value of [ { version: 1, fields: [] }, { version: 1, fields: [{ id: 'x', label: 'x', initial: 'x', hidden: 'secret' }] }, { version: 1, fields: [{ id: 'x', label: 'x', initial: 'x' }, { id: 'x', label: 'y', initial: 'y' }] }, { version: 1, fields: [{ id: 'x', label: 'x', initial: 'x'.repeat(241) }] }, { version: 1, fields: [{ id: '../x', label: 'x', initial: 'x' }] } ]) assert.throws(() => parseCharacterConfig(JSON.stringify(value)))
})

test('状态更新绑定本局唯一的真实对话，且公开结果不暴露证据或 ID', () => {
  const c = config(), state = advanceCharacterState(c, [], request(), events())
  assert.equal(state.revision, 1)
  assert.deepEqual(state.history[0].evidence, [3])
  assert.deepEqual(publicCharacterState(c, state.history), { revision: 1, fields: [{ label: '精力', value: '有所放松' }, { label: '朋友关系', value: '和小林有联系' }] })
  assert.deepEqual(initialCharacterState(c).values, { energy: '有些疲惫', friends: '和小林有联系' })
})

test('拒绝过期、未变化、非法字段、其他组证据和重复原文', () => {
  const c = config()
  for (const req of [{ ...request(), expectedRevision: 1 }, { ...request(), field: 'secret' }, { ...request(), value: '有些疲惫' }, { ...request(), quotes: ['另一个小组的独立对话记录。'] }, { ...request(), value: '伪造\n多行' }]) assert.throws(() => advanceCharacterState(c, [], req, events()))
  assert.throws(() => advanceCharacterState(c, [], request(), [...events(), { seq: 5, role: 'assistant', text: events()[0].text }]), /歧义/)
  assert.throws(() => advanceCharacterState(c, [], request(), [{ seq: 3, role: 'user', text: events()[0].text }]), /主持叙述/)
})

test('恢复时拒绝跳号、修改为未知字段及重复无变化历史', () => {
  const c = config(), first = advanceCharacterState(c, [], request(), events()).history[0]
  assert.throws(() => restoreCharacterState(c, [{ ...first, revision: 2 }]))
  assert.throws(() => restoreCharacterState(c, [{ ...first, field: 'secret' }]))
  assert.throws(() => restoreCharacterState(c, [first, { ...first, revision: 2 }]))
})

test('隐藏的同条工具叙述不是可引用的玩家可见证据', () => {
  const log = [{ type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { message: { content: [{ type: 'text', text: '和小林聊过之后，他终于放松了一点。' }, { type: 'tool-call', name: 'other' }] } } }]
  assert.deepEqual(stageDialogueEvidence(log), [])
  assert.throws(() => advanceCharacterState(config(), [], request(), stageDialogueEvidence(log)))
})
