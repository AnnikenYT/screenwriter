import { StateEffect, Transaction } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import * as Y from 'yjs'
import { applyReviewChanges, projectReview, sourceToView, viewToSource, annotationViewRange } from './review-model.js'
import { relativeAnchor, resolveAnchor } from './collaboration.js'

const refreshReview = StateEffect.define()
const remoteReview = Transaction.remote

class OriginalText extends WidgetType {
  constructor(span) { super(); this.span = span }
  eq(other) { return other.span.id === this.span.id && other.span.original === this.span.original }
  toDOM() {
    const el = document.createElement('del')
    el.className = 'inline-suggestion-original'
    el.textContent = this.span.original
    el.dataset.suggestionId = this.span.id
    el.tabIndex = 0
    el.setAttribute('aria-label', `Original text: ${this.span.original}. Suggestion by ${this.span.author}`)
    return el
  }
  ignoreEvent() { return false }
}

class PeerCursor extends WidgetType {
  constructor(user) { super(); this.user = user }
  eq(other) { return other.user.name === this.user.name && other.user.color === this.user.color }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'peer-cursor'
    el.style.setProperty('--peer-color', this.user.color || '#597d67')
    const label = document.createElement('span')
    label.textContent = this.user.name || 'Writer'
    el.append(label)
    return el
  }
}

