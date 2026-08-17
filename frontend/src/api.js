// All API calls use relative URLs — no hardcoded localhost
// In development Vite proxies /api → http://localhost:8000
// In production FastAPI serves the built dist directly

export const API = '/api'

// Central fetch helper
export async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body && !(opts.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...opts.headers,
    },
  })

  // 401 on non-auth endpoints → clear session
  if (res.status === 401) {
    const isAuthEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register')
    if (!isAuthEndpoint) {
      localStorage.removeItem('token')
      window.location.href = '/'
      return null
    }
    // For auth endpoints, fall through to error handling below
  }

  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail || detail } catch (_) {}
    throw new Error(detail)
  }

  return res.status === 204 ? null : res.json()
}

// Authenticated file URL helper — used for page images and template images
export function fileUrl(path) {
  const token = localStorage.getItem('token')
  // Images are served through authenticated API endpoints
  return path  // used directly in fetch calls, not img.src
}

// Blob download (for Excel/JSON export)
export async function downloadBlob(path, filename) {
  const token = localStorage.getItem('token')
  const res = await fetch(API + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Export failed')
  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
