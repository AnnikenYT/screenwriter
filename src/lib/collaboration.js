import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { characterName, parseFountain } from '../../shared/fountain.js'
import { reconcileSheets } from '../../shared/entities.js'

export function connect(id, user) {
  const doc = new Y.Doc()
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new WebsocketProvider(`${protocol}//${location.host}/collaboration`, id, doc)
  provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, colorLight: `${user.color}25` })
  return { doc, provider, text: doc.getText('screenplay'), scratchpad: doc.getText('scratchpad') }
}

export function relativeAnchor(doc, from, to) {
  const text = doc.getText('screenplay')
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  }
}

export function resolveAnchor(doc, anchor) {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), doc)
    const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), doc)
    if (!a || !b || a.type !== doc.getText('screenplay') || b.type !== a.type) return null
    return { from: a.index, to: Math.max(a.index, b.index) }
  } catch { return null }
}

export function discoverSheets(doc, blocks) {
  reconcileSheets(doc, { prune: false, blocks })
}

// Independent field keys prevent editing one sheet field from overwriting a
// collaborator's simultaneous work in a different field.
export function sheetFieldKey(kind, id, field) { return `sheet:${kind}:${id}:${field}` }
export function readSheet(doc, kind, sheet) {
  if (!sheet) return null
  const result = { ...sheet }
  for (const field of ['age', 'tagline', 'appearance', 'notes', 'images']) {
    const key = sheetFieldKey(kind, sheet.id, field)
    if (doc.getMap('meta').has(key)) result[field] = doc.getMap('meta').get(key)
  }
  return result
}

function replaceName(text, before, after) {
  const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), after)
}

export function renameSheet(doc, kind, id, name) {
  const map = doc.getMap(kind)
  const sheet = map.get(id)
  name = name.trim()
  if (!name || /[\n\r]/.test(name)) throw new Error('Enter a name on one line.')
  if ([...map.values()].some(s => s.id !== id && s.name.toUpperCase() === name.toUpperCase())) throw new Error('A sheet with this name already exists.')
  if (sheet.name === name) return
  doc.transact(() => {
    const text = doc.getText('screenplay')
    const source = text.toString()
    // Apply individual changes from the end, preserving CRDT anchors elsewhere.
    const escaped = sheet.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu')
    const matches = [...source.matchAll(regex)]
    for (const match of matches.reverse()) {
      text.delete(match.index, match[0].length)
      text.insert(match.index, name)
    }
    if (kind === 'characters' && name !== name.toUpperCase()) {
      // Preserve mixed-case character cues with Fountain's explicit @ marker.
      for (const b of parseFountain(text.toString()).reverse()) {
        if (b.type === 'character' && characterName(b.text) === name && !text.toString().slice(b.from, b.to).trim().startsWith('@')) text.insert(b.from, '@')
      }
      // Renamed automatic cues may now parse as action; detect original cue offsets
      // by line and force them explicitly instead.
      const cues = new Set(parseFountain(source).filter(b => b.type === 'character' && characterName(b.text).toUpperCase() === sheet.name.toUpperCase()).map(b => b.startLine))
      const lines = text.toString().split('\n')
      let offset = 0
      const positions = []
      lines.forEach((line, i) => { if (cues.has(i + 1) && !line.trimStart().startsWith('@')) positions.push(offset); offset += line.length + 1 })
      for (const pos of positions.reverse()) text.insert(pos, '@')
    }
    for (const key of ['scratchpad']) {
      const ytext = doc.getText(key)
      const old = ytext.toString()
      const next = replaceName(old, sheet.name, name)
      if (old !== next) { ytext.delete(0, ytext.length); ytext.insert(0, next) }
    }
    for (const collection of ['characters', 'locations']) {
      for (const [key, item] of doc.getMap(collection)) {
        const updated = { ...item }
        for (const field of ['appearance', 'tagline', 'notes']) {
          updated[field] = replaceName(updated[field] || '', sheet.name, name)
          const fieldKey = sheetFieldKey(collection, key, field)
          const meta = doc.getMap('meta')
          if (meta.has(fieldKey)) meta.set(fieldKey, replaceName(meta.get(fieldKey), sheet.name, name))
        }
        if (collection === kind && key === id) updated.name = name
        doc.getMap(collection).set(key, updated)
      }
    }
  }, 'rename')
}
