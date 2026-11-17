<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { X, Upload } from 'lucide-vue-next'
import { relativeAnchor } from '../lib/collaboration.js'
import { api } from '../lib/api.js'
const props = defineProps({ doc: Object, documentId: String, selection: Object, user: Object })
const emit = defineEmits(['close', 'error'])
const selected = { ...props.selection, anchor: relativeAnchor(props.doc, props.selection.from, props.selection.to) }
const url = ref('')
const caption = ref('')
const uploading = ref(false)
const input = ref(null)
async function upload(event) {
  const file = event.target.files[0]
  if (!file) return
  uploading.value = true
  try {
    const body = new FormData(); body.append('image', file)
    const image = await api(`/api/documents/${props.documentId}/images`, { method: 'POST', body })
    url.value = image.url
  } catch (error) { emit('error', error.message) }
  finally { uploading.value = false }
}
function save() {
  const value = url.value.trim()
  if (!/^\/uploads\/[a-zA-Z0-9.-]+$/.test(value)) {
    try { if (new URL(value).protocol !== 'https:') throw new Error() }
    catch { emit('error', 'Use an HTTPS image URL, or upload an image.'); return }
  }
  if (value.length > 2048) { emit('error', 'The image URL is too long.'); return }
  const id = crypto.randomUUID()
  props.doc.getMap('meta').set(`image-link:${id}`, { id, url: value, caption: caption.value.trim(), quote: selected.text, anchor: selected.anchor, ...(selected.proposal ? { proposal: selected.proposal } : {}), author: props.user.name, authorId: props.user.id, createdAt: Date.now() })
  emit('close')
}
onMounted(() => nextTick(() => input.value?.focus()))
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <form class="modal image-link-modal" role="dialog" aria-modal="true" aria-labelledby="image-link-title" @submit.prevent="save" @keydown.esc="emit('close')">
        <header><h2 id="image-link-title">Link an image to this passage</h2><button class="icon-button" type="button" aria-label="Close image link" @click="emit('close')"><X :size="18" /></button></header>
        <div class="selection-quote">{{ selected.text }}</div>
        <label class="field-label">Image URL<input ref="input" v-model="url" placeholder="https://…" maxlength="2048" /></label>
        <label class="text-button upload-button"><Upload :size="14" />{{ uploading ? 'Uploading…' : 'Or upload an image' }}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" :disabled="uploading" @change="upload" /></label>
        <label class="field-label">Caption (optional)<input v-model="caption" maxlength="300" /></label>
        <p class="small muted">The passage is marked subtly. Hover or tap it to see the image; remote image URLs are only loaded when opened.</p>
        <button class="primary-button" :disabled="uploading || !url.trim()">Link image</button>
      </form>
    </div>
  </Teleport>
</template>
