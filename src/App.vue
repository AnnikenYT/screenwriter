<script setup>
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick, markRaw, watch } from 'vue'
import { PanelLeftClose, PanelLeftOpen, List, UsersRound, MapPin, ChartNoAxesColumn, MessageSquare, NotebookPen, History, FileText, Plus, Upload, Download, ChevronDown, Columns2, AlignLeft, Pencil, Check, X, Undo2, Redo2, CircleHelp, Link, LogOut, LoaderCircle, Bold, Italic, Underline, ImagePlus, Palette, Keyboard, CircleArrowDown, RefreshCw } from 'lucide-vue-next'
import AppearanceDialog from './components/AppearanceDialog.vue'
import TextEditor from './components/TextEditor.vue'
import ScreenplayPreview from './components/ScreenplayPreview.vue'
import SheetPanel from './components/SheetPanel.vue'
import StatsPanel from './components/StatsPanel.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import VersionPanel from './components/VersionPanel.vue'
import InlineComments from './components/InlineComments.vue'
import ImageLinkDialog from './components/ImageLinkDialog.vue'
import MobileNamePicker from './components/MobileNamePicker.vue'
import DocumentManager from './components/DocumentManager.vue'
import ShareDialog from './components/ShareDialog.vue'
import { connect } from './lib/collaboration.js'
import { api, download } from './lib/api.js'
import { parseFountain } from '../shared/fountain.js'
import { outlineEntries, sortOutline } from './lib/outline.js'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMobileLayout } from './lib/mobile.js'
import { usePwa } from './lib/pwa.js'
import { flushCollaboration } from './lib/sync-barrier.js'
import { TITLE_PAGE_ALIGNMENTS, titlePageAlignment } from '../shared/preferences.js'
import { defaultEditorColor, editorColorInk, isEditorColor } from '../shared/editor-colors.js'
import { Settings } from 'lucide-vue-next'

const session = ref(null)
const alignmentStorageKey = 'screenwriter-title-page-alignment'
const localAlignment = ref(titlePageAlignment(localStorage.getItem(alignmentStorageKey)))
const alignment = computed(() => session.value?.user?.account
  ? titlePageAlignment(session.value.preferences?.titlePageAlignment) : localAlignment.value)
const settingsDialog = ref(null)
const draftAlignment = ref(alignment.value)
const savingPreferences = ref(false)
const settingsError = ref('')
const { mobile, keyboardOpen } = useMobileLayout()
const { installed, updateAvailable, register: registerPwa, install: installPwa, applyUpdate: applyPwaUpdate } = usePwa()
const mobilePane = ref('write')
const namePicker = ref(null)
const installHelpOpen = ref(false)
const updateHelpOpen = ref(false)
const appUpdating = ref(false)
const appearance = ref(null)
const loading = ref(true)
const error = ref('')
const documents = ref([])
const documentAccess = ref({ canEdit: false, canReview: false, canExport: false, owner: false })
const shareOpen = ref(false)
const shareToken = ref(location.pathname === '/share' ? location.hash.slice(1) : '')
const sharePassword = ref('')
const shareNeedsPassword = ref(false)
const openingShare = ref(false)
const workspaceFilter = ref('mine')
const canCreate = computed(() => session.value?.authMode === 'none' || Boolean(session.value?.user?.account))
const canEdit = computed(() => documentAccess.value.canEdit)
const canReview = computed(() => documentAccess.value.canReview)
const canExport = computed(() => documentAccess.value.canExport)
const visibleDocuments = computed(() => session.value?.authMode !== 'oauth' ? documents.value
  : documents.value.filter(doc => workspaceFilter.value === 'mine' ? doc.access.owner : !doc.access.owner))
const managerOpen = ref(false)
const roomUnavailable = ref(false)
const currentId = ref('')
const pdfURL = computed(() => `/api/documents/${currentId.value}/export.pdf`
  + (session.value?.user?.account ? '' : `?titlePageAlignment=${alignment.value}`))
