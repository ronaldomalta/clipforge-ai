import { useEffect, useMemo, useState } from 'react'
import { api, uploadWithProgress } from '../api'
import { useFeedback } from '../components/Feedback'
import { ProgressBar, Segmented, Toggle } from '../components/Bits'
import { bytes, clock } from '../utils'

const EXT = ['.mp4', '.mkv', '.mov', '.webm', '.avi']
export const DEFAULT_OPTIONS = {
  count: 5, duration: 30, format: '9:16', framing: 'fit_blur', quality: 'high',
  smart: true, captions: true, autoEdit: true, captionStyle: 'viral', language: 'auto',
}

export function OptionsForm({ value, onChange, modelInfo }) {
  const set = (patch) => onChange({ ...value, ...patch })
  const custom = ![1, 3, 5, 10].includes(value.count)
  return (
    <div className="options-form">
      <label className="field-label">QUANTIDADE DE CLIPES <strong>{value.count}</strong></label>
      <Segmented
        label="Quantidade"
        value={custom ? 'custom' : value.count}
        onChange={(v) => set({ count: v === 'custom' ? 7 : v })}
        options={[{ value: 1, label: '1' }, { value: 3, label: '3' }, { value: 5, label: '5' }, { value: 10, label: '10' }, { value: 'custom', label: 'Outro' }]}
      />
      {custom && (
        <input aria-label="Quantidade personalizada" className="range" type="range" min="1" max="20" value={value.count} onChange={(e) => set({ count: Number(e.target.value) })} />
      )}

      <label className="field-label">DURAÇÃO</label>
      <Segmented
        label="Duração"
        value={value.duration}
        onChange={(v) => set({ duration: v })}
        options={[15, 30, 45, 60, 90].map((n) => ({ value: n, label: `${n}s` })).concat([{ value: 'auto', label: 'Auto', title: 'A IA ajusta a duração ao acontecimento (12–75 s)' }])}
      />
      {value.duration === 'auto' && !value.smart && <small className="hint">Duração automática precisa da seleção inteligente; sem ela usaremos 30 s.</small>}

      <label className="field-label">FORMATO</label>
      <Segmented
        label="Formato"
        value={value.format}
        onChange={(v) => set({ format: v })}
        options={[{ value: '9:16', label: '9:16 · TikTok/Reels' }, { value: '16:9', label: '16:9 · YouTube' }, { value: '1:1', label: '1:1' }]}
      />

      <label className="field-label">ENQUADRAMENTO</label>
      <Segmented
        label="Enquadramento"
        value={value.framing}
        onChange={(v) => set({ framing: v })}
        options={[
          { value: 'fit_blur', label: 'Gameplay completa', title: 'Vídeo inteiro centralizado com fundo desfocado (não perde as laterais)' },
          { value: 'smart_crop', label: 'Smart crop', title: 'Recorte que acompanha a região com mais movimento' },
          { value: 'center_crop', label: 'Corte central' },
        ]}
      />

      <label className="field-label">QUALIDADE DE EXPORTAÇÃO</label>
      <Segmented
        label="Qualidade"
        value={value.quality}
        onChange={(v) => set({ quality: v })}
        options={[{ value: 'high', label: 'Alta' }, { value: 'balanced', label: 'Equilibrada' }, { value: 'fast', label: 'Rápida (720p)' }]}
      />

      <div className="toggles">
        <Toggle label="Seleção inteligente" hint="Áudio, fala, reações e visão computacional" checked={value.smart} onChange={(v) => set({ smart: v })} />
        <Toggle label="Legendas automáticas" hint="Transcrição local (faster-whisper) com destaque da palavra" checked={value.captions} onChange={(v) => set({ captions: v })} />
        {value.captions && (
          <div className="sub-options">
            <Segmented
              label="Estilo da legenda"
              value={value.captionStyle}
              onChange={(v) => set({ captionStyle: v })}
              options={[{ value: 'classic', label: 'Classic' }, { value: 'viral', label: 'Viral' }, { value: 'neon', label: 'Neon' }, { value: 'minimal', label: 'Minimal' }]}
            />
            <Segmented
              label="Idioma"
              value={value.language}
              onChange={(v) => set({ language: v })}
              options={[{ value: 'auto', label: 'Detectar idioma' }, { value: 'pt', label: 'Português' }, { value: 'en', label: 'English' }]}
            />
          </div>
        )}
        <Toggle label="Auto Editor" hint="Zoom suave no pico, cor e normalização de áudio" checked={value.autoEdit} onChange={(v) => set({ autoEdit: v })} />
      </div>

      {modelInfo && (value.smart || value.captions) && !modelInfo.cached && (
        <div className="info-box warn">
          {modelInfo.whisperInstalled ? (
            <>
              O modelo de transcrição <strong>{modelInfo.name}</strong> (~{modelInfo.sizeMB} MB) ainda não foi baixado.
              <label className="inline-check">
                <input type="checkbox" checked={!!value.allowModelDownload} onChange={(e) => set({ allowModelDownload: e.target.checked })} />
                Permitir baixar o modelo do HuggingFace durante este processamento
              </label>
              Sem ele a IA usa só áudio e imagem, e as legendas ficam desativadas.
            </>
          ) : (
            <>O <strong>faster-whisper</strong> não está instalado: sem transcrição/legendas. Rode <code>install-windows.bat</code> e veja Configurações → Diagnóstico.</>
          )}
        </div>
      )}
    </div>
  )
}

