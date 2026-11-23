import { characterName } from './fountain.js'

export function* spokenBlocks(blocks) {
  let cue, name
  for (const block of blocks) {
    if (block.type === 'character') {
      cue = block
      name = characterName(block.text)
    } else if (block.type === 'dialogue' && name && block.group === cue.group) {
      // Count source lines, not display wrapping or Fountain's blank dialogue lines.
      const lines = block.text.split('\n').filter(line => line.trim())
      if (lines.length) yield { block, cue, name, key: name.toUpperCase(), lines }
    }
  }
}

export function dialogueLineCounts(blocks) {
  const counts = new Map()
  for (const { key, lines } of spokenBlocks(blocks)) {
    counts.set(key, (counts.get(key) ?? 0) + lines.length)
  }
  return counts
}
