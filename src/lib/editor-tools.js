import { EditorSelection } from '@codemirror/state'
import { autocompletion, acceptCompletion, startCompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { characterName, locationName, parseFountain } from '../../shared/fountain.js'
import { parsedFountain } from './fountain-editor.js'

export function wrapSelection(view, delimiter, { toggle = false, closing = delimiter } = {}) {
  const changes = view.state.changeByRange(range => {
    const selected = view.state.sliceDoc(range.from, range.to)
    const starActive = depth => delimiter === '*' ? depth % 2 === 1 : depth >= 2
    const selectedDepth = Math.min(selected.match(/^\*+/)?.[0].length || 0, selected.match(/(?<!\\)\*+$/)?.[0].length || 0)
    const before = view.state.sliceDoc(0, range.from)
    const after = view.state.sliceDoc(range.to)
    const surroundingDepth = Math.min(before.match(/(?<!\\)\*+$/)?.[0].length || 0, after.match(/^\*+/)?.[0].length || 0)
    const stars = delimiter === '*' || delimiter === '**'
    const selectedWrapped = selected.startsWith(delimiter) && selected.endsWith(closing) && (!stars || starActive(selectedDepth))
    const surroundingWrapped = view.state.sliceDoc(range.from - Math.min(range.from, delimiter.length), range.from) === delimiter && after.slice(0, closing.length) === closing && (!stars || starActive(surroundingDepth))
    let from = range.from, to = range.to, insert, anchor
    if (toggle && selectedWrapped && selected.length >= delimiter.length + closing.length) {
      insert = selected.slice(delimiter.length, -closing.length)
      anchor = from
    } else if (toggle && from >= delimiter.length && surroundingWrapped) {
      from -= delimiter.length
      to += closing.length
      insert = selected
      anchor = from
    } else {
      insert = delimiter + selected + closing
      anchor = from + delimiter.length
    }
    return {
      changes: { from, to, insert },
      range: EditorSelection.range(anchor, anchor + selected.length - (insert.length < selected.length ? delimiter.length + closing.length : 0)),
    }
  })
  view.dispatch({ ...changes, userEvent: 'input.format' })
  view.focus()
  return true
}

export function nameCompletions(doc, state, position) {
  const line = state.doc.lineAt(position)
  const before = state.sliceDoc(line.from, position)
  const location = before.match(/^(?:\.(?=[\p{L}\p{N}])|(?:INT\.?\/EXT\.?|INT\/EXT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?)\s+)(.*)$/iu)
  const character = !location && before.match(/^\s*@?([\p{L}\p{N} .'’-]+)$/u)
  const match = location || character
  if (!match) return null
  if (!location && !before.trim().startsWith('@')) {
    // Never complete ordinary action/dialogue paragraphs in the middle of a line.
    const previous = line.number > 1 ? state.doc.line(line.number - 1).text : ''
    if (previous.trim()) return null
  }
  const kind = location ? 'locations' : 'characters'
  const prefix = match[1]
  if (!prefix.trim()) return null
  const names = new Set([...doc.getMap(kind).values()].filter(sheet => !sheet.status || sheet.status === 'active').map(sheet => sheet.name))
  // Include newly typed names before the server's settled-sheet reconciliation.
  for (const block of state.field(parsedFountain, false) || parseFountain(state.doc.toString())) {
    if (block.type === (location ? 'scene' : 'character')) names.add(location ? locationName(block.text) : characterName(block.text))
  }
  const options = [...names].filter(name => name.toUpperCase().startsWith(prefix.toUpperCase()) && name.toUpperCase() !== prefix.toUpperCase()).sort().map(name => ({
    label: name,
    type: location ? 'constant' : 'variable',
    detail: location ? 'Location · Tab' : 'Character · Tab',
    apply: !location && name !== name.toUpperCase() && !before.trimStart().startsWith('@') ? `@${name}` : name,
  }))
  return options.length ? { from: position - prefix.length, options, filter: true } : null
}

const headingPrefixes = ['EXT. ', 'INT. ', 'INT./EXT. ']
const actionPrefixes = ['SHOT: ', 'VFX: ', 'SFX: ']
const headingTimes = ['MORNING', 'NOON', 'DAY', 'EVENING', 'NIGHT', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER']
const cueExtensions = ["(CONT'D)", '(V.O.)', '(O.S.)', '(O.C.)']

export function screenplayCompletions(doc, state, position) {
  const line = state.doc.lineAt(position)
  const before = state.sliceDoc(line.from, position)
  const blocks = state.field(parsedFountain, false) || parseFountain(state.doc.toString())
  const block = blocks.find(block => line.number >= block.startLine && line.number <= block.endLine)
  if (['title', 'note', 'boneyard'].includes(block?.type) || !state.selection.main.empty) return null
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : ''
  const heading = /^(?:INT\.?\/EXT\.?|INT\/EXT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?)\s+(.+)$/i.exec(before)
  if (heading && previous.trim() && block?.type !== 'scene') return null
  const result = (from, values, prefix, detail) => {
    const options = values.filter(value => value.toUpperCase().startsWith(prefix.toUpperCase()) && value !== prefix)
      .map(value => ({ label: value.trimEnd(), apply: value, type: 'keyword', detail }))
    return options.length ? { from, options, filter: false } : null
  }
  // Extensions belong on cues, never in the dialogue immediately below them.
  const name = characterName(before.replace(/\s*\([^)]*$/, ''))
  const known = [...doc.getMap('characters').values()].some(sheet => sheet.name.toUpperCase() === name.toUpperCase())
  const cueText = before.replace(/\([^)]*(?:\)|$)/g, '').trim()
  const newCue = cueText.length <= 60 && /^(?=.*\p{Lu})[^\p{Ll}:]+$/u.test(cueText)
  if (!heading && (block?.type === 'character' || (!previous.trim() && (known || newCue || before.trimStart().startsWith('@'))))) {
    const extensions = cueExtensions.filter(value => !before.includes(value))
    const extension = before.match(/\([^)]*$/)
    if (extension) return result(line.from + extension.index, extensions, extension[0], 'Dialogue extension')
    if (/\S\s+$/.test(before)) return result(position, extensions, '', 'Dialogue extension')
  }
  const names = nameCompletions(doc, state, position)
  if (heading) {
    // Replace the separator as a unit, so " - N" never becomes " -  - NIGHT".
    const time = heading[1].match(/^(.+?\S)(\s+-\s*|\s+-?)([A-Za-z ]*)$/)
    if (time && (!names || time[2].includes('-'))) {
      const from = position - time[2].length - time[3].length
      return result(from, headingTimes.map(value => ` - ${value}`), ` - ${time[3].toUpperCase()}`, 'Time of day')
    }
    return names
  }
  if (!previous.trim() && /^[A-Za-z./:]+$/.test(before)) {
    const keywords = result(line.from, [...headingPrefixes, ...actionPrefixes], before, 'Screenplay')
    if (keywords) return keywords
  }
  // Production labels can also start an action line within an action block.
  if (block?.type === 'action' && /^[A-Za-z:]+$/.test(before)) {
    const keywords = result(line.from, actionPrefixes, before, 'Production cue')
    if (keywords) return keywords
  }
  return names
}

export function completeName(view, doc) {
  if (acceptCompletion(view)) { view.focus(); return true }
  const result = screenplayCompletions(doc, view.state, view.state.selection.main.head)
  if (!result) return false
  const completion = result.options[0]
  const insert = completion.apply || completion.label
  view.dispatch({ changes: { from: result.from, to: view.state.selection.main.head, insert }, selection: { anchor: result.from + insert.length }, userEvent: 'input.complete' })
  view.focus()
  return true
}

export function insertScreenplayName(view, name, kind) {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const location = kind === 'locations'
  const heading = line.text.match(/^((?:INT\.?\/EXT\.?|INT\/EXT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?)\s+)(.*?)(\s+-\s+.*)?$/i)
  const blocks = view.state.field(parsedFountain, false) || parseFountain(view.state.doc.toString())
  const block = blocks.find(block => line.number >= block.startLine && line.number <= block.endLine)
  const prefix = line.text.trim().replace(/^@/, '')
  const partialCue = !heading && block?.type === 'action' && prefix.length > 0 && prefix.length < name.length &&
    (line.number === 1 || !view.state.doc.line(line.number - 1).text.trim()) && name.toUpperCase().startsWith(prefix.toUpperCase())
  const cue = /^\s*@/.test(line.text) || block?.type === 'character' || partialCue
  if (location && heading && name) {
    const insert = heading[1] + name + (heading[3] || '')
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + heading[1].length + name.length }, userEvent: 'input.complete' })
  } else if (!location && cue && name) {
    const suffix = line.text.match(/(\s*\([^)]*\))?(\s*\^)?\s*$/)?.[0] || ''
    const insert = `@${name}${suffix}`
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.complete' })
  } else {
    const snippet = location ? `INT. ${name}` : name ? `@${name}\n` : '@'
    let end = line.to
    let following = line.number + 1
    while (line.text.trim() && following <= view.state.doc.lines && view.state.doc.line(following).text.trim()) end = view.state.doc.line(following++).to
    const from = line.text.trim() ? end : line.from
    const to = line.text.trim() ? end : line.to
    const prefix = line.text.trim() ? '\n\n' : ''
    view.dispatch({ changes: { from, to, insert: prefix + snippet }, selection: { anchor: from + prefix.length + snippet.length }, userEvent: 'input.complete' })
  }
  view.focus()
  return true
}

