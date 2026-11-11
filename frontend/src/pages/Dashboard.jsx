import { api } from '../api'
import { usePoll } from '../hooks'
import { StatusPill } from '../components/Bits'
import { bytes, dateTime, hours } from '../utils'

export default function Dashboard({ navigate }) {
  const { data: stats, error } = usePoll(() => api('/api/stats'), (d) => (d?.projects?.processing ? 3000 : 15000))
  const s = stats || { projects: {}, clips: {}, storage: {}, recent: [] }

  const cards = [
    ['PROJETOS', s.projects.total, 'Processamentos registrados'],
    ['CLIPES GERADOS', s.clips.generated, 'Total desde o início'],
    ['APROVADOS', s.clips.approved, 'Prontos para postar'],
    ['DESCARTADOS', s.clips.discarded, 'Removidos na revisão'],
    ['CONCLUÍDOS', s.projects.completed, 'Projetos finalizados'],
    ['EM PROCESSAMENTO', s.projects.processing, 'Na fila ou renderizando'],
    ['VÍDEO ANALISADO', stats ? hours(s.processedSeconds) : '—', 'Tempo de gravação processado'],
    ['ESPAÇO UTILIZADO', stats ? bytes(s.storage.totalBytes) : '—', stats?.storage?.freeBytes != null ? `${bytes(s.storage.freeBytes)} livres no disco` : 'Arquivos gerados'],
  ]

  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <div className="eyebrow">✦ WELCOME TO THE NEXT LEVEL</div>
          <h1>Transforme momentos<br />em <em>conteúdo viral.</em></h1>
          <p>Da sua live para o feed. Encontre, edite e exporte os melhores momentos de GTA e outros jogos, tudo no seu PC.</p>
          <div className="hero-actions">
            <button type="button" className="primary" onClick={() => navigate('create')}>✂ Criar meus cortes <span>↗</span></button>
            <button type="button" className="ghost" onClick={() => navigate('library')}>Ver biblioteca →</button>
          </div>
        </div>
        <div className="hero-graphic" aria-hidden>
          <div className="sun" />
          <div className="palm palm-left">✳</div>
          <div className="palm palm-right">✳</div>
          <div className="hero-glass">▶<span>AI CLIP ENGINE</span></div>
        </div>
      </section>

      <div className="section-title">
        <div><span className="eyebrow">SEU ESTÚDIO</span><h2>Visão geral</h2></div>
        <span className="chip">● v1.0 LOCAL</span>
      </div>
      {error && <p className="error">Não foi possível carregar as estatísticas: {error.message}</p>}
      <div className="stats">
        {cards.map(([label, value, hint]) => (
          <div className="stat" key={label}>
            <span>{label}</span>
            <strong>{value ?? '—'}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>

      <div className="two-col">
        <div className="panel">
          <h3>◷ Histórico recente</h3>
          {s.recent?.length ? (
            <ul className="recent-list">
              {s.recent.map((p) => (
                <li key={p.id}>
                  <button type="button" className="link-row" onClick={() => navigate('library', p.id)}>
                    <span className="recent-name"><strong>{p.name}</strong><small>{dateTime(p.createdAt)} • {p.step}</small></span>
                    <StatusPill status={p.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nenhum projeto ainda. Importe uma gravação para começar.</p>
          )}
        </div>
        <div className="panel">
          <h3>◉ Como a IA escolhe os cortes</h3>
          <p>Combina sinais medidos de verdade: picos de áudio acima do nível local, voz alta, expressões de reação na transcrição, sons de impacto, movimento e clarões na imagem e mudanças de cena. Cada clipe mostra a nota e os motivos.</p>
          <span className="hint">A nota é uma avaliação interna do algoritmo — não é probabilidade de viralizar.</span>
        </div>
      </div>
    </>
  )
}
