import { useState } from 'react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { useFeedback } from '../components/Feedback'
import { Empty } from '../components/Bits'
import { DEFAULT_OPTIONS, OptionsForm, toPayload, useModelInfo } from './CreatePage'
import { bytes, dateTime } from '../utils'

export default function LivePage({ navigate }) {
  const { toast } = useFeedback()
  const recordings = usePoll(() => api('/api/library/recordings'), 0)
  const [chosen, setChosen] = useState(null)
  const [options, setOptions] = useState({ ...DEFAULT_OPTIONS, count: 10 })
  const [busy, setBusy] = useState(false)
  const modelInfo = useModelInfo()
  const items = recordings.data?.items || []
  const dirs = recordings.data?.dirs || []

  async function start() {
    if (!chosen) return
    setBusy(true)
    try {
      const project = await api('/api/projects', { method: 'POST', body: { source: { type: 'library', token: chosen.token }, options: toPayload(options) } })
      toast('Gravação enviada para análise!')
      navigate('library', project.id)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">LIVE TO CLIPS</span>
        <h1>Live <em>AI.</em></h1>
        <p>Terminou a live? Escolha a gravação na sua pasta (OBS, TikTok LIVE Studio…) e a IA encontra os melhores momentos — sem copiar o arquivo de horas.</p>
      </div>
      <div className="create-grid">
        <div className="panel">
          <div className="detail-head">
            <h3>◉ Gravações encontradas</h3>
            <button type="button" className="secondary small" onClick={recordings.refresh}>↻ Atualizar</button>
          </div>
          {dirs.length === 0 ? (
            <Empty icon="◉" title="Nenhuma pasta de gravações configurada" action={<button type="button" className="primary" onClick={() => navigate('settings')}>Configurar pasta</button>}>
              Informe a pasta onde o OBS/TikTok LIVE Studio salva as lives (ex.: C:\Users\PC\Videos). O ClipForge só lê esses arquivos: nunca os altera ou apaga.
            </Empty>
          ) : items.length === 0 ? (
            <p className="hint">Nenhum vídeo em: {dirs.join(', ')}</p>
          ) : (
            <ul className="recording-list">
              {items.map((r) => (
                <li key={r.token}>
                  <button type="button" className={`link-row ${chosen?.token === r.token ? 'chosen' : ''}`} onClick={() => setChosen(r)} aria-pressed={chosen?.token === r.token}>
                    <span className="recent-name"><strong>{r.name}</strong><small>{r.folder}{r.relativePath !== r.name ? ` / ${r.relativePath}` : ''} • {dateTime(r.modifiedAt)}</small></span>
                    <span className="size-tag">{bytes(r.sizeBytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Captura em tempo real e publicação automática ficam para versões futuras; a arquitetura de fila já permite receber gravações contínuas.</p>
        </div>
        <div className="panel settings-panel">
          <h3>Configurar geração</h3>
          <OptionsForm value={options} onChange={setOptions} modelInfo={modelInfo} />
          <button type="button" className="primary generate" disabled={!chosen || busy} onClick={start}>{busy ? 'Iniciando…' : chosen ? `✦ Analisar ${chosen.name}` : 'Selecione uma gravação'}</button>
        </div>
      </div>
    </>
  )
}
