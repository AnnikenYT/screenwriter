import { StateField } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, EditorView } from '@codemirror/view'
import { parseFountain, inlineFountain, screenplayEmphasis, createNameMatcher, boldUnderlineInnerWidth } from '../../shared/fountain.js'

export const parsedFountain = StateField.define({
  create: state => parseFountain(state.doc.toString()),
  update: (blocks, tr) => tr.docChanged ? parseFountain(tr.newDoc.toString()) : blocks,
})

const nameMentions = StateField.define({
  create: state => createNameMatcher(state.field(parsedFountain)),
  update: (value, tr) => tr.docChanged ? createNameMatcher(tr.state.field(parsedFountain)) : value,
})

function markup(line, from, raw, ranges, type, names) {
  const add = (a, b, spec) => { if (b > a) ranges.push(Decoration[spec ? 'mark' : 'replace'](spec || {}).range(from + a, from + b)) }
  // Keep offsets rooted in the source, hiding only formatting delimiters.
  if (!raw) {
    const prefix = line.match(/^\s*([@!~]|>(?:\s*)|\.(?=[\p{L}\p{N}]))/u)
    if (prefix) add(0, prefix[0].length)
    const suffix = line.match(type === 'centered' ? /\s*<\s*$/ : type === 'character' ? /\s*\^\s*$/ : type === 'scene' ? /\s+#[\w.-]+#\s*$/ : /$^/)
    if (suffix) add(suffix.index, line.length)
  }
  const expression = /(?<!\\)(\*{1,3}|_)(?=\S)(.+?)\1/g
  if (type !== 'note' && type !== 'boneyard') {
    for (const span of screenplayEmphasis(line)) add(span.from, span.to, { class: 'emphasis-bold' })
    if (type !== 'title' && names.source) {
      for (const match of line.matchAll(names.source)) add(match.index, match.index + match[0].length, { class: 'emphasis-bold name-mention' })
    }
  }
  for (const match of line.matchAll(expression)) {
    const innerWidth = boldUnderlineInnerWidth(match[1], match[2])
    const length = match[1].length + innerWidth
    if (!raw) { add(match.index, match.index + length); add(match.index + match[0].length - length, match.index + match[0].length) }
    add(match.index + length, match.index + match[0].length - length, { class: innerWidth ? 'emphasis-bold emphasis-underline' : match[1] === '_' ? 'emphasis-underline' : length === 3 ? 'emphasis-bold emphasis-italic' : length === 2 ? 'emphasis-bold' : 'emphasis-italic' })
  }
}

class DualDialogueWidget extends WidgetType {
  constructor(left, right, annotations, callbacks, names) { super(); this.left = left; this.right = right; this.annotations = annotations; this.callbacks = callbacks; this.names = names }
  eq(other) { return this.names.source?.source === other.names.source?.source && JSON.stringify([this.left, this.right, this.annotations]) === JSON.stringify([other.left, other.right, other.annotations]) }
  toDOM(view) {
    const wrapper = document.createElement('div')
    wrapper.className = 'live-dual-dialogue dual'
    for (const side of [this.left, this.right]) {
      const speech = document.createElement('div')
      speech.className = 'speech'
      for (const block of side) {
        const line = document.createElement('div')
        line.className = `fountain ${block.type}`
        line.dataset.sourceFrom = block.from
        line.dataset.sourceTo = block.to
        line.innerHTML = inlineFountain(block.text, this.names)
        for (const annotation of this.annotations.filter(a => a.from <= block.to && a.to >= block.from)) {
          if (annotation.type === 'image') {
            line.classList.add('image-linked-passage')
            line.addEventListener('mouseover', () => this.callbacks.onImageHover?.(annotation.value, line.getBoundingClientRect()))
          } else {
            line.classList.add('commented-passage')
            line.dataset.commentId = annotation.value.id
          }
        }
        speech.append(line)
      }
      wrapper.append(speech)
    }
    wrapper.addEventListener('mousedown', event => {
      event.preventDefault()
      const row = event.target.closest('[data-source-from]')
      view.dispatch({ selection: { anchor: Number(row?.dataset.sourceFrom ?? this.left[0].from) } })
      view.focus()
      if (row?.dataset.commentId) this.callbacks.onCommentFocus?.(row.dataset.commentId)
    })
    return wrapper
  }
  ignoreEvent() { return true }
}

function dualFormatting(getSuggestions, getAnnotations, callbacks) {
  const build = state => {
    const blocks = state.field(parsedFountain)
    const decorations = []
    for (let i = 0; i < blocks.length; i++) {
      const left = blocks[i]
      if (left.type !== 'character') continue
      let end = i + 1
      while (blocks[end]?.group === left.group) end++
      let next = end
      while (blocks[next]?.type === 'blank') next++
      const right = blocks[next]
      if (right?.type !== 'character' || !right.dual) continue
      let rightEnd = next + 1
      while (blocks[rightEnd]?.group === right.group) rightEnd++
      const last = blocks[rightEnd - 1]
      const active = state.selection.ranges.some(range => {
        const from = state.doc.lineAt(range.from).number
        const to = state.doc.lineAt(range.to).number
        return from <= last.endLine + 1 && to >= left.startLine
      })
      const proposed = getSuggestions?.().some(span => span.from <= last.to && span.to >= left.from)
      const annotations = getAnnotations?.().filter(a => a.from <= last.to && a.to >= left.from) || []
      if (!active && !proposed) decorations.push(Decoration.replace({ widget: new DualDialogueWidget(blocks.slice(i, end), blocks.slice(next, rightEnd), annotations, callbacks, state.field(nameMentions)), block: true }).range(left.from, last.to))
      i = rightEnd - 1
    }
    return Decoration.set(decorations, true)
  }
  return StateField.define({
    create: build,
    update: (value, tr) => tr.docChanged || tr.selection || tr.effects.length ? build(tr.state) : value,
    provide: field => EditorView.decorations.from(field),
  })
}

export function fountainFormatting(live, getSuggestions, getAnnotations, callbacks = {}) {
  return [
    parsedFountain,
    nameMentions,
    ...(live ? [dualFormatting(getSuggestions, getAnnotations, callbacks)] : []),
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = this.build(view) }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) this.decorations = this.build(update.view)
      }
      build(view) {
        const ranges = []
        const blocks = view.state.field(parsedFountain)
        const selections = view.state.selection.ranges.map(r => ({
          from: view.state.doc.lineAt(r.from).number,
          to: view.state.doc.lineAt(r.to).number,
          head: view.state.doc.lineAt(r.head).number,
        }))
        for (const block of blocks) {
          if (!view.visibleRanges.some(r => block.to >= r.from && block.from <= r.to)) continue
          const active = live && selections.some(range =>
            (range.from <= block.endLine && range.to >= block.startLine) ||
            (block.group ? range.head >= block.group && range.head <= block.groupEnd + 1
              : block.endLine > block.startLine && range.head >= block.startLine && range.head <= block.endLine + 1))
          for (let n = block.startLine; n <= block.endLine; n++) {
            const line = view.state.doc.line(n)
            if (!view.visibleRanges.some(r => line.to >= r.from && line.from <= r.to)) continue
            ranges.push(Decoration.line({ class: `ft-${block.type} ${live ? active ? 'ft-active' : 'ft-rendered' : 'ft-source'}` }).range(line.from))
            markup(line.text, line.from, !live || active, ranges, block.type, view.state.field(nameMentions))
          }
        }
        return Decoration.set(ranges, true)
      }
    }, { decorations: instance => instance.decorations }),
  ]
}
