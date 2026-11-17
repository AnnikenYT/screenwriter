<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
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
import { screenplayTools, wrapSelection } from '../lib/editor-tools.js'

const props = defineProps({
  ytext: { type: Object, required: true },
  awareness: { type: Object, required: true },
  user: { type: Object, default: () => ({}) },
  mode: { type: String, default: 'live' },
  markdown: Boolean,
  review: Boolean,
})
const emit = defineEmits(['selection', 'cursor', 'geometry', 'display', 'error', 'decide', 'link-image', 'open-comment', 'scroll'])
const host = ref(null)
const hovered = ref(null)
const hoveredImage = ref(null)
const hoverStyle = ref({})
let view, undo, binding, resizeObserver, hoverTimer
const presentation = new Compartment()

function extensions() {
  return props.markdown ? [markdownLanguage(), lineNumbers()] : [
    fountainFormatting(props.mode === 'live', () => binding?.model.spans || [], () => binding?.annotations() || [], { onImageHover: showImage, onCommentFocus: id => emit('open-comment', id) }),
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
    left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - 278))}px`,
    top: `${Math.min(window.innerHeight - 150, bounds.bottom + 9)}px`,
  }
}
function showImage(link, bounds) {
  if (!link) { hideHover(); return }
  clearTimeout(hoverTimer)
  hovered.value = null
  hoveredImage.value = link
  hoverStyle.value = { left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - 298))}px`, top: `${Math.max(60, Math.min(window.innerHeight - 330, bounds.bottom + 9))}px` }
}
function unlinkImage() { props.ytext.doc.getMap('meta').delete(`image-link:${hoveredImage.value.id}`); hoveredImage.value = null }
function measure() {
  if (!view || props.markdown) return
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
      onHover: showHover,
      onImageHover: showImage,
      onCommentFocus: id => emit('open-comment', id),
      onChange(model) {
        emit('display', model.text)
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
        EditorView.contentAttributes.of({ 'aria-label': props.markdown ? 'Shared scratchpad' : 'Screenplay editor', spellcheck: 'true', autocapitalize: 'off' }),
        EditorView.domEventHandlers({ blur: () => { measure(); return false }, focus: () => { measure(); return false }, mouseleave: () => { hideHover(); return false } }),
      ],
    }),
  })
  binding?.attach(view)
  binding?.setSuggesting(props.review)
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
watch(() => props.mode, () => { view?.dispatch({ effects: presentation.reconfigure(extensions()) }); measure() })
watch(() => props.review, value => binding?.setSuggesting(value))
onBeforeUnmount(() => {
  clearTimeout(hoverTimer)
  resizeObserver?.disconnect()
  view?.scrollDOM.removeEventListener('scroll', onScroll)
  view?.destroy()
  if (binding) binding.destroy()
  else undo?.destroy()
})
defineExpose({ goTo, goToAnnotation, focus: () => view?.focus(), undo: () => undo?.undo(), redo: () => undo?.redo(), getSelection, scrollToPosition, format: delimiter => wrapSelection(view, delimiter, { toggle: true }) })
</script>

<template>
  <div ref="host" :class="['text-editor', { 'live-editor': mode === 'live' && !markdown, 'raw-editor': mode === 'split', 'markdown-editor': markdown }]" />
  <Teleport to="body">
    <section v-if="hovered" class="inline-suggestion-popover" :style="hoverStyle" role="dialog" :aria-label="`Suggestion by ${hovered.author}`" @mouseenter="keepHover" @mouseleave="hideHover" @keydown.esc="hovered = null">
      <div class="review-byline"><strong>{{ hovered.author }}</strong><span class="small muted">Suggested edit</span></div>
      <p class="small muted">{{ new Date(hovered.createdAt).toLocaleString() }}</p>
      <div class="button-row"><button class="text-button accept" @click="decide('accepted')"><Check :size="14" />Accept suggestion</button><button class="text-button" @click="decide('rejected')"><X :size="14" />Reject suggestion</button></div>
    </section>
    <section v-if="hoveredImage" class="linked-image-popover" :style="hoverStyle" role="dialog" aria-label="Linked image" @mouseenter="keepHover" @mouseleave="hideHover" @keydown.esc="hoveredImage = null">
      <img :src="hoveredImage.url" :alt="hoveredImage.caption || 'Passage image reference'" referrerpolicy="no-referrer" />
      <p v-if="hoveredImage.caption">{{ hoveredImage.caption }}</p>
      <div class="review-byline"><span class="small muted">{{ hoveredImage.author }}</span><button class="text-button" @click="unlinkImage">Unlink image</button></div>
    </section>
  </Teleport>
</template>
