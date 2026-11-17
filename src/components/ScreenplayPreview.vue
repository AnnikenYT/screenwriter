<script setup>
import { computed, ref } from 'vue'
import { inlineFountain, titleFields } from '../../shared/fountain.js'
const props = defineProps({ blocks: { type: Array, default: () => [] } })
const emit = defineEmits(['scroll'])
const scroller = ref(null)
function markers() { return [...scroller.value.querySelectorAll('[data-from]')].sort((a, b) => Number(a.dataset.from) - Number(b.dataset.from)) }
function scrollToPosition({ from, ratio }) {
  const root = scroller.value
  if (!root) return
  if (ratio <= .001) { root.scrollTop = 0; return }
  if (ratio >= .999) { root.scrollTop = root.scrollHeight; return }
  const nodes = markers()
  let i = nodes.findLastIndex(node => Number(node.dataset.from) <= from)
  if (i < 0) i = 0
  const current = nodes[i], next = nodes[i + 1]
  if (!current) return
  const top = current.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
  const nextTop = next ? next.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop : top + current.offsetHeight
  const span = next ? Number(next.dataset.from) - Number(current.dataset.from) : 1
  root.scrollTop = top + Math.max(0, Math.min(1, (from - Number(current.dataset.from)) / Math.max(1, span))) * (nextTop - top) - 8
}
function onScroll() {
  const root = scroller.value
  const nodes = markers()
  const rootTop = root.getBoundingClientRect().top
  let i = nodes.findLastIndex(node => node.getBoundingClientRect().top <= rootTop + 12)
  if (i < 0) i = 0
  const current = nodes[i], next = nodes[i + 1]
  if (!current) return
  const top = current.getBoundingClientRect().top - rootTop
  const height = next ? next.getBoundingClientRect().top - current.getBoundingClientRect().top : current.offsetHeight
  const fraction = Math.max(0, Math.min(1, -top / Math.max(1, height)))
  emit('scroll', { from: Number(current.dataset.from) + Math.round(fraction * ((next ? Number(next.dataset.from) : Number(current.dataset.from)) - Number(current.dataset.from))), ratio: root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight) })
}
defineExpose({ scrollToPosition })
const groups = computed(() => {
  const result = []
  for (let i = 0; i < props.blocks.length; i++) {
    const block = props.blocks[i]
    if (['section', 'synopsis', 'note', 'boneyard'].includes(block.type)) continue
    if (block.type === 'character') {
      const items = [block]
      while (props.blocks[i + 1]?.group === block.group) items.push(props.blocks[++i])
      if (block.dual) {
        let index = result.length - 1
        while (index >= 0 && result[index].type === 'blank') index--
        if (result[index]?.type === 'speech') {
          const left = result[index]
          result.splice(index)
          result.push({ type: 'dual', left: left.items, right: items, from: left.from })
          continue
        }
      }
      result.push({ type: 'speech', items, from: block.from })
    } else result.push(block)
  }
  return result
})
</script>

<template>
  <div ref="scroller" class="screenplay-preview" aria-label="Rendered screenplay" @scroll.passive="onScroll">
    <article class="paper">
      <template v-for="(block, index) in groups" :key="index">
        <section v-if="block.type === 'title'" class="title-page" :data-from="block.from">
          <div class="title-page-main"><h1 v-if="titleFields(block.text).title" v-html="inlineFountain(titleFields(block.text).title)" /><p v-for="field in ['credit', 'author', 'authors', 'source']" :key="field" v-html="inlineFountain(titleFields(block.text)[field] || '')" /></div>
          <div class="title-page-contact"><p v-for="field in ['contact', 'draft date', 'copyright']" :key="field" v-html="inlineFountain(titleFields(block.text)[field] || '')" /></div>
        </section>
        <div v-else-if="block.type === 'speech'" class="speech" :data-from="block.from">
          <div v-for="(line, n) in block.items" :key="n" :class="['fountain', line.type]" :data-from="line.from" v-html="inlineFountain(line.text)" />
        </div>
        <div v-else-if="block.type === 'dual'" class="dual" :data-from="block.from">
          <div v-for="(side, n) in [block.left, block.right]" :key="n" class="speech">
            <div v-for="(line, j) in side" :key="j" :class="['fountain', line.type]" :data-from="line.from" v-html="inlineFountain(line.text)" />
          </div>
        </div>
        <div v-else :class="['fountain', block.type]" :data-from="block.from">
          <span v-if="block.sceneNumber" class="scene-number">{{ block.sceneNumber }}</span>
          <span v-if="block.type !== 'blank' && block.type !== 'pagebreak'" v-html="inlineFountain(block.text)" />
        </div>
      </template>
    </article>
  </div>
</template>
