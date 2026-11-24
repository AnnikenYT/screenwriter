<script setup>
import { onMounted, onBeforeUnmount, ref, useId, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, drawSelection } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { yCollab } from 'y-codemirror.next'
import { Check, X } from 'lucide-vue-next'
import * as Y from 'yjs'
import { fountainFormatting } from '../lib/fountain-editor.js'
import { createScreenplayBinding } from '../lib/screenplay-binding.js'
import { screenplayTools, wrapSelection, completeName, insertScreenplayName, insertParenthetical } from '../lib/editor-tools.js'
import { viewportBounds } from '../lib/mobile.js'
import { useEditorScrollbar } from '../lib/editor-scrollbar.js'
import { screenplayCharacterColors, isCharacterColorKey } from '../lib/character-colors.js'
import { lineBlameGutter } from '../lib/line-blame-gutter.js'

const props = defineProps({
  ytext: { type: Object, required: true },
  awareness: { type: Object, required: true },
  user: { type: Object, default: () => ({}) },
  mode: { type: String, default: 'live' },
  markdown: Boolean,
  review: Boolean,
  readOnly: Boolean,
  blameRuns: { type: Array, default: null },
})
const emit = defineEmits(['selection', 'cursor', 'geometry', 'display', 'error', 'decide', 'link-image', 'open-comment', 'scroll'])
const host = ref(null)
const hovered = ref(null)
const hoveredImage = ref(null)
const hoverStyle = ref({})
const unsavedReview = ref(null)
let view, undo, binding, resizeObserver, hoverTimer
const presentation = new Compartment()
const attribution = new Compartment()
const scrollbar = useEditorScrollbar()
const { rail, metrics: scrollbarMetrics } = scrollbar
const contentId = `editor-${useId()}`
const screenplayDoc = props.ytext.doc
const characters = props.markdown ? null : screenplayDoc.getMap('characters')
const meta = props.markdown ? null : screenplayDoc.getMap('meta')
function refreshPresentation() { view?.dispatch({ effects: presentation.reconfigure(extensions()) }); measure() }
let cueRefreshQueued = false
function refreshCues() {
  if (cueRefreshQueued) return
  cueRefreshQueued = true
  queueMicrotask(() => {
    cueRefreshQueued = false
    refreshPresentation()
  })
}
function cueMetadataChanged(event) {
  if ([...event.keysChanged].some(isCharacterColorKey)) refreshCues()
}

