export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function preciseClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  const base = clock(s)
  return `${base}.${Math.floor((s % 1) * 10)}`
}

export function bytes(n) {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function hours(seconds) {
  const s = Number(seconds) || 0
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

export const STATUS_LABEL = {
  queued: 'Na fila',
  running: 'Processando',
  completed: 'Concluído',
  failed: 'Falhou',
  canceled: 'Cancelado',
  interrupted: 'Interrompido',
}

export const CLIP_STATUS = { pending: 'Pendente', approved: 'Aprovado', discarded: 'Descartado' }

export const isBusy = (status) => status === 'queued' || status === 'running'

export function dateTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}
