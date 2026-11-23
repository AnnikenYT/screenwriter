import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFountain } from '../shared/fountain.js'
import { screenplayStats } from '../shared/screenplay-stats.js'

test('stats split runtime by scene and speaking time by normalized character', () => {
  const stats = screenplayStats(parseFountain([
    'Title: Ignored', '', 'A cold open.', '',
    'INT. ZOO - DAY #7A#', '', 'MARA waves to SAM.', '',
    'MARA (V.O.)', '(quietly)', 'One **two**.', 'Three.', '',
    'ELI ^', 'Yes.', '', 'EXT. PARK - DAY', '',
    '@Mara (CONT’D)', "Don't go.", '', 'INT. ROOM - DAY', '',
  ].join('\n')))
  assert.equal(stats.characters, 2)
  assert.equal(stats.dialogueLines, 4)
  assert.equal(stats.dialogueWords, 6)
  assert.equal(stats.words, 13)
  assert.equal(stats.opening.seconds, 60 / 55)
  assert.deepEqual(stats.scenes.map(scene => [scene.number, scene.characters, scene.dialogueWords]), [
    ['7A', 2, 4], ['2', 1, 2], ['3', 0, 0],
  ])
  assert.equal(stats.scenes[0].seconds, 4 * 60 / 150 + 60 / 55)
  assert.equal(stats.scenes[2].seconds, 0)
  assert.ok(Math.abs(stats.seconds - stats.opening.seconds - stats.scenes.reduce((sum, scene) => sum + scene.seconds, 0)) < 1e-9)
  assert.deepEqual(stats.speakers.map(({ name, words, lines, seconds }) => [name, words, lines, seconds]), [
    ['MARA', 5, 3, 2], ['ELI', 1, 1, 0.4],
  ])
})

test('omitted content, headings and production metadata do not add runtime', () => {
  const stats = screenplayStats(parseFountain([
    'Title: Ignored', '', '# Section', '= Synopsis', '', '[[Note]]', '',
    '/*', 'MARA', 'Not filmed.', '*/', '', '===', '', '> CUT TO:', '',
  ].join('\n')))
  assert.equal(stats.seconds, 0)
  assert.equal(stats.words, 0)
  assert.deepEqual(stats.scenes, [])
  assert.deepEqual(stats.speakers, [])
  const wrapped = screenplayStats(parseFountain(`!${'a'.repeat(61)}\n`))
  assert.equal(wrapped.actionLines, 2)
  assert.equal(wrapped.seconds, 120 / 55)
})

test('scene cast includes silent known characters mentioned in action without counting partial names', () => {
  const stats = screenplayStats(parseFountain('INT. HOUSE - DAY\n\nMARA and ELI enter. MARA nods.\n\nELI\nHi.\n\nEXT. ROAD - DAY\n\nMARATHON banners flutter.\n\nMARA (O.S.)\nHello.\n'))
  assert.deepEqual(stats.scenes.map(({ cast, characters }) => [cast, characters]), [[2, 1], [1, 1]])
})
