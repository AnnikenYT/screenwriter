<script setup>
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue'
import { X } from 'lucide-vue-next'

const modes = { system: 'System', light: 'Light', dark: 'Dark' }
const palettes = { sage: 'Sage', ocean: 'Ocean', plum: 'Plum', mono: 'Mono', gruvbox: 'Gruvbox' }
const media = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(media.matches)
const mode = ref(Object.hasOwn(modes, localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'system')
const palette = ref(Object.hasOwn(palettes, localStorage.getItem('theme-palette')) ? localStorage.getItem('theme-palette') : 'sage')
const theme = computed(() => mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value)
const dialog = ref(null)
const onSchemeChange = event => { systemDark.value = event.matches }
media.addEventListener('change', onSchemeChange)
onBeforeUnmount(() => media.removeEventListener('change', onSchemeChange))

watchEffect(() => {
  const root = document.documentElement
  root.dataset.theme = theme.value
  root.dataset.palette = palette.value
  const color = getComputedStyle(root).getPropertyValue('--theme-chrome').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  localStorage.setItem('theme', mode.value)
  localStorage.setItem('theme-palette', palette.value)
})
defineExpose({ open: () => dialog.value?.showModal(), isOpen: () => dialog.value?.open })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="modal appearance-dialog" aria-labelledby="appearance-heading">
      <header>
        <h2 id="appearance-heading">Appearance</h2>
        <form method="dialog"><button class="icon-button" aria-label="Close appearance"><X :size="18" /></button></form>
      </header>
      <label>Brightness
        <select v-model="mode">
          <option v-for="(label, value) in modes" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>Palette
        <select v-model="palette">
          <option v-for="(label, value) in palettes" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <p class="muted">Appearance is saved on this device and does not change exports.</p>
    </dialog>
  </Teleport>
</template>
