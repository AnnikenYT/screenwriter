<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { X, Link, LockKeyhole, Globe, ChevronDown } from 'lucide-vue-next'
import { api } from '../lib/api.js'
import SharePermissions from './SharePermissions.vue'
const props = defineProps({ documentId: String, access: Object, title: String, user: Object })
const emit = defineEmits(['close', 'changed', 'error'])
const email = ref(''), role = ref('viewer'), canInvite = ref(false), canExport = ref(false)
const expires = ref(''), password = ref(''), grants = ref([]), busy = ref(false)
const status = ref(''), linkOptions = ref(false), owner = ref(null), panel = ref(null)
const roles = computed(() => ['viewer', 'reviewer', 'editor'].slice(0, ['viewer', 'reviewer', 'editor'].indexOf(props.access.role) + 1))
const people = computed(() => grants.value.filter(grant => grant.kind === 'user' && grant.active))
const links = computed(() => grants.value.filter(grant => grant.kind === 'link' && grant.active))
const link = computed(() => links.value.find(grant => grant.url)?.url || '')
const documentLink = new URL(`/?document=${props.documentId}`, location.origin).href
const previousFocus = document.activeElement
const initials = name => (name || '?').split(/[\s@]+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()
async function load() {
  const info = await api(`/api/documents/${props.documentId}/sharing-info`)
  owner.value = info.owner
  if (props.access.canInvite || props.access.owner) grants.value = await api(`/api/documents/${props.documentId}/shares`)
}
async function run(action) {
  if (busy.value) return
  busy.value = true
  try { await action() } catch (error) { emit('error', error.message) }
  finally { busy.value = false }
}
async function create(kind) {
  await run(async () => {
    const result = await api(`/api/documents/${props.documentId}/shares`, { method: 'POST', body: {
      kind, email: email.value, role: role.value, canInvite: canInvite.value, canExport: canExport.value,
      expiresAt: expires.value ? new Date(expires.value).getTime() : null, password: password.value,
    } })
    if (result.url) linkOptions.value = false
    status.value = result.email ? result.notificationSent === false ? 'Invited. Email was not sent.' : 'Invited.' : 'Link created.'
    email.value = ''; password.value = ''
    await load()
  })
}
async function update(grant, values) {
  await run(async () => {
    await api(`/api/documents/${props.documentId}/shares/${grant.id}`, { method: 'PATCH', body: {
      role: grant.role, canInvite: Boolean(grant.canInvite), canExport: Boolean(grant.canExport), ...values,
    } })
    await load()
    status.value = 'Permissions updated.'
  })
}
async function revoke(id) {
  await run(async () => {
    await api(`/api/documents/${props.documentId}/shares/${id}`, { method: 'DELETE' })
    await load()
    status.value = 'Access removed.'
  })
}
async function leave() {
  if (!window.confirm('Leave this screenplay? You’ll need a new invitation to return.')) return
  await run(async () => {
    await api(`/api/documents/${props.documentId}/leave`, { method: 'POST' })
    emit('changed', props.documentId, 'leave'); emit('close')
  })
}
async function transfer(email) {
  if (!window.confirm(`Transfer ownership to ${email}? You may lose access.`)) return
  await run(async () => {
    await api(`/api/documents/${props.documentId}/owner`, { method: 'POST', body: { email } })
    emit('changed', props.documentId, 'transfer'); emit('close')
  })
}
async function copy(url = link.value || documentLink) {
  try {
    await navigator.clipboard.writeText(url)
    status.value = url !== documentLink ? 'Link copied.' : 'Link copied. Only people with access can open it.'
  } catch { emit('error', 'Select and copy the link.') }
}
function trapFocus(event) {
  if (event.key !== 'Tab') return
  const controls = [...panel.value.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')]
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => {
  await nextTick()
  panel.value?.querySelector('input, button')?.focus()
  try { await load() } catch (error) { emit('error', error.message) }
})
onUnmounted(() => previousFocus?.isConnected && previousFocus.focus())
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <section ref="panel" class="modal share-dialog" role="dialog" aria-modal="true" aria-label="Share screenplay" @keydown.esc="emit('close')" @keydown="trapFocus">
        <header><h2>Share “{{ title || 'Untitled screenplay' }}”</h2><button class="icon-button" aria-label="Close sharing" @click="emit('close')"><X :size="20" /></button></header>
        <form v-if="access.canInvite" class="share-invite" @submit.prevent="create('user')">
          <input v-model="email" aria-label="Email" type="email" required autocomplete="off" placeholder="Add people by email" />
          <div v-if="email" class="share-invite-options">
            <label class="field-label">Role<select v-model="role" aria-label="Role"><option v-for="item in roles" :key="item" :value="item">{{ item }}</option></select></label>
            <label class="checkbox-label"><input v-model="canInvite" type="checkbox" /> Can invite others</label>
            <label class="checkbox-label"><input v-model="canExport" type="checkbox" :disabled="!access.canExport" /> Can export</label>
            <label class="field-label">Expires (optional)<input v-model="expires" type="datetime-local" /></label>
            <button class="primary-button" :disabled="busy">Invite</button>
          </div>
        </form>
        <section class="share-section" aria-labelledby="share-people-title">
          <h3 id="share-people-title">People with access</h3>
          <div v-if="owner" class="share-person">
            <span class="share-person-avatar">{{ initials(owner.name) }}</span>
            <div class="share-person-identity"><strong>{{ owner.name }}{{ access.owner ? ' (you)' : '' }}</strong><span v-if="owner.email">{{ owner.email }}</span></div>
            <span class="share-owner-role">Owner</span>
          </div>
          <div v-if="!access.owner && user" class="share-person">
            <span class="share-person-avatar">{{ initials(user.name) }}</span>
            <div class="share-person-identity"><strong>{{ user.name }} (you)</strong><span>{{ user.email || 'Link guest' }}</span></div>
            <span class="share-owner-role share-role-name">{{ access.role }}</span>
          </div>
          <div v-for="grant in people" :key="grant.id" class="share-person share-grant">
            <span class="share-person-avatar">{{ initials(grant.name || grant.email) }}</span>
            <div class="share-person-identity"><strong>{{ grant.name || grant.email }}</strong><span>{{ grant.name ? grant.email : 'Invited by email' }}</span><small v-if="grant.expiresAt">Expires {{ new Date(grant.expiresAt).toLocaleString() }}</small></div>
            <SharePermissions :grant="grant" :roles="roles" :owner="access.owner" :can-export="access.canExport" :busy="busy" @change="update" @remove="revoke" @transfer="transfer" />
          </div>
          <p v-if="!access.owner && access.canInvite" class="small muted">Only invitations you created are shown.</p>
        </section>
        <section class="share-section share-general" aria-labelledby="share-general-title">
          <h3 id="share-general-title">General access</h3>
          <div class="share-person">
            <span class="share-access-icon"><Globe v-if="links.length" :size="21" /><LockKeyhole v-else :size="21" /></span>
            <div class="share-person-identity"><strong>{{ links.length ? 'People with a link' : 'Restricted' }}</strong><span>{{ links.length ? 'Active links allow access without an account.' : 'Only people with access can open this screenplay.' }}</span></div>
          </div>
          <div v-for="(grant, index) in links" :key="grant.id" class="share-saved-link">
            <div class="share-person share-grant">
            <Link :size="18" />
            <div class="share-person-identity"><strong>Share link{{ links.length > 1 ? ` ${index + 1}` : '' }}</strong><small v-if="grant.expiresAt">Expires {{ new Date(grant.expiresAt).toLocaleString() }}</small></div>
            <SharePermissions :grant="grant" :roles="roles" :owner="false" :can-export="access.canExport" :busy="busy" @change="update" @remove="revoke" />
            </div>
            <div v-if="grant.url" class="share-link">
              <label class="field-label">{{ links.length === 1 ? 'Link' : `Link ${index + 1}` }}<input :value="grant.url" readonly @focus="$event.target.select()" /></label>
              <button class="text-button" :aria-label="`Copy share link ${index + 1}`" @click="copy(grant.url)">Copy link</button>
            </div>
            <p v-else class="small muted">This older link cannot be displayed. Create a new link to copy it.</p>
          </div>
          <template v-if="access.canInvite">
            <button class="text-button" :aria-expanded="linkOptions" @click="linkOptions = !linkOptions">{{ links.length ? 'Create another link' : 'Create a share link' }}<ChevronDown :size="14" /></button>
            <form v-if="linkOptions" class="share-link-options" @submit.prevent="create('link')">
              <label class="field-label">Link role<select v-model="role" aria-label="Link role"><option v-for="item in roles" :key="item" :value="item">{{ item }}</option></select></label>
              <label class="checkbox-label"><input v-model="canInvite" type="checkbox" /> Can invite others</label>
              <label class="checkbox-label"><input v-model="canExport" type="checkbox" :disabled="!access.canExport" /> Can export</label>
              <label class="field-label">Link expires (optional)<input v-model="expires" type="datetime-local" /></label>
              <label class="field-label">Password (optional)<input v-model="password" type="password" autocomplete="new-password" maxlength="1024" /></label>
              <button class="primary-button" :disabled="busy">Create link</button>
            </form>
          </template>
        </section>
        <p v-if="status" class="small muted" role="status">{{ status }}</p>
        <footer class="share-footer">
          <button class="text-button share-copy-button" @click="copy()"><Link :size="17" />Copy link</button>
          <button v-if="!access.owner" class="text-button danger-button" :disabled="busy" @click="leave">Leave screenplay</button>
          <button class="primary-button" :disabled="busy" @click="emit('close')">Done</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
