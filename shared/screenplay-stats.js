import { spokenBlocks } from './dialogue.js'
import { characterName, plainText } from './fountain.js'

export const WORDS_PER_MINUTE = 150
export const ACTION_COLUMNS = 60
export const ACTION_LINES_PER_MINUTE = 55

const actionTypes = new Set(['action', 'centered', 'lyric'])
const countWords = text => (text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? []).length
const speakingSeconds = words => words * 60 / WORDS_PER_MINUTE
const totals = () => ({ words: 0, dialogueLines: 0, dialogueWords: 0, actionLines: 0, speakers: new Set(), cast: new Set() })

function summarize({ speakers, cast, ...counts }) {
  return {
    ...counts,
    characters: speakers.size,
    cast: cast.size,
    seconds: speakingSeconds(counts.dialogueWords) + counts.actionLines * 60 / ACTION_LINES_PER_MINUTE,
  }
}

export function screenplayStats(blocks) {
  const script = totals()
  const opening = totals()
  const scenes = []
  const characters = new Map()
  const names = [...new Set(blocks.filter(block => block.type === 'character')
    .map(block => characterName(block.text).toUpperCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  const castMatcher = names.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null
  let part = opening
  const spoken = spokenBlocks(blocks)
  let dialogue = spoken.next().value
  for (const block of blocks) {
    if (block.type === 'scene') {
      part = totals()
      scenes.push({ block, number: block.sceneNumber || String(scenes.length + 1), part })
    } else if (block.type === 'character') {
      const key = characterName(block.text).toUpperCase()
      if (key) { script.cast.add(key); part.cast.add(key) }
    } else if (block === dialogue?.block) {
      const { cue, key, name, lines } = dialogue
      const words = countWords(plainText(block.text))
      if (!characters.has(key)) characters.set(key, { name, from: cue.from, words: 0, lines: 0 })
      const character = characters.get(key)
      character.words += words
      character.lines += lines.length
      for (const bucket of [script, part]) {
        bucket.words += words
        bucket.dialogueWords += words
        bucket.dialogueLines += lines.length
        bucket.speakers.add(key)
      }
      dialogue = spoken.next().value
    } else if (actionTypes.has(block.type)) {
      const text = plainText(block.text)
      const words = countWords(text)
      const lines = text.split('\n').reduce((n, line) => n + Math.ceil(line.trim().length / ACTION_COLUMNS), 0)
      if (block.type === 'action' && castMatcher) {
        for (const [name] of text.matchAll(castMatcher)) { script.cast.add(name); part.cast.add(name) }
      }
      for (const bucket of [script, part]) {
        bucket.words += words
        bucket.actionLines += lines
      }
    }
  }
  return {
    ...summarize(script),
    opening: summarize(opening),
    scenes: scenes.map(({ block, number, part }) => ({ block, number, ...summarize(part) })),
    speakers: [...characters.values()].map(character => ({ ...character, seconds: speakingSeconds(character.words) }))
      .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name)),
  }
}
