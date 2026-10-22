import { usePresence } from '../../crdt/hooks.js'

export default function PresenceBar({ awareness }) {
  const people = usePresence(awareness)
  // Same user may have several tabs open; show each person once.
  const unique = [...new Map(people.map((p) => [p.user.id + (p.self ? ':self' : ''), p])).values()]
  if (unique.length <= 1) return <div className="presence-bar" />
  return (
    <div className="presence-bar" title={`${unique.length} people here`}>
      {unique.slice(0, 5).map((p) => (
        <span
          key={p.clientId}
          className={`avatar ${p.self ? 'self' : ''}`}
          style={{ background: p.user.color }}
          title={p.self ? `${p.user.name} (you)` : p.user.name}
        >
          {p.user.name[0]?.toUpperCase()}
        </span>
      ))}
      {unique.length > 5 && <span className="avatar more">+{unique.length - 5}</span>}
    </div>
  )
}
