import { useEffect, useState } from 'react'
import './App.css'
import { api } from './api'
import { useHashRoute } from './hooks'
import { FeedbackProvider } from './components/Feedback'
import Dashboard from './pages/Dashboard'
import CreatePage from './pages/CreatePage'
import LibraryPage from './pages/LibraryPage'
import EditorPage from './pages/EditorPage'
import LivePage from './pages/LivePage'
import SettingsPage from './pages/SettingsPage'

export const NAV = [
  { id: 'dashboard', icon: '◈', label: 'Dashboard' },
  { id: 'create', icon: '✂', label: 'Criar cortes' },
  { id: 'library', icon: '▤', label: 'Meus clipes' },
  { id: 'editor', icon: '✎', label: 'Editor' },
  { id: 'live', icon: '◉', label: 'Live AI' },
  { id: 'settings', icon: '⚙', label: 'Configurações' },
]

function Shell() {
  const [route, navigate] = useHashRoute()
  const [online, setOnline] = useState(null)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const h = await api('/api/health')
        if (!alive) return
        setOnline(true)
        setPending((h.queue?.running || 0) + (h.queue?.queued || 0))
      } catch {
        if (alive) setOnline(false)
      }
    }
    check()
    const t = setInterval(check, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const page = NAV.some((n) => n.id === route.page) ? route.page : 'dashboard'
  const current = NAV.find((n) => n.id === page)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">✦</span>
          <div>
            <strong>CLIPFORGE<span> AI</span></strong>
            <small>VICE CITY STUDIO</small>
          </div>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Navegação principal">
          {NAV.map((item) => (
            <button key={item.id} type="button" className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
              <span className="nav-icon" aria-hidden>{item.icon}</span>
              {item.label}
              {item.id === 'library' && pending > 0 && <span className="nav-count" title="Tarefas em andamento">{pending}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="neon-card">
            <span>✦ LOCAL CREATOR</span>
            <strong>Seu estúdio. Suas regras.</strong>
            <p>IA local, exportação livre e zero marca-d'água.</p>
          </div>
          <div className="profile">
            <span className="profile-avatar">CF</span>
            <div>
              <strong>Meu workspace</strong>
              <small>Windows • Local</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="muted">WORKSPACE</span>
            <span className="slash">/</span>
            <strong>{current?.label}</strong>
          </div>
          <div className="top-right">
            <span className={`online ${online === false ? 'offline' : ''}`} />
            {online === false ? 'SERVIDOR OFFLINE' : 'LOCAL STUDIO'}
            <span className="avatar">CF</span>
          </div>
        </header>
        {online === false && (
          <div className="offline-banner" role="alert">
            O servidor local não está respondendo. Abra o ClipForge pelo <code>start-clipforge.bat</code> (ou rode <code>npm start</code> em <code>backend</code>).
          </div>
        )}
        <div className="content">
          {page === 'dashboard' && <Dashboard navigate={navigate} />}
          {page === 'create' && <CreatePage navigate={navigate} />}
          {page === 'library' && <LibraryPage navigate={navigate} projectId={route.param} />}
          {page === 'editor' && <EditorPage navigate={navigate} clipId={route.param} />}
          {page === 'live' && <LivePage navigate={navigate} />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <FeedbackProvider>
      <Shell />
    </FeedbackProvider>
  )
}
