import * as decoding from 'lib0/decoding'

// A fresh presence marker travels behind all earlier outgoing updates on this
// socket. Its server echo confirms those updates were processed and committed.
// A nonce distinguishes the reply from old/in-flight synchronization messages.
// Providers must disable BroadcastChannel relays (see connect()).
export function flushCollaboration(provider, doc, timeout = 6000) {
  const ws = provider.ws
  const awareness = provider.awareness
  if (!ws || ws.readyState !== 1 || !provider.synced || !awareness?.getLocalState()) return Promise.reject(new Error('Reconnect before updating. Keep this tab open to preserve unsynced edits.'))
  const nonce = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      ws.removeEventListener('message', message)
      ws.removeEventListener('close', closed)
      const state = awareness.getLocalState()
      if (state?._flush === nonce) { const next = { ...state }; delete next._flush; awareness.setLocalState(next) }
      error ? reject(error) : resolve()
    }
    const message = async event => {
      try {
        const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
        const decoder = decoding.createDecoder(new Uint8Array(data))
        if (decoding.readVarUint(decoder) !== 1) return
        const update = decoding.createDecoder(decoding.readVarUint8Array(decoder))
        const count = decoding.readVarUint(update)
        for (let i = 0; i < count; i++) {
          const client = decoding.readVarUint(update)
          decoding.readVarUint(update)
          const state = JSON.parse(decoding.readVarString(update))
          if (client === doc.clientID && state?._flush === nonce) finish()
        }
      } catch { /* Ignore other protocol frames; the provider validates them. */ }
    }
    const closed = () => finish(new Error('Connection lost. Your tab was not reloaded; reconnect and try again.'))
    const timer = setTimeout(() => finish(new Error('Could not confirm saved edits. Keep this tab open and try again.')), timeout)
    ws.addEventListener('message', message)
    ws.addEventListener('close', closed)
    try { awareness.setLocalStateField('_flush', nonce) } catch { closed() }
  })
}
