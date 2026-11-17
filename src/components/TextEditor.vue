<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, drawSelection } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { fountainFormatting } from '../lib/fountain-editor.js'

const props = defineProps({
  ytext: { type: Object, required: true },
  awareness: { type: Object, required: true },
  mode: { type: String, default: 'live' },
  markdown: Boolean,
  review: Boolean,
})
const emit = defineEmits(['selection', 'suggest', 'cursor'])
const host = ref(null)
let view
let undo
const presentation = new Compartment()
const reviewMode = new Compartment()
let proposalPending = false
const reviewFilter = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || tr.annotation(remoteAnnotation)) return tr
  if (tr.annotation(TransactionUserEvent) === 'input.suggest-accepted') return tr
  // Only intercept local editing, never remote CRDT synchronization.
  const event = tr.annotation(TransactionUserEvent)
  if (!event || !/^(input|delete|move)/.test(event)) return tr
  const changes = []
  tr.changes.iterChanges((from, to, _a, _b, inserted) => changes.push({ from, to, replacement: inserted.toString() }))
  if (!proposalPending) {
    proposalPending = true
    queueMicrotask(() => { proposalPending = false; changes.forEach(c => emit('suggest', c)) })
  }
  return []
})
// Yjs remote transactions do not have userEvent annotations. The explicit import
// below keeps review filters limited to actual keyboard/paste edits.
import { Transaction } from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'
const remoteAnnotation = ySyncAnnotation
const TransactionUserEvent = Transaction.userEvent

function extensions() {
  return props.markdown ? [markdownLanguage(), lineNumbers()] : [
    fountainFormatting(props.mode === 'live'),
    ...(props.mode === 'split' ? [lineNumbers(), highlightActiveLine()] : []),
  ]
}
onMounted(() => {
  undo = new Y.UndoManager(props.ytext)
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.ytext.toString(),
      extensions: [
        yCollab(props.ytext, props.awareness, { undoManager: undo }),
        presentation.of(extensions()),
        reviewMode.of(props.review ? reviewFilter : []),
        EditorView.lineWrapping,
        drawSelection(),
        highlightSelectionMatches(),
        placeholder(props.markdown ? 'Notes, ideas, loose ends…' : 'INT. SOMEWHERE - DAY\n\nStart writing.'),
        keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab, {
          key: 'Mod-Alt-m', run: () => { emit('selection', getSelection(), true); return true },
        }]),
        EditorView.updateListener.of(update => {
          if (update.selectionSet || update.docChanged) {
            emit('selection', getSelection())
            emit('cursor', { line: update.state.doc.lineAt(update.state.selection.main.head).number, column: update.state.selection.main.head - update.state.doc.lineAt(update.state.selection.main.head).from + 1 })
          }
        }),
        EditorView.contentAttributes.of({ 'aria-label': props.markdown ? 'Shared scratchpad' : 'Screenplay editor', spellcheck: 'true', autocapitalize: 'off' }),
      ],
    }),
  })
})
function getSelection() {
  const range = view.state.selection.main
  return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) }
}
function goTo(from, to = from) {
  const max = view.state.doc.length
  view.dispatch({ selection: { anchor: Math.min(max, from), head: Math.min(max, to) }, effects: EditorView.scrollIntoView(Math.min(max, from), { y: 'center' }) })
  view.focus()
}
watch(() => props.mode, () => view?.dispatch({ effects: presentation.reconfigure(extensions()) }))
watch(() => props.review, value => view?.dispatch({ effects: reviewMode.reconfigure(value ? reviewFilter : []) }))
onBeforeUnmount(() => { view?.destroy(); undo?.destroy() })
defineExpose({ goTo, focus: () => view?.focus(), undo: () => undo?.undo(), redo: () => undo?.redo() })
</script>

<template>
  <div ref="host" :class="['text-editor', { 'live-editor': mode === 'live' && !markdown, 'raw-editor': mode === 'split', 'markdown-editor': markdown }]" />
</template>
