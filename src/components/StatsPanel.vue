<script setup>
import { computed } from 'vue'
import { ACTION_COLUMNS, ACTION_LINES_PER_MINUTE, screenplayStats, WORDS_PER_MINUTE } from '../../shared/screenplay-stats.js'

const props = defineProps({ blocks: { type: Array, required: true } })
const emit = defineEmits(['jump'])
const stats = computed(() => screenplayStats(props.blocks))
function duration(seconds) {
  if (seconds > 0 && seconds < 1) return '<1s'
  const rounded = Math.round(seconds)
  const minutes = Math.floor(rounded / 60)
  return minutes ? `${minutes}m ${rounded % 60}s` : `${rounded}s`
}
const characterCount = count => `${count.toLocaleString()} ${count === 1 ? 'cast member' : 'cast members'}`
</script>

<template>
  <section class="panel-body stats-panel" aria-label="Screenplay statistics">
    <dl class="stats-summary">
      <div><dt>Estimated runtime</dt><dd>{{ duration(stats.seconds) }}</dd></div>
      <div><dt>Scenes</dt><dd>{{ stats.scenes.length.toLocaleString() }}</dd></div>
      <div><dt>Speaking characters</dt><dd>{{ stats.characters.toLocaleString() }}</dd></div>
      <div><dt>Dialogue lines</dt><dd>{{ stats.dialogueLines.toLocaleString() }}</dd></div>
      <div><dt>Action &amp; dialogue words</dt><dd>{{ stats.words.toLocaleString() }}</dd></div>
    </dl>

    <details class="stats-method">
      <summary>How runtime is estimated</summary>
      <p>Dialogue is estimated at {{ WORDS_PER_MINUTE }} words per minute and action at {{ ACTION_LINES_PER_MINUTE }} lines per minute, wrapped at {{ ACTION_COLUMNS }} characters. Overlapping dialogue is counted separately. Timing on screen will vary.</p>
      <p>Scene cast counts include dialogue cues and uppercase mentions of known characters in action. Mentions do not guarantee a character appears on screen. Dialogue lines are nonblank written lines, not visual wraps.</p>
    </details>

    <h3>Scenes</h3>
    <p v-if="stats.scenes.length && stats.opening.seconds" class="field-hint">
      Before the first scene: {{ duration(stats.opening.seconds) }} · {{ characterCount(stats.opening.cast) }}
    </p>
    <ul v-if="stats.scenes.length" class="stats-list">
      <li v-for="scene in stats.scenes" :key="scene.block.from">
        <button class="stats-row" @click="emit('jump', scene.block.from)">
          <strong>{{ scene.number }} · {{ scene.block.text }}</strong>
          <small>{{ duration(scene.seconds) }} · {{ characterCount(scene.cast) }}</small>
        </button>
      </li>
    </ul>
    <p v-else class="field-hint">No scene headings yet.</p>

    <h3>Speaking time by character</h3>
    <ul v-if="stats.speakers.length" class="stats-list">
      <li v-for="speaker in stats.speakers" :key="speaker.from">
        <button class="stats-row" @click="emit('jump', speaker.from)">
          <strong>{{ speaker.name }}</strong>
          <small>{{ duration(speaker.seconds) }} · {{ speaker.words.toLocaleString() }} {{ speaker.words === 1 ? 'word' : 'words' }} · {{ speaker.lines.toLocaleString() }} {{ speaker.lines === 1 ? 'line' : 'lines' }}</small>
        </button>
      </li>
    </ul>
    <p v-else class="field-hint">No dialogue yet.</p>
  </section>
</template>
