<script setup>
import { computed } from 'vue'
import { inlineFountain, titleFields } from '../../shared/fountain.js'
const props = defineProps({ blocks: { type: Array, default: () => [] } })
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
  <div class="screenplay-preview" aria-label="Rendered screenplay">
    <article class="paper">
      <template v-for="(block, index) in groups" :key="index">
        <section v-if="block.type === 'title'" class="title-page" :data-from="block.from">
          <div class="title-page-main"><h1 v-if="titleFields(block.text).title" v-html="inlineFountain(titleFields(block.text).title)" /><p v-for="field in ['credit', 'author', 'authors', 'source']" :key="field" v-html="inlineFountain(titleFields(block.text)[field] || '')" /></div>
          <div class="title-page-contact"><p v-for="field in ['contact', 'draft date', 'copyright']" :key="field" v-html="inlineFountain(titleFields(block.text)[field] || '')" /></div>
        </section>
        <div v-else-if="block.type === 'speech'" class="speech" :data-from="block.from">
          <div v-for="(line, n) in block.items" :key="n" :class="['fountain', line.type]" v-html="inlineFountain(line.text)" />
        </div>
        <div v-else-if="block.type === 'dual'" class="dual" :data-from="block.from">
          <div v-for="(side, n) in [block.left, block.right]" :key="n" class="speech">
            <div v-for="(line, j) in side" :key="j" :class="['fountain', line.type]" v-html="inlineFountain(line.text)" />
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
