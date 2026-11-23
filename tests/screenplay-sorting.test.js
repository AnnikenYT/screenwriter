import assert from 'node:assert/strict'
import test from 'node:test'
import { dialogueLineCounts } from '../shared/dialogue.js'
import { parseFountain } from '../shared/fountain.js'
import { outlineEntries, sortOutline } from '../src/lib/outline.js'

test('dialogue line counts combine cue variants and exclude directions and omitted lines', () => {
  const blocks = parseFountain([
    'MARA (V.O.)', '(quietly)', 'One.', 'Two.', '  ', '[[omit this]]', 'Three.',
    '', '@Mara (CONT’D)', 'Four.', '', 'ELI ^', 'Wait.', '',
    '/*', 'MARA', 'Not filmed.', '*/', '', 'MARA waves.',
  ].join('\n'))
  assert.deepEqual([...dialogueLineCounts(blocks)], [['MARA', 4], ['ELI', 1]])
})

test('scene sort preserves original scene numbers, positions, and duplicate heading order', () => {
  const blocks = parseFountain('# Act one\n\nINT. ZOO - DAY #7A#\n\n= Introduction\n\nEXT. PARK - DAY\n\nEXT. PARK - DAY\n')
  const entries = outlineEntries(blocks)
  assert.deepEqual(sortOutline(entries, 'script').map(e => e.block.type), ['section', 'scene', 'synopsis', 'scene', 'scene'])
  const sorted = sortOutline(entries, 'heading')
  assert.deepEqual(sorted.map(e => e.number), ['2', '3', '7A'])
  assert.equal(sorted[2].nextLine, 5)
  assert.equal(sorted[2].block.from, blocks.find(b => b.type === 'scene').from)
  assert.deepEqual(sortOutline(entries, 'reverse').map(e => e.number), ['3', '2', '7A'])
  assert.deepEqual(sortOutline(entries, 'heading-desc').map(e => e.number), ['7A', '2', '3'])
  assert.equal(entries[0].block.type, 'section')
})
