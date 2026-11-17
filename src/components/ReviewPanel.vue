<script setup>
import { computed, ref, nextTick } from 'vue'
import { MessageSquare, Check, X, CornerDownRight } from 'lucide-vue-next'
import { relativeAnchor, resolveAnchor } from '../lib/collaboration.js'
import { api } from '../lib/api.js'
const props = defineProps({ doc: Object, documentId: String, revision: Number, selection: Object, user: Object })
const emit = defineEmits(['error', 'jump'])
const tab = ref('comments')
const showResolved = ref(false)
const draft = ref('')
const replacement = ref('')
const proposedSelection = ref(null)
const proposalInput = ref(null)
const replies = ref({})
const comments = computed(() => { void props.revision; return [...props.doc.getMap('comments').values()].filter(c => !c.parentId && (showResolved.value || !c.resolved)).sort((a, b) => a.createdAt - b.createdAt) })
const suggestions = computed(() => { void props.revision; return [...props.doc.getMap('suggestions').values()].filter(s => showResolved.value || s.status === 'pending').sort((a, b) => a.createdAt - b.createdAt) })
const target = computed(() => {
  void props.revision
  if (!proposedSelection.value) return props.selection
  const range = resolveAnchor(props.doc, proposedSelection.value.anchor)
  return range ? { ...proposedSelection.value, ...range } : null
})
function addComment(parentId) {
  const text = (parentId ? replies.value[parentId] : draft.value).trim()
  if (!text) return
  const id = crypto.randomUUID()
  const selected = props.selection || { from: 0, to: 0, text: '' }
  props.doc.getMap('comments').set(id, { id, parentId: parentId || null, text, quote: selected.text, anchor: relativeAnchor(props.doc, selected.from, selected.to), author: props.user.name, createdAt: Date.now(), resolved: false })
  if (parentId) replies.value[parentId] = ''
  else draft.value = ''
}
function thread(id) { void props.revision; return [...props.doc.getMap('comments').values()].filter(c => c.parentId === id).sort((a, b) => a.createdAt - b.createdAt) }
function setComment(comment, patch) { props.doc.getMap('comments').set(comment.id, { ...props.doc.getMap('comments').get(comment.id), ...patch }) }
function submitSuggestion() {
  const selected = target.value || { from: 0, to: 0, text: '' }
  if (props.doc.getText('screenplay').toString().slice(selected.from, selected.to) !== selected.text) {
    emit('error', 'The selected passage changed while you were writing. Select it again to make a new proposal.')
    return
  }
  if (selected.text === replacement.value) return
  const id = crypto.randomUUID()
  props.doc.getMap('suggestions').set(id, { id, original: selected.text, replacement: replacement.value, anchor: relativeAnchor(props.doc, selected.from, selected.to), author: props.user.name, createdAt: Date.now(), status: 'pending' })
  replacement.value = ''; proposedSelection.value = null
}
async function decide(suggestion, status) {
  try {
    await api(`/api/documents/${props.documentId}/suggestions/${suggestion.id}/decide`, { method: 'POST', body: { decision: status } })
  } catch (error) { emit('error', error.message) }
}
function jump(item) {
  const range = resolveAnchor(props.doc, item.anchor)
  if (range) emit('jump', range.from, range.to)
  else emit('error', 'The original passage is no longer available.')
}
function propose(change) {
  const source = props.doc.getText('screenplay').toString()
  proposedSelection.value = { ...change, text: source.slice(change.from, change.to), anchor: relativeAnchor(props.doc, change.from, change.to) }
  replacement.value = change.replacement
  tab.value = 'suggestions'
  nextTick(() => proposalInput.value?.focus())
}
function comment() { tab.value = 'comments'; nextTick(() => document.getElementById('new-comment')?.focus()) }
defineExpose({ propose, comment })
const date = time => new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="panel-body review-panel">
    <div class="panel-tabs"><button :class="{ active: tab === 'comments' }" @click="tab = 'comments'">Comments</button><button :class="{ active: tab === 'suggestions' }" @click="tab = 'suggestions'">Suggestions</button></div>
    <template v-if="tab === 'comments'">
      <form class="review-compose" @submit.prevent="addComment()">
        <div v-if="selection?.text" class="selection-quote">{{ selection.text }}</div>
        <label class="field-label" for="new-comment">{{ selection?.text ? 'Comment on selection' : 'Document comment' }}</label>
        <textarea id="new-comment" v-model="draft" rows="3" placeholder="Leave a thought…" />
        <button class="primary-button" :disabled="!draft.trim()">Add comment</button>
      </form>
      <label class="checkbox-label"><input v-model="showResolved" type="checkbox" /> Show resolved</label>
      <article v-for="comment in comments" :key="comment.id" class="review-card" :class="{ resolved: comment.resolved }">
        <div class="review-byline"><strong>{{ comment.author }}</strong><time>{{ date(comment.createdAt) }}</time></div>
        <button v-if="comment.quote" class="selection-quote quote-link" @click="jump(comment)">{{ comment.quote }}</button>
        <p class="comment-text">{{ comment.text }}</p>
        <div class="thread-reply" v-for="reply in thread(comment.id)" :key="reply.id"><strong>{{ reply.author }}</strong><p>{{ reply.text }}</p></div>
        <form v-if="!comment.resolved" class="reply-form" @submit.prevent="addComment(comment.id)"><input v-model="replies[comment.id]" placeholder="Reply…" aria-label="Reply to comment" /><button class="icon-button" aria-label="Send reply" :disabled="!replies[comment.id]?.trim()"><CornerDownRight :size="15" /></button></form>
        <button class="text-button" @click="setComment(comment, { resolved: !comment.resolved })"><Check :size="13" /> {{ comment.resolved ? 'Reopen' : 'Resolve' }}</button>
      </article>
      <div v-if="!comments.length" class="empty-state"><MessageSquare :size="25" /><p>A little room for conversation.</p><small>Select a passage to leave a comment, or add a note to the whole document.</small></div>
    </template>
    <template v-else>
      <form class="review-compose" @submit.prevent="submitSuggestion">
        <p class="panel-intro">Propose a replacement without changing the screenplay. Anyone in the workspace can accept or reject it.</p>
        <div v-if="target?.text" class="selection-quote">{{ target.text }}</div>
        <label class="field-label"> {{ target?.text ? 'Suggested replacement' : 'Suggested insertion at cursor' }}<textarea ref="proposalInput" v-model="replacement" rows="4" placeholder="Your proposed text…" /></label>
        <button class="primary-button" :disabled="!target || (target.text || '') === replacement">Suggest edit</button>
        <button v-if="proposedSelection" type="button" class="text-button" @click="proposedSelection = null; replacement = ''">Cancel</button>
      </form>
      <label class="checkbox-label"><input v-model="showResolved" type="checkbox" /> Show decided</label>
      <article v-for="suggestion in suggestions" :key="suggestion.id" class="review-card">
        <div class="review-byline"><strong>{{ suggestion.author }}</strong><time>{{ date(suggestion.createdAt) }}</time></div>
        <button class="suggestion-diff" @click="jump(suggestion)"><del v-if="suggestion.original">{{ suggestion.original }}</del><ins v-if="suggestion.replacement">{{ suggestion.replacement }}</ins><em v-else>Delete selected text</em></button>
        <div v-if="suggestion.status === 'pending'" class="button-row"><button class="text-button accept" @click="decide(suggestion, 'accepted')"><Check :size="14" />Accept</button><button class="text-button" @click="decide(suggestion, 'rejected')"><X :size="14" />Reject</button></div>
        <span v-else class="small muted">{{ suggestion.status }} by {{ suggestion.decidedBy }}</span>
      </article>
      <div v-if="!suggestions.length" class="empty-state">No pending suggestions.</div>
    </template>
  </div>
</template>
