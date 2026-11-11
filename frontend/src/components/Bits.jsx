import { STATUS_LABEL } from '../utils'

export function ProgressBar({ value, label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label || 'Progresso'}>
      <div style={{ width: `${v}%` }} />
    </div>
  )
}

export function StatusPill({ status }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status] || status}</span>
}

export function ScoreBadge({ score }) {
  if (score == null) return <span className="score-badge muted-badge" title="Sem pontuação: cortes uniformes ou clipe da versão anterior">—</span>
  const tier = score >= 75 ? 'high' : score >= 55 ? 'mid' : 'low'
  return (
    <span className={`score-badge ${tier}`} title="Nota interna do algoritmo (não é probabilidade de viralizar)">
      {score}<small>/100</small>
    </span>
  )
}

export function Empty({ icon = '✂', title, children, action }) {
  return (
    <div className="empty panel">
      <span>{icon}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Toggle({ label, hint, checked, onChange, disabled }) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'selected' : ''}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
