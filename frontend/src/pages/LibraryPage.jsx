import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { useFeedback } from '../components/Feedback'
import { Empty, ProgressBar, StatusPill } from '../components/Bits'
import ClipCard from '../components/ClipCard'
import { clock, dateTime, isBusy } from '../utils'

export default function LibraryPage({ navigate, projectId }) {
  const projects = usePoll(() => api('/api/projects'), (list) => (list?.some((p) => isBusy(p.status)) ? 2000 : 10000))
  const list = projects.data || []
  const activeId = projectId || list[0]?.id || null

  if (projects.loading && !projects.data) return <p className="hint">Carregando biblioteca…</p>

  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">YOUR CONTENT LIBRARY</span>
        <h1>Meus <em>clipes.</em></h1>
        <p>Assista, aprove, descarte, edite e exporte os cortes de cada projeto.</p>
      </div>
      {projects.error && <p className="error">{projects.error.message}</p>}
      {list.length === 0 ? (
        <Empty title="Nenhum projeto ainda" action={<button type="button" className="primary" onClick={() => navigate('create')}>Criar projeto</button>}>
          Crie seu primeiro projeto para ver os clipes aqui.
        </Empty>
      ) : (
        <div className="library-layout">
          <div className="job-list" role="list">
            {list.map((p) => (
              <button type="button" role="listitem" key={p.id} className={`job-row ${activeId === p.id ? 'chosen' : ''}`} onClick={() => navigate('library', p.id)}>
                <span className="job-icon">▣</span>
                <span className="job-name">
                  <strong>{p.name}</strong>
                  <small>{dateTime(p.createdAt)} • {p.counts?.total ?? 0} clipe(s){p.counts?.approved ? ` • ${p.counts.approved} aprovado(s)` : ''}</small>
                </span>
                <StatusPill status={p.status} />
                {isBusy(p.status) && <span className="job-percent">{p.progress}%</span>}
              </button>
            ))}
          </div>
          {activeId && <ProjectDetail key={activeId} id={activeId} navigate={navigate} onChanged={projects.refresh} />}
        </div>
      )}
    </>
  )
}

