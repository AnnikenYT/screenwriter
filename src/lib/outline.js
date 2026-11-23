export function outlineEntries(blocks) {
  const entries = []
  let sceneIndex = 0
  for (const block of blocks) {
    if (!['scene', 'section', 'synopsis'].includes(block.type)) continue
    if (entries.length) entries.at(-1).nextLine = block.startLine
    if (block.type === 'scene') sceneIndex++
    entries.push({ block, number: block.type === 'scene' ? (block.sceneNumber || String(sceneIndex)) : null, nextLine: Infinity })
  }
  return entries
}

export function sortOutline(entries, order) {
  if (order === 'script') return entries
  const scenes = entries.filter(entry => entry.block.type === 'scene')
  if (order === 'reverse') return scenes.reverse()
  const direction = order === 'heading-desc' ? -1 : 1
  return scenes.sort((a, b) => direction * a.block.text.localeCompare(b.block.text, undefined, { sensitivity: 'base' }))
}
