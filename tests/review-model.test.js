import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { applyReviewChanges, projectReview, sourceToView, viewToSource, annotationViewRange } from '../src/lib/review-model.js'
import { relativeAnchor, resolveAnchor } from '../src/lib/collaboration.js'
import { reconcileSheets } from '../shared/entities.js'
import { sheetFieldKey } from '../src/lib/collaboration.js'

const alice = { id: 'alice', name: 'Alice' }
function fixture(source = 'The cat waits.') {
  const doc = new Y.Doc()
  doc.getText('screenplay').insert(0, source)
  return doc
}
function edit(doc, from, to, replacement, user = alice, suggesting = true) {
  return applyReviewChanges(doc, projectReview(doc), [{ from, to, replacement }], { user, suggesting, origin: 'test' })
}

test('typing and backspacing a proposal is normal editing without changing accepted source', () => {
  const doc = fixture()
  let model = edit(doc, 4, 7, 'd')
  const id = model.spans[0].id
  model = edit(doc, 5, 5, 'o')
  model = edit(doc, 6, 6, 'g')
  assert.equal(model.text, 'The dog waits.')
  assert.equal(doc.getText('screenplay').toString(), 'The cat waits.')
  assert.equal(doc.getMap('suggestions').size, 1)
  assert.equal(model.spans[0].id, id)
  assert.equal(model.spans[0].original, 'cat')
  assert.equal(model.spans[0].replacement, 'dog')
  model = edit(doc, 6, 7, '')
  assert.equal(model.text, 'The do waits.')
  model = edit(doc, 4, 6, 'cat')
  assert.equal(model.text, 'The cat waits.')
  assert.equal(doc.getMap('suggestions').size, 0)
  doc.destroy()
})

test('pure insertions and deletions are editable and have stable coordinate mappings', () => {
  const doc = fixture()
  let model = edit(doc, 4, 7, '')
  assert.equal(model.text, 'The  waits.')
  assert.equal(model.spans[0].original, 'cat')
  model = edit(doc, 4, 4, 'dog')
  assert.equal(model.text, 'The dog waits.')
  for (const [source, projected] of [[0, 0], [4, 4], [7, 7], [14, 14]]) {
    assert.equal(sourceToView(model, source), projected)
    assert.equal(viewToSource(model, projected), source)
  }
  model = edit(doc, model.text.length, model.text.length, ' Again.')
  assert.equal(model.text, 'The dog waits. Again.')
  assert.equal(doc.getText('screenplay').toString(), 'The cat waits.')
  doc.destroy()
})

test('direct editing outside proposals changes accepted source and preserves proposals', () => {
  const doc = fixture()
  edit(doc, 4, 7, 'horse')
  let model = edit(doc, 0, 0, 'Well, ', alice, false)
  assert.equal(model.text, 'Well, The horse waits.')
  assert.equal(doc.getText('screenplay').toString(), 'Well, The cat waits.')
  assert.equal(model.spans[0].replacement, 'horse')
  model = edit(doc, 15, 15, '!', { id: 'bob', name: 'Bob' }, false)
  assert.equal(model.text, 'Well, The horse! waits.')
  assert.equal(doc.getText('screenplay').toString(), 'Well, The cat! waits.')
  assert.throws(() => edit(doc, 12, 12, 'x', { id: 'bob', name: 'Bob' }), /Accept or reject/)
  doc.destroy()
})

test('selection spanning owned proposals merges safely and attribution survives name changes', () => {
  const doc = fixture()
  edit(doc, 4, 7, 'dog')
  let model = edit(doc, 4, 14, 'hound rests.', { ...alice, name: 'Alicia' })
  assert.equal(model.text, 'The hound rests.')
  assert.equal(doc.getMap('suggestions').size, 1)
  assert.equal(model.spans[0].authorId, 'alice')
  assert.equal(doc.getText('screenplay').toString(), 'The cat waits.')
  doc.destroy()
})

