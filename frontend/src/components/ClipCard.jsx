import { useState } from 'react'
import { mediaUrl } from '../api'
import { ScoreBadge } from './Bits'
import { CLIP_STATUS, bytes, clock } from '../utils'

export default function ClipCard({ clip, selected, onSelect, onAction, disabled, onEdit }) {
  const [playing, setPlaying] = useState(false)
  const [showWhy, setShowWhy] = useState(false)
  const playable = clip.fileStatus === 'ok' && clip.url

  return (
    <article className={`clip-card status-${clip.status} ${selected ? 'clip-selected' : ''}`} aria-label={clip.title}>
      <div className="clip-media">
        {playing && playable ? (
          <video src={mediaUrl(clip.url)} controls autoPlay preload="metadata" />
        ) : (
          <button type="button" className="thumb" onClick={() => playable && setPlaying(true)} disabled={!playable} aria-label={`Assistir ${clip.title}`}>
            {clip.thumbUrl ? <img src={mediaUrl(clip.thumbUrl)} alt="" loading="lazy" /> : <span className="thumb-placeholder" />}
            {playable ? <span className="play">▶</span> : <span className="thumb-state">{clip.fileStatus === 'missing' ? 'Arquivo ausente' : clip.fileStatus === 'failed' ? 'Falhou' : clip.fileStatus === 'rendering' ? 'Renderizando…' : '—'}</span>}
            <span className="duration-tag">{Math.round(clip.duration)}s</span>
          </button>
        )}
        <label className="clip-check">
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Selecionar ${clip.title}`} />
        </label>
        <span className={`clip-status ${clip.status}`}>{CLIP_STATUS[clip.status]}</span>
      </div>
      <div className="clip-info">
        <div className="clip-title-row">
          <strong title={clip.title}>{clip.title}</strong>
          <ScoreBadge score={clip.score} />
        </div>
        <small>
          Origem {clock(clip.start)}–{clock(clip.end)} • {Math.round(clip.duration)}s
          {clip.version > 1 ? ` • versão ${clip.version}` : ''}
          {clip.sizeBytes ? ` • ${bytes(clip.sizeBytes)}` : ''}
          {clip.captionsApplied ? ' • legendado' : ''}
        </small>
        {clip.error && <small className="error">{clip.error}</small>}
        {(clip.reasons?.length > 0 || clip.transcript) && (
          <button type="button" className="why" onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy}>
            {showWhy ? '▾' : '▸'} {clip.score != null ? 'Por que essa nota?' : 'Detalhes'}
          </button>
        )}
        {showWhy && (
          <div className="why-box">
            {clip.score != null && <p className="hint">Nota interna do algoritmo, baseada nos sinais abaixo — não é probabilidade de viralizar.</p>}
            <ul>
              {clip.reasons?.map((r) => <li key={r}>{r}</li>)}
              {clip.penalties?.map((p) => <li key={p} className="penalty">− {p}</li>)}
            </ul>
            {clip.breakdown && clip.score != null && (
              <div className="breakdown">
                {['reaction', 'speech', 'audio', 'visual', 'context', 'scene'].map((k) => (
                  <div key={k} className="bar-row">
                    <span>{{ reaction: 'Reação', speech: 'Fala', audio: 'Áudio', visual: 'Visual', context: 'Contexto', scene: 'Cenas' }[k]}</span>
                    <div className="mini-bar"><div style={{ width: `${Math.round((clip.breakdown[k] || 0) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
            {clip.transcript && <blockquote>“{clip.transcript.slice(0, 280)}{clip.transcript.length > 280 ? '…' : ''}”</blockquote>}
          </div>
        )}
        <div className="clip-actions">
          <button type="button" className={`chip-btn ok ${clip.status === 'approved' ? 'on' : ''}`} disabled={disabled} onClick={() => onAction('approve')}>✓ Aprovar</button>
          <button type="button" className={`chip-btn bad ${clip.status === 'discarded' ? 'on' : ''}`} disabled={disabled} onClick={() => onAction('discard')}>✕ Descartar</button>
          <button type="button" className="chip-btn" disabled={!playable} onClick={() => setPlaying(true)}>▶ Assistir</button>
          {playable ? (
            <a className="chip-btn" href={mediaUrl(clip.downloadUrl)} download>↓ Baixar</a>
          ) : (
            <span className="chip-btn disabled">↓ Baixar</span>
          )}
          {clip.srtUrl && <a className="chip-btn" href={mediaUrl(clip.srtUrl)} download>SRT</a>}
          <button type="button" className="chip-btn" disabled={!clip.editable || disabled} title={clip.editable ? 'Abrir no editor' : 'Clipes da versão anterior não têm trecho de origem salvo'} onClick={onEdit}>✎ Editar</button>
          <button type="button" className="chip-btn bad" disabled={disabled} onClick={() => onAction('delete')}>🗑 Excluir</button>
        </div>
      </div>
    </article>
  )
}
