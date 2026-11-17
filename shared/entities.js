import { characterName, locationName, parseFountain } from './fountain.js'

export function changeSheetStatus(doc, kind, id, status) {
  if (!['characters', 'locations'].includes(kind) || !['active', 'archived', 'deleted'].includes(status)) throw new Error('Invalid sheet action')
  const map = doc.getMap(kind), sheet = map.get(id)
  if (!sheet || sheet.status === 'deleted') throw new Error('Sheet not found')
  doc.transact(() => {
    if (status === 'deleted') {
      const meta = doc.getMap('meta')
      for (const key of meta.keys()) if (key.startsWith(`sheet:${kind}:${id}:`)) meta.delete(key)
      meta.delete(`sheet-archive:${kind}:${sheet.name.toUpperCase()}`)
      // Keep only a name tombstone so discovery does not recreate the sheet.
      map.set(id, { id, name: sheet.name, status })
    } else map.set(id, { ...sheet, status, retained: true })
  }, 'sheet-lifecycle')
}

// Reconcile from the authoritative screenplay, never from projected suggestions.
// The server calls this after edits settle so transient, partially typed cues do
// not immediately destroy sheet notes.
export function reconcileSheets(doc, { prune = true, blocks = parseFountain(doc.getText('screenplay').toString()) } = {}) {
  const visibleText = blocks.filter(block => !['title', 'note', 'boneyard', 'section', 'synopsis'].includes(block.type)).map(block => block.text).join('\n')
  doc.transact(() => {
    for (const [kind, type, getName] of [['characters', 'character', characterName], ['locations', 'scene', locationName]]) {
      const map = doc.getMap(kind)
      const present = new Map(blocks.filter(block => block.type === type).map(block => {
        const name = getName(block.text)
        return [name.toUpperCase(), name]
      }).filter(([, name]) => name))
      const known = new Set()
      for (const [id, sheet] of map) {
        const name = sheet.name.toUpperCase()
        if (sheet.status === 'archived' || sheet.status === 'deleted' || sheet.retained) { known.add(name); continue }
        const escaped = sheet.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const stillMentioned = kind === 'characters' && new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(visibleText)
        if (prune && !present.has(name) && !stillMentioned) {
          const meta = doc.getMap('meta')
          const fields = {}
          const prefix = `sheet:${kind}:${id}:`
          for (const key of meta.keys()) if (key.startsWith(prefix)) { fields[key] = meta.get(key); meta.delete(key) }
          // Remove from the active collection, but let undo/reintroduced names
          // recover their notes and moodboards instead of silently losing them.
          meta.set(`sheet-archive:${kind}:${name}`, { sheet: { ...sheet, id }, fields })
          map.delete(id)
        } else known.add(name)
      }
      for (const [canonical, name] of present) {
        if (known.has(canonical)) continue
        const meta = doc.getMap('meta')
        const archiveKey = `sheet-archive:${kind}:${canonical}`
        const archived = meta.get(archiveKey)
        if (archived) {
          map.set(archived.sheet.id, archived.sheet)
          for (const [key, value] of Object.entries(archived.fields)) meta.set(key, value)
          meta.delete(archiveKey)
          continue
        }
        const id = `${kind}-${encodeURIComponent(canonical)}`
        map.set(id, { id, name, age: '', tagline: '', appearance: '', notes: '', images: [] })
      }
    }
  }, 'sheet-reconciliation')
}
