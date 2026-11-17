<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { X, Plus, MapPin, UserRound } from 'lucide-vue-next'
import { characterName, locationName } from '../../shared/fountain.js'
const props = defineProps({ doc: Object, revision: Number, blocks: Array, kind: String })
const emit = defineEmits(['select', 'close'])
const query = ref('')
const input = ref(null)
const character = computed(() => props.kind === 'characters')
const names = computed(() => {
  void props.revision
  const known = new Set([...props.doc.getMap(props.kind).values()].map(s => s.name))
  for (const block of props.blocks) if (block.type === (character.value ? 'character' : 'scene')) known.add(character.value ? characterName(block.text) : locationName(block.text))
  return [...known].filter(Boolean).filter(name => name.toLowerCase().includes(query.value.toLowerCase())).sort()
})
function choose(name = query.value.trim()) { emit('select', name, props.kind) }
onMounted(() => nextTick(() => input.value?.focus()))
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop mobile-picker-backdrop" @click.self="emit('close')">
      <section class="modal mobile-name-picker" role="dialog" aria-modal="true" :aria-label="character ? 'Choose a character' : 'Choose a location'" @keydown.esc="emit('close')">
        <header><h2>{{ character ? 'Character' : 'Scene location' }}</h2><button class="icon-button" aria-label="Close name picker" @click="emit('close')"><X :size="20" /></button></header>
        <input ref="input" v-model="query" :placeholder="character ? 'Find or create a character…' : 'Find or create a location…'" :aria-label="character ? 'Character name' : 'Location name'" autocomplete="off" @keydown.enter.prevent="choose()" />
        <div class="mobile-name-list">
          <button v-for="name in names" :key="name" class="mobile-name-option" @click="choose(name)"><UserRound v-if="character" :size="17" /><MapPin v-else :size="17" /><span>{{ name }}</span></button>
          <button class="mobile-name-option new-name" @click="choose()"><Plus :size="18" /><span>{{ query.trim() ? `Use “${query.trim()}”` : character ? 'New character' : 'New scene' }}</span></button>
        </div>
        <p class="field-hint">{{ character ? 'On a character cue, replaces the name. Elsewhere, starts a new dialogue block.' : 'Completes the current scene heading, or starts a new scene.' }}</p>
      </section>
    </div>
  </Teleport>
</template>