export function createScreenplayBinding({ text, awareness, getUser, onError, onChange, onHover, onImageHover, onCommentFocus }) {
  const doc = text.doc
  const origin = {}
  const undoManager = new Y.UndoManager([text, doc.getMap('suggestions')], { trackedOrigins: new Set([origin]), captureTimeout: 650 })
  let model = projectReview(doc), view, queued = false, applying = false, destroyed = false, bookmark = null, suggesting = false
  const selectionBookmark = () => {
    if (!view) return null
    const range = view.state.selection.main
    const capture = pos => {
      const span = model.spans.find(s => pos >= s.from && pos <= s.to)
      return {
        position: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, viewToSource(model, pos), 0)),
        ...(span ? { suggestionId: span.id, offset: pos - span.from } : {}),
      }
    }
    return { anchor: capture(range.anchor), head: capture(range.head) }
  }
  const restorePoint = point => {
    const span = model.spans.find(s => s.id === point.suggestionId)
    if (span) return span.from + Math.min(span.replacement.length, point.offset)
    try {
      const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(point.position), doc)
      return absolute?.type === text ? sourceToView(model, absolute.index) : null
    } catch { return null }
  }
  const refresh = () => {
    queued = false
    if (destroyed || !view) return
    model = projectReview(doc)
    const oldText = view.state.doc.toString()
    let from = 0
    while (from < oldText.length && from < model.text.length && oldText[from] === model.text[from]) from++
    let oldEnd = oldText.length, newEnd = model.text.length
    while (oldEnd > from && newEnd > from && oldText[oldEnd - 1] === model.text[newEnd - 1]) { oldEnd--; newEnd-- }
    const anchor = bookmark && restorePoint(bookmark.anchor), head = bookmark && restorePoint(bookmark.head)
    const selection = view.state.selection.main
    view.dispatch({
      ...(oldText !== model.text ? { changes: { from, to: oldEnd, insert: model.text.slice(from, newEnd) } } : {}),
      // Presence echoes and metadata updates do not move the caret. Reasserting
      // the same selection would cancel CodeMirror's typing-triggered completion.
      ...(anchor != null && head != null && (oldText !== model.text || anchor !== selection.anchor || head !== selection.head) ? { selection: { anchor, head } } : {}),
      effects: refreshReview.of(null),
      annotations: remoteReview.of(true),
    })
    bookmark = selectionBookmark()
    onChange?.(model)
  }
  const schedule = () => { if (!queued && !destroyed) { queued = true; queueMicrotask(refresh) } }
  const beforeTransaction = () => { if (!applying) bookmark = selectionBookmark() }
  const afterTransaction = () => { if (!applying) schedule() }
  const awarenessChanged = () => { if (view && !destroyed) schedule() }
  doc.on('beforeTransaction', beforeTransaction)
  doc.on('afterTransaction', afterTransaction)
  awareness.on('change', awarenessChanged)

  const decorations = ViewPlugin.fromClass(class {
    constructor(editor) { this.decorations = this.build(editor) }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.some(t => t.effects.some(e => e.is(refreshReview)))) this.decorations = this.build(update.view)
    }
    build(editor) {
      const ranges = []
      for (const span of model.spans) {
        if (!editor.visibleRanges.some(r => span.to >= r.from && span.from <= r.to)) continue
        if (span.original) ranges.push(Decoration.widget({ widget: new OriginalText(span), side: -1 }).range(span.from))
        if (span.to > span.from) ranges.push(Decoration.mark({ class: 'inline-suggestion-replacement', attributes: { 'data-suggestion-id': span.id } }).range(span.from, span.to))
      }
      for (const [key, link] of doc.getMap('meta')) {
        if (!key.startsWith('image-link:') || !link?.anchor) continue
        const range = annotationViewRange(doc, model, link)
        if (!range) continue
        const { from, to } = range
        if (to > from) ranges.push(Decoration.mark({ class: 'image-linked-passage', attributes: { 'data-image-link-id': link.id } }).range(from, to))
      }
      for (const comment of doc.getMap('comments').values()) {
        if (comment.parentId || comment.resolved) continue
        const range = annotationViewRange(doc, model, comment)
        if (!range) continue
        const { from, to } = range
        if (to > from) ranges.push(Decoration.mark({ class: 'commented-passage', attributes: { 'data-comment-id': comment.id } }).range(from, to))
      }
      for (const [id, state] of awareness.getStates()) {
        if (id === doc.clientID || !state.screenplaySelection) continue
        const range = resolveAnchor(doc, state.screenplaySelection)
        if (!range) continue
        const point = (proposal, fallback, assoc) => {
          const span = model.spans.find(s => s.id === proposal?.id)
          return span ? span.from + Math.min(span.replacement.length, proposal.offset) : sourceToView(model, fallback, assoc)
        }
        const from = point(state.screenplaySelection.proposalStart, range.from, -1), to = point(state.screenplaySelection.proposalEnd, range.to, 1)
        const color = /^#[0-9a-f]{6}$/i.test(state.user?.color) ? state.user.color : '#597d67'
        if (to > from) ranges.push(Decoration.mark({ attributes: { style: `background-color:${color}25` } }).range(from, to))
        const head = state.screenplaySelection.backwards ? from : to
        if (head <= editor.state.doc.length) ranges.push(Decoration.widget({ widget: new PeerCursor({ ...state.user, color }), side: 1 }).range(head))
      }
      return Decoration.set(ranges, true)
    }
  }, {
    decorations: plugin => plugin.decorations,
    eventHandlers: {
      mouseover(event) {
        const el = event.target.closest?.('[data-suggestion-id]')
        const image = event.target.closest?.('[data-image-link-id]')
        if (el) onHover?.(model.spans.find(s => s.id === el.dataset.suggestionId), el.getBoundingClientRect())
        else if (image) onImageHover?.(doc.getMap('meta').get(`image-link:${image.dataset.imageLinkId}`), image.getBoundingClientRect())
        else onHover?.(null)
      },
      click(event) {
        const el = event.target.closest?.('[data-suggestion-id]')
        if (el) onHover?.(model.spans.find(s => s.id === el.dataset.suggestionId), el.getBoundingClientRect())
        const image = event.target.closest?.('[data-image-link-id]')
        if (image) onImageHover?.(doc.getMap('meta').get(`image-link:${image.dataset.imageLinkId}`), image.getBoundingClientRect())
        const comment = event.target.closest?.('[data-comment-id]')
        if (comment) onCommentFocus?.(comment.dataset.commentId)
      },
      focusin(event) {
        const el = event.target.closest?.('[data-suggestion-id]')
        if (el) onHover?.(model.spans.find(s => s.id === el.dataset.suggestionId), el.getBoundingClientRect())
      },
    },
  })

  return {
    get model() { return model },
    get undoManager() { return undoManager },
    extensions: [
      decorations,
      keymap.of([
        { key: 'Mod-z', run: () => { undoManager.undo(); return true } },
        { key: 'Mod-Shift-z', run: () => { undoManager.redo(); return true } },
        { key: 'Mod-y', run: () => { undoManager.redo(); return true } },
      ]),
    ],
    attach(editor) { view = editor; bookmark = selectionBookmark(); onChange?.(model) },
    setSuggesting(value) { suggesting = value; undoManager.stopCapturing() },
    toView: (pos, assoc) => sourceToView(model, pos, assoc),
    annotationRange: item => annotationViewRange(doc, model, item),
    annotations() {
      const items = []
      for (const [key, value] of doc.getMap('meta')) {
        if (!key.startsWith('image-link:') || !value?.anchor) continue
        const range = annotationViewRange(doc, model, value)
        if (range) items.push({ type: 'image', value, ...range })
      }
      for (const value of doc.getMap('comments').values()) {
        if (value.parentId || value.resolved) continue
        const range = annotationViewRange(doc, model, value)
        if (range) items.push({ type: 'comment', value, ...range })
      }
      return items
    },
    dispatch(transactions, editor) {
      for (const tr of transactions) {
        if (tr.docChanged && !tr.annotation(remoteReview)) {
          const changes = []
          tr.changes.iterChanges((from, to, _a, _b, inserted) => changes.push({ from, to, replacement: inserted.toString() }))
          applying = true
          try {
            model = applyReviewChanges(doc, model, changes, { user: getUser(), suggesting, origin })
          } catch (error) {
            // A rejected native input may already have touched contenteditable's
            // DOM. Reset it to the unchanged state rather than leaving a ghost
            // edit that will be replayed by the next input event.
            editor.setState(editor.state)
            onError?.(error.message)
            continue
          }
          finally { applying = false }
          editor.update([tr])
          bookmark = selectionBookmark()
          onChange?.(model)
          if (editor.state.doc.toString() !== model.text) schedule()
        } else {
          editor.update([tr])
          if (!tr.annotation(remoteReview)) bookmark = selectionBookmark()
        }
      }
    },
    selection() {
      const range = view.state.selection.main
      const selected = {
        from: viewToSource(model, range.from, -1),
        to: viewToSource(model, range.to, 1),
        text: view.state.sliceDoc(range.from, range.to),
        viewFrom: range.from, viewTo: range.to,
      }
      if (range.empty) selected.from = selected.to = viewToSource(model, range.head)
      const span = model.spans.find(s => range.from >= s.from && range.to <= s.to)
      if (span) selected.proposal = { id: span.id, from: range.from - span.from, to: range.to - span.from }
      return selected
    },
    publishSelection() {
      if (!view?.hasFocus) return
      const selected = this.selection()
      const proposalPoint = position => {
        const span = model.spans.find(s => position >= s.from && position <= s.to)
        return span ? { id: span.id, offset: position - span.from } : null
      }
      const range = view.state.selection.main
      const next = {
        ...relativeAnchor(doc, selected.from, selected.to), backwards: range.anchor > range.head,
        proposalStart: proposalPoint(range.from), proposalEnd: proposalPoint(range.to),
      }
      const previous = awareness.getLocalState()?.screenplaySelection
      if (JSON.stringify(previous) !== JSON.stringify(next)) awareness.setLocalStateField('screenplaySelection', next)
    },
    destroy() {
      destroyed = true
      doc.off('beforeTransaction', beforeTransaction)
      doc.off('afterTransaction', afterTransaction)
      awareness.off('change', awarenessChanged)
      awareness.setLocalStateField('screenplaySelection', null)
      undoManager.destroy()
    },
  }
}
