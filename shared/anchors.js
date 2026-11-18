import * as Y from 'yjs'

export function relativeAnchor(doc, from, to) {
  const text = doc.getText('screenplay')
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  }
}

export function resolveAnchor(doc, anchor) {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), doc)
    const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), doc)
    if (!a || !b || a.type !== doc.getText('screenplay') || b.type !== a.type) return null
    return { from: a.index, to: Math.max(a.index, b.index) }
  } catch { return null }
}
