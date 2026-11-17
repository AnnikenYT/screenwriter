// Source ranges are UTF-16 offsets, matching CodeMirror and Y.Text.
// Parsing is deliberately lossless: unrecognized syntax remains action.
const scenePattern = /^(?:INT\.?\/EXT|INT\/EXT|INT|EXT|EST|I\/E)(?:[. ]|$)/i
const titlePattern = /^(Title|Credit|Author|Authors|Source|Draft date|Contact|Copyright|Notes):/i

export function characterName(text) {
  return text.trim().replace(/^@/, '').replace(/\s*\^\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
}

export function locationName(text) {
  return text.replace(/^\./, '').replace(/^\s*(?:INT\.?\/EXT\.?|INT\/EXT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?)\s+/i, '')
    .replace(/\s*#[\w.-]+#\s*$/, '').replace(/\s+-\s+(?:DAY|NIGHT|MORNING|EVENING|DAWN|DUSK|LATER|CONTINUOUS|SAME|MOMENTS LATER).*$/i, '').trim()
}

export function parseFountain(source) {
  const raw = source.split('\n')
  const lines = []
  let offset = 0
  let boneyard = false
  let note = false
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].replace(/\r$/, '')
    // Source offsets come from raw lines; visible text omits annotations.
    let visible = ''
    let hiddenKind = boneyard ? 'boneyard' : note ? 'note' : null
    for (let j = 0; j < text.length; j++) {
      if (boneyard) {
        if (text.slice(j, j + 2) === '*/') { boneyard = false; j++ }
      } else if (note) {
        if (text.slice(j, j + 2) === ']]') { note = false; j++ }
      } else if (text.slice(j, j + 2) === '/*') { boneyard = true; hiddenKind = 'boneyard'; j++ }
      else if (text.slice(j, j + 2) === '[[') { note = true; hiddenKind = 'note'; j++ }
      else visible += text[j]
    }
    lines.push({ raw: text, visible, hiddenKind, from: offset, to: offset + text.length, number: i + 1 })
    offset += raw[i].length + 1
    if (!text.trim() && note) note = false
  }
  const blocks = []
  let dialogue = false
  let group = null
  let title = titlePattern.test(raw[0] || '')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const text = line.visible.trim()
    const prevBlank = i === 0 || !lines[i - 1].visible.trim()
    const next = lines[i + 1]?.visible.trim() || ''
    let type = 'action'
    let content = line.visible.trimEnd()
    let extra = {}
    if (title && (titlePattern.test(line.raw) || /^(?: {3,}|\t)/.test(line.raw))) {
      type = 'title'
    } else {
      if (!text) title = false
      if (!text && line.hiddenKind) type = line.hiddenKind
      else if (!text && line.raw.length < 2) { type = 'blank'; dialogue = false; group = null }
      else if (/^={3,}$/.test(text)) type = 'pagebreak'
      else if (/^#{1,6}\s/.test(text)) type = 'section'
      else if (/^=(?!=)/.test(text)) type = 'synopsis'
      else if (/^>.*<$/.test(text)) { type = 'centered'; content = text.slice(1, -1).trim() }
      else if (/^~/.test(text)) { type = 'lyric'; content = text.slice(1) }
      else if (/^!/.test(text)) { type = 'action'; content = text.slice(1); dialogue = false }
      else if (/^\.[\p{L}\p{N}]/u.test(text) || (prevBlank && scenePattern.test(text) && !next)) {
        type = 'scene'
        content = text.replace(/^\./, '')
        const number = content.match(/\s+#([\w.-]+)#\s*$/)
        if (number) { extra.sceneNumber = number[1]; content = content.slice(0, number.index) }
        dialogue = false
      } else if (text.startsWith('>') || (prevBlank && !next && /^[^a-z]+TO:$/.test(text))) {
        type = 'transition'; content = text.replace(/^>\s*/, ''); dialogue = false
      } else if (text.startsWith('@') || (prevBlank && next && /^[^\p{Ll}]*\p{Lu}[^\p{Ll}]*$/u.test(text.replace(/\([^)]*\)\s*\^?$/, '')))) {
        type = 'character'; content = text.replace(/^@/, '').replace(/\s*\^$/, '')
        extra.dual = /\^$/.test(text)
        dialogue = true; group = line.number
      } else if (dialogue) {
        type = /^\(.*\)$/.test(text) ? 'parenthetical' : 'dialogue'
        content = text
      }
    }
    const last = blocks.at(-1)
    if (last && last.type === type && ['action', 'dialogue', 'title', 'boneyard', 'note'].includes(type)) {
      last.text += '\n' + content
      last.to = line.to; last.endLine = line.number
    } else {
      blocks.push({ type, text: content, from: line.from, to: line.to, startLine: line.number, endLine: line.number, ...extra, ...(dialogue ? { group } : {}) })
    }
  }
  // Dialogue cues, parentheticals and dialogue share a raw-editing region.
  const ends = new Map()
  for (const block of blocks) if (block.group) ends.set(block.group, block.endLine)
  for (const block of blocks) if (block.group) block.groupEnd = ends.get(block.group)
  return blocks
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Restricted inline Fountain markup: no HTML, links or executable attributes.
export function inlineFountain(text) {
  const escaped = []
  let html = escapeHtml(text.replace(/\\([\\*_])/g, (_, c) => `\u0000${escaped.push(c) - 1}\u0000`))
  html = html.replace(/\*\*\*(?=\S)(.+?\S|\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)(.+?\S|\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?=\S)([^*\n]*?\S|[^*\s])\*(?!\*)/g, '<em>$1</em>')
    .replace(/_(?=\S)([^_\n]*?\S|[^_\s])_/g, '<u>$1</u>')
  return html.replace(/\u0000(\d+)\u0000/g, (_, n) => escapeHtml(escaped[Number(n)]))
}

export function plainText(text) {
  const escaped = []
  const protectedText = text.replace(/\\([\\*_])/g, (_, c) => `\u0000${escaped.push(c) - 1}\u0000`)
  return protectedText.replace(/(\*{1,3}|_)(?=\S)(.+?)\1/g, '$2').replace(/\u0000(\d+)\u0000/g, (_, n) => escaped[Number(n)])
}

export function titleFields(text) {
  const fields = {}
  let key = ''
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (match) {
      key = match[1].trim().toLowerCase()
      fields[key] = match[2]
    } else if (key) fields[key] += `${fields[key] ? '\n' : ''}${line.trim()}`
  }
  return fields
}
