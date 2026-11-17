<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { MessageSquarePlus, MessageSquare, X } from 'lucide-vue-next'
import CommentThread from './CommentThread.vue'
import { relativeAnchor } from '../lib/collaboration.js'
import { viewportBounds } from '../lib/mobile.js'

const props = defineProps({ doc: Object, geometry: Object, revision: Number, selection: Object, user: Object })
const emit = defineEmits(['jump', 'jump-annotation'])
const host = ref(null)
const textarea = ref(null)
const compact = ref(false)
const composer = ref(null)
const draft = ref('')
const selectedId = ref(null)
const floatingStyle = ref({})
let resizeObserver
const comments = computed(() => { void props.revision; return [...props.doc.getMap('comments').values()].filter(c => !c.parentId && !c.resolved) })
const visibleComments = computed(() => {
  const positions = new Map((props.geometry?.comments || []).map(c => [c.id, c.top]))
  let bottom = -10
  return comments.value.filter(c => positions.has(c.id)).sort((a, b) => positions.get(a.id) - positions.get(b.id)).map(comment => {
    const top = Math.max(positions.get(comment.id), bottom + 10, 4)
    bottom = top + 175
    return { comment, top }
  })
})
const selected = computed(() => comments.value.find(c => c.id === selectedId.value))
const expanded = computed(() => !compact.value && (comments.value.length > 0 || composer.value))
const bubbleTop = computed(() => Math.max(6, Math.min((props.geometry?.cursor?.top ?? 10), (props.geometry?.height || 500) - 40)))
function positionFloating(top = bubbleTop.value) {
  const bounds = host.value.getBoundingClientRect()
  const viewport = viewportBounds()
  floatingStyle.value = {
    left: `${Math.max(8, Math.min(bounds.right - 252, viewport.width - 260))}px`,
    top: `${Math.max(viewport.top + 8, Math.min(bounds.top + top, viewport.bottom - 320))}px`,
  }
}
async function open() {
  const selection = props.selection || { from: 0, to: 0, text: '' }
  composer.value = { quote: selection.text, anchor: relativeAnchor(props.doc, selection.from, selection.to), proposal: selection.proposal, top: bubbleTop.value }
  selectedId.value = null
  positionFloating()
  await nextTick()
  textarea.value?.focus()
}
function submit() {
  if (!draft.value.trim() || !composer.value) return
  const id = crypto.randomUUID()
  props.doc.getMap('comments').set(id, { id, parentId: null, text: draft.value.trim(), quote: composer.value.quote, anchor: composer.value.anchor, ...(composer.value.proposal ? { proposal: composer.value.proposal } : {}), author: props.user.name, authorId: props.user.id, createdAt: Date.now(), resolved: false })
  composer.value = null
  draft.value = ''
  selectedId.value = id
}
function show(comment, top) {
  selectedId.value = selectedId.value === comment.id ? null : comment.id
  composer.value = null
  positionFloating(top)
}
function jump(comment) {
  emit('jump-annotation', comment)
}
watch(() => props.geometry, () => { if (compact.value && (selected.value || composer.value)) positionFloating(composer.value?.top || bubbleTop.value) })
onMounted(() => {
  resizeObserver = new ResizeObserver(() => { compact.value = host.value.parentElement.clientWidth < 740 })
  resizeObserver.observe(host.value.parentElement)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
defineExpose({ open, reveal(id) { const comment = comments.value.find(c => c.id === id); if (comment) show(comment, props.geometry?.comments?.find(c => c.id === id)?.top || bubbleTop.value) } })
</script>

<template>
  <aside ref="host" :class="['inline-comments', { expanded }]" aria-label="Line comments">
    <button v-if="geometry?.cursor && (geometry.focused || composer || selection?.text)" class="line-comment-add icon-button" :style="{ top: `${bubbleTop}px` }" title="Comment on this line or selection" aria-label="Comment on this line" @mousedown.prevent @click="open"><MessageSquarePlus :size="18" /></button>
    <template v-for="item in visibleComments" :key="item.comment.id">
      <div v-if="expanded" class="positioned-comment" :style="{ top: `${item.top}px` }"><CommentThread :doc="doc" :comment="item.comment" :revision="revision" :user="user" @jump="jump" /></div>
      <button v-else class="line-comment-marker icon-button" :style="{ top: `${item.top}px` }" :aria-label="`Open comment by ${item.comment.author}: ${item.comment.text}`" @click="show(item.comment, item.top)"><MessageSquare :size="16" /></button>
    </template>
    <Teleport to="body">
      <section v-if="composer || (compact && selected)" class="line-comment-popover" :style="floatingStyle" role="dialog" :aria-label="composer ? 'New line comment' : 'Comment thread'" @keydown.esc="composer = null; selectedId = null">
        <button class="icon-button compact close-comment" aria-label="Close comment" @click="composer = null; selectedId = null"><X :size="14" /></button>
        <form v-if="composer" class="line-comment-compose" @submit.prevent="submit">
          <strong class="small">{{ user.name }}</strong>
          <div v-if="composer.quote" class="comment-quote">{{ composer.quote }}</div>
          <label class="field-label" for="line-comment-draft">{{ composer.quote ? 'Comment on selection' : 'Comment on this line' }}</label>
          <textarea id="line-comment-draft" ref="textarea" v-model="draft" placeholder="Leave a thought…" rows="3" />
          <button class="primary-button" :disabled="!draft.trim()">Post comment</button>
        </form>
        <CommentThread v-else-if="selected" :doc="doc" :comment="selected" :revision="revision" :user="user" @jump="jump" />
      </section>
    </Teleport>
  </aside>
</template>
