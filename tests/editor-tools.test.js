import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import * as Y from 'yjs'
import { wrapSelection, nameCompletions } from '../src/lib/editor-tools.js'
import { reconcileSheets } from '../shared/entities.js'

function editor(text, from, to = from) {
  return {
    state: EditorState.create({ doc: text, selection: { anchor: from, head: to } }),
    dispatch(spec) { this.state = this.state.update(spec).state },
    focus() {},
  }
}
test('formatting shortcuts wrap and toggle without losing the selected text', () => {
  const view = editor('A word.', 2, 6)
  wrapSelection(view, '**', { toggle: true })
  assert.equal(view.state.doc.toString(), 'A **word**.')
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'word')
  wrapSelection(view, '**', { toggle: true })
  assert.equal(view.state.doc.toString(), 'A word.')
  wrapSelection(view, '[', { closing: ']' })
  assert.equal(view.state.doc.toString(), 'A [word].')
  wrapSelection(view, '_')
  assert.equal(view.state.doc.toString(), 'A [_word_].')
})
test('formatting with a collapsed cursor creates paired delimiters', () => {
  const view = editor('Word', 4)
  wrapSelection(view, '*', { toggle: true })
  assert.equal(view.state.doc.toString(), 'Word**')
  assert.equal(view.state.selection.main.head, 5)
})
test('completion is contextual and includes character and location names', () => {
  const doc = new Y.Doc()
  doc.getText('screenplay').insert(0, 'INT. LIGHTHOUSE - NIGHT\n\nMARA\nHello.\n\n@McClane\nHi.')
  reconcileSheets(doc)
  let view = editor('INT. LIGH', 9)
  assert.equal(nameCompletions(doc, view.state, 9).options[0].label, 'LIGHTHOUSE')
  view = editor('MA', 2)
  assert.equal(nameCompletions(doc, view.state, 2).options[0].label, 'MARA')
  view = editor('Mc', 2)
  assert.equal(nameCompletions(doc, view.state, 2).options[0].apply, '@McClane')
  view = editor('MARA\nMA', 7)
  assert.equal(nameCompletions(doc, view.state, 7), null)
  doc.destroy()
})
