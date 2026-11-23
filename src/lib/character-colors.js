import { characterName } from '../../shared/fountain.js'

const palette = [
  '#b54b46', '#a75d29', '#8c700e', '#598028', '#32804e', '#20817b',
  '#2e789e', '#4c66b4', '#7658b5', '#a149a3', '#b0467b', '#9e5b68',
]

export const characterColorKey = id => `sheet:characters:${id}:color`
export const isCharacterColorKey = key => key.startsWith('sheet:characters:') && key.endsWith(':color')
export const isCharacterColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
export const characterCueName = block => block.type === 'character' ? characterName(block.text).toUpperCase() : ''

function hash(name) {
  let value = 2166136261
  for (const letter of name) value = Math.imul(value ^ letter.codePointAt(0), 16777619)
  return value >>> 0
}

export function screenplayCharacterColors(doc, blocks) {
  const meta = doc.getMap('meta')
  const sheets = new Map([...doc.getMap('characters').values()].filter(sheet => sheet.status !== 'deleted').map(sheet => [sheet.name.toUpperCase(), sheet]))
  const names = new Set([...sheets.keys()])
  for (const block of blocks) {
    const name = characterCueName(block)
    if (name) names.add(name)
  }
  const used = new Set()
  const colors = new Map()
  // Resolve default collisions in name order, independently of custom choices.
  for (const name of [...names].sort()) {
    const seed = hash(name)
    let fallback = palette[seed % palette.length]
    for (let offset = 1; used.has(fallback); offset++) {
      fallback = offset < palette.length
        ? palette[(seed + offset) % palette.length]
        : `#${((seed + Math.imul(offset, 0x9e3779)) & 0xffffff).toString(16).padStart(6, '0')}`
    }
    used.add(fallback)
    const sheet = sheets.get(name)
    const custom = sheet && meta.get(characterColorKey(sheet.id))
    colors.set(name, isCharacterColor(custom) ? custom.toLowerCase() : fallback)
  }
  return colors
}
