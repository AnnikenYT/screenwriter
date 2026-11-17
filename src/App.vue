<script setup>
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick, markRaw, watch } from 'vue'
import { PanelLeftClose, PanelLeftOpen, List, UsersRound, MapPin, MessageSquare, NotebookPen, History, FileText, Plus, Upload, Download, ChevronDown, Columns2, AlignLeft, Pencil, Check, X, Undo2, Redo2, CircleHelp, Link, LogOut, LoaderCircle, Bold, Italic, Underline, ImagePlus, Moon, Sun } from 'lucide-vue-next'
import TextEditor from './components/TextEditor.vue'
import ScreenplayPreview from './components/ScreenplayPreview.vue'
import SheetPanel from './components/SheetPanel.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import VersionPanel from './components/VersionPanel.vue'
import InlineComments from './components/InlineComments.vue'
import ImageLinkDialog from './components/ImageLinkDialog.vue'
import { connect } from './lib/collaboration.js'
import { api, download } from './lib/api.js'
import { parseFountain } from '../shared/fountain.js'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const session = ref(null)
const theme = ref(localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
watch(theme, value => { document.documentElement.dataset.theme = value; localStorage.setItem('theme', value) }, { immediate: true })
const loading = ref(true)
const error = ref('')
const documents = ref([])
const currentId = ref('')
const connection = shallowRef(null)
const revision = ref(0)
const source = ref('')
const blocks = shallowRef([])
const synced = ref(false)
const status = ref('connecting')
const peers = ref([])
const sidebar = ref(window.innerWidth > 900)
const panel = ref('outline')
const mode = ref(localStorage.getItem('editor-mode') || 'live')
const reviewMode = ref(false)
const selection = ref({ from: 0, to: 0, text: '' })
const cursor = ref({ line: 1, column: 1 })
const editor = ref(null)
const preview = ref(null)
const scrollSync = ref(true)
let scrollOrigin = null, scrollGeneration = 0
const review = ref(null)
const lineComments = ref(null)
const geometry = ref(null)
const displaySource = ref('')
const displayBlocks = computed(() => parseFountain(displaySource.value))
const profileOpen = ref(false)
const writerName = ref('')
const savingName = ref(false)
const imageLinkOpen = ref(false)
let profileChannel
const filesOpen = ref(false)
const exportOpen = ref(false)
const helpOpen = ref(false)
const scratchView = ref('write')
const importInput = ref(null)
const titleInput = ref('')
const dirtyOffline = ref(false)
let timer, errorTimer
let generation = 0
let documentUpdate
const tabs = [
  { id: 'outline', label: 'Outline', icon: List },
  { id: 'characters', label: 'Characters', icon: UsersRound },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'review', label: 'Review', icon: MessageSquare },
  { id: 'scratchpad', label: 'Scratchpad', icon: NotebookPen },
  { id: 'versions', label: 'Versions', icon: History },
]
const panelTitle = computed(() => tabs.find(t => t.id === panel.value)?.label)
const outline = computed(() => blocks.value.filter(b => ['scene', 'section', 'synopsis'].includes(b.type)))
const words = computed(() => source.value.trim() ? source.value.trim().split(/\s+/).length : 0)
const activeComments = computed(() => { void revision.value; return connection.value ? [...connection.value.doc.getMap('comments').values()].filter(c => !c.parentId && !c.resolved).length + [...connection.value.doc.getMap('suggestions').values()].filter(s => s.status === 'pending').length : 0 })
const scratchHtml = computed(() => { void revision.value; return DOMPurify.sanitize(marked.parse(connection.value?.scratchpad.toString() || '')) })
const estimate = computed(() => Math.max(1, Math.ceil(blocks.value.filter(b => !['title', 'note', 'boneyard', 'section', 'synopsis'].includes(b.type)).reduce((n, b) => n + Math.max(1, b.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (['dialogue', 'parenthetical'].includes(b.type) ? 35 : 60))), 0)), 0) / 55)))
function notify(message) { error.value = message; clearTimeout(errorTimer); errorTimer = setTimeout(() => error.value = '', 9000) }
async function refreshDocuments() { documents.value = await api('/api/documents') }
async function initialize() {
  loading.value = true
  try {
    session.value = await api('/api/session')
    if (!session.value.user) return
    await refreshDocuments()
    const requested = new URL(location.href).searchParams.get('document')
    if (requested && !documents.value.some(d => d.id === requested)) notify('That document is not available. Choose a document or create a new one.')
    const id = documents.value.find(d => d.id === requested)?.id || documents.value[0]?.id
    if (id) await openDocument(id)
    else await createDocument('Untitled screenplay', '')
  } catch (e) { notify(e.message) }
  finally { loading.value = false }
}
function cleanup() {
  clearTimeout(timer)
  if (connection.value) {
    connection.value.doc.off('update', documentUpdate)
    connection.value.provider.destroy()
    connection.value.doc.destroy()
    connection.value = null
  }
}
async function openDocument(id) {
  if (id === currentId.value && connection.value) { filesOpen.value = false; return }
  if (dirtyOffline.value) { notify('Reconnect before switching documents, or download your Fountain file to preserve unsynced changes.'); return }
  generation++
  cleanup()
  currentId.value = id
  synced.value = false
  status.value = 'connecting'
  source.value = ''; blocks.value = []; peers.value = []
  const current = connect(id, session.value.user)
  connection.value = markRaw(current)
  const token = generation
  const refresh = () => {
    if (token !== generation) return
    source.value = current.text.toString()
    blocks.value = parseFountain(source.value)
    titleInput.value = current.doc.getMap('meta').get('title') || 'Untitled screenplay'
  }
  documentUpdate = (_update, origin) => {
    revision.value++
    if (origin !== current.provider && status.value !== 'connected') dirtyOffline.value = true
    // Coalesce keystrokes; the editor itself updates synchronously.
    clearTimeout(timer)
    timer = setTimeout(refresh, 80)
  }
  current.doc.on('update', documentUpdate)
  current.provider.on('sync', value => {
    if (!value) return
    synced.value = true; dirtyOffline.value = false
    refresh()
  })
  current.provider.on('status', event => {
    if (token !== generation) return
    status.value = event.status
  })
  current.provider.on('connection-error', () => { if (!synced.value) error.value = 'Unable to connect. Check the server or sign in again.' })
  const updatePeers = () => { peers.value = [...current.provider.awareness.getStates()].filter(([client]) => client !== current.doc.clientID).map(([, state]) => state.user).filter(Boolean) }
  current.provider.awareness.on('change', updatePeers)
  const url = new URL(location.href)
  url.searchParams.set('document', id)
  history.replaceState({}, '', url)
  filesOpen.value = false
  selection.value = { from: 0, to: 0, text: '' }
}
async function createDocument(title = 'Untitled screenplay', text = '') {
  if (dirtyOffline.value) return notify('Reconnect before creating a new document.')
  try {
    const doc = await api('/api/documents', { method: 'POST', body: { title, text } })
    await refreshDocuments()
    await openDocument(doc.id)
  } catch (e) { notify(e.message) }
}
async function importFile(event) {
  const file = event.target.files[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) { notify('Please import a Fountain file smaller than 2 MB.'); return }
  try { await createDocument(file.name.replace(/\.(fountain|txt)$/i, ''), (await file.text()).replace(/\r\n?/g, '\n')) }
  catch (e) { notify(e.message) }
  finally { event.target.value = '' }
}
function renameTitle() {
  const title = titleInput.value.trim().slice(0, 200) || 'Untitled screenplay'
  connection.value.doc.getMap('meta').set('title', title)
  titleInput.value = title
  const doc = documents.value.find(d => d.id === currentId.value)
  if (doc) doc.title = title
  document.title = title
}
function selectPanel(id) { panel.value = id; sidebar.value = true }
function setMode(value) { mode.value = value; localStorage.setItem('editor-mode', value) }
function onSelection(value, comment = false) { selection.value = value; if (comment) addComment() }
async function addComment() { await nextTick(); lineComments.value?.open() }
async function decideSuggestion(suggestion, decision) {
  try { await api(`/api/documents/${currentId.value}/suggestions/${suggestion.id}/decide`, { method: 'POST', body: { decision } }) }
  catch (error) { notify(error.message) }
}
function editName() { writerName.value = session.value.user.name; profileOpen.value = true; nextTick(() => document.getElementById('writer-name')?.focus()) }
function applyProfile(user) {
  if (!user || session.value?.authMode !== 'none' || user.id !== session.value.user.id) return
  session.value.user = user
  connection.value?.provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, colorLight: `${user.color}25` })
}
async function saveName() {
  savingName.value = true
  try {
    const updated = await api('/api/session', { method: 'PATCH', body: { name: writerName.value } })
    applyProfile(updated.user)
    profileChannel?.postMessage(updated.user)
    profileOpen.value = false
  } catch (error) { notify(error.message) }
  finally { savingName.value = false }
}
function linkImage() {
  if (!selection.value.text) { notify('Select a passage first, then link an image.'); return }
  imageLinkOpen.value = true
}
function syncScroll(origin, position) {
  if (!scrollSync.value || mode.value !== 'split' || (scrollOrigin && scrollOrigin !== origin)) return
  scrollOrigin = origin
  const generation = ++scrollGeneration
  if (origin === 'source') preview.value?.scrollToPosition(position)
  else editor.value?.scrollToPosition(position)
  requestAnimationFrame(() => requestAnimationFrame(() => { if (generation === scrollGeneration) scrollOrigin = null }))
}
function goTo(from, to) { editor.value?.goTo(from, to); if (window.innerWidth < 700) sidebar.value = false }
async function share() {
  try { await navigator.clipboard.writeText(location.href); notify('Document link copied. Anyone with workspace access can collaborate.') }
  catch { notify('Copy the document URL from your browser to invite a collaborator.') }
}
function exportFountain() { download(connection.value.text.toString(), `${titleInput.value || 'screenplay'}.fountain`); exportOpen.value = false }
function closeMenus(event) { if (!event.target.closest('.dropdown-anchor')) { filesOpen.value = false; exportOpen.value = false } }
function beforeUnload(event) { if (dirtyOffline.value) { event.preventDefault(); event.returnValue = '' } }
function hotkeys(event) {
  if (event.key === 'Escape') { helpOpen.value = false; filesOpen.value = false; exportOpen.value = false; profileOpen.value = false; imageLinkOpen.value = false }
}
onMounted(() => {
  initialize()
  if ('BroadcastChannel' in window) { profileChannel = new BroadcastChannel('screenwriter-profile'); profileChannel.onmessage = event => applyProfile(event.data) }
  document.addEventListener('click', closeMenus); window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', hotkeys)
})
onBeforeUnmount(() => { cleanup(); profileChannel?.close(); clearTimeout(errorTimer); document.removeEventListener('click', closeMenus); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', hotkeys) })
</script>

<template>
  <div v-if="loading" class="loading-screen"><LoaderCircle class="spin" :size="22" /><p>Opening workspace…</p></div>
  <div v-else-if="!session?.user" class="login-screen">
    <FileText :size="28" :stroke-width="1" />
    <h1>Your writing, together.</h1><p>Sign in to open the shared workspace.</p>
    <a class="primary-button" href="/auth/login">Sign in</a>
    <p v-if="error" class="error-text">{{ error }}</p>
    <button v-if="!session" class="text-button" @click="initialize">Try again</button>
  </div>
  <div v-else class="workspace">
    <header class="topbar">
      <div class="document-controls">
        <div class="dropdown-anchor">
          <button class="icon-button document-menu-button" aria-label="Open documents" :aria-expanded="filesOpen" @click="filesOpen = !filesOpen"><FileText :size="19" /><ChevronDown :size="11" /></button>
          <div v-if="filesOpen" class="dropdown document-dropdown">
            <div class="dropdown-label">DOCUMENTS</div>
            <button v-for="doc in documents" :key="doc.id" :class="{ selected: doc.id === currentId }" @click="openDocument(doc.id)"><FileText :size="15" /><span>{{ doc.id === currentId ? titleInput : doc.title }}</span><Check v-if="doc.id === currentId" :size="14" /></button>
            <div class="menu-divider" /><button @click="createDocument()"><Plus :size="15" />New screenplay</button><button @click="importInput.click()"><Upload :size="15" />Import Fountain</button>
          </div>
        </div>
        <input v-model="titleInput" class="document-title" aria-label="Document title" maxlength="200" :disabled="!synced" @change="renameTitle" @keydown.enter="$event.target.blur()" />
      </div>
      <div class="toolbar-center">
        <div class="segmented mode-switch" aria-label="Editor mode"><button :class="{ active: mode === 'live' }" title="Live formatted editor" @click="setMode('live')"><AlignLeft :size="14" /><span>Live</span></button><button :class="{ active: mode === 'split' }" title="Raw Fountain and rendered preview" @click="setMode('split')"><Columns2 :size="14" /><span>Split</span></button></div>
      </div>
      <div class="toolbar-actions">
        <div class="collaborators" :title="[session.user.name + ' (you)', ...peers.map(p => p.name)].join(', ')"><button v-if="session.authMode === 'none'" class="avatar" :style="{ background: session.user.color }" aria-label="Set writer name" :title="`${session.user.name} · Set your name`" @click="editName">{{ session.user.name.slice(0, 1) }}</button><span v-else class="avatar" :style="{ background: session.user.color }">{{ session.user.name.slice(0, 1) }}</span><span v-for="(peer, i) in peers.slice(0, 3)" :key="i" class="avatar" :style="{ background: peer.color }">{{ peer.name.slice(0, 1) }}</span><span v-if="peers.length > 3" class="avatar extra">+{{ peers.length - 3 }}</span></div>
        <button class="icon-button" title="Copy collaboration link" aria-label="Copy collaboration link" @click="share"><Link :size="16" /></button>
        <div class="dropdown-anchor">
          <button class="text-button export-button" :disabled="!synced" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen"><Download :size="15" /><span>Export</span><ChevronDown :size="11" /></button>
          <div v-if="exportOpen" class="dropdown export-dropdown"><button @click="exportFountain"><FileText :size="15" />Fountain (.fountain)</button><a :href="`/api/documents/${currentId}/export.pdf`" target="_blank" rel="noopener" @click="exportOpen = false"><Download :size="15" />Screenplay PDF</a></div>
        </div>
      </div>
    </header>

    <div class="workspace-body">
      <aside class="tool-rail" aria-label="Workspace tools">
        <button class="rail-button sidebar-toggle" :aria-label="sidebar ? 'Hide sidebar' : 'Show sidebar'" @click="sidebar = !sidebar"><PanelLeftClose v-if="sidebar" :size="19" /><PanelLeftOpen v-else :size="19" /></button>
        <button v-for="tab in tabs" :key="tab.id" :class="['rail-button', { active: sidebar && panel === tab.id }]" :title="tab.label" :aria-label="tab.label" :aria-pressed="sidebar && panel === tab.id" @click="sidebar && panel === tab.id ? sidebar = false : selectPanel(tab.id)"><component :is="tab.icon" :size="19" :stroke-width="1.6" /><span v-if="tab.id === 'review' && activeComments" class="rail-dot" /></button>
        <div class="rail-spacer" />
        <button class="rail-button" :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'" :title="theme === 'dark' ? 'Light mode' : 'Dark mode'" @click="theme = theme === 'dark' ? 'light' : 'dark'"><Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" /></button>
        <button class="rail-button" title="Fountain reference" aria-label="Fountain reference" @click="helpOpen = true"><CircleHelp :size="18" /></button>
        <a v-if="session.authMode === 'oauth'" class="rail-button" href="/auth/logout" aria-label="Sign out" title="Sign out"><LogOut :size="18" /></a>
      </aside>
      <aside v-if="sidebar && connection && synced" class="sidebar" :class="{ 'scratchpad-sidebar': panel === 'scratchpad' }">
        <div class="sidebar-heading"><h2>{{ panelTitle }}</h2><span v-if="panel === 'outline'" class="count">{{ blocks.filter(b => b.type === 'scene').length }} scenes</span><button v-else class="icon-button compact" aria-label="Close sidebar" @click="sidebar = false"><X :size="14" /></button></div>
        <div v-if="panel === 'outline'" class="outline panel-body">
          <div class="outline-summary"><span>{{ words.toLocaleString() }} words</span><span>~{{ estimate }} {{ estimate === 1 ? 'page' : 'pages' }}</span></div>
          <button v-for="(block, i) in outline" :key="block.from" :class="['outline-item', block.type, { current: cursor.line >= block.startLine && cursor.line < (outline[i + 1]?.startLine || Infinity) }]" @click="goTo(block.from)"><span v-if="block.type === 'scene'" class="outline-number">{{ block.sceneNumber || outline.slice(0, i + 1).filter(b => b.type === 'scene').length }}</span><span>{{ block.text.replace(/^#+\s*|^=\s*/, '') }}</span></button>
          <div v-if="!outline.length" class="empty-state"><List :size="25" /><p>A place for every scene.</p><small>Scene headings and sections will appear here as you write.</small><code>INT. SOMEWHERE - DAY</code></div>
        </div>
        <SheetPanel v-else-if="['characters', 'locations'].includes(panel)" :key="currentId + panel" :doc="connection.doc" :document-id="currentId" :kind="panel" :revision="revision" :blocks="blocks" @error="notify" @jump="goTo" />
        <ReviewPanel v-else-if="panel === 'review'" ref="review" :key="currentId" :doc="connection.doc" :document-id="currentId" :revision="revision" :selection="selection" :user="session.user" @error="notify" @jump="goTo" />
        <div v-else-if="panel === 'scratchpad'" class="scratchpad-panel"><p class="panel-intro">A shared place for everything that isn't on the page. Markdown supported.</p><div class="panel-tabs scratchpad-tabs"><button :class="{ active: scratchView === 'write' }" @click="scratchView = 'write'">Write</button><button :class="{ active: scratchView === 'preview' }" @click="scratchView = 'preview'">Preview</button></div><TextEditor v-if="scratchView === 'write'" :key="currentId + '-scratch'" :ytext="connection.scratchpad" :awareness="connection.provider.awareness" markdown mode="split" /><div v-else class="markdown-content scratchpad-preview" v-html="scratchHtml || '<p class=&quot;muted&quot;>Nothing here yet.</p>'" /></div>
        <VersionPanel v-else-if="panel === 'versions'" :key="currentId" :document-id="currentId" @error="notify" />
      </aside>

      <main class="editor-main" :class="{ 'split-mode': mode === 'split' }">
        <div class="editor-toolbar">
          <div class="button-row"><button class="icon-button compact" title="Undo (Ctrl/⌘ Z)" aria-label="Undo" @mousedown.prevent @click="editor?.undo()"><Undo2 :size="15" /></button><button class="icon-button compact" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo" @mousedown.prevent @click="editor?.redo()"><Redo2 :size="15" /></button><span class="toolbar-divider" /><button class="icon-button compact" title="Bold (Ctrl/⌘ B)" aria-label="Bold" @mousedown.prevent @click="editor?.format('**')"><Bold :size="14" /></button><button class="icon-button compact" title="Italic (Ctrl/⌘ I)" aria-label="Italic" @mousedown.prevent @click="editor?.format('*')"><Italic :size="14" /></button><button class="icon-button compact" title="Underline (Ctrl/⌘ U)" aria-label="Underline" @mousedown.prevent @click="editor?.format('_')"><Underline :size="14" /></button><button class="icon-button compact" title="Link image to selection (Ctrl/⌘ Shift K)" aria-label="Link image to selection" @mousedown.prevent @click="linkImage"><ImagePlus :size="15" /></button></div>
          <div class="button-row"><button :class="['text-button editing-mode', { suggesting: reviewMode }]" :aria-pressed="reviewMode" :title="reviewMode ? 'Switch to direct editing' : 'Suggest changes instead of editing directly'" @click="reviewMode = !reviewMode"><Pencil :size="13" />{{ reviewMode ? 'Suggesting' : 'Editing' }}<ChevronDown :size="10" /></button><button class="icon-button compact" aria-label="Add comment" title="Add comment (Ctrl/⌘ Alt M)" @click="addComment"><MessageSquare :size="15" /></button></div>
        </div>
        <div v-if="!synced" class="editor-connecting"><LoaderCircle :size="20" class="spin" /><p>Connecting to document…</p><button v-if="error" class="text-button" @click="initialize">Reconnect</button></div>
        <div v-else class="editing-area">
          <div class="source-pane"><div v-if="mode === 'split'" class="pane-heading">SOURCE</div><div class="editor-with-review"><TextEditor ref="editor" :key="currentId" :ytext="connection.text" :awareness="connection.provider.awareness" :user="session.user" :mode="mode" :review="reviewMode" @selection="onSelection" @cursor="cursor = $event" @geometry="geometry = $event" @display="displaySource = $event" @error="notify" @decide="decideSuggestion" @link-image="linkImage" @open-comment="lineComments?.reveal($event)" @scroll="syncScroll('source', $event)" /><InlineComments ref="lineComments" :key="currentId + '-comments'" :doc="connection.doc" :revision="revision" :geometry="geometry" :selection="selection" :user="session.user" @jump="goTo" @jump-annotation="editor?.goToAnnotation($event)" /></div></div>
          <div v-if="mode === 'split'" class="preview-pane"><div class="pane-heading preview-heading"><span>PREVIEW</span><button :class="['icon-button', 'compact', 'scroll-sync-toggle', { active: scrollSync }]" :aria-pressed="scrollSync" aria-label="Synchronized scrolling" title="Toggle synchronized scrolling" @click="scrollSync = !scrollSync"><Link :size="12" /></button></div><ScreenplayPreview ref="preview" :blocks="displayBlocks" @scroll="syncScroll('preview', $event)" /></div>
        </div>
      </main>
    </div>
    <footer class="statusbar">
      <span :class="['connection-status', { offline: status !== 'connected' }]"><i />{{ status === 'connected' ? 'Live' : 'Reconnecting…' }}</span>
      <span class="status-separator">·</span><span>{{ peers.length + 1 }} {{ peers.length ? 'collaborators' : 'writer' }}</span>
      <span class="status-spacer" /><span class="status-hint">{{ dirtyOffline ? 'Unsynced edits · keep this tab open' : mode === 'live' ? 'Click a line to reveal its Fountain source' : 'Plain text, live preview' }}</span>
      <span class="status-spacer" /><span>{{ words.toLocaleString() }} words</span><span class="status-separator">·</span><span>Ln {{ cursor.line }}, Col {{ cursor.column }}</span>
    </footer>
    <input ref="importInput" type="file" accept=".fountain,.txt,text/plain" hidden @change="importFile" />
  </div>
  <div v-if="error && session?.user" class="toast" role="status"><span>{{ error }}</span><button class="icon-button compact" aria-label="Dismiss notification" @click="error = ''"><X :size="14" /></button></div>
  <Teleport to="body">
    <div v-if="profileOpen" class="modal-backdrop" @click.self="profileOpen = false">
      <form class="modal writer-profile-modal" role="dialog" aria-modal="true" aria-labelledby="writer-profile-title" @submit.prevent="saveName">
        <header><h2 id="writer-profile-title">Your writer name</h2><button type="button" class="icon-button" aria-label="Close writer profile" @click="profileOpen = false"><X :size="18" /></button></header>
        <p class="small muted">Shown to collaborators and on your new comments and suggestions. No account required.</p>
        <label class="field-label" for="writer-name">Display name<input id="writer-name" v-model="writerName" maxlength="60" autocomplete="nickname" required /></label>
        <button class="primary-button" :disabled="savingName || !writerName.trim()">Save name</button>
      </form>
    </div>
    <div v-if="helpOpen" class="modal-backdrop" @click.self="helpOpen = false">
      <section class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header><h2 id="help-title">A little Fountain reference</h2><button class="icon-button" aria-label="Close reference" @click="helpOpen = false"><X :size="18" /></button></header>
        <p class="muted">Write a screenplay as plain text. The formatting follows.</p>
        <dl class="syntax-reference"><dt>Scene</dt><dd><code>INT. APARTMENT - NIGHT</code></dd><dt>Character & dialogue</dt><dd><pre>MARA
You kept the light on.
(a beat)
I wasn't sure you would.</pre></dd><dt>Force an element</dt><dd><code>.A SCENE</code> · <code>@McCLANE</code> · <code>!Action</code></dd><dt>Emphasis</dt><dd><code>*italic* **bold** _underline_</code></dd><dt>Transition / center</dt><dd><code>&gt; FADE OUT.</code> · <code>&gt; THE END &lt;</code></dd><dt>Simultaneous dialogue</dt><dd>Add <code>^</code> after the second character's name.</dd><dt>Outline / hidden notes</dt><dd><code># Act I</code> · <code>= Synopsis</code><br /><code>[[Note]]</code> · <code>/* Hidden text */</code></dd><dt>Page break</dt><dd><code>===</code></dd></dl>
        <p class="small muted">Live mode reveals the line you're editing. Dialogue and multiline blocks stay in source form until the cursor moves two lines below. Tab completes character/location names. Ctrl/⌘ B: bold · I: italic · U: underline · Shift K: image link · F: search · Alt M: comment. Selecting text and typing *, _ or [ surrounds it.</p>
        <a class="text-button" href="https://fountain.io/syntax/" target="_blank" rel="noopener">Full Fountain syntax ↗</a>
      </section>
    </div>
  </Teleport>
  <ImageLinkDialog v-if="imageLinkOpen && connection" :doc="connection.doc" :document-id="currentId" :selection="selection" :user="session.user" @close="imageLinkOpen = false" @error="notify" />
</template>
