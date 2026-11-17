<script setup>
import { computed, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { ImagePlus, ArrowLeft, X, MapPin, UserRound } from 'lucide-vue-next'
import { api } from '../lib/api.js'
import { renameSheet, readSheet, sheetFieldKey } from '../lib/collaboration.js'
import { characterName, locationName } from '../../shared/fountain.js'
import { changeSheetStatus } from '../../shared/entities.js'
const props = defineProps({ doc: Object, documentId: String, kind: String, revision: Number, blocks: Array })
const emit = defineEmits(['error', 'jump'])
const selectedId = ref(null)
const filter = ref('')
const editing = ref('notes')
const uploading = ref(false)
const archived = ref(false)
const map = computed(() => props.doc.getMap(props.kind))
const sheets = computed(() => { void props.revision; return [...map.value.values()].filter(s => archived.value ? s.status === 'archived' : !s.status || s.status === 'active').map(sheet => readSheet(props.doc, props.kind, sheet)).sort((a, b) => a.name.localeCompare(b.name)).filter(s => s.name.toLowerCase().includes(filter.value.toLowerCase())) })
const selected = computed(() => { void props.revision; const sheet = map.value.get(selectedId.value); return sheet && sheet.status !== 'deleted' ? readSheet(props.doc, props.kind, sheet) : null })
function lifecycle(status) {
  if (status === 'deleted' && !window.confirm(`Delete “${selected.value.name}” and its sheet notes and moodboard? Screenplay text is unchanged. Older saved versions may still contain this sheet.`)) return
  try { changeSheetStatus(props.doc, props.kind, selectedId.value, status); selectedId.value = null }
  catch (error) { emit('error', error.message) }
}
const related = computed(() => !selected.value ? [] : props.blocks.filter(b => b.type === (props.kind === 'characters' ? 'character' : 'scene') && (props.kind === 'characters' ? characterName(b.text) : locationName(b.text)).toUpperCase() === selected.value.name.toUpperCase()))
function update(field, value) {
  const current = map.value.get(selectedId.value)
  if (current) props.doc.getMap('meta').set(sheetFieldKey(props.kind, current.id, field), value)
}
function rename(event) {
  try { renameSheet(props.doc, props.kind, selectedId.value, event.target.value) }
  catch (error) { emit('error', error.message); event.target.value = selected.value.name }
}
async function upload(event) {
  const file = event.target.files[0]
  if (!file) return
  const id = selectedId.value
  uploading.value = true
  try {
    const body = new FormData()
    body.append('image', file)
    const image = await api(`/api/documents/${props.documentId}/images`, { method: 'POST', body })
    const current = readSheet(props.doc, props.kind, map.value.get(id))
    if (current) props.doc.getMap('meta').set(sheetFieldKey(props.kind, id, 'images'), [...current.images, image])
  } catch (error) { emit('error', error.message) }
  finally { uploading.value = false; event.target.value = '' }
}
const render = text => DOMPurify.sanitize(marked.parse(text || ''))
</script>

<template>
  <section class="sheet-panel panel-body">
    <template v-if="!selected">
      <p class="panel-intro">Created automatically from {{ kind === 'characters' ? 'speaking characters' : 'scene headings' }}.</p>
      <div class="segmented lifecycle-tabs"><button :class="{ active: !archived }" @click="archived = false">Active</button><button :class="{ active: archived }" @click="archived = true">Archived</button></div>
      <input v-model="filter" class="search-input" :placeholder="`Find ${kind === 'characters' ? 'a character' : 'a location'}…`" :aria-label="`Search ${kind}`" />
      <button v-for="sheet in sheets" :key="sheet.id" class="sheet-list-item" @click="selectedId = sheet.id">
        <span class="sheet-initial"><UserRound v-if="kind === 'characters'" :size="17" /><MapPin v-else :size="17" /></span>
        <span><strong>{{ sheet.name }}</strong><small>{{ sheet.tagline || (kind === 'characters' ? 'Character sheet' : 'Location sheet') }}</small></span>
        <span class="arrow">›</span>
      </button>
      <div v-if="!sheets.length" class="empty-state">{{ archived ? 'No archived sheets.' : 'No active sheets. Write a new name in the screenplay to discover a sheet.' }}</div>
    </template>
    <template v-else>
      <button class="text-button back-link" @click="selectedId = null"><ArrowLeft :size="14" /> All {{ kind }}</button>
      <div class="lifecycle-actions">
        <button v-if="selected.status === 'archived'" class="text-button" @click="lifecycle('active')">Restore sheet</button>
        <button v-else class="text-button" @click="lifecycle('archived')">Archive sheet</button>
        <button class="text-button danger-button" @click="lifecycle('deleted')">Delete sheet</button>
      </div>
      <p v-if="selected.status === 'archived'" class="field-hint">Archived — notes and images are kept. Restore to edit.</p>
      <fieldset :disabled="selected.status === 'archived'" class="sheet-fields">
      <label class="field-label">Name<input :value="selected.name" class="sheet-name" @change="rename" /></label>
      <p class="field-hint">Renaming updates references throughout the screenplay and notes.</p>
      <label v-if="kind === 'characters'" class="field-label">Age<input :value="selected.age" placeholder="e.g. Early 30s" @input="update('age', $event.target.value)" /></label>
      <label class="field-label">Tagline<input :value="selected.tagline" placeholder="In a few words…" @input="update('tagline', $event.target.value)" /></label>
      <div v-for="field in ['appearance', 'notes']" :key="field" class="markdown-field">
        <div class="field-heading"><label :for="`sheet-${field}`">{{ field === 'appearance' ? kind === 'characters' ? 'Appearance' : 'Description' : 'Notes' }}</label><button class="text-button" @click="editing = editing === field ? '' : field">{{ editing === field ? 'Preview' : 'Edit' }}</button></div>
        <textarea v-if="editing === field" :id="`sheet-${field}`" :value="selected[field]" placeholder="Markdown supported…" rows="7" @input="update(field, $event.target.value)" />
        <div v-else class="markdown-content sheet-markdown" tabindex="0" @dblclick="editing = field" v-html="render(selected[field]) || '<p class=&quot;muted&quot;>Nothing here yet.</p>'" />
      </div>
      <div class="field-heading"><span>Moodboard</span><label class="text-button upload-button"><ImagePlus :size="14" />{{ uploading ? 'Uploading…' : 'Add image' }}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" :disabled="uploading" @change="upload" /></label></div>
      <div class="moodboard">
        <div v-for="image in selected.images" :key="image.id" class="mood-image">
          <a :href="image.url" target="_blank" rel="noopener"><img :src="image.url" alt="Moodboard reference" loading="lazy" /></a>
          <button class="image-remove icon-button" aria-label="Remove image" @click="update('images', selected.images.filter(i => i.id !== image.id))"><X :size="12" /></button>
        </div>
        <p v-if="!selected.images.length" class="field-hint">Collect visual references here.</p>
      </div>
      <div class="field-heading">In the screenplay <span class="count">{{ related.length }}</span></div>
      <button v-for="block in related" :key="block.from" class="reference-link" @click="emit('jump', block.from)">Line {{ block.startLine }} <span>{{ block.text }}</span></button>
      </fieldset>
    </template>
  </section>
</template>
