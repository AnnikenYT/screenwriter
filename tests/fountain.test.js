import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFountain, inlineFountain, plainText, characterName, locationName, titleFields } from '../shared/fountain.js'

test('scene headings, dialogue groups and UTF16 source ranges', () => {
  const text = 'INT. CAFÉ - DAY #1A#\n\nA door opens. 🎬\n\nMARA (softly)\n(quietly)\nHello.\nTwo lines.\n\n\n!LOUD ACTION\n'
  const blocks = parseFountain(text)
  assert.equal(blocks[0].type, 'scene')
  assert.equal(blocks[0].text, 'INT. CAFÉ - DAY')
  assert.equal(blocks[0].sceneNumber, '1A')
  const cue = blocks.find(b => b.type === 'character')
  assert.equal(cue.text, 'MARA (softly)')
  assert.equal(characterName(cue.text), 'MARA')
  const dialogue = blocks.find(b => b.type === 'dialogue')
  assert.equal(dialogue.text, 'Hello.\nTwo lines.')
  assert.equal(dialogue.group, cue.startLine)
  assert.equal(cue.groupEnd, dialogue.endLine)
  assert.equal(text.slice(dialogue.from, dialogue.to), 'Hello.\nTwo lines.')
  assert.equal(blocks.find(b => b.text === 'LOUD ACTION').type, 'action')
})

test('forced syntax, dual dialogue, transitions, lyrics, center and structure', () => {
  const blocks = parseFountain('.SOMEWHERE\n\n@McClane\nOne.\n\nMARA ^\nTwo.\n\n> FADE OUT.\n\n> THE END <\n\n~A song\n\n# Act I\n= A synopsis\n===\n')
  for (const type of ['scene', 'character', 'dialogue', 'transition', 'centered', 'lyric', 'section', 'synopsis', 'pagebreak']) assert.ok(blocks.some(b => b.type === type), type)
  assert.equal(blocks.filter(b => b.type === 'character')[1].dual, true)
  assert.equal(locationName('INT./EXT. OLD HOUSE - NIGHT #4#'), 'OLD HOUSE')
  assert.equal(locationName('EXT. ROAD - CONTINUOUS'), 'ROAD')
})

test('boneyards span paragraphs and inline notes never reach output', () => {
  const source = 'He [[private]]runs.\n\n/*\nINT. SECRET - NIGHT\n\nHIDDEN\nGone.\n*/\n\nINT. REAL - DAY\n\nVisible.'
  const blocks = parseFountain(source)
  assert.equal(blocks[0].text, 'He runs.')
  assert.deepEqual(blocks.filter(b => b.type === 'scene').map(b => b.text), ['INT. REAL - DAY'])
  assert.ok(blocks.some(b => b.type === 'boneyard'))
})

test('intentional whitespace dialogue and title page continuation', () => {
  const blocks = parseFountain('Title:\n    A Small Film\nAuthor: Someone\n\nINT. ROOM - DAY\n\nMARA\nFirst.\n  \nLast.\n')
  const fields = titleFields(blocks[0].text)
  assert.equal(fields.title, 'A Small Film')
  assert.equal(fields.author, 'Someone')
  assert.equal(blocks.find(b => b.type === 'dialogue').text, 'First.\n\nLast.')
})

test('safe inline emphasis and escaping', () => {
  assert.equal(inlineFountain('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(inlineFountain('***bold italic*** _under_ **bold** *italic*'), '<strong><em>bold italic</em></strong> <u>under</u> <strong>bold</strong> <em>italic</em>')
  assert.equal(inlineFountain('\\*not italic\\*'), '*not italic*')
  assert.equal(plainText('\\*not italic\\* **bold**'), '*not italic* bold')
  assert.equal(inlineFountain('*one\n\ntwo*'), '*one\n\ntwo*')
})
