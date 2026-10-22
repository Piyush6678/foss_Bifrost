import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './features/auth/AuthContext.jsx'
import AuthPage from './features/auth/AuthPage.jsx'
import Dashboard from './features/dashboard/Dashboard.jsx'
import DocPage from './features/dashboard/DocPage.jsx'
import JoinPage from './features/dashboard/JoinPage.jsx'
import Lab from './features/lab/Lab.jsx'

function Protected({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="center muted">Loading…</div>
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/signup" element={<AuthPage mode="signup" />} />
      <Route path="/lab" element={<Lab />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/d/:id" element={<Protected><DocPage /></Protected>} />
      <Route path="/join/:token" element={<Protected><JoinPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
