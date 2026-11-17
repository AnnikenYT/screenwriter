<script setup>
import { computed, ref } from 'vue'
import { Check, CornerDownRight } from 'lucide-vue-next'
import { relativeAnchor } from '../lib/collaboration.js'
const props = defineProps({ doc: Object, comment: Object, revision: Number, user: Object })
const emit = defineEmits(['jump'])
const reply = ref('')
const replies = computed(() => { void props.revision; return [...props.doc.getMap('comments').values()].filter(c => c.parentId === props.comment.id).sort((a, b) => a.createdAt - b.createdAt) })
function send() {
  if (!reply.value.trim()) return
  const id = crypto.randomUUID()
  props.doc.getMap('comments').set(id, { id, parentId: props.comment.id, text: reply.value.trim(), author: props.user.name, authorId: props.user.id, createdAt: Date.now(), anchor: props.comment.anchor || relativeAnchor(props.doc, 0, 0), resolved: false })
  reply.value = ''
}
function resolve() {
  const map = props.doc.getMap('comments')
  const current = map.get(props.comment.id)
  if (current) map.set(current.id, { ...current, resolved: true })
}
</script>

<template>
  <article class="line-comment-card" :aria-label="`Comment by ${comment.author}`">
    <div class="review-byline"><strong>{{ comment.author }}</strong><button class="icon-button compact" title="Resolve comment" aria-label="Resolve comment" @click="resolve"><Check :size="14" /></button></div>
    <button v-if="comment.quote" class="comment-quote" @click="emit('jump', comment)">{{ comment.quote }}</button>
    <p class="comment-text">{{ comment.text }}</p>
    <div v-for="item in replies" :key="item.id" class="thread-reply"><strong>{{ item.author }}</strong><p>{{ item.text }}</p></div>
    <form class="reply-form" @submit.prevent="send"><input v-model="reply" placeholder="Reply…" aria-label="Reply to comment" /><button class="icon-button compact" aria-label="Send reply" :disabled="!reply.trim()"><CornerDownRight :size="15" /></button></form>
  </article>
</template>
