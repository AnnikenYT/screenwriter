import { onBeforeUnmount, onMounted, ref } from 'vue'

export function viewportBounds() {
  const visual = window.visualViewport
  if (!visual || visual.scale > 1.1) return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight, bottom: window.innerHeight }
  return { top: visual.offsetTop, left: visual.offsetLeft, width: visual.width, height: visual.height, bottom: visual.offsetTop + visual.height }
}

export function useMobileLayout() {
  const query = window.matchMedia('(max-width: 760px)')
  const mobile = ref(query.matches)
  const keyboardOpen = ref(false)
  let frame, fullHeight = window.innerHeight, lastWidth = window.innerWidth
  const update = () => {
    frame = null
    const root = document.documentElement
    const bounds = viewportBounds()
    const focused = document.activeElement?.matches('input:not([type="file"]), textarea, [contenteditable="true"]')
    if (Math.abs(lastWidth - window.innerWidth) > 50) { fullHeight = window.innerHeight; lastWidth = window.innerWidth }
    if (!focused) fullHeight = Math.max(fullHeight, window.innerHeight, bounds.height)
    else fullHeight = Math.max(fullHeight, window.innerHeight, bounds.height)
    mobile.value = query.matches
    keyboardOpen.value = mobile.value && focused && fullHeight - bounds.height > 120
    root.dataset.mobile = String(mobile.value)
    root.style.setProperty('--app-height', `${Math.round(bounds.height)}px`)
    root.style.setProperty('--viewport-top', `${Math.round(bounds.top)}px`)
    root.style.setProperty('--viewport-bottom', `${Math.max(0, Math.round(window.innerHeight - bounds.bottom))}px`)
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
  onMounted(() => {
    update()
    query.addEventListener('change', schedule)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    document.addEventListener('focusin', schedule)
    document.addEventListener('focusout', schedule)
  })
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    query.removeEventListener('change', schedule)
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
    document.removeEventListener('focusin', schedule)
    document.removeEventListener('focusout', schedule)
    delete document.documentElement.dataset.mobile
  })
  return { mobile, keyboardOpen }
}
