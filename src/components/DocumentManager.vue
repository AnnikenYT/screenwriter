<script setup>
import { computed, ref, onMounted } from 'vue'
import { X } from 'lucide-vue-next'
import { api } from '../lib/api.js'
const emit = defineEmits(['close', 'changed', 'open', 'error'])
const props = defineProps({ beforeChange: Function, oauth: Boolean })
const archived = ref(false), documents = ref([]), busy = ref(false)
const shared = ref(false)
const visible = computed(() => documents.value.filter(doc => !props.oauth || Boolean(!doc.access.owner) === shared.value))
async function load() {
  try { documents.value = await api(`/api/documents?archived=${archived.value}`) }
  catch (error) { emit('error', error.message) }
}
async function change(document, action) {
  const message = action === 'delete'
    ? `Permanently delete “${document.title}” for everyone? This removes the screenplay, sheets, comments, versions and uploaded images. This cannot be undone.`
    : action === 'leave' ? 'Leave this screenplay? You’ll need a new invitation to return.'
    : `Archive “${document.title}” for everyone? Live editing will stop until it is restored.`
  if (action !== 'restore' && !window.confirm(message)) return
  busy.value = true
  try {
    await props.beforeChange?.(document.id, action)
    await api(`/api/documents/${document.id}${action === 'leave' ? '/leave' : ''}`, action === 'delete' ? { method: 'DELETE' } : action === 'leave' ? { method: 'POST' } : { method: 'PATCH', body: { archived: action === 'archive' } })
    emit('changed', document.id, action)
    await load()
  } catch (error) { emit('error', error.message) }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="!busy && emit('close')">
      <section class="modal document-manager" role="dialog" aria-modal="true" aria-label="Manage screenplays" @keydown.esc="!busy && emit('close')">
        <header><h2>Screenplays</h2><button class="icon-button" aria-label="Close screenplays" :disabled="busy" @click="emit('close')"><X :size="20" /></button></header>
        <div v-if="oauth" class="segmented lifecycle-tabs"><button :class="{ active: !shared }" @click="shared = false">My screenplays</button><button :class="{ active: shared }" @click="shared = true">Shared with me</button></div>
        <div class="segmented lifecycle-tabs"><button :class="{ active: !archived }" :disabled="busy" @click="archived = false; load()">Active</button><button :class="{ active: archived }" :disabled="busy" @click="archived = true; load()">Archived</button></div>
        <div v-for="document in visible" :key="document.id" class="document-management-row">
          <strong>{{ document.title }}</strong>
          <div class="lifecycle-actions">
            <button v-if="!archived" class="text-button" :disabled="busy" @click="emit('open', document.id)">Open</button>
            <button v-if="document.access?.owner !== false" class="text-button" :disabled="busy" @click="change(document, archived ? 'restore' : 'archive')">{{ archived ? 'Restore' : 'Archive' }}</button>
            <button v-if="document.access?.owner !== false" class="text-button danger-button" :disabled="busy" @click="change(document, 'delete')">Delete</button>
            <button v-else class="text-button danger-button" :disabled="busy" @click="change(document, 'leave')">Leave</button>
          </div>
        </div>
        <p v-if="!visible.length" class="empty-state">No {{ archived ? 'archived' : 'active' }} screenplays.</p>
      </section>
    </div>
  </Teleport>
</template>
