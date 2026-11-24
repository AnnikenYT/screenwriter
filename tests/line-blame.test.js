import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { LineBlame } from '../server/line-blame.js'

test('line blame follows unchanged lines and credits split, joined and rewritten lines', () => {
  const doc = new Y.Doc()
  const ytext = doc.getText('screenplay')
  ytext.insert(0, 'One\nTwo\nThree')
  const blame = new LineBlame(ytext.toString(), [[1, { name: 'First' }], [1, null], [1, { name: 'Third' }]])
  let writer
  const edit = (name, callback) => {
    writer = { name }
    doc.transact(callback)
    assert.equal(blame.source.toString(), ytext.toString())
    return blame.writers.map(w => w?.name ?? null)
  }
  ytext.observe(event => blame.update(ytext, event.delta, { writer }))
  assert.deepEqual(edit('Insert', () => ytext.insert(4, 'Middle\n')), ['First', 'Insert', null, 'Third'])
  assert.deepEqual(edit('Split', () => ytext.insert(12, '\n')), ['First', 'Insert', 'Split', 'Split', 'Third'])
  assert.deepEqual(edit('Join', () => ytext.delete(12, 1)), ['First', 'Insert', 'Join', 'Third'])
  assert.deepEqual(edit('Delete', () => ytext.delete(4, 7)), ['First', 'Join', 'Third'])
  assert.deepEqual(edit('Replace', () => { ytext.delete(1, 1); ytext.insert(1, 'N'); ytext.insert(7, '!') }), ['Replace', 'Replace', 'Third'])
  assert.deepEqual(edit('No-op', () => { ytext.delete(0, 3); ytext.insert(0, 'ONe') }), ['Replace', 'Replace', 'Third'])
  doc.destroy()
})
