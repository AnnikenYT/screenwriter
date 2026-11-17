import { EditorSelection } from '@codemirror/state'
import { autocompletion, acceptCompletion, startCompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { characterName, locationName, parseFountain } from '../../shared/fountain.js'
import { parsedFountain } from './fountain-editor.js'

export function wrapSelection(view, delimiter, { toggle = false, closing = delimiter } = {}) {
  const changes = view.state.changeByRange(range => {
    const selected = view.state.sliceDoc(range.from, range.to)
    let from = range.from, to = range.to, insert, anchor
    if (toggle && selected.startsWith(delimiter) && selected.endsWith(closing) && selected.length >= delimiter.length + closing.length) {
      insert = selected.slice(delimiter.length, -closing.length)
      anchor = from
    } else if (toggle && from >= delimiter.length && view.state.sliceDoc(from - delimiter.length, from) === delimiter && view.state.sliceDoc(to, to + closing.length) === closing) {
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
  const names = new Set([...doc.getMap(kind).values()].map(sheet => sheet.name))
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

export function screenplayTools(doc, onImageLink) {
  return [
    autocompletion({ override: [context => nameCompletions(doc, context.state, context.pos)], activateOnTyping: true }),
    keymap.of([
      { key: 'Mod-b', run: view => wrapSelection(view, '**', { toggle: true }) },
      { key: 'Mod-i', run: view => wrapSelection(view, '*', { toggle: true }) },
      { key: 'Mod-u', run: view => wrapSelection(view, '_', { toggle: true }) },
      { key: 'Mod-Shift-k', run: () => { onImageLink(); return true } },
      { key: 'Tab', run: view => {
        if (acceptCompletion(view)) return true
        const result = nameCompletions(doc, view.state, view.state.selection.main.head)
        if (!result) return false
        const completion = result.options[0]
        const insert = completion.apply || completion.label
        view.dispatch({ changes: { from: result.from, to: view.state.selection.main.head, insert }, selection: { anchor: result.from + insert.length }, userEvent: 'input.complete' })
        return true
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
