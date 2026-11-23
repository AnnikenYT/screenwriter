import { ref, shallowRef } from 'vue'

const minimumThumb = 44

export function useEditorScrollbar() {
  const rail = ref(null)
  const metrics = shallowRef(null)
  let scroll, drag

  function read(element) {
    const { clientHeight, scrollHeight, scrollTop } = element
    const max = scrollHeight - clientHeight
    const proportional = clientHeight * clientHeight / scrollHeight
    if (max <= 0 || clientHeight <= minimumThumb * 2 || proportional >= minimumThumb ||
        element.scrollWidth > element.clientWidth + 1) return null
    const travel = clientHeight - minimumThumb
    const value = Math.min(max, Math.max(0, scrollTop))
    return { max, value, travel, offset: value / max * travel }
  }
  function update(element, next = read(element)) {
    scroll = element
    const previous = metrics.value
    if (previous?.max !== next?.max || previous?.value !== next?.value || previous?.travel !== next?.travel) {
      metrics.value = next
    }
  }
  function setFromPointer(y, grab) {
    const { max, travel } = metrics.value
    scroll.scrollTop = (y - rail.value.getBoundingClientRect().top - grab) / travel * max
  }
  function start(event) {
    if (event.button !== 0 || !metrics.value) return
    const hitThumb = event.target !== rail.value
    const grab = hitThumb ? event.clientY - event.target.getBoundingClientRect().top : minimumThumb / 2
    rail.value.focus({ preventScroll: true })
    rail.value.setPointerCapture(event.pointerId)
    drag = { pointer: event.pointerId, grab }
    if (!hitThumb) setFromPointer(event.clientY, grab)
  }
  function move(event) {
    if (drag?.pointer === event.pointerId && metrics.value) setFromPointer(event.clientY, drag.grab)
  }
  function stop(event) {
    if (drag?.pointer === event.pointerId) drag = null
  }
  function key(event) {
    if (!metrics.value) return
    const offsets = { ArrowUp: -40, ArrowDown: 40, PageUp: -scroll.clientHeight, PageDown: scroll.clientHeight }
    if (Object.hasOwn(offsets, event.key)) scroll.scrollTop += offsets[event.key]
    else if (event.key === 'Home') scroll.scrollTop = 0
    else if (event.key === 'End') scroll.scrollTop = metrics.value.max
    else return
    event.preventDefault()
  }
  return { rail, metrics, read, update, start, move, stop, key }
}
