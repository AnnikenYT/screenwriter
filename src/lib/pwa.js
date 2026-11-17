import { onBeforeUnmount, ref } from 'vue'

export function usePwa() {
  const installAvailable = ref(false)
  const installed = ref(false)
  const updateAvailable = ref(false)
  let deferredPrompt
  let registration
  let started = false
  let disposed = false
  let reloadRequested = false
  let pendingUpdate
  const cleanup = []
  const listen = (target, event, handler) => {
    target.addEventListener(event, handler)
    cleanup.push(() => target.removeEventListener(event, handler))
  }

  async function register() {
    if (started || disposed || typeof window === 'undefined') return
    started = true
    const display = window.matchMedia('(display-mode: standalone)')
    const updateInstalled = () => {
      installed.value = display.matches || window.navigator.standalone === true
      if (installed.value) { deferredPrompt = undefined; installAvailable.value = false }
    }
    updateInstalled()
    listen(display, 'change', updateInstalled)
    listen(window, 'beforeinstallprompt', event => {
      event.preventDefault()
      deferredPrompt = event
      installAvailable.value = !installed.value
    })
    listen(window, 'appinstalled', () => {
      installed.value = true
      deferredPrompt = undefined
      installAvailable.value = false
    })
    // Localhost is a secure context for development, but must never register
    // a production worker while Vite serves development modules.
    if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      if (disposed) return
      const checkWaiting = () => { updateAvailable.value = Boolean(registration.waiting) }
      checkWaiting()
      const watch = worker => {
        if (worker) listen(worker, 'statechange', checkWaiting)
      }
      watch(registration.installing)
      listen(registration, 'updatefound', () => watch(registration.installing))
    } catch {
      // Private browsing, blocked storage and offline first visits must not
      // create unhandled promise rejections or prevent editing.
    }
  }

  async function install() {
    const prompt = deferredPrompt
    if (!prompt) return { prompted: false }
    deferredPrompt = undefined
    installAvailable.value = false
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      return { prompted: true, outcome: choice.outcome }
    } catch { return { prompted: true, outcome: 'dismissed' } }
  }

  function applyUpdate() {
    if (pendingUpdate) return pendingUpdate.promise
    if (disposed || !registration?.waiting) return Promise.reject(new Error('No app update is waiting. This tab was not reloaded.'))
    const worker = registration.waiting
    let resolve
    let reject
    let settled = false
    const promise = new Promise((done, fail) => { resolve = done; reject = fail })
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      reloadRequested = false
      pendingUpdate = undefined
      if (error) { reject(error); return }
      try {
        // Only this requesting tab reloads. Other open writers stay untouched.
        window.location.reload()
        resolve()
      } catch (failure) { reject(failure) }
    }
    const changed = () => {
      if (reloadRequested) finish()
    }
    const timer = setTimeout(() => finish(new Error('The app update timed out. This tab was kept open; try again when ready.')), 8000)
    pendingUpdate = { promise, cancel: () => finish(new Error('The app update was cancelled because this view closed.')) }
    reloadRequested = true
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    try { worker.postMessage({ type: 'SKIP_WAITING' }) }
    catch (error) { finish(error) }
    return promise
  }

  onBeforeUnmount(() => {
    disposed = true
    pendingUpdate?.cancel()
    cleanup.splice(0).forEach(remove => remove())
    deferredPrompt = undefined
  })
  return { installAvailable, installed, updateAvailable, register, install, applyUpdate }
}
