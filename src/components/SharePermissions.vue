<script setup>
import { ref } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
const props = defineProps({ grant: Object, roles: Array, owner: Boolean, canExport: Boolean, busy: Boolean })
const emit = defineEmits(['change', 'remove', 'transfer'])
const open = ref(false)
const trigger = ref(null)
function close() { open.value = false; trigger.value?.focus() }
function change(values) { if (!props.busy) emit('change', props.grant, values) }
function move(event) {
  const items = [...event.currentTarget.querySelectorAll('[role^="menuitem"]:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
  }
}
</script>

<template>
  <div class="share-permissions" @focusout="event => { if (!event.currentTarget.contains(event.relatedTarget)) open = false }" @keydown.esc.stop="close">
    <button ref="trigger" class="share-role-button" aria-haspopup="menu" :aria-expanded="open"
      :aria-label="`Permissions for ${grant.email || 'link'}`" @click="open = !open">
      <span>{{ grant.role }}</span><ChevronDown :size="15" />
    </button>
    <div v-if="open" class="share-permission-menu" role="menu" :aria-label="`Permissions for ${grant.email || 'link'}`" @keydown="move">
      <button v-for="role in roles" :key="role" role="menuitemradio" :aria-checked="grant.role === role" :disabled="busy" @click="change({ role }); close()">
        <Check :size="16" :style="{ visibility: grant.role === role ? 'visible' : 'hidden' }" /><span class="share-role-name">{{ role[0].toUpperCase() + role.slice(1) }}</span>
      </button>
      <div class="share-menu-divider"></div>
      <button v-if="owner && grant.kind === 'user'" role="menuitem" :disabled="busy" @click="emit('transfer', grant.email); close()">Transfer ownership</button>
      <button role="menuitem" :disabled="busy" @click="emit('remove', grant.id); close()">Remove access</button>
      <div class="share-menu-divider"></div>
      <button role="menuitemcheckbox" :aria-checked="Boolean(grant.canInvite)" :aria-disabled="busy" @click="change({ canInvite: !grant.canInvite })">
        <span>Can invite others</span><span class="share-toggle" :class="{ checked: grant.canInvite }"><span></span></span>
      </button>
      <button role="menuitemcheckbox" :aria-checked="Boolean(grant.canExport)" :aria-disabled="busy || !canExport" @click="canExport && change({ canExport: !grant.canExport })">
        <span>Can export</span><span class="share-toggle" :class="{ checked: grant.canExport }"><span></span></span>
      </button>
    </div>
  </div>
</template>
