import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

const KEY = 'collab-theme'
const ORDER = ['system', 'light', 'dark']
const META = {
  system: { Icon: Monitor, label: 'System theme' },
  light: { Icon: Sun, label: 'Light theme' },
  dark: { Icon: Moon, label: 'Dark theme' },
}

function read() {
  try {
    return ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system'
  } catch {
    return 'system'
  }
}

/** Applies a theme by setting data-theme on <html>; 'system' removes it so the OS preference wins. */
export function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* private mode: theme just won't persist */
    }
  }, [theme])
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
  const { Icon, label } = META[theme]
  return (
    <button className="btn ghost icon sm" onClick={() => setTheme(next)} title={`${label} · click for ${META[next].label.toLowerCase()}`} aria-label={label}>
      <Icon size={15} />
    </button>
  )
}
