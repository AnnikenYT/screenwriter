<script setup>
import { ref, onMounted } from 'vue'
import { History, RotateCcw, X } from 'lucide-vue-next'
import { api } from '../lib/api.js'
const props = defineProps({ documentId: String })
const emit = defineEmits(['error'])
const versions = ref([])
const label = ref('')
const preview = ref(null)
const busy = ref(false)
const confirmRestore = ref(false)
async function load() {
  try { versions.value = await api(`/api/documents/${props.documentId}/versions`) }
  catch (error) { emit('error', error.message) }
}
async function save() {
  busy.value = true
  try { await api(`/api/documents/${props.documentId}/versions`, { method: 'POST', body: { label: label.value } }); label.value = ''; await load() }
  catch (error) { emit('error', error.message) }
  finally { busy.value = false }
}
async function inspect(version) {
  try { preview.value = await api(`/api/documents/${props.documentId}/versions/${version.id}`); confirmRestore.value = false }
  catch (error) { emit('error', error.message) }
}
async function restore() {
  busy.value = true
  try { await api(`/api/documents/${props.documentId}/versions/${preview.value.id}/restore`, { method: 'POST' }); preview.value = null; confirmRestore.value = false; await load() }
  catch (error) { emit('error', error.message) }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <div class="panel-body version-panel">
    <p class="panel-intro">Live edits are saved continuously. Keep a named checkpoint before trying something new.</p>
    <form @submit.prevent="save" class="version-form"><input v-model="label" placeholder="Version name (optional)" aria-label="Version name" /><button class="primary-button" :disabled="busy">Save version</button></form>
    <button v-for="version in versions" :key="version.id" class="version-item" @click="inspect(version)"><History :size="16" /><span><strong>{{ version.label || 'Untitled version' }}</strong><small>{{ new Date(version.createdAt).toLocaleString() }}</small></span></button>
    <div v-if="!versions.length" class="empty-state">Your checkpoints will appear here.</div>
    <Teleport to="body">
      <div v-if="preview" class="modal-backdrop" @click.self="preview = null">
        <section class="modal version-modal" role="dialog" aria-modal="true" aria-labelledby="version-title" @keydown.esc="preview = null">
          <header><div><h2 id="version-title">{{ preview.label || 'Version preview' }}</h2><p class="muted small">{{ new Date(preview.createdAt).toLocaleString() }}</p></div><button class="icon-button" aria-label="Close version preview" @click="preview = null"><X :size="18" /></button></header>
          <pre class="version-source">{{ preview.text }}</pre>
          <footer><p class="small muted">{{ confirmRestore ? 'Restore screenplay, sheets, scratchpad, and review data for everyone? A backup is saved first.' : 'Restoring changes the shared document for all collaborators.' }}</p><button class="primary-button" :disabled="busy" @click="confirmRestore ? restore() : confirmRestore = true"><RotateCcw :size="14" />{{ confirmRestore ? 'Confirm restore' : 'Restore this version' }}</button></footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>
