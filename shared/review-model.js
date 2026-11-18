import { relativeAnchor, resolveAnchor } from './anchors.js'

export function projectReview(doc) {
  const source = doc.getText('screenplay').toString()
  const pending = [...doc.getMap('suggestions').values()]
    .filter(s => s.status === 'pending')
    .map(suggestion => ({ suggestion, range: resolveAnchor(doc, suggestion.anchor) }))
    .filter(({ suggestion, range }) => range && source.slice(range.from, range.to) === suggestion.original)
    .sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to || a.suggestion.id.localeCompare(b.suggestion.id))
  const spans = []
  const parts = []
  let sourceOffset = 0, viewOffset = 0
  for (const { suggestion, range } of pending) {
    // Conflicting proposals remain available in the review overview, but never
    // obscure each other or silently overwrite a collaborator's proposal.
    if (range.from < sourceOffset) continue
    const gap = source.slice(sourceOffset, range.from)
    parts.push(gap, suggestion.replacement)
    viewOffset += gap.length
    spans.push({ ...suggestion, baseFrom: range.from, baseTo: range.to, from: viewOffset, to: viewOffset + suggestion.replacement.length })
    viewOffset += suggestion.replacement.length
    sourceOffset = range.to
  }
  parts.push(source.slice(sourceOffset))
  return { source, text: parts.join(''), spans }
}

export function sourceToView(model, position, assoc = 1) {
  let delta = 0
  for (const span of model.spans) {
    if (position < span.baseFrom) break
    if (position === span.baseFrom && span.baseFrom !== span.baseTo) return span.from
    if (position === span.baseTo && span.baseFrom !== span.baseTo) return span.to
    if (position <= span.baseTo) return assoc < 0 ? span.from : span.to
    delta += (span.to - span.from) - (span.baseTo - span.baseFrom)
  }
  return Math.max(0, Math.min(model.text.length, position + delta))
}

export function viewToSource(model, position, assoc = 1) {
  let delta = 0
  for (const span of model.spans) {
    if (position < span.from) break
    if (position === span.from && span.from !== span.to) return span.baseFrom
    if (position === span.to && span.from !== span.to) return span.baseTo
    if (position <= span.to) return assoc < 0 ? span.baseFrom : span.baseTo
    delta += (span.to - span.from) - (span.baseTo - span.baseFrom)
  }
  return Math.max(0, Math.min(model.source.length, position - delta))
}

export function ownsSuggestion(suggestion, user) {
  return suggestion.authorId ? suggestion.authorId === user.id : suggestion.author === user.name
}

export function annotationViewRange(doc, model, annotation) {
  const span = model.spans.find(s => s.id === annotation.proposal?.id)
  if (span) return {
    from: span.from + Math.min(span.replacement.length, annotation.proposal.from),
    to: span.from + Math.min(span.replacement.length, annotation.proposal.to),
  }
  const range = resolveAnchor(doc, annotation.anchor)
  return range ? { from: sourceToView(model, range.from, -1), to: sourceToView(model, range.to, 1) } : null
}

function moveProposalAnnotations(doc, touched, change, start, replacement, proposalId, baseFrom) {
  if (!touched.length) return
  const spans = new Map(touched.map(span => [span.id, span]))
  const move = (point, end) => {
    if (change.from === change.to && point === change.from) return point + (end ? 0 : change.replacement.length)
    if (point <= change.from) return point
    if (point >= change.to) return point + change.replacement.length - (change.to - change.from)
    return change.from + (end ? change.replacement.length : 0)
  }
  for (const name of ['comments', 'meta']) {
    const map = doc.getMap(name)
    for (const [key, item] of map) {
      if (name === 'meta' && !key.startsWith('image-link:')) continue
      const old = spans.get(item?.proposal?.id)
      if (!old) continue
      const from = Math.max(0, Math.min(replacement.length, move(old.from + item.proposal.from, false) - start))
      const to = Math.max(from, Math.min(replacement.length, move(old.from + item.proposal.to, true) - start))
      if (proposalId) map.set(key, { ...item, proposal: { id: proposalId, from, to } })
      else {
        const { proposal, ...plain } = item
        map.set(key, { ...plain, anchor: relativeAnchor(doc, baseFrom + from, baseFrom + to) })
      }
    }
  }
}

function touchedSpans(model, change, user) {
  return model.spans.filter(span => {
    if (change.from === change.to) {
      return ownsSuggestion(span, user)
        ? change.from >= span.from && change.from <= span.to
        : change.from > span.from && change.from < span.to
    }
    return span.from === span.to
      ? change.from <= span.from && change.to >= span.to
      : change.from < span.to && change.to > span.from
  })
}

export function applyReviewChanges(doc, model, changes, { user, suggesting, origin }) {
  const planned = changes.map(change => ({ change, touched: touchedSpans(model, change, user) }))
  if (planned.some(({ touched }) => touched.some(span => !ownsSuggestion(span, user)))) {
    throw new Error('Accept or reject this writer’s suggestion before editing its proposed text.')
  }
  doc.transact(() => {
    const text = doc.getText('screenplay')
    const suggestions = doc.getMap('suggestions')
    for (const { change, touched } of planned.sort((a, b) => b.change.from - a.change.from)) {
      if (suggesting || touched.length) {
        const from = Math.min(change.from, ...touched.map(span => span.from))
        const to = Math.max(change.to, ...touched.map(span => span.to))
        const baseFrom = viewToSource(model, from, -1)
        const baseTo = viewToSource(model, to, 1)
        const replacement = model.text.slice(from, change.from) + change.replacement + model.text.slice(change.to, to)
        const original = model.source.slice(baseFrom, baseTo)
        const existing = touched.length === 1 ? suggestions.get(touched[0].id) : null
        for (const span of touched) if (span.id !== existing?.id) suggestions.delete(span.id)
        if (replacement === original) {
          if (existing) suggestions.delete(existing.id)
          moveProposalAnnotations(doc, touched, change, from, replacement, null, baseFrom)
          continue
        }
        const id = existing?.id || crypto.randomUUID()
        suggestions.set(id, {
          ...existing, id, original, replacement,
          anchor: relativeAnchor(doc, baseFrom, baseTo),
          author: existing?.author || user.name,
          authorId: existing?.authorId || user.id,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now(), status: 'pending',
        })
        moveProposalAnnotations(doc, touched, change, from, replacement, id, baseFrom)
      } else {
        const from = viewToSource(model, change.from, -1)
        const to = viewToSource(model, change.to, 1)
        const original = model.source.slice(from, to)
        const wrappedAt = original ? change.replacement.indexOf(original) : -1
        const unwrappedAt = change.replacement ? original.indexOf(change.replacement) : -1
        if (wrappedAt >= 0) {
          // Wrapping a selection in markup must not replace its CRDT items:
          // comments/image links on the actual words should survive formatting.
          const suffix = change.replacement.slice(wrappedAt + original.length)
          const prefix = change.replacement.slice(0, wrappedAt)
          if (suffix) text.insert(to, suffix)
          if (prefix) text.insert(from, prefix)
        } else if (unwrappedAt >= 0) {
          const suffixLength = original.length - unwrappedAt - change.replacement.length
          if (suffixLength) text.delete(from + unwrappedAt + change.replacement.length, suffixLength)
          if (unwrappedAt) text.delete(from, unwrappedAt)
        } else {
          if (to > from) text.delete(from, to - from)
          if (change.replacement) text.insert(from, change.replacement)
        }
      }
    }
  }, origin)
  return projectReview(doc)
}