const connection = shallowRef(null)
const revision = ref(0)
const source = ref('')
const blocks = shallowRef([])
const synced = ref(false)
const status = ref('connecting')
const peers = ref([])
const presencePeople = computed(() => {
  const people = new Map()
  for (const peer of peers.value) {
    const key = peer.id || `${peer.name}\0${peer.color}`
    if (!people.has(key)) people.set(key, { key, name: peer.name || 'Writer', color: peer.color || '#597d67', self: false })
  }
  return [{ key: 'self', name: session.value?.user?.name || 'You', color: session.value?.user?.color || '#597d67', self: true }, ...people.values()]
})
const presenceNames = computed(() => presencePeople.value.map(person => `${person.name}${person.self ? ' (you)' : ''}`).join(', '))
const sidebar = ref(window.innerWidth > 900)
const panel = ref('outline')
const sceneSort = ref('script')
const characterSort = ref('name')
const mode = ref(localStorage.getItem('editor-mode') || 'live')
const reviewMode = ref(false)
const selection = ref({ from: 0, to: 0, text: '' })
const cursor = ref({ line: 1, column: 1 })
const editor = ref(null)
const preview = ref(null)
const scrollSync = ref(true)
let scrollOrigin = null, scrollGeneration = 0
let sourceScrollPosition = { from: 0, ratio: 0 }
const review = ref(null)
const lineComments = ref(null)
const geometry = ref(null)
const displaySource = ref('')
const displayBlocks = computed(() => parseFountain(displaySource.value))
const profileOpen = ref(false)
const writerName = ref('')
const editorColor = ref('#2563eb')
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
let timer, errorTimer, pendingFlushTimer
let generation = 0
let documentUpdate
const tabs = [
  { id: 'outline', label: 'Outline', icon: List },
  { id: 'characters', label: 'Characters', icon: UsersRound },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'stats', label: 'Stats', icon: ChartNoAxesColumn },
  { id: 'review', label: 'Review', icon: MessageSquare },
  { id: 'scratchpad', label: 'Scratchpad', icon: NotebookPen },
  { id: 'versions', label: 'Versions', icon: History },
]
const panelTitle = computed(() => tabs.find(t => t.id === panel.value)?.label)
const outline = computed(() => sortOutline(outlineEntries(blocks.value), sceneSort.value))
const words = computed(() => source.value.trim() ? source.value.trim().split(/\s+/).length : 0)
const activeComments = computed(() => { void revision.value; return connection.value ? [...connection.value.doc.getMap('comments').values()].filter(c => !c.parentId && !c.resolved).length + [...connection.value.doc.getMap('suggestions').values()].filter(s => s.status === 'pending').length : 0 })
const scratchHtml = computed(() => { void revision.value; return DOMPurify.sanitize(marked.parse(connection.value?.scratchpad.toString() || '')) })
const estimate = computed(() => Math.max(1, Math.ceil(blocks.value.filter(b => !['title', 'note', 'boneyard', 'section', 'synopsis'].includes(b.type)).reduce((n, b) => n + Math.max(1, b.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (['dialogue', 'parenthetical'].includes(b.type) ? 35 : 60))), 0)), 0) / 55)))
function notify(message) { error.value = message; clearTimeout(errorTimer); errorTimer = setTimeout(() => error.value = '', 9000) }
function openSettings() {
  draftAlignment.value = alignment.value
  settingsError.value = ''
  settingsDialog.value.showModal()
}
async function saveSettings() {
  savingPreferences.value = true
  settingsError.value = ''
  try {
    const titlePageAlignment = draftAlignment.value
    if (session.value.user.account) {
      session.value.preferences = await api('/api/preferences', { method: 'PATCH', body: { titlePageAlignment } })
    } else {
      localStorage.setItem(alignmentStorageKey, titlePageAlignment)
      localAlignment.value = titlePageAlignment
    }
    settingsDialog.value.close()
  } catch (e) { settingsError.value = e.message }
  finally { savingPreferences.value = false }
}
function signInURL() { const id = new URL(location.href).searchParams.get('document'); return `/auth/login?returnTo=${encodeURIComponent(id ? '/?document=' + id : '/')}` }
async function refreshDocuments() { documents.value = await api('/api/documents') }
async function initialize() {
  loading.value = true
  try {
    session.value = await api('/api/session')
    if (shareToken.value) { await openSharedLink(); return }
    if (!session.value.user) return
    writerName.value = session.value.user.nameSet ? session.value.user.name : ''
    editorColor.value = session.value.user.color || defaultEditorColor(session.value.user.id)
    await refreshDocuments()
    const requested = new URL(location.href).searchParams.get('document')
    if (requested && await openDocument(requested)) return
    const id = documents.value[0]?.id
    if (id) await openDocument(id)
    else if (canCreate.value) await createDocument('Untitled screenplay', '')
  } catch (e) { notify(e.message) }
  finally { loading.value = false }
}
async function openSharedLink() {
  openingShare.value = true
  try {
    const result = await api('/api/shares/open', { method: 'POST', body: { token: shareToken.value, password: sharePassword.value } })
    shareToken.value = ''; sharePassword.value = ''
    history.replaceState({}, '', `/?document=${result.documentId}`)
    await initialize()
  } catch (error) {
    if (error.status === 401 && !shareNeedsPassword.value) shareNeedsPassword.value = true
    else notify(error.message)
  }
  finally { openingShare.value = false }
}
function cleanup() {
  clearTimeout(timer)
  clearTimeout(pendingFlushTimer)
  if (connection.value) {
    connection.value.doc.off('update', documentUpdate)
    connection.value.provider.destroy()
    connection.value.doc.destroy()
    connection.value = null
  }
}
async function openDocument(id) {
  if (id === currentId.value && connection.value && !roomUnavailable.value) { filesOpen.value = false; return true }
  if (!navigator.onLine) { notify('Reconnect before switching documents. Your current writing is still in this tab.'); return }
  if (dirtyOffline.value) { notify('Reconnect before switching documents, or download your Fountain file to preserve unsynced changes.'); return }
  let record
  try {
    record = await api(`/api/documents/${id}`)
    if (record.archivedAt) return notify('This screenplay is archived. Restore it from Manage screenplays.')
  } catch (error) { return notify(error.message) }
  generation++
  cleanup()
  currentId.value = id
  documentAccess.value = record.access
  workspaceFilter.value = record.access.owner ? 'mine' : 'shared'
  if (!record.access.canEdit) reviewMode.value = record.access.canReview
  synced.value = false
  roomUnavailable.value = false
  status.value = 'connecting'
  source.value = ''; displaySource.value = ''; blocks.value = []; peers.value = []; geometry.value = null; namePicker.value = null
  const current = connect(id, session.value.user, record.access)
  connection.value = markRaw(current)
  const token = generation
  let localVersion = 0, confirming = false
  const refresh = () => {
    if (token !== generation) return
    source.value = current.text.toString()
    blocks.value = parseFountain(source.value)
    titleInput.value = current.doc.getMap('meta').get('title') || 'Untitled screenplay'
  }
  const confirmPending = async () => {
    if (token !== generation || confirming || !dirtyOffline.value || status.value !== 'connected' || !current.provider.synced) return
    confirming = true
    const version = localVersion
    try {
      await flushCollaboration(current.provider, current.doc)
      if (token === generation && version === localVersion) dirtyOffline.value = false
    } catch { /* Keep the unsynced warning until the connection can confirm it. */ }
    finally {
      confirming = false
      if (token === generation && dirtyOffline.value && status.value === 'connected') pendingFlushTimer = setTimeout(confirmPending, 250)
    }
  }
  documentUpdate = (_update, origin) => {
    revision.value++
    if (origin !== current.provider) {
      localVersion++
      if (status.value !== 'connected') dirtyOffline.value = true
      if (dirtyOffline.value) { clearTimeout(pendingFlushTimer); pendingFlushTimer = setTimeout(confirmPending, 100) }
    }
    // Coalesce keystrokes; the editor itself updates synchronously.
    clearTimeout(timer)
    timer = setTimeout(refresh, 80)
  }
  current.doc.on('update', documentUpdate)
  current.provider.on('sync', value => {
    if (!value) return
    synced.value = true
    refresh()
    confirmPending()
  })
  current.provider.on('status', event => {
    if (token !== generation) return
    status.value = event.status
  })
  current.provider.on('connection-error', () => { if (!synced.value) error.value = 'Unable to connect. Check the server or sign in again.' })
  current.provider.on('connection-close', event => {
    if (token !== generation) return
    const unavailable = message => {
      if (token !== generation) return
      roomUnavailable.value = true
      namePicker.value = null
      imageLinkOpen.value = false
      current.provider.disconnect()
      notify(`${message}. You can download this tab’s draft or choose another screenplay.`)
      refreshDocuments().catch(error => notify(error.message))
    }
    if (event?.code === 4004 || event?.code === 4003) unavailable(event.reason)
    else if (navigator.onLine) api(`/api/documents/${id}`).then(record => { if (record.archivedAt) unavailable('Screenplay archived') }).catch(error => { if (error.status === 404) unavailable('Screenplay deleted') })
  })
  const updatePeers = () => { peers.value = [...current.provider.awareness.getStates()].filter(([client]) => client !== current.doc.clientID).map(([, state]) => state.user).filter(Boolean) }
  current.provider.awareness.on('change', updatePeers)
  const url = new URL(location.href)
  url.searchParams.set('document', id)
  history.replaceState({}, '', url)
  filesOpen.value = false
  selection.value = { from: 0, to: 0, text: '' }
  return true
}
async function createDocument(title = 'Untitled screenplay', text = '') {
  if (!canCreate.value) return
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
  if (roomUnavailable.value || !canEdit.value) return
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
async function addComment() { if (!canReview.value || roomUnavailable.value) return; await nextTick(); lineComments.value?.open() }
async function decideSuggestion(suggestion, decision) {
  try { await api(`/api/documents/${currentId.value}/suggestions/${suggestion.id}/decide`, { method: 'POST', body: { decision } }) }
  catch (error) { notify(error.message) }
}
function editProfile() {
  writerName.value = session.value.user.nameSet ? session.value.user.name : ''
  editorColor.value = session.value.user.color || defaultEditorColor(session.value.user.id)
  profileOpen.value = true
  nextTick(() => document.getElementById(session.value.user.account ? 'editor-color' : 'writer-name')?.focus())
}
function applyProfile(user) {
  if (!user || !session.value?.user || user.id !== session.value.user.id) return
  session.value.user = user
  if (!isEditorColor(editorColor.value)) editorColor.value = user.color
  connection.value?.provider.awareness.setLocalStateField('user', { id: user.id, name: user.name, color: user.color, colorLight: `${user.color}25` })
}
async function saveName() {
  savingName.value = true
  try {
    const color = isEditorColor(editorColor.value) ? editorColor.value.toLowerCase() : session.value.user.color
    const body = { color }
    if (!session.value.user.account) body.name = writerName.value
    const updated = await api('/api/session', { method: 'PATCH', body })
    applyProfile(updated.user)
    profileChannel?.postMessage(updated.user)
    profileOpen.value = false
  } catch (error) { notify(error.message) }
  finally { savingName.value = false }
}
function linkImage() {
  if (!canEdit.value || roomUnavailable.value) return
  if (!selection.value.text) { notify('Select a passage first, then link an image.'); return }
  imageLinkOpen.value = true
}
function closeTools() {
  sidebar.value = false
  if (mobile.value && mobilePane.value === 'write') nextTick(() => editor.value?.focus())
}
function toggleTools() {
  if (sidebar.value) { closeTools(); return }
  sidebar.value = true
  nextTick(() => document.querySelector('.mobile-tools-heading button')?.focus())
}
function switchMobilePane(pane) {
  sidebar.value = false
  mobilePane.value = pane
  if (pane === 'preview') { editor.value?.blur(); nextTick(() => preview.value?.scrollToPosition(sourceScrollPosition)) }
  else nextTick(() => { editor.value?.focus(); editor.value?.revealSelection() })
}
function hideKeyboard() { document.activeElement?.blur(); editor.value?.blur() }
function chooseName(name, kind) { editor.value?.insertName(name, kind); namePicker.value = null }
function completeName() {
  if (!editor.value?.completeName()) namePicker.value = 'characters'
}
async function downloadDraft() {
  if (!canExport.value) return
  try {
    if (session.value.authMode === 'oauth' && !(await api(`/api/documents/${currentId.value}`)).access.canExport) return
    download(displaySource.value || connection.value.text.toString(), `${titleInput.value || 'screenplay'}.draft.fountain`)
  } catch (error) { notify(error.message) }
}
async function installApp() {
  try {
    const result = await installPwa()
    if (!result.prompted) installHelpOpen.value = true
  } catch { installHelpOpen.value = true }
}
async function updateApp() {
  if (dirtyOffline.value || (connection.value && status.value !== 'connected')) { notify('Reconnect before updating. Keep this tab open until your edits sync.'); return }
  appUpdating.value = true
  document.activeElement?.blur()
  try {
    await nextTick()
    if (connection.value) await flushCollaboration(connection.value.provider, connection.value.doc)
    await applyPwaUpdate()
  } catch (error) { notify(error.message || 'The app could not update. This tab was kept open.'); appUpdating.value = false }
}
function resume() { if (!roomUnavailable.value && document.visibilityState === 'visible' && navigator.onLine) connection.value?.provider.connect() }
function networkOffline() { connection.value?.provider.disconnect() }
function networkOnline() { if (!roomUnavailable.value) connection.value?.provider.connect() }
async function documentChanged(id, action) {
  await refreshDocuments()
  if (id === currentId.value && action !== 'restore') {
    roomUnavailable.value = true
    connection.value?.provider.disconnect()
  }
}
async function manageOpen(id) {
  if (roomUnavailable.value && dirtyOffline.value) {
    if (!window.confirm('Leave this stopped room? Download your draft first if you need to keep unsynced writing.')) return
    dirtyOffline.value = false
  }
  await openDocument(id)
  managerOpen.value = false
}
async function beforeDocumentChange(id, action) {
  if (id !== currentId.value || !connection.value || roomUnavailable.value || action === 'restore') return
  if (dirtyOffline.value) throw new Error('Reconnect and save your edits before archiving or deleting.')
  await flushCollaboration(connection.value.provider, connection.value.doc)
}
function syncScroll(origin, position) {
  if (origin === 'source') sourceScrollPosition = position
  if (mobile.value) return
  if (!scrollSync.value || mode.value !== 'split' || (scrollOrigin && scrollOrigin !== origin)) return
  scrollOrigin = origin
  const generation = ++scrollGeneration
  if (origin === 'source') preview.value?.scrollToPosition(position)
  else editor.value?.scrollToPosition(position)
  requestAnimationFrame(() => requestAnimationFrame(() => { if (generation === scrollGeneration) scrollOrigin = null }))
}
function goTo(from, to) { editor.value?.goTo(from, to); if (window.innerWidth < 700) sidebar.value = false }
async function share() {
  if (session.value.authMode === 'oauth') { shareOpen.value = true; return }
  try { await navigator.clipboard.writeText(location.href); notify('Document link copied. Anyone with workspace access can collaborate.') }
  catch { notify('Copy the document URL from your browser to invite a collaborator.') }
}
async function exportFountain() {
  if (!canExport.value) return
  try {
    let text = connection.value.text.toString()
    if (session.value.authMode === 'oauth') {
      const response = await fetch(`/api/documents/${currentId.value}/export.fountain`)
      if (!response.ok) throw new Error('Export not permitted')
      text = await response.text()
    }
    download(text, `${titleInput.value || 'screenplay'}.fountain`)
    exportOpen.value = false
  } catch (error) { notify(error.message) }
}
function workspaceError(event) { notify(event.detail) }
function closeMenus(event) { if (!event.target.closest('.dropdown-anchor')) { filesOpen.value = false; exportOpen.value = false } }
function beforeUnload(event) { if (dirtyOffline.value) { event.preventDefault(); event.returnValue = '' } }
function hotkeys(event) {
  if (appearance.value?.isOpen()) return
  if (event.key === 'Escape') { helpOpen.value = false; filesOpen.value = false; exportOpen.value = false; profileOpen.value = false; imageLinkOpen.value = false; namePicker.value = null; installHelpOpen.value = false; updateHelpOpen.value = false; if (mobile.value && sidebar.value) closeTools() }
  if (event.key === 'Tab' && mobile.value && sidebar.value && !profileOpen.value && !imageLinkOpen.value && !helpOpen.value && !installHelpOpen.value && !updateHelpOpen.value) {
    const tools = document.querySelector('.mobile-tools-open')
    const controls = tools && [...tools.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length)
    if (controls?.length && (!tools.contains(document.activeElement) || (event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1)))) {
      event.preventDefault()
      const target = event.shiftKey ? controls.at(-1) : controls[0]
      target.focus()
    }
  }
}
watch(mobile, small => { if (small) sidebar.value = false })
watch([mobile, sidebar], ([small, open]) => { document.documentElement.dataset.toolsOpen = String(small && open) }, { immediate: true })
watch(keyboardOpen, () => nextTick(() => { if (!sidebar.value && mobilePane.value === 'write') editor.value?.revealSelection() }))
onMounted(() => {
  initialize()
  registerPwa()
  if ('BroadcastChannel' in window) { profileChannel = new BroadcastChannel('screenwriter-profile'); profileChannel.onmessage = event => applyProfile(event.data) }
  document.addEventListener('click', closeMenus); window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', hotkeys)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('offline', networkOffline)
  window.addEventListener('online', networkOnline)
  window.addEventListener('workspace-error', workspaceError)
})
onBeforeUnmount(() => { cleanup(); profileChannel?.close(); clearTimeout(errorTimer); document.removeEventListener('click', closeMenus); document.removeEventListener('visibilitychange', resume); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', hotkeys); window.removeEventListener('offline', networkOffline); window.removeEventListener('online', networkOnline); window.removeEventListener('workspace-error', workspaceError) })
</script>

<template>
  <div v-if="loading" class="loading-screen">
    <LoaderCircle class="spin" :size="22" />
    <p>Opening workspace…</p>
  </div>
  <form v-else-if="shareToken" class="login-screen" aria-label="Open shared screenplay"
    @submit.prevent="openSharedLink">
    <h1>Shared screenplay</h1>
    <label v-if="shareNeedsPassword" class="field-label">Password<input v-model="sharePassword" type="password"
        autocomplete="current-password" required /></label>
    <button class="primary-button" :disabled="openingShare">Open screenplay</button>
    <p v-if="error" class="error-text">{{ error }}</p>
  </form>
  <div v-else-if="!session?.user" class="login-screen">
    <FileText :size="28" :stroke-width="1" />
    <h1>Screenwriter</h1>
    <p>Sign in to open your workspace.</p>
    <a class="primary-button" :href="signInURL()">Sign in</a>
    <p v-if="error" class="error-text">{{ error }}</p>
    <button v-if="!session" class="text-button" @click="initialize">Try again</button>
  </div>
  <div v-else
    :class="['workspace', { 'is-mobile': mobile, 'keyboard-open': keyboardOpen, 'mobile-preview': mobile && mobilePane === 'preview', 'mobile-writing': mobile && mobilePane === 'write' }]"
    :style="{ '--title-page-alignment': alignment }"
    :inert="appUpdating">
    <header class="topbar">
      <div class="document-controls">
        <div class="dropdown-anchor">
          <button class="icon-button document-menu-button" aria-label="Open documents" :aria-expanded="filesOpen"
            @click="filesOpen = !filesOpen">
            <FileText :size="19" />
            <ChevronDown :size="11" />
          </button>
          <div v-if="filesOpen" class="dropdown document-dropdown">
            <div v-if="session.authMode === 'oauth'" class="segmented"><button
                :class="{ active: workspaceFilter === 'mine' }" @click="workspaceFilter = 'mine'">My
                screenplays</button><button :class="{ active: workspaceFilter === 'shared' }"
                @click="workspaceFilter = 'shared'">Shared with me</button></div>
            <div v-else class="dropdown-label">DOCUMENTS</div>
            <button v-for="doc in visibleDocuments" :key="doc.id" :class="{ selected: doc.id === currentId }"
              @click="openDocument(doc.id)">
              <FileText :size="15" /><span>{{ doc.id === currentId ? titleInput : doc.title }}</span>
              <Check v-if="doc.id === currentId" :size="14" />
            </button>
            <div class="menu-divider" /><button @click="managerOpen = true; filesOpen = false">Manage
              screenplays</button><button v-if="canCreate" @click="createDocument()">
              <Plus :size="15" />New screenplay
            </button><button v-if="canCreate" @click="importInput.click()">
              <Upload :size="15" />Import Fountain
            </button>
          </div>
        </div>
        <input v-model="titleInput" class="document-title" aria-label="Document title" maxlength="200"
          :disabled="!synced || roomUnavailable || !canEdit" @change="renameTitle"
          @keydown.enter="$event.target.blur()" />
      </div>
      <div v-if="!mobile" class="toolbar-center">
        <div class="segmented mode-switch" aria-label="Editor mode"><button :class="{ active: mode === 'live' }"
            title="Live formatted editor" @click="setMode('live')">
            <AlignLeft :size="14" /><span>Live</span>
          </button><button :class="{ active: mode === 'split' }" title="Raw Fountain and rendered preview"
            @click="setMode('split')">
            <Columns2 :size="14" /><span>Split</span>
          </button></div>
      </div>
      <div class="toolbar-actions">
        <a v-if="session.user.guest" class="text-button" :href="signInURL()">Sign in</a>
        <div class="collaborators" :title="presenceNames" :aria-label="`Collaborators: ${presenceNames}`"><button
            class="avatar" :style="{ background: session.user.color, color: editorColorInk(session.user.color) }"
            :aria-label="session.user.account ? 'Set editor color' : 'Set writer name'"
            :title="`${session.user.name} · ${session.user.account ? 'Set your color' : 'Set your name'}`"
            @click="editProfile">{{ session.user.name.slice(0, 1) }}</button><span
            v-for="(peer, i) in peers.slice(0, 3)" :key="i" class="avatar" :title="peer.name"
            :aria-label="peer.name" :style="{ background: peer.color, color: editorColorInk(peer.color) }">{{
              peer.name.slice(0, 1) }}</span><span v-if="peers.length > 3" class="avatar extra">+{{ peers.length - 3
            }}</span></div>
        <button class="icon-button share-button" :disabled="!synced"
          :title="session.authMode === 'oauth' ? 'Share screenplay' : 'Copy collaboration link'"
          :aria-label="session.authMode === 'oauth' ? 'Share screenplay' : 'Copy collaboration link'" @click="share">
          <Link :size="16" />
        </button>
        <div v-if="canExport" class="dropdown-anchor">
          <button class="text-button export-button" :disabled="!synced" :aria-expanded="exportOpen"
            @click="exportOpen = !exportOpen">
            <Download :size="15" /><span>Export</span>
            <ChevronDown :size="11" />
          </button>
          <div v-if="exportOpen" class="dropdown export-dropdown"><button @click="exportFountain">
              <FileText :size="15" />Fountain (.fountain)
            </button><a :href="pdfURL" target="_blank" rel="noopener"
              @click="exportOpen = false">
              <Download :size="15" />Screenplay PDF
            </a></div>
        </div>
      </div>
    </header>

    <form v-if="(session.authMode === 'none' || session.user.guest) && !session.user.nameSet && !profileOpen" class="writer-name-nag"
      aria-label="Set your writer name" @submit.prevent="saveName">
      <label for="quick-writer-name">Who’s writing? <span>Add your name for collaborators.</span></label>
      <input id="quick-writer-name" v-model="writerName" aria-label="Your writer name" placeholder="Your name"
        maxlength="60" autocomplete="nickname" required />
      <button class="text-button" :disabled="savingName || !writerName.trim()">Save name</button>
    </form>
    <nav v-if="mobile" class="mobile-view-tabs" aria-label="Mobile workspace">
      <button :class="{ active: mobilePane === 'write' && !sidebar }" :aria-pressed="mobilePane === 'write' && !sidebar"
        aria-label="Write" :title="reviewMode ? 'Suggesting edits' : 'Write screenplay'"
        @click="switchMobilePane('write')">
        <Pencil :size="16" />{{ reviewMode ? 'Suggesting' : 'Write' }}
      </button>
      <button :class="{ active: mobilePane === 'preview' && !sidebar }"
        :aria-pressed="mobilePane === 'preview' && !sidebar" @click="switchMobilePane('preview')">
        <FileText :size="16" />Preview
      </button>
      <button :class="{ active: sidebar }" :aria-expanded="sidebar" aria-label="Open tools" @click="toggleTools">
        <PanelLeftOpen :size="17" />Tools<span v-if="activeComments" class="mobile-review-count">{{ activeComments
          }}</span>
      </button>
      <button v-if="keyboardOpen" class="mobile-hide-keyboard" aria-label="Hide keyboard" @click="hideKeyboard">
        <Keyboard :size="19" />
      </button>
    </nav>
    <div v-if="mobile && synced && (status !== 'connected' || dirtyOffline)" class="mobile-offline-notice"
      role="status"><span>{{ status === 'connected' ? 'Syncing edits · keep this tab open.' : 'Reconnecting · keep this tab open. Unsent edits aren’t stored offline.' }}</span><button v-if="canExport" @click="downloadDraft">Download
        draft</button></div>
    <div v-if="roomUnavailable" class="room-unavailable" role="status"><span>Editing stopped. Access or document status
        changed.</span><button v-if="canExport" class="text-button" @click="downloadDraft">Download
        draft</button><button class="text-button" @click="managerOpen = true">Manage screenplays</button></div>
    <div class="workspace-body" :inert="roomUnavailable">
      <div v-if="mobile && sidebar" class="mobile-tools-scrim" @click="closeTools" />
      <div :class="['workspace-tools', { 'mobile-tools-open': mobile && sidebar }]"
        :role="mobile && sidebar ? 'dialog' : undefined" :aria-modal="mobile && sidebar ? 'true' : undefined"
        :aria-label="mobile && sidebar ? 'Workspace tools' : undefined">
        <header v-if="mobile && sidebar" class="mobile-tools-heading">
          <h2>Tools</h2><button class="icon-button" aria-label="Close tools" @click="closeTools">
            <X :size="20" />
          </button>
        </header>
        <aside class="tool-rail" aria-label="Workspace tools">
          <button v-if="!mobile" class="rail-button sidebar-toggle"
            :aria-label="sidebar ? 'Hide sidebar' : 'Show sidebar'" @click="sidebar = !sidebar">
            <PanelLeftClose v-if="sidebar" :size="19" />
            <PanelLeftOpen v-else :size="19" />
          </button>
          <button v-for="tab in tabs" :key="tab.id" :class="['rail-button', { active: sidebar && panel === tab.id }]"
            :title="tab.label" :aria-label="tab.label" :aria-pressed="sidebar && panel === tab.id"
            @click="!mobile && sidebar && panel === tab.id ? sidebar = false : selectPanel(tab.id)">
            <component :is="tab.icon" :size="19" :stroke-width="1.6" /><span v-if="mobile" class="mobile-tool-label">{{
              tab.label }}</span><span v-if="tab.id === 'review' && activeComments" class="rail-dot" />
          </button>
          <div class="rail-spacer" />
          <button v-if="!mobile" class="rail-button" title="Settings" aria-label="Settings"
            :disabled="savingPreferences" @click="openSettings"><Settings :size="18" /></button>
          <button v-if="!mobile" class="rail-button" aria-label="Appearance" title="Appearance" @click="appearance.open()">
            <Palette :size="18" />
          </button>
          <button v-if="!mobile" class="rail-button" title="Fountain reference" aria-label="Fountain reference"
            @click="helpOpen = true">
            <CircleHelp :size="18" />
          </button>
          <button v-if="!mobile && !installed" class="rail-button" title="Install app" aria-label="Install app"
            @click="installApp">
            <CircleArrowDown :size="18" />
          </button>
          <button v-if="!mobile && updateAvailable" class="rail-button update-available" title="Update app"
            aria-label="Update app" @click="updateHelpOpen = true">
            <RefreshCw :size="18" />
          </button>
          <a v-if="session.authMode === 'oauth'" class="rail-button" href="/auth/logout" aria-label="Sign out"
            title="Sign out">
            <LogOut :size="18" />
          </a>
        </aside>
        <aside v-if="sidebar && connection && synced" class="sidebar"
          :class="{ 'scratchpad-sidebar': panel === 'scratchpad' }">
          <div class="sidebar-heading">
            <h2>{{ panelTitle }}</h2><span v-if="panel === 'outline'" class="count">{{blocks.filter(b => b.type ===
              'scene').length }} scenes</span><button v-else-if="!mobile" class="icon-button compact"
              aria-label="Close sidebar" @click="sidebar = false">
              <X :size="14" />
            </button>
          </div>
          <div v-if="panel === 'outline'" class="outline panel-body">
            <div class="outline-summary"><span>{{ words.toLocaleString() }} words</span><span>~{{ estimate }} {{
              estimate === 1 ? 'page' : 'pages' }}</span></div>
            <label class="panel-sort outline-sort">Sort scenes
              <select v-model="sceneSort">
                <option value="script">Script order</option>
                <option value="reverse">Reverse script order</option>
                <option value="heading">Heading (A–Z)</option>
                <option value="heading-desc">Heading (Z–A)</option>
              </select>
            </label>
            <p v-if="sceneSort !== 'script' && outline.length" class="field-hint outline-sort">Sections and synopses are shown in script order only.</p>
            <button v-for="{ block, number, nextLine } in outline" :key="block.from"
              :class="['outline-item', block.type, { current: cursor.line >= block.startLine && cursor.line < nextLine }]"
              @click="goTo(block.from)"><span v-if="number" class="outline-number">{{ number }}</span><span>{{
                  block.text.replace(/^#+\s*|^=\s*/, '') }}</span></button>
            <div v-if="!outline.length" class="empty-state">
              <List :size="25" />
              <p>A place for every scene.</p><small>Scene headings and sections will appear here as you
                write.</small><code>INT. SOMEWHERE - DAY</code>
            </div>
          </div>
          <SheetPanel v-else-if="['characters', 'locations'].includes(panel)" :key="currentId + panel" v-model:sort="characterSort"
            :doc="connection.doc" :document-id="currentId" :kind="panel" :revision="revision" :blocks="blocks"
            @error="notify" @jump="goTo" />
          <StatsPanel v-else-if="panel === 'stats'" :key="currentId" :blocks="blocks" @jump="goTo" />
          <ReviewPanel v-else-if="panel === 'review'" ref="review" :key="currentId" :doc="connection.doc"
            :document-id="currentId" :revision="revision" :selection="selection" :user="session.user" @error="notify"
            @jump="goTo" />
          <div v-else-if="panel === 'scratchpad'" class="scratchpad-panel">
            <div class="panel-tabs scratchpad-tabs"><button :class="{ active: scratchView === 'write' }"
                @click="scratchView = 'write'">Write</button><button :class="{ active: scratchView === 'preview' }"
                @click="scratchView = 'preview'">Preview</button></div>
            <TextEditor v-if="scratchView === 'write'" :key="currentId + '-scratch'" :ytext="connection.scratchpad"
              :awareness="connection.provider.awareness" :read-only="!canEdit" markdown mode="split" />
            <div v-else class="markdown-content scratchpad-preview"
              v-html="scratchHtml || '<p class=&quot;muted&quot;>Nothing here yet.</p>'" />
          </div>
          <VersionPanel v-else-if="panel === 'versions'" :key="currentId" :document-id="currentId" :can-edit="canEdit"
            @error="notify" />
        </aside>
        <div v-if="mobile && sidebar" class="mobile-tool-actions">
          <div class="mobile-editor-mode"><span>Editor</span>
            <div class="segmented"><button :class="{ active: mode === 'live' }" @click="setMode('live')">Live
                formatting</button><button :class="{ active: mode === 'split' }" @click="setMode('split')">Raw
                Fountain</button></div>
          </div>
          <div class="mobile-extra-actions">
            <button class="text-button" :disabled="savingPreferences" @click="openSettings">
              <Settings :size="16" />Settings
            </button>
            <button v-if="canEdit" class="text-button" @click="reviewMode = !reviewMode">
              <Pencil :size="16" />{{ reviewMode ? 'Switch to editing' : 'Suggest edits' }}
            </button>
            <button v-if="session.authMode === 'oauth' && synced" class="text-button"
              @click="shareOpen = true">Share</button>
            <button class="text-button" @click="appearance.open()">
              <Palette :size="16" />Appearance
            </button>
            <button class="text-button" @click="helpOpen = true">
              <CircleHelp :size="16" />Syntax
            </button>
            <button v-if="!installed" class="text-button" @click="installApp">
              <CircleArrowDown :size="16" />Install app
            </button>
            <button v-if="updateAvailable" class="text-button update-available" @click="updateHelpOpen = true">
              <RefreshCw :size="16" />Update app
            </button>
          </div>
        </div>
      </div>

      <main class="editor-main" :class="{ 'split-mode': mode === 'split' }" :inert="mobile && sidebar">
        <div v-if="canReview" class="editor-toolbar">
          <div class="button-row"><button class="icon-button compact" title="Undo (Ctrl/⌘ Z)" aria-label="Undo"
              @pointerdown.prevent @click="editor?.undo()">
              <Undo2 :size="17" />
            </button><button class="icon-button compact" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo"
              @pointerdown.prevent @click="editor?.redo()">
              <Redo2 :size="17" />
            </button><span class="toolbar-divider" /><button class="icon-button compact" title="Bold (Ctrl/⌘ B)"
              aria-label="Bold" @pointerdown.prevent @click="editor?.format('**')">
              <Bold :size="16" />
            </button><button class="icon-button compact" title="Italic (Ctrl/⌘ I)" aria-label="Italic"
              @pointerdown.prevent @click="editor?.format('*')">
              <Italic :size="16" />
            </button><button class="icon-button compact" title="Underline (Ctrl/⌘ U)" aria-label="Underline"
              @pointerdown.prevent @click="editor?.format('_')">
              <Underline :size="16" />
            </button><button class="icon-button compact" title="Link image to selection (Ctrl/⌘ Shift K)"
              aria-label="Link image to selection" @pointerdown.prevent @click="linkImage">
              <ImagePlus :size="17" />
            </button></div>
          <div class="button-row"><button v-if="canEdit"
              :class="['text-button editing-mode', { suggesting: reviewMode }]" :aria-pressed="reviewMode"
              :title="reviewMode ? 'Switch to direct editing' : 'Suggest changes instead of editing directly'"
              @click="reviewMode = !reviewMode">
              <Pencil :size="13" />{{ reviewMode ? 'Suggesting' : 'Editing' }}
              <ChevronDown :size="10" />
            </button><span v-else class="small muted">Suggesting</span><button class="icon-button compact"
              aria-label="Add comment" title="Add comment (Ctrl/⌘ Alt M)" @pointerdown.prevent @click="addComment">
              <MessageSquare :size="17" />
            </button></div>
        </div>
        <div v-if="mobile && mobilePane === 'write' && synced && canReview" class="mobile-writing-actions"
          aria-label="Screenplay shortcuts">
          <button @pointerdown.prevent @click="namePicker = 'locations'">Scene</button><button @pointerdown.prevent
            @click="namePicker = 'characters'">Character</button><button @pointerdown.prevent
            @click="editor?.insertParenthetical()">(Aside)</button><button @pointerdown.prevent
            @click="completeName">Complete ↹</button>
        </div>
        <div v-if="!connection" class="editor-connecting">
          <p>No screenplay open.</p><button v-if="canCreate" class="text-button" @click="createDocument()">New
            screenplay</button>
        </div>
        <div v-else-if="!synced" class="editor-connecting">
          <LoaderCircle :size="20" class="spin" />
          <p>Connecting to document…</p><button v-if="error" class="text-button" @click="initialize">Reconnect</button>
        </div>
        <div v-else class="editing-area">
          <div class="source-pane">
            <div v-if="mode === 'split'" class="pane-heading">SOURCE</div>
            <div class="editor-with-review">
              <TextEditor ref="editor" :key="currentId" :ytext="connection.text"
                :awareness="connection.provider.awareness" :user="session.user" :mode="mode" :review="reviewMode"
                :read-only="!canReview" @selection="onSelection" @cursor="cursor = $event" @geometry="geometry = $event"
                @display="displaySource = $event" @error="notify" @decide="decideSuggestion" @link-image="linkImage"
                @open-comment="lineComments?.reveal($event)" @scroll="syncScroll('source', $event)" />
              <InlineComments ref="lineComments" :key="currentId + '-comments'" :doc="connection.doc"
                :revision="revision" :geometry="geometry" :selection="selection" :user="session.user" @jump="goTo"
                @jump-annotation="editor?.goToAnnotation($event)" />
            </div>
          </div>
          <div v-if="mode === 'split' || mobile" class="preview-pane">
            <div class="pane-heading preview-heading"><span>PREVIEW</span><button v-if="!mobile"
                :class="['icon-button', 'compact', 'scroll-sync-toggle', { active: scrollSync }]"
                :aria-pressed="scrollSync" aria-label="Synchronized scrolling" title="Toggle synchronized scrolling"
                @click="scrollSync = !scrollSync">
                <Link :size="12" />
              </button></div>
            <ScreenplayPreview ref="preview" :blocks="displayBlocks" @scroll="syncScroll('preview', $event)" />
          </div>
        </div>
      </main>
    </div>
    <footer class="statusbar">
      <span :class="['connection-status', { offline: status !== 'connected' }]"><i />{{ status === 'connected' ? 'Live'
        : 'Reconnecting…' }}</span>
      <span class="status-separator">·</span>
      <span class="presence-summary" :aria-label="`Collaborators: ${presenceNames}`"><span>{{ peers.length + 1 }} {{ peers.length ? 'collaborators' : 'writer'
        }}</span><span class="presence-names"><span v-for="person in presencePeople" :key="person.key"
            class="presence-person"><i :style="{ background: person.color }" />{{ person.name }}<em
              v-if="person.self"> (you)</em></span></span></span>
      <span class="status-spacer" /><span class="status-hint">{{ dirtyOffline ? 'Unsynced edits · keep this tab open' :
        mode === 'live' ? 'Click a line to reveal its Fountain source' : 'Plain text, live preview' }}</span>
      <span class="status-spacer" /><span>{{ words.toLocaleString() }} words</span><span
        class="status-separator">·</span><span>Ln {{ cursor.line }}, Col {{ cursor.column }}</span>
    </footer>
    <input ref="importInput" type="file" accept=".fountain,.txt,text/plain" hidden @change="importFile" />
    <dialog ref="settingsDialog" class="modal settings-dialog" aria-labelledby="settings-title" @keydown.stop>
      <form @submit.prevent="saveSettings">
        <h2 id="settings-title">Settings</h2>
        <label class="field-label">Title page alignment
          <select v-model="draftAlignment" :disabled="savingPreferences" autofocus>
            <option v-for="option in TITLE_PAGE_ALIGNMENTS" :key="option" :value="option">{{ option[0].toUpperCase() + option.slice(1) }}</option>
          </select>
        </label>
        <p>Applies to the rendered title page and PDF, without changing the Fountain source.</p>
        <p v-if="settingsError" class="error-text" role="alert">{{ settingsError }}</p>
        <footer>
          <button type="button" class="text-button" @click="settingsDialog.close()">Cancel</button>
          <button type="submit" class="primary-button" :disabled="savingPreferences">Save settings</button>
        </footer>
      </form>
    </dialog>
  </div>
  <div v-if="error && session?.user" class="toast" role="status"><span>{{ error }}</span><button
      class="icon-button compact" aria-label="Dismiss notification" @click="error = ''">
      <X :size="14" />
    </button></div>
  <AppearanceDialog ref="appearance" />
  <Teleport to="body">
    <div v-if="appUpdating" class="modal-backdrop" role="alert" aria-live="polite">
      <div class="modal app-update-progress">
        <LoaderCircle class="spin" :size="24" />
        <p>Confirming saved edits and updating…</p>
      </div>
    </div>
    <div v-else-if="updateHelpOpen" class="modal-backdrop" @click.self="updateHelpOpen = false">
      <section class="modal install-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header>
          <h2 id="update-title">Update available</h2><button class="icon-button" aria-label="Close update"
            @click="updateHelpOpen = false">
            <X :size="20" />
          </button>
        </header>
        <p>A new version is ready. Finish any unposted comments first. Saved edits will be confirmed with the server
          before this tab reloads.</p><button class="primary-button" :disabled="dirtyOffline || status !== 'connected'"
          @click="updateApp">Reload and update</button>
      </section>
    </div>
    <div v-if="installHelpOpen" class="modal-backdrop" @click.self="installHelpOpen = false">
      <section class="modal install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <header>
          <h2 id="install-title">Install on your device</h2><button class="icon-button"
            aria-label="Close install instructions" @click="installHelpOpen = false">
            <X :size="20" />
          </button>
        </header>
        <ul>
          <li>iPhone / iPad: open in Safari, tap <strong>Share → Add to Home Screen</strong>.</li>
          <li>Android / desktop: use your browser’s <strong>Install app</strong> or <strong>Add to Home screen</strong>
            menu.</li>
          <li>Installation requires <strong>HTTPS</strong> (or localhost for development).</li>
          <li>This adds an app icon and a standalone window. Opening documents and live collaboration still require a
            connection; unsynced edits aren’t stored offline.</li>
        </ul>
      </section>
    </div>
    <div v-if="profileOpen" class="modal-backdrop" @click.self="profileOpen = false">
      <form class="modal writer-profile-modal" role="dialog" aria-modal="true" aria-labelledby="writer-profile-title"
        @submit.prevent="saveName">
        <header>
          <h2 id="writer-profile-title">{{ session.user.account ? 'Your profile' : 'Your writer name' }}</h2>
          <button type="button" class="icon-button" aria-label="Close writer profile" @click="profileOpen = false">
            <X :size="18" />
          </button>
        </header>
        <p v-if="session.user.account" class="small muted">Signed in as {{ session.user.name }}. Choose a color for
          your cursor, selections and avatar.</p>
        <p v-else class="small muted">Shown to collaborators and on your new comments and suggestions. No account
          required.</p>
        <label v-if="!session.user.account" class="field-label" for="writer-name">Display name<input id="writer-name"
            v-model="writerName" maxlength="60" autocomplete="nickname" required /></label>
        <div class="editor-color-field">
          <label class="field-label" for="editor-color">Editor color<input id="editor-color" v-model="editorColor"
              type="color" aria-label="Editor color" /></label>
          <span class="editor-color-preview" :style="{ background: editorColor, color: editorColorInk(editorColor) }"
            aria-hidden="true">{{ session.user.name.slice(0, 2).toUpperCase() }}</span>
          <button type="button" class="text-button"
            @click="editorColor = defaultEditorColor(session.user.id)">Use default</button>
        </div>
        <p class="small muted">Separate from character colors in the screenplay.</p>
        <button class="primary-button"
          :disabled="savingName || (!session.user.account && !writerName.trim())">{{ session.user.account ? 'Save color' : 'Save name' }}</button>
      </form>
    </div>
    <div v-if="helpOpen" class="modal-backdrop" @click.self="helpOpen = false">
      <section class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header>
          <h2 id="help-title">A little Fountain reference</h2><button class="icon-button" aria-label="Close reference"
            @click="helpOpen = false">
            <X :size="18" />
          </button>
        </header>
        <p class="muted">Write a screenplay as plain text. The formatting follows.</p>
        <dl class="syntax-reference">
          <dt>Scene</dt>
          <dd><code>INT. APARTMENT - NIGHT</code></dd>
          <dt>Character & dialogue</dt>
          <dd>
            <pre>MARA
You kept the light on.
(a beat)
I wasn't sure you would.</pre>
          </dd>
          <dt>Force an element</dt>
          <dd><code>.A SCENE</code> · <code>@McCLANE</code> · <code>!Action</code></dd>
          <dt>Emphasis</dt>
          <dd><code>*italic* **bold** _underline_</code></dd>
          <dt>Transition / center</dt>
          <dd><code>&gt; FADE OUT.</code> · <code>&gt; THE END &lt;</code></dd>
          <dt>Simultaneous dialogue</dt>
          <dd>Add <code>^</code> after the second character's name.</dd>
          <dt>Outline / hidden notes</dt>
          <dd><code># Act I</code> · <code>= Synopsis</code><br /><code>[[Note]]</code> · <code>/* Hidden text */</code>
          </dd>
          <dt>Page break</dt>
          <dd><code>===</code></dd>
        </dl>
        <p class="small muted">Live mode reveals the line you're editing. Dialogue and multiline blocks stay in source
          form until the cursor moves two lines below. Tab completes character/location names. Ctrl/⌘ B: bold · I:
          italic · U: underline · Shift K: image link · F: search · Alt M: comment. Selecting text and typing *, _ or [
          surrounds it.</p>
        <a class="text-button" href="https://fountain.io/syntax/" target="_blank" rel="noopener">Full Fountain syntax
          ↗</a>
      </section>
    </div>
  </Teleport>
  <ImageLinkDialog v-if="imageLinkOpen && connection" :doc="connection.doc" :document-id="currentId"
    :selection="selection" :user="session.user" @close="imageLinkOpen = false" @error="notify" />
  <MobileNamePicker v-if="namePicker && connection" :doc="connection.doc" :revision="revision" :blocks="displayBlocks"
    :kind="namePicker" @select="chooseName" @close="namePicker = null; editor?.focus()" />
  <DocumentManager v-if="managerOpen" :before-change="beforeDocumentChange" :oauth="session?.authMode === 'oauth'"
    @close="managerOpen = false" @changed="documentChanged" @open="manageOpen" @error="notify" />
  <ShareDialog v-if="shareOpen && connection" :document-id="currentId" :access="documentAccess" :title="titleInput" :user="session.user"
    @close="shareOpen = false" @changed="documentChanged" @error="notify" />
</template>
