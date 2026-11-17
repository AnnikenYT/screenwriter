export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    const error = new Error(detail.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return response.status === 204 ? null : response.json()
}

export function download(text, filename, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