function extensions() {
  return props.markdown ? [markdownLanguage(), lineNumbers()] : [
    fountainFormatting(props.mode === 'live', () => binding?.model.spans || [], () => binding?.annotations() || [], { onImageHover: showImage, onCommentFocus: id => emit('open-comment', id) }, blocks => screenplayCharacterColors(screenplayDoc, blocks)),
    ...(props.mode === 'split' ? [lineNumbers(), highlightActiveLine()] : []),
  ]
}
function hideHover() { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { hovered.value = null; hoveredImage.value = null }, 220) }
function keepHover() { clearTimeout(hoverTimer) }
function showHover(suggestion, bounds) {
  if (!suggestion) { hideHover(); return }
  clearTimeout(hoverTimer)
  hovered.value = suggestion
  hoveredImage.value = null
  hoverStyle.value = {
    left: `${Math.max(8, Math.min(bounds.left, viewportBounds().width - 278))}px`,
    top: `${Math.max(viewportBounds().top + 8, Math.min(viewportBounds().bottom - 150, bounds.bottom + 9))}px`,
  }
}
function showImage(link, bounds) {
  if (!link) { hideHover(); return }
  clearTimeout(hoverTimer)
  hovered.value = null
  hoveredImage.value = link
  const viewport = viewportBounds()
  hoverStyle.value = { left: `${Math.max(8, Math.min(bounds.left, viewport.width - 298))}px`, top: `${Math.max(viewport.top + 8, Math.min(viewport.bottom - 330, bounds.bottom + 9))}px` }
}
function unlinkImage() { props.ytext.doc.getMap('meta').delete(`image-link:${hoveredImage.value.id}`); hoveredImage.value = null }
function measure() {
  if (!view || props.markdown) return
  view.requestMeasure({
    key: scrollbar,
    read: editor => scrollbar.read(editor.scrollDOM),
    write: (metrics, editor) => scrollbar.update(editor.scrollDOM, metrics),
  })
  view.requestMeasure({
    key: host,
    read(editor) {
      const bounds = host.value.getBoundingClientRect()
      const caret = editor.coordsAtPos(editor.state.selection.main.head)
      const comments = []
      for (const comment of props.ytext.doc.getMap('comments').values()) {
        if (comment.parentId || comment.resolved) continue
        const range = binding.annotationRange(comment)
        if (!range) continue
        const pos = range.from
        if (pos < editor.viewport.from || pos > editor.viewport.to) continue
        const dualRow = [...host.value.querySelectorAll('.live-dual-dialogue [data-source-from]')].find(row => pos >= Number(row.dataset.sourceFrom) && pos <= Number(row.dataset.sourceTo))
        const coords = dualRow?.getBoundingClientRect() || editor.coordsAtPos(pos)
        if (coords && coords.bottom >= bounds.top && coords.top < bounds.bottom) comments.push({ id: comment.id, top: coords.top - bounds.top })
      }
      return {
        focused: editor.hasFocus, width: bounds.width, height: bounds.height,
        cursor: caret ? { top: caret.top - bounds.top, bottom: caret.bottom - bounds.top } : null,
        comments,
      }
    },
    write(geometry) { emit('geometry', geometry) },
  })
}
function onScroll() {
  if (view && !props.markdown) scrollbar.update(view.scrollDOM)
  measure()
  if (!view || props.markdown) return
  const bounds = view.scrollDOM.getBoundingClientRect()
  const content = view.contentDOM.getBoundingClientRect()
  const x = Math.max(bounds.left + 20, Math.min(bounds.right - 25, content.left + parseFloat(getComputedStyle(view.contentDOM).paddingLeft) + 3))
  const from = view.posAtCoords({ x, y: bounds.top + 10 }, false) ?? view.viewport.from
  emit('scroll', { from, ratio: view.scrollDOM.scrollTop / Math.max(1, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight) })
}
function scrollToPosition({ from, ratio }) {
  if (!view) return
  if (ratio <= .001) { view.scrollDOM.scrollTop = 0; return }
  if (ratio >= .999) { view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight; return }
  view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(view.state.doc.length, from)), { y: 'start', yMargin: 8 }) })
}
onMounted(() => {
  if (!props.markdown) {
    binding = createScreenplayBinding({
      text: props.ytext, awareness: props.awareness, getUser: () => props.user,
      onError: message => emit('error', message),
      onUnsaved: text => { unsavedReview.value = text },
      onHover: showHover,
      onImageHover: showImage,
      onCommentFocus: id => emit('open-comment', id),
      onChange(model) {
        emit('display', model.text)
        if (view) emit('selection', getSelection())
        if (hovered.value && !model.spans.some(s => s.id === hovered.value.id)) hovered.value = null
        measure()
      },
    })
    undo = binding.undoManager
  } else undo = new Y.UndoManager(props.ytext)
  view = new EditorView({
    parent: host.value,
    ...(binding ? { dispatchTransactions: (transactions, editor) => binding.dispatch(transactions, editor) } : {}),
    state: EditorState.create({
      doc: binding ? binding.model.text : props.ytext.toString(),
      extensions: [
        ...(binding ? binding.extensions : [yCollab(props.ytext, props.awareness, { undoManager: undo })]),
        ...(!props.markdown ? screenplayTools(props.ytext.doc, () => emit('link-image')) : []),
         presentation.of(extensions()),
         attribution.of(props.blameRuns ? lineBlameGutter(props.blameRuns) : []),
         ...(!props.markdown ? [EditorState.lineSeparator.of('\n')] : []),
         EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly),
        EditorView.lineWrapping, drawSelection(), highlightSelectionMatches(),
        placeholder(props.markdown ? 'Notes, ideas, loose ends…' : 'INT. SOMEWHERE - DAY\n\nStart writing.'),
        keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab, {
          key: 'Mod-Alt-m', run: () => { emit('selection', getSelection(), true); return true },
        }]),
        EditorView.updateListener.of(update => {
          if (update.selectionSet || update.docChanged) {
            emit('selection', getSelection())
            emit('cursor', { line: update.state.doc.lineAt(update.state.selection.main.head).number, column: update.state.selection.main.head - update.state.doc.lineAt(update.state.selection.main.head).from + 1 })
            binding?.publishSelection()
          }
          measure()
        }),
        EditorView.contentAttributes.of({ id: contentId, 'aria-label': props.markdown ? 'Shared scratchpad' : 'Screenplay editor', spellcheck: 'true', autocapitalize: 'off' }),
        EditorView.domEventHandlers({ blur: () => { measure(); return false }, focus: () => { measure(); return false }, mouseleave: () => { hideHover(); return false } }),
      ],
    }),
  })
  binding?.attach(view)
  binding?.setSuggesting(props.review)
  characters?.observe(refreshCues)
  meta?.observe(cueMetadataChanged)
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(host.value)
  measure()
})
function getSelection() {
  if (binding) return binding.selection()
  const range = view.state.selection.main
  return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) }
}
function goTo(from, to = from) {
  const max = view.state.doc.length
  const anchor = Math.min(max, binding ? binding.toView(from, -1) : from)
  const head = Math.min(max, binding ? binding.toView(to, 1) : to)
  view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
  view.focus()
}
function goToAnnotation(annotation) {
  const range = binding?.annotationRange(annotation)
  if (!range) return
  view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
  view.focus()
}
function decide(status) { emit('decide', hovered.value, status); hovered.value = null }
function command(run) { undo?.stopCapturing(); return run() }
function revealSelection() { if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 26 }) }) }
watch(() => props.mode, refreshPresentation)
watch(() => props.blameRuns, runs => view?.dispatch({ effects: attribution.reconfigure(runs ? lineBlameGutter(runs) : []) }))
watch(() => props.review, value => binding?.setSuggesting(value))
onBeforeUnmount(() => {
  clearTimeout(hoverTimer)
  resizeObserver?.disconnect()
  characters?.unobserve(refreshCues)
  meta?.unobserve(cueMetadataChanged)
  view?.scrollDOM.removeEventListener('scroll', onScroll)
  view?.destroy()
  view = null
  if (binding) binding.destroy()
  else undo?.destroy()
})
defineExpose({
  goTo, goToAnnotation, focus: () => view?.focus(), blur: () => { hovered.value = null; hoveredImage.value = null; view?.contentDOM.blur() },
  undo: () => undo?.undo(), redo: () => undo?.redo(), getSelection, scrollToPosition, revealSelection,
  format: delimiter => command(() => wrapSelection(view, delimiter, { toggle: true })),
  completeName: () => completeName(view, props.ytext.doc),
  insertName: (name, kind) => command(() => insertScreenplayName(view, name, kind)),
  insertParenthetical: () => command(() => insertParenthetical(view)),
})
</script>

