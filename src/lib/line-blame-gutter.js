import { gutter, GutterMarker } from '@codemirror/view'

class WriterMarker extends GutterMarker {
  constructor(writer) { super(); this.writer = writer }
  toDOM(view) {
    const label = view.dom.ownerDocument.createElement('span')
    label.className = 'line-blame-writer'
    const { writer } = this
    if (writer?.color) label.style.setProperty('--writer-color', writer.color)
    const name = label.appendChild(view.dom.ownerDocument.createElement('span'))
    name.textContent = writer?.name ?? 'Unknown'
    if (writer) label.append(` · ${writer.key.slice(0, 4)}`)
    label.title = writer ? `Last writer: ${writer.name} (${writer.key})` : 'Unknown: no verified attribution for this line'
    return label
  }
}

export function lineBlameGutter(runs) {
  const markers = runs.map(({ writer }) => new WriterMarker(writer))
  return gutter({
    class: 'cm-line-blame',
    lineMarker(view, block) {
      return markers[writerRunAt(runs, view.state.doc.lineAt(block.from).number)] || null
    },
  })
}

export function writerRunAt(runs, line) {
  let lo = 0, hi = runs.length
  while (lo < hi) {
    const midpoint = (lo + hi) >>> 1
    if (line <= runs[midpoint].end) hi = midpoint
    else lo = midpoint + 1
  }
  return lo
}
