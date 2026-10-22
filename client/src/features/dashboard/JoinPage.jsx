import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../../api/client.js'

export default function JoinPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/docs/join/${token}`, { method: 'POST' })
      .then(({ doc }) => navigate(`/d/${doc.id}`, { replace: true }))
      .catch((e) => setError(e.message))
  }, [token])

  return (
    <div className="center">
      {error ? (
        <div className="card">
          <p className="error">{error}</p>
          <Link to="/">Back to dashboard</Link>
        </div>
      ) : (
        <p className="muted">Joining document…</p>
      )}
    </div>
  )
}