<template>
  <div :class="['editor-frame', { 'long-editor': scrollbarMetrics }]">
    <div ref="host" :class="['text-editor', { 'live-editor': mode === 'live' && !markdown, 'raw-editor': mode === 'split', 'markdown-editor': markdown }]" />
    <div v-if="scrollbarMetrics" ref="rail" class="editor-scrollbar" role="scrollbar" tabindex="0"
      aria-label="Screenplay scroll position" :aria-controls="contentId" aria-orientation="vertical"
      :aria-valuemin="0" :aria-valuemax="Math.round(scrollbarMetrics.max)" :aria-valuenow="Math.round(scrollbarMetrics.value)"
      @pointerdown.prevent="scrollbar.start" @pointermove="scrollbar.move" @lostpointercapture="scrollbar.stop"
      @keydown="scrollbar.key">
      <span :style="{ transform: `translateY(${scrollbarMetrics.offset}px)` }" />
    </div>
  </div>
  <Teleport to="body">
    <div v-if="unsavedReview !== null" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="Unsaved suggestion"><header><h2>Suggestion not saved</h2><button class="icon-button" aria-label="Close unsaved suggestion" @click="unsavedReview = null"><X :size="18" /></button></header><p>Copy your proposed text before closing.</p><textarea :value="unsavedReview" readonly rows="10" aria-label="Unsaved proposed text" @focus="$event.target.select()" /></section></div>
    <section v-if="hovered" class="inline-suggestion-popover" :style="hoverStyle" role="dialog" :aria-label="`Suggestion by ${hovered.author}`" @mouseenter="keepHover" @mouseleave="hideHover" @keydown.esc="hovered = null">
      <button class="icon-button compact touch-popover-close" aria-label="Close suggestion" @click="hovered = null"><X :size="18" /></button>
      <div class="review-byline"><strong>{{ hovered.author }}</strong><span class="small muted">Suggested edit</span></div>
      <p class="small muted">{{ new Date(hovered.createdAt).toLocaleString() }}</p>
      <div v-if="ytext.doc.access?.canEdit !== false" class="button-row"><button class="text-button accept" @click="decide('accepted')"><Check :size="14" />Accept suggestion</button><button class="text-button" @click="decide('rejected')"><X :size="14" />Reject suggestion</button></div>
    </section>
    <section v-if="hoveredImage" class="linked-image-popover" :style="hoverStyle" role="dialog" aria-label="Linked image" @mouseenter="keepHover" @mouseleave="hideHover" @keydown.esc="hoveredImage = null">
      <button class="icon-button compact touch-popover-close" aria-label="Close image preview" @click="hoveredImage = null"><X :size="18" /></button>
      <img :src="hoveredImage.url" :alt="hoveredImage.caption || 'Passage image reference'" referrerpolicy="no-referrer" />
      <p v-if="hoveredImage.caption">{{ hoveredImage.caption }}</p>
      <div class="review-byline"><span class="small muted">{{ hoveredImage.author }}</span><button v-if="ytext.doc.access?.canEdit !== false" class="text-button" @click="unlinkImage">Unlink image</button></div>
    </section>
  </Teleport>
</template>

<style>
.cm-editor .cm-line-blame {
  width: clamp(7.5rem, 12vw, 10rem);
  color: var(--text, #333);
}
.line-blame-writer {
  display: flex;
  white-space: pre;
  padding: 0 .35rem;
  margin-inline: .25rem;
  border-inline-start: 3px solid var(--writer-color, transparent);
}
.line-blame-writer > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
