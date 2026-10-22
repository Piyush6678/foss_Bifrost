import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext.jsx'
import { Logo } from '../../components/ui.jsx'
import ThemeToggle from '../../components/ThemeToggle.jsx'

export default function AuthPage({ mode }) {
  const { login, signup } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isSignup = mode === 'signup'

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (isSignup) await signup(form.name, form.email, form.password)
      else await login(form.email, form.password)
      navigate(location.state?.from || '/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  return (
    <div className="auth-page">
      <div style={{ position: 'fixed', top: 12, right: 12 }}>
        <ThemeToggle />
      </div>
      <div className="auth-panel">
        <div className="auth-head">
          <Logo size="lg" />
          <div>
            <h1>{isSignup ? 'Create your account' : 'Sign in to Merge'}</h1>
            <p>{isSignup ? 'Start editing together in under a minute.' : 'Welcome back. Pick up where you left off.'}</p>
          </div>
        </div>
        <form className="auth-card" onSubmit={submit}>
          {isSignup && (
            <label className="field">
              Name
              <input value={form.name} onChange={set('name')} required autoFocus placeholder="Ada Lovelace" />
            </label>
          )}
          <label className="field">
            Email
            <input type="email" value={form.email} onChange={set('email')} required autoFocus={!isSignup} placeholder="you@company.com" />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={form.password}
              onChange={set('password')}
              required
              minLength={isSignup ? 6 : 1}
              placeholder={isSignup ? 'At least 6 characters' : ''}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <div className="auth-foot">
          <span>
            {isSignup ? 'Already have an account? ' : "Don't have an account? "}
            <Link to={isSignup ? '/login' : '/signup'} state={location.state}>
              {isSignup ? 'Sign in' : 'Sign up'}
            </Link>
          </span>
          <span>
            Or explore the <Link to="/lab">CRDT Lab</Link>, no account needed
          </span>
        </div>
      </div>
    </div>
  )
}
