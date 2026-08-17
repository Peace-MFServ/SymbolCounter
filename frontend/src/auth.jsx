import React, { createContext, useContext, useState, useEffect } from 'react'
import { apiFetch } from './api'

export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      apiFetch('/auth/me')
        .then(u => { if (u) setUser(u) })
        .catch(() => localStorage.removeItem('token'))
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  const login = async (email, password) => {
    const form = new URLSearchParams({ username: email, password })
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (!data) throw new Error('Login failed')
    localStorage.setItem('token', data.access_token)
    setUser(data.user)
    return data.user
  }

  const register = async (email, name, password) => {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    })
    if (!data) throw new Error('Registration failed')
    localStorage.setItem('token', data.access_token)
    setUser(data.user)
    return data.user
  }

  const logout = () => {
    localStorage.removeItem('token')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

// ── Login page ────────────────────────────────────────────────────────────────
export function LoginPage({ onNavigate }) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [pass,  setPass]  = useState('')
  const [busy,  setBusy]  = useState(false)
  const { showToast } = useToastHelper()

  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      await login(email, pass)
      onNavigate('dashboard')
    } catch (err) {
      showToast(err.message || 'Invalid email or password', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="logo">MF <span>Symbol Counter</span></div>
        <div className="subtitle">Sign in to your account</div>
        <div className="card">
          <form onSubmit={submit}>
            <div className="form-group">
              <label>Email</label>
              <input className="form-control" type="email" placeholder="you@example.com"
                     value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input className="form-control" type="password" placeholder="••••••••"
                     value={pass} onChange={e => setPass(e.target.value)} required />
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
                    type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Sign In'}
            </button>
          </form>
        </div>
        <div className="auth-footer">
          Don't have an account?{' '}
          <a onClick={() => onNavigate('register')} style={{ cursor: 'pointer' }}>Register</a>
        </div>
      </div>
    </div>
  )
}

// ── Register page ─────────────────────────────────────────────────────────────
export function RegisterPage({ onNavigate }) {
  const { register } = useAuth()
  const [name,  setName]  = useState('')
  const [email, setEmail] = useState('')
  const [pass,  setPass]  = useState('')
  const [busy,  setBusy]  = useState(false)
  const { showToast } = useToastHelper()

  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      await register(email, name, pass)
      onNavigate('dashboard')
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="logo">MF <span>Symbol Counter</span></div>
        <div className="subtitle">Create your account</div>
        <div className="card">
          <form onSubmit={submit}>
            <div className="form-group">
              <label>Full Name</label>
              <input className="form-control" placeholder="Your name"
                     value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input className="form-control" type="email" placeholder="you@example.com"
                     value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input className="form-control" type="password" placeholder="Min. 8 characters"
                     value={pass} onChange={e => setPass(e.target.value)} required minLength={8} />
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
                    type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create Account'}
            </button>
          </form>
        </div>
        <div className="auth-footer">
          Already have an account?{' '}
          <a onClick={() => onNavigate('login')} style={{ cursor: 'pointer' }}>Sign in</a>
        </div>
      </div>
    </div>
  )
}

// Tiny helper to avoid importing toast in auth (circular)
function useToastHelper() {
  const showToast = (msg, type = 'info') => {
    const el = document.createElement('div')
    el.className = `toast toast-${type}`
    el.textContent = msg
    const c = document.getElementById('toast-container')
    if (c) c.appendChild(el)
    setTimeout(() => el.remove(), 3500)
  }
  return { showToast }
}
