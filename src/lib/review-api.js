import * as Y from 'yjs'
import { api } from './api.js'

export function applyReviewResponse(doc, response) {
  if (doc.isDestroyed) return
  Y.applyUpdate(doc, Uint8Array.from(atob(response.update), char => char.charCodeAt(0)), 'review-response')
}

export async function sendReviewChanges(doc, text, changes) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const base = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const stateVector = btoa(Array.from(Y.encodeStateVector(doc), byte => String.fromCharCode(byte)).join(''))
  const response = await api(`/api/documents/${doc.documentId}/review`, { method: 'POST', body: { base, changes, stateVector } })
  applyReviewResponse(doc, response)
}

export async function reviewWrite(doc, collection, value, patch = false) {
  if (!doc.access || doc.access.canEdit) {
    doc.getMap(collection).set(value.id, value)
    return value.id
  }
  if (!doc.access.canReview) return null
  try {
    await doc.flushReview?.()
    const path = collection === 'comments' && patch ? `/comments/${value.id}` : `/${collection}`
    const response = await api(`/api/documents/${doc.documentId}${path}`, { method: patch ? 'PATCH' : 'POST', body: value })
    applyReviewResponse(doc, response)
    return response.id || value.id
  } catch (error) {
    window.dispatchEvent(new CustomEvent('workspace-error', { detail: error.message }))
    return null
  }
}