export function insertParenthetical(view) {
  const range = view.state.selection.main
  if (!range.empty) return wrapSelection(view, '(', { closing: ')' })
  const line = view.state.doc.lineAt(range.head)
  const insert = line.text.trim() ? '\n()' : '()'
  const from = line.text.trim() ? line.to : range.head
  view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length - 1 }, userEvent: 'input.format' })
  view.focus()
  return true
}

export function screenplayTools(doc, onImageLink) {
  return [
    autocompletion({ override: [context => screenplayCompletions(doc, context.state, context.pos)], activateOnTyping: true }),
    keymap.of([
      { key: 'Mod-b', run: view => wrapSelection(view, '**', { toggle: true }) },
      { key: 'Mod-i', run: view => wrapSelection(view, '*', { toggle: true }) },
      { key: 'Mod-u', run: view => wrapSelection(view, '_', { toggle: true }) },
      { key: 'Mod-Shift-k', run: () => { onImageLink(); return true } },
      { key: 'Tab', run: view => {
        return completeName(view, doc)
      } },
      { key: 'Ctrl-Space', run: startCompletion },
    ]),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.ctrlKey || event.metaKey || event.altKey || view.state.selection.main.empty || !['*', '_', '['].includes(event.key)) return false
        event.preventDefault()
        return wrapSelection(view, event.key, { closing: event.key === '[' ? ']' : event.key })
      },
    }),
  ]
}
