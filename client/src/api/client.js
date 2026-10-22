// Tiny REST client. The access token lives only in memory; the refresh token
// is an httpOnly cookie the browser sends to /api/auth/refresh.

let accessToken = null
let refreshing = null
const listeners = new Set()

export const onAuthChange = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setSession(token, user) {
  accessToken = token
  if (user) localStorage.setItem('collab-user', JSON.stringify(user))
  listeners.forEach((fn) => fn(user ?? null))
}

export function cachedUser() {
  try {
    return JSON.parse(localStorage.getItem('collab-user'))
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Single-flight refresh so parallel 401s trigger only one request. */
export function refresh() {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, 'session expired')
      const { accessToken: token, user } = await res.json()
      setSession(token, user)
      return token
    })
    .finally(() => (refreshing = null))
  return refreshing
}

const expiresSoon = (token) => {
  try {
    const { exp } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return exp * 1000 - Date.now() < 60_000
  } catch {
    return true
  }
}

/** A token that is valid for at least another minute (used by the WebSocket). */
export async function freshToken() {
  if (accessToken && !expiresSoon(accessToken)) return accessToken
  return refresh()
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    await refresh()
    return api(path, { method, body, retry: false })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText)
  return data
}
