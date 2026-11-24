import test from 'node:test'
import assert from 'node:assert/strict'
import { editorColorInk, defaultEditorColor, normalizeEditorColor } from '../shared/editor-colors.js'

test('editor ink chooses the higher black or white contrast, including mid gray', () => {
  assert.equal(editorColorInk('#808080'), '#000000')
  assert.equal(editorColorInk('#ffffff'), '#000000')
  assert.equal(editorColorInk('#000000'), '#ffffff')
  for (let gray = 0; gray <= 255; gray++) {
    const color = `#${gray.toString(16).padStart(2, '0').repeat(3)}`
    const channel = gray / 255
    const luminance = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    const contrast = editorColorInk(color) === '#000000' ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05)
    assert.ok(contrast >= 4.5, `${color}: ${contrast}`)
  }
})

test('editor defaults are stable and custom colors normalize without accepting CSS', () => {
  assert.equal(defaultEditorColor('ada'), defaultEditorColor('ada'))
  assert.notEqual(defaultEditorColor('ada'), defaultEditorColor('bo'))
  assert.equal(normalizeEditorColor('#ABCDEF'), '#abcdef')
  for (const value of [null, 'red', '#abc', '#123456;']) assert.equal(normalizeEditorColor(value), null)
})
