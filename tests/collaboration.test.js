import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { relativeAnchor, resolveAnchor, discoverSheets, renameSheet, readSheet, sheetFieldKey } from '../src/lib/collaboration.js'
import { parseFountain } from '../shared/fountain.js'

test('anchors survive concurrent insertion before a selected passage', () => {
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText('screenplay').insert(0, 'Hello world.')
  const anchor = relativeAnchor(a, 6, 11)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  b.getText('screenplay').insert(0, 'Before. ')
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  const range = resolveAnchor(a, anchor)
  assert.equal(a.getText('screenplay').toString().slice(range.from, range.to), 'world')
  a.destroy(); b.destroy()
})

test('sheet discovery is idempotent across concurrent clients', () => {
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText('screenplay').insert(0, 'INT. HOUSE - DAY\n\nMARA\nHello.\n\nMARA\nAgain.')
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  discoverSheets(a, parseFountain(a.getText('screenplay').toString()))
  discoverSheets(b, parseFountain(b.getText('screenplay').toString()))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  assert.equal(a.getMap('characters').size, 1)
  assert.equal(a.getMap('locations').size, 1)
  assert.deepEqual(a.getMap('characters').toJSON(), b.getMap('characters').toJSON())
  a.destroy(); b.destroy()
})

test('renaming changes cues and whole word mentions, preserving mixed-case cues', () => {
  const doc = new Y.Doc()
  doc.getText('screenplay').insert(0, 'INT. ROOM - DAY\n\nMARA holds a MARATHON medal.\n\nMARA (V.O.)\nMara was here.')
  doc.getText('scratchpad').insert(0, '# Mara\nNotes for MARA.')
  discoverSheets(doc, parseFountain(doc.getText('screenplay').toString()))
  const sheet = [...doc.getMap('characters').values()][0]
  renameSheet(doc, 'characters', sheet.id, 'McClane')
  const text = doc.getText('screenplay').toString()
  assert.ok(text.includes('McClane holds a MARATHON medal.'))
  assert.ok(text.includes('@McClane (V.O.)'))
  assert.equal(parseFountain(text).find(b => b.type === 'character').text, 'McClane (V.O.)')
  assert.equal(doc.getText('scratchpad').toString(), '# McClane\nNotes for McClane.')
  assert.equal(doc.getMap('characters').get(sheet.id).name, 'McClane')
  discoverSheets(doc, parseFountain(text))
  assert.equal(doc.getMap('characters').size, 1)
  doc.destroy()
})

test('simultaneous edits to different sheet fields both survive', () => {
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText('screenplay').insert(0, 'MARA\nHello.')
  discoverSheets(a, parseFountain(a.getText('screenplay').toString()))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const sheet = [...a.getMap('characters').values()][0]
  a.getMap('meta').set(sheetFieldKey('characters', sheet.id, 'age'), '34')
  b.getMap('meta').set(sheetFieldKey('characters', sheet.id, 'notes'), 'MARA is hiding something.')
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const merged = readSheet(a, 'characters', sheet)
  assert.equal(merged.age, '34')
  assert.equal(merged.notes, 'MARA is hiding something.')
  renameSheet(a, 'characters', sheet.id, 'ELI')
  assert.equal(readSheet(a, 'characters', a.getMap('characters').get(sheet.id)).notes, 'ELI is hiding something.')
  a.destroy(); b.destroy()
})
