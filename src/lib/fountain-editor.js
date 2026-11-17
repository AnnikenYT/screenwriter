import { StateField } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import { parseFountain } from '../../shared/fountain.js'

export const parsedFountain = StateField.define({
  create: state => parseFountain(state.doc.toString()),
  update: (blocks, tr) => tr.docChanged ? parseFountain(tr.newDoc.toString()) : blocks,
})

function markup(line, from, raw, ranges, type) {
  const add = (a, b, spec) => { if (b > a) ranges.push(Decoration[spec ? 'mark' : 'replace'](spec || {}).range(from + a, from + b)) }
  // Keep offsets rooted in the source, hiding only formatting delimiters.
  if (!raw) {
    const prefix = line.match(/^\s*([@!~]|>(?:\s*)|\.(?=[\p{L}\p{N}]))/u)
    if (prefix) add(0, prefix[0].length)
    const suffix = line.match(type === 'centered' ? /\s*<\s*$/ : type === 'character' ? /\s*\^\s*$/ : type === 'scene' ? /\s+#[\w.-]+#\s*$/ : /$^/)
    if (suffix) add(suffix.index, line.length)
  }
  const expression = /(?<!\\)(\*{1,3}|_)(?=\S)(.+?)\1/g
  for (const match of line.matchAll(expression)) {
    const length = match[1].length
    if (!raw) { add(match.index, match.index + length); add(match.index + match[0].length - length, match.index + match[0].length) }
    add(match.index + length, match.index + match[0].length - length, { class: match[1] === '_' ? 'emphasis-underline' : length === 3 ? 'emphasis-bold emphasis-italic' : length === 2 ? 'emphasis-bold' : 'emphasis-italic' })
  }
}

export function fountainFormatting(live) {
  return [
    parsedFountain,
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = this.build(view) }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) this.decorations = this.build(update.view)
      }
      build(view) {
        const ranges = []
        const blocks = view.state.field(parsedFountain)
        const cursorLines = view.state.selection.ranges.map(r => view.state.doc.lineAt(r.head).number)
        for (const block of blocks) {
          if (!view.visibleRanges.some(r => block.to >= r.from && block.from <= r.to)) continue
          const active = live && cursorLines.some(line => block.group
            ? line >= block.group && line <= block.groupEnd + 1
            : block.endLine > block.startLine
              ? line >= block.startLine && line <= block.endLine + 1
              : line >= block.startLine && line <= block.endLine)
          for (let n = block.startLine; n <= block.endLine; n++) {
            const line = view.state.doc.line(n)
            if (!view.visibleRanges.some(r => line.to >= r.from && line.from <= r.to)) continue
            ranges.push(Decoration.line({ class: `ft-${block.type} ${live ? active ? 'ft-active' : 'ft-rendered' : 'ft-source'}` }).range(line.from))
            markup(line.text, line.from, !live || active, ranges, block.type)
          }
        }
        return Decoration.set(ranges, true)
      }
    }, { decorations: instance => instance.decorations }),
  ]
}