export function toPayload(o) {
  return {
    count: o.count, duration: o.duration, format: o.format, framing: o.framing, quality: o.quality,
    smart: o.smart, captions: o.captions, autoEdit: o.autoEdit, captionStyle: o.captionStyle,
    language: o.language, allowModelDownload: !!o.allowModelDownload,
  }
}

export function useModelInfo() {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let alive = true
    Promise.all([api('/api/system/diagnostics'), api('/api/settings')])
      .then(([diag, settings]) => {
        if (!alive) return
        const model = diag.models?.find((m) => m.name === settings.whisperModel)
        setInfo({ name: settings.whisperModel, sizeMB: model?.sizeMB, cached: !!model?.cached, whisperInstalled: !!diag.python?.faster_whisper })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return info
}

export default function CreatePage({ navigate }) {
  const { toast } = useFeedback()
  const [source, setSource] = useState('file')
  const [file, setFile] = useState(null)
  const [fileMeta, setFileMeta] = useState(null)
  const [url, setUrl] = useState('')
  const [video, setVideo] = useState(null)
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [uploadPct, setUploadPct] = useState(null)
  const [error, setError] = useState('')
  const modelInfo = useModelInfo()

  const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => objectUrl && URL.revokeObjectURL(objectUrl), [objectUrl])

  function pickFile(f) {
    setError('')
    setFileMeta(null)
    if (!f) return setFile(null)
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
    if (!EXT.includes(ext)) {
      setFile(null)
      return setError('Formato não suportado. Use MP4, MKV, MOV, WEBM ou AVI.')
    }
    setFile(f)
  }

  async function analyzeUrl() {
    setError('')
    setVideo(null)
    if (!url.trim()) return setError('Cole um link do YouTube.')
    setBusy(true)
    try {
      setVideo(await api('/api/videos/info', { method: 'POST', body: { url } }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (source === 'file' && !file) return setError('Escolha uma gravação (MP4, MKV, MOV, WEBM ou AVI).')
    if (source === 'youtube' && !url.trim()) return setError('Cole a URL do YouTube.')
    setBusy(true)
    try {
      let project
      if (source === 'file') {
        const form = new FormData()
        Object.entries(toPayload(options)).forEach(([k, v]) => form.append(k, String(v)))
        form.append('video', file)
        setUploadPct(0)
        project = await uploadWithProgress('/api/projects/upload', form, setUploadPct)
      } else {
        project = await api('/api/projects', { method: 'POST', body: { source: { type: 'youtube', url, title: video?.title }, options: toPayload(options) } })
      }
      toast('Projeto enviado para processamento!')
      navigate('library', project.id)
    } catch (err) {
      setError(err.message || 'Não foi possível iniciar o projeto.')
    } finally {
      setBusy(false)
      setUploadPct(null)
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AI VIDEO WORKFLOW</span>
          <h1>Criar cortes <em>incríveis.</em></h1>
          <p>Transforme um vídeo longo em até 20 clipes prontos para redes sociais.</p>
        </div>
      </div>
      <form onSubmit={submit} className="create-grid" noValidate>
        <div className="panel upload-panel">
          <h3>01 / Fonte do vídeo</h3>
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={source === 'file'} className={source === 'file' ? 'selected' : ''} onClick={() => setSource('file')}>▣ Arquivo local</button>
            <button type="button" role="tab" aria-selected={source === 'youtube'} className={source === 'youtube' ? 'selected' : ''} onClick={() => setSource('youtube')}>▶ YouTube</button>
            <button type="button" role="tab" className="" onClick={() => navigate('live')}>◉ Pasta de gravações</button>
          </div>
          {source === 'file' ? (
            <>
              <label className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]) }}>
                <input type="file" data-testid="file-input" accept={EXT.join(',')} onChange={(e) => pickFile(e.target.files?.[0] || null)} />
                <span className="drop-icon">⇧</span>
                <strong>{file ? file.name : 'Escolha ou arraste sua gravação'}</strong>
                <small>{file ? `${bytes(file.size)}${fileMeta ? ` • ${clock(fileMeta.duration)} • ${fileMeta.width}×${fileMeta.height}` : ''}` : 'MP4, MKV, MOV, WEBM ou AVI • até 20 GB'}</small>
                <span className="fake-button">Selecionar arquivo</span>
              </label>
              {objectUrl && (
                <video className="hidden-probe" src={objectUrl} preload="metadata" muted
                  onLoadedMetadata={(e) => setFileMeta({ duration: e.currentTarget.duration, width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })} />
              )}
              {file && file.size > 4 * 1024 ** 3 && (
                <div className="info-box">Arquivo grande: o envio copia o vídeo para o ClipForge. Para lives de 3–4 h, configure a <button type="button" className="link" onClick={() => navigate('settings')}>pasta de gravações</button> e importe sem copiar.</div>
              )}
            </>
          ) : (
            <div className="url-box">
              <label htmlFor="yt-url">URL DO VÍDEO</label>
              <input id="yt-url" type="url" placeholder="https://www.youtube.com/watch?v=..." value={url} onChange={(e) => { setUrl(e.target.value); setVideo(null) }} />
              <button type="button" className="secondary" onClick={analyzeUrl} disabled={busy}>{busy ? 'Analisando...' : 'Analisar vídeo'}</button>
              {video && (
                <div className="video-info">
                  {video.thumbnail && <img src={video.thumbnail} alt="" />}
                  <div><strong>{video.title}</strong><small>{video.uploader} • {clock(video.duration || 0)}</small></div>
                </div>
              )}
              <p className="hint">Use apenas vídeos seus ou que você tem autorização para editar.</p>
            </div>
          )}
          <div className="info-box">Gravações de 3–4 horas são processadas em segundo plano, em partes, sem carregar o vídeo inteiro na memória. A gravação original nunca é apagada.</div>
        </div>
        <div className="panel settings-panel">
          <h3>02 / Configurar geração</h3>
          <OptionsForm value={options} onChange={setOptions} modelInfo={modelInfo} />
          {uploadPct != null && (
            <div className="upload-progress">
              <small>Enviando arquivo... {Math.round(uploadPct * 100)}%</small>
              <ProgressBar value={uploadPct * 100} label="Envio do arquivo" />
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="primary generate" disabled={busy}>{busy ? (uploadPct != null ? 'Enviando...' : 'Iniciando...') : '✦ Gerar clipes agora →'}</button>
        </div>
      </form>
    </>
  )
}