export function ProjectDetail({ id, navigate, onChanged }) {
  const { toast, confirm } = useFeedback()
  const project = usePoll(() => api(`/api/projects/${encodeURIComponent(id)}`), (p) => (p && (isBusy(p.status) || p.clips?.some((c) => c.fileStatus === 'rendering')) ? 1500 : 0), [id])
  const p = project.data
  const [selected, setSelected] = useState(() => new Set())
  const [filter, setFilter] = useState('all')
  const [working, setWorking] = useState(false)

  const clips = useMemo(() => p?.clips || [], [p])
  useEffect(() => {
    setSelected((old) => new Set([...old].filter((cid) => clips.some((c) => c.id === cid))))
  }, [clips])

  if (project.error) return <div className="panel detail"><p className="error">{project.error.message}</p></div>
  if (!p) return <div className="panel detail"><p className="hint">Carregando projeto…</p></div>

  const busy = isBusy(p.status)
  const visible = clips.filter((c) => filter === 'all' || c.status === filter)
  const counts = { pending: 0, approved: 0, discarded: 0 }
  clips.forEach((c) => (counts[c.status] += 1))
  const ids = [...selected]

  async function run(fn, success) {
    setWorking(true)
    try {
      const r = await fn()
      if (success) toast(typeof success === 'function' ? success(r) : success)
      await project.refresh()
      onChanged?.()
      return r
    } catch (e) {
      toast(e.message, 'error')
      return null
    } finally {
      setWorking(false)
    }
  }

  const batch = (action, list = ids) => run(() => api('/api/clips/batch', { method: 'POST', body: { ids: list, action } }), action === 'approve' ? `${list.length} clipe(s) aprovado(s).` : `${list.length} clipe(s) marcado(s) para descarte.`)

  async function clipAction(clip, action) {
    if (action === 'delete') {
      const ok = await confirm({ title: 'Excluir clipe?', message: `"${clip.title}" será apagado do disco. A gravação original não é afetada.`, confirmLabel: 'Excluir', danger: true })
      if (!ok) return
      return run(() => api(`/api/clips/${encodeURIComponent(clip.id)}`, { method: 'DELETE', body: { confirm: true } }), 'Clipe excluído.')
    }
    return batch(action, [clip.id])
  }

  async function finalize() {
    const toDelete = clips.filter((c) => c.status === 'discarded')
    if (!toDelete.length) {
      const ok = await confirm({ title: 'Finalizar revisão?', message: 'Nenhum clipe está marcado como descartado. A revisão será apenas marcada como concluída.', confirmLabel: 'Finalizar' })
      if (!ok) return
    } else {
      const ok = await confirm({
        title: `Excluir ${toDelete.length} clipe(s) descartado(s)?`,
        message: `${counts.approved} aprovado(s) e ${counts.pending} pendente(s) serão mantidos. Esta ação apaga os arquivos dos descartados e não pode ser desfeita. A gravação original nunca é apagada.`,
        details: toDelete.slice(0, 8).map((c) => `${c.title} (${clock(c.start)})`),
        confirmLabel: `Excluir ${toDelete.length} arquivo(s)`,
        danger: true,
      })
      if (!ok) return
    }
    await run(() => api(`/api/projects/${encodeURIComponent(p.id)}/review/finalize`, { method: 'POST', body: { confirm: true } }), (r) => `Revisão finalizada: ${r.deleted} excluído(s), ${r.kept} mantido(s).`)
  }

  async function exportApproved() {
    await run(() => api(`/api/projects/${encodeURIComponent(p.id)}/export`, { method: 'POST', body: {} }), (r) => `${r.files.length} clipe(s) copiado(s) para ${r.folder}`)
  }

  async function deleteProject() {
    const ok = await confirm({ title: 'Excluir projeto inteiro?', message: 'Todos os clipes, legendas e trechos salvos deste projeto serão apagados. Gravações originais em pastas suas não são tocadas.', confirmLabel: 'Excluir projeto', danger: true })
    if (!ok) return
    const r = await run(() => api(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE', body: { confirm: true } }), 'Projeto excluído.')
    if (r) navigate('library')
  }

  const a = p.analysis || {}
  return (
    <section className="panel detail" aria-label={`Projeto ${p.name}`}>
      <div className="detail-head">
        <div>
          <h3>{p.name}</h3>
          <small className="muted-text">
            {dateTime(p.createdAt)}
            {p.media?.duration ? ` • ${clock(p.media.duration)}` : ''}
            {p.media?.width ? ` • ${p.media.width}×${p.media.height} ${Math.round(p.media.fps)} fps` : ''}
            {` • ${p.settings?.count} × ${p.settings?.duration === 'auto' ? 'auto' : `${p.settings?.duration}s`} • ${p.settings?.format}`}
          </small>
        </div>
        <div className="detail-actions">
          {busy && <button type="button" className="secondary" disabled={working} onClick={() => run(() => api(`/api/projects/${encodeURIComponent(p.id)}/cancel`, { method: 'POST' }), 'Cancelamento solicitado.')}>■ Cancelar</button>}
          {['failed', 'interrupted', 'canceled'].includes(p.status) && (
            <button type="button" className="secondary" disabled={working} onClick={() => run(() => api(`/api/projects/${encodeURIComponent(p.id)}/retry`, { method: 'POST' }), 'Projeto retomado.')}>↻ Retomar</button>
          )}
          {!busy && <button type="button" className="ghost-danger" disabled={working} onClick={deleteProject}>Excluir projeto</button>}
        </div>
      </div>

      {(busy || p.status !== 'completed') && (
        <>
          <p className="step-line"><StatusPill status={p.status} /> {p.step}</p>
          <ProgressBar value={p.progress} label="Progresso do projeto" />
        </>
      )}
      {p.error && <p className="error">{p.error}</p>}
      {a.message && <div className="info-box warn">{a.message}</div>}
      {a.warnings?.length > 0 && (
        <details className="warnings">
          <summary>{a.warnings.length} aviso(s) da análise</summary>
          <ul>{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}
      {p.status === 'completed' && a.engine && (
        <p className="hint">
          Motor: {a.engine === 'uniform' ? 'cortes uniformes (seleção inteligente desligada)' : a.engine === 'fallback' ? 'cortes uniformes (IA falhou)' : a.engine}
          {a.capabilities ? ` • transcrição ${a.capabilities.transcription ? `sim (${a.language || '?'})` : 'não'} • visão ${a.capabilities.vision ? 'sim' : 'não'}` : ''}
        </p>
      )}

      {clips.length > 0 && (
        <div className="review-bar">
          <div>
            <strong>{p.reviewedAt ? '✓ Revisão finalizada' : 'Revisão dos cortes'}</strong>
            <small>{counts.approved} aprovado(s) • {counts.discarded} descartado(s) • {counts.pending} pendente(s) • {selected.size} selecionado(s)</small>
          </div>
          <div className="review-actions">
            <button type="button" className="secondary" onClick={() => setSelected(new Set(visible.map((c) => c.id)))}>Selecionar todos</button>
            <button type="button" className="secondary" onClick={() => setSelected(new Set())}>Desmarcar todos</button>
            <button type="button" className="secondary" disabled={!selected.size || working || busy} onClick={() => batch('approve')}>✓ Aprovar selecionados</button>
            <button type="button" className="secondary" disabled={!selected.size || working || busy} onClick={() => batch('discard')}>✕ Descartar selecionados</button>
            <button type="button" className="primary" disabled={working || busy || p.status !== 'completed'} onClick={finalize}>Finalizar revisão</button>
            {counts.approved > 0 && <button type="button" className="secondary" disabled={working} onClick={exportApproved}>⇩ Exportar aprovados</button>}
          </div>
        </div>
      )}

      {clips.length > 0 && (
        <div className="filter-row" role="tablist" aria-label="Filtrar clipes">
          {[['all', `Todos (${clips.length})`], ['pending', `Pendentes (${counts.pending})`], ['approved', `Aprovados (${counts.approved})`], ['discarded', `Descartados (${counts.discarded})`]].map(([v, l]) => (
            <button type="button" role="tab" key={v} aria-selected={filter === v} className={filter === v ? 'selected' : ''} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>
      )}

      <div className="clip-grid">
        {visible.map((c) => (
          <ClipCard
            key={c.id}
            clip={c}
            selected={selected.has(c.id)}
            disabled={working || busy}
            onSelect={(on) => setSelected((old) => { const n = new Set(old); if (on) n.add(c.id); else n.delete(c.id); return n })}
            onAction={(action) => clipAction(c, action)}
            onEdit={() => navigate('editor', c.id)}
          />
        ))}
      </div>
      {p.status === 'completed' && clips.length === 0 && <p className="hint">Nenhum clipe neste projeto.</p>}
    </section>
  )
}
