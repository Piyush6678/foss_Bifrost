import { createContext, useContext, useEffect, useState } from 'react'
import { api, refresh, setSession, cachedUser, onAuthChange } from '../../api/client.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  useEffect(() => onAuthChange(setUser), [])

  useEffect(() => {
    refresh()
      .catch((err) => {
        // No network: let the user keep working on documents cached locally.
        if (!(err?.status >= 400)) {
          const u = cachedUser()
          if (u) {
            setUser(u)
            setOffline(true)
          }
        }
      })
      .finally(() => setLoading(false))
  }, [])

  const login = async (email, password) => {
    const { accessToken, user } = await api('/auth/login', { method: 'POST', body: { email, password } })
    setSession(accessToken, user)
  }

  const signup = async (name, email, password) => {
    const { accessToken, user } = await api('/auth/signup', { method: 'POST', body: { name, email, password } })
    setSession(accessToken, user)
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    localStorage.removeItem('collab-user')
    setSession(null, null)
  }

  return <AuthContext.Provider value={{ user, loading, offline, login, signup, logout }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