test('concurrent distinct proposals converge without changing accepted text', () => {
  const a = fixture(), b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  edit(a, 4, 7, 'dog')
  edit(b, 14, 14, ' Again.', { id: 'bob', name: 'Bob' })
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  assert.equal(projectReview(a).text, 'The dog waits. Again.')
  assert.equal(projectReview(a).text, projectReview(b).text)
  assert.equal(a.getText('screenplay').toString(), 'The cat waits.')
  a.destroy(); b.destroy()
})

test('reconciliation deletes unused sheets and their independent fields, not survivors', () => {
  const doc = fixture('INT. HOUSE - DAY\n\nMARA\nHi.\n\nELI\nHello.')
  reconcileSheets(doc)
  const mara = [...doc.getMap('characters').values()].find(s => s.name === 'MARA')
  const eli = [...doc.getMap('characters').values()].find(s => s.name === 'ELI')
  doc.getMap('meta').set(sheetFieldKey('characters', mara.id, 'notes'), 'Unused')
  doc.getMap('meta').set(sheetFieldKey('characters', eli.id, 'notes'), 'Keep')
  doc.transact(() => {
    const text = doc.getText('screenplay')
    text.delete(0, text.length)
    text.insert(0, 'EXT. ROAD - DAY\n\nELI\nHello.')
  })
  reconcileSheets(doc)
  assert.equal(doc.getMap('characters').size, 1)
  assert.equal(doc.getMap('characters').get(eli.id).name, 'ELI')
  assert.equal(doc.getMap('meta').has(sheetFieldKey('characters', mara.id, 'notes')), false)
  assert.equal(doc.getMap('meta').get(sheetFieldKey('characters', eli.id, 'notes')), 'Keep')
  assert.deepEqual([...doc.getMap('locations').values()].map(s => s.name), ['ROAD'])
  doc.getText('screenplay').insert(doc.getText('screenplay').length, '\n\nMARA\nBack again.')
  reconcileSheets(doc)
  assert.equal(doc.getMap('characters').get(mara.id).name, 'MARA')
  assert.equal(doc.getMap('meta').get(sheetFieldKey('characters', mara.id, 'notes')), 'Unused', 'undo/reintroduction recovers previous sheet fields')
  doc.destroy()
})

test('a character still mentioned in action keeps its notes even without a speaking cue', () => {
  const doc = fixture('MARA\nHello.')
  reconcileSheets(doc)
  const sheet = [...doc.getMap('characters').values()][0]
  const text = doc.getText('screenplay')
  text.delete(0, text.length)
  text.insert(0, 'Mara walks across the room.')
  reconcileSheets(doc)
  assert.equal(doc.getMap('characters').has(sheet.id), true)
  text.delete(0, text.length)
  text.insert(0, 'An empty room.')
  reconcileSheets(doc)
  assert.equal(doc.getMap('characters').size, 0)
  doc.destroy()
})

test('annotations on proposed text follow edits within the same proposal', () => {
  const doc = fixture('A.')
  let model = edit(doc, 1, 1, ' quiet room')
  const id = model.spans[0].id
  doc.getMap('comments').set('c', { id: 'c', anchor: relativeAnchor(doc, 1, 1), proposal: { id, from: 7, to: 11 } })
  model = edit(doc, 2, 2, 'very ')
  const comment = doc.getMap('comments').get('c')
  const range = annotationViewRange(doc, model, comment)
  assert.equal(model.text.slice(range.from, range.to), 'room')
  assert.equal(doc.getText('screenplay').toString(), 'A.')
  doc.destroy()
})

test('formatting and removing wrappers preserve comments and images on unchanged words', () => {
  const doc = fixture()
  const anchor = relativeAnchor(doc, 4, 7)
  edit(doc, 4, 7, '**cat**', alice, false)
  let range = resolveAnchor(doc, anchor)
  assert.equal(doc.getText('screenplay').toString().slice(range.from, range.to), 'cat')
  edit(doc, 4, 11, 'cat', alice, false)
  range = resolveAnchor(doc, anchor)
  assert.equal(doc.getText('screenplay').toString().slice(range.from, range.to), 'cat')
  assert.equal(doc.getText('screenplay').toString(), 'The cat waits.')
  doc.destroy()
})
