import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, mediaUrl } from '../api'
import { usePoll } from '../hooks'
import { useFeedback } from '../components/Feedback'
import { Empty, ProgressBar, ScoreBadge, Segmented, Toggle } from '../components/Bits'
import { clock, preciseClock } from '../utils'

const FONTS = ['Montserrat ExtraBold', 'Montserrat Black', 'Anton', 'Bebas Neue']
const ASPECT = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1 }

export default function EditorPage({ clipId, navigate }) {
  if (!clipId) return <ClipChooser navigate={navigate} />
  return <Editor key={clipId} clipId={clipId} navigate={navigate} />
}

function ClipChooser({ navigate }) {
  const { data, loading } = usePoll(() => api('/api/clips'), 0)
  const editable = (data || []).filter((c) => c.editable && c.fileStatus === 'ok')
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">QUICK EDITOR</span>
        <h1>Editor de <em>cortes.</em></h1>
        <p>Escolha um clipe para ajustar início, fim, legendas e enquadramento.</p>
      </div>
      {loading ? <p className="hint">Carregando…</p> : editable.length === 0 ? (
        <Empty icon="✎" title="Nenhum clipe editável" action={<button type="button" className="primary" onClick={() => navigate('create')}>Criar cortes</button>}>
          Clipes gerados por esta versão guardam o trecho de origem e podem ser reeditados.
        </Empty>
      ) : (
        <div className="chooser-grid">
          {editable.map((c) => (
            <button type="button" key={c.id} className="chooser-item" onClick={() => navigate('editor', c.id)}>
              {c.thumbUrl ? <img src={mediaUrl(c.thumbUrl)} alt="" /> : <span className="thumb-placeholder" />}
              <span><strong>{c.title}</strong><small>{c.projectName} • {Math.round(c.duration)}s</small></span>
              <ScoreBadge score={c.score} />
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function Editor({ clipId, navigate }) {
  const { toast, confirm } = useFeedback()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [state, setState] = useState(null)
  const [cues, setCues] = useState([])
  const [cuesDirty, setCuesDirty] = useState(false)
  const [wave, setWave] = useState(null)
  const [now, setNow] = useState(0) // absolute time
  const [previewReady, setPreviewReady] = useState(false)
  const [task, setTask] = useState(null)
  const videoRef = useRef(null)
  const bgRef = useRef(null)

  useEffect(() => {
    let alive = true
    api(`/api/clips/${encodeURIComponent(clipId)}/editor`)
      .then((d) => {
        if (!alive) return
        setData(d)
        const r = d.clip.render || {}
        setState({
          start: d.clip.start, end: d.clip.end, format: r.format || '9:16', framing: r.framing || 'fit_blur',
          custom: r.custom || { zoom: 1, x: 0, y: 0 }, quality: r.quality || 'high', autoEdit: !!r.autoEdit,
          captionsEnabled: r.captionsEnabled ?? d.cues.length > 0,
          captionOptions: { style: 'viral', position: 'lower', size: 'M', color: '#FFFFFF', highlightColor: '#FF4FA0', font: 'Montserrat ExtraBold', uppercase: true, ...(r.captionOptions || {}) },
        })
        setCues(d.cues)
        setNow(d.clip.start)
        if (d.task) setTask(d.task)
      })
      .catch((e) => alive && setError(e))
    api(`/api/clips/${encodeURIComponent(clipId)}/waveform`).then((w) => alive && setWave(w)).catch(() => {})
    return () => {
      alive = false
    }
  }, [clipId])

  // Render task polling
  useEffect(() => {
    if (!task || !['queued', 'running'].includes(task.status)) return
    const t = setTimeout(async () => {
      try {
        const next = await api(`/api/tasks/${task.id}`)
        setTask(next)
        if (next.status === 'completed') toast(next.payload?.resultClipId && next.payload.mode !== 'replace' ? 'Nova versão renderizada!' : 'Clipe atualizado!')
        if (next.status === 'failed') toast(`Falha ao renderizar: ${next.error}`, 'error')
      } catch (e) {
        toast(e.message, 'error')
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [task, toast])

  const seg = data?.segment
  const offset = seg?.offset || 0
  const segDur = seg?.duration || 1
  const set = (patch) => setState((s) => ({ ...s, ...patch }))

  const seekAbs = useCallback((abs) => {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, abs - offset)
    if (bgRef.current) bgRef.current.currentTime = Math.max(0, abs - offset)
    setNow(abs)
  }, [offset])

  const onTime = () => {
    const v = videoRef.current
    if (!v || !state) return
    const abs = v.currentTime + offset
    setNow(abs)
    if (!v.paused && abs >= state.end) seekAbs(state.start) // loop the selection
    const bg = bgRef.current
    if (bg && Math.abs(bg.currentTime - v.currentTime) > 0.3) bg.currentTime = v.currentTime
  }

  const activeCue = useMemo(() => cues.find((c) => now >= c.start && now <= c.end), [cues, now])

  if (error) return <div className="panel"><p className="error">{error.message}</p><button type="button" className="secondary" onClick={() => navigate('editor')}>Escolher outro clipe</button></div>
  if (!data || !state) return <p className="hint">Carregando editor…</p>
  if (!seg) return <div className="panel"><p>Este clipe não possui trecho de origem salvo e não pode ser reeditado.</p></div>

  const length = state.end - state.start
  const validRange = length >= 3 && length <= 180 && state.start >= offset - 0.05 && state.end <= offset + segDur + 0.05
  const rendering = task && ['queued', 'running'].includes(task.status)
  const visibleCues = cues.filter((c) => c.end > state.start && c.start < state.end)

  function setDuration(d) {
    let start = state.start
    let end = start + d
    if (end > offset + segDur) {
      end = offset + segDur
      start = Math.max(offset, end - d)
    }
    set({ start: round(start), end: round(end) })
  }

  async function render(mode) {
    if (!validRange) return toast('Intervalo inválido: a duração deve ficar entre 3 e 180 s dentro do trecho disponível.', 'error')
    if (mode === 'replace') {
      const ok = await confirm({ title: 'Substituir o arquivo original do clipe?', message: 'O MP4 atual deste clipe será sobrescrito pela versão editada. Para manter os dois, use "Salvar como nova versão".', confirmLabel: 'Substituir', danger: true })
      if (!ok) return
    }
    try {
      if (cuesDirty) {
        const saved = await api(`/api/clips/${encodeURIComponent(clipId)}/captions`, { method: 'PUT', body: { cues: cues.map(({ start, end, text }) => ({ start, end, text })) } })
        setCues(saved.cues)
        setCuesDirty(false)
      }
      const t = await api(`/api/clips/${encodeURIComponent(clipId)}/render`, {
        method: 'POST',
        body: {
          start: state.start, end: state.end, format: state.format, framing: state.framing, custom: state.framing === 'custom' ? state.custom : undefined,
          quality: state.quality, autoEdit: state.autoEdit, captionsEnabled: state.captionsEnabled, captionOptions: state.captionOptions,
          mode, confirmReplace: mode === 'replace' ? true : undefined,
        },
      })
      setTask(t)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const pct = (abs) => `${((abs - offset) / segDur) * 100}%`

  return (
    <>
      <div className="page-heading compact">
        <span className="eyebrow">QUICK EDITOR</span>
        <h1>{data.clip.title}</h1>
        <p>{data.clip.projectName} • trecho disponível {clock(offset)}–{clock(offset + segDur)} da gravação</p>
      </div>
      <div className="editor-grid">
        <div className="panel editor-preview">
          <div className="preview-frame" style={{ aspectRatio: ASPECT[state.format] }}>
            {(state.framing === 'fit_blur' || state.framing === 'custom') && (
              <video ref={bgRef} className="preview-bg" src={mediaUrl(seg.previewUrl)} muted playsInline preload="auto" aria-hidden />
            )}
            <video
              ref={videoRef}
              className={`preview-fg framing-${state.framing}`}
              src={mediaUrl(seg.previewUrl)}
              playsInline
              preload="auto"
              style={state.framing === 'custom' ? { transform: `translate(${state.custom.x * 25}%, ${state.custom.y * 25}%) scale(${state.custom.zoom})` } : undefined}
              onLoadedData={() => { setPreviewReady(true); seekAbs(state.start) }}
              onTimeUpdate={onTime}
              onPlay={() => bgRef.current?.play().catch(() => {})}
              onPause={() => bgRef.current?.pause()}
            />
            {!previewReady && <div className="preview-loading">Gerando prévia do trecho…</div>}
            {state.captionsEnabled && activeCue && <CaptionPreview cue={activeCue} now={now} options={state.captionOptions} />}
          </div>
          <div className="player-controls">
            <button type="button" className="secondary" onClick={() => { const v = videoRef.current; if (!v) return; if (v.paused) { if (now < state.start || now > state.end) seekAbs(state.start); v.play() } else v.pause() }}>▶/❚❚</button>
            <span className="timecode">{preciseClock(now - state.start)} / {preciseClock(length)}</span>
            <button type="button" className="secondary" onClick={() => set({ start: round(now) })} disabled={now >= state.end - 3}>[ Início aqui</button>
            <button type="button" className="secondary" onClick={() => set({ end: round(now) })} disabled={now <= state.start + 3}>Fim aqui ]</button>
          </div>
          <Timeline wave={wave} offset={offset} segDur={segDur} state={state} now={now} pct={pct} onSeek={seekAbs} onChange={(patch) => set(patch)} />
          <div className="range-inputs">
            <label>Início (s na gravação)<input type="number" step="0.1" value={state.start} onChange={(e) => set({ start: Number(e.target.value) })} /></label>
            <label>Fim<input type="number" step="0.1" value={state.end} onChange={(e) => set({ end: Number(e.target.value) })} /></label>
            <span className={`length-tag ${validRange ? '' : 'bad'}`}>{length.toFixed(1)} s</span>
          </div>
          <Segmented label="Duração rápida" value={null} onChange={setDuration} options={[15, 30, 45, 60, 90].map((d) => ({ value: d, label: `${d}s` }))} />
        </div>

        <div className="panel editor-side">
          <h3>Enquadramento</h3>
          <Segmented label="Formato" value={state.format} onChange={(v) => set({ format: v })} options={[{ value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }, { value: '1:1', label: '1:1' }]} />
          <Segmented label="Modo" value={state.framing} onChange={(v) => set({ framing: v })} options={[{ value: 'fit_blur', label: 'Completa' }, { value: 'smart_crop', label: 'Smart crop' }, { value: 'center_crop', label: 'Central' }, { value: 'custom', label: 'Personalizado' }]} />
          {state.framing === 'custom' && (
            <div className="sliders">
              <label>Zoom {state.custom.zoom.toFixed(2)}×<input type="range" min="0.5" max="2.5" step="0.05" value={state.custom.zoom} onChange={(e) => set({ custom: { ...state.custom, zoom: Number(e.target.value) } })} /></label>
              <label>Horizontal<input type="range" min="-1" max="1" step="0.05" value={state.custom.x} onChange={(e) => set({ custom: { ...state.custom, x: Number(e.target.value) } })} /></label>
              <label>Vertical<input type="range" min="-1" max="1" step="0.05" value={state.custom.y} onChange={(e) => set({ custom: { ...state.custom, y: Number(e.target.value) } })} /></label>
            </div>
          )}
          <Toggle label="Auto Editor" hint="Zoom no pico, cor e áudio normalizado" checked={state.autoEdit} onChange={(v) => set({ autoEdit: v })} />
          <Segmented label="Qualidade" value={state.quality} onChange={(v) => set({ quality: v })} options={[{ value: 'high', label: 'Alta' }, { value: 'balanced', label: 'Equilibrada' }, { value: 'fast', label: 'Rápida' }]} />

          <h3 className="mt">Legendas</h3>
          <Toggle label="Legendas embutidas" hint={data.hasTranscript || cues.length ? 'Texto editável abaixo' : 'Sem transcrição: adicione legendas manualmente'} checked={state.captionsEnabled} onChange={(v) => set({ captionsEnabled: v })} />
          {state.captionsEnabled && (
            <>
              <Segmented label="Estilo" value={state.captionOptions.style} onChange={(v) => set({ captionOptions: { ...state.captionOptions, style: v } })} options={[{ value: 'classic', label: 'Classic' }, { value: 'viral', label: 'Viral' }, { value: 'neon', label: 'Neon' }, { value: 'minimal', label: 'Minimal' }]} />
              <div className="caption-grid">
                <label>Fonte<select value={state.captionOptions.font} onChange={(e) => set({ captionOptions: { ...state.captionOptions, font: e.target.value } })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></label>
                <label>Tamanho<select value={state.captionOptions.size} onChange={(e) => set({ captionOptions: { ...state.captionOptions, size: e.target.value } })}>{['S', 'M', 'L', 'XL'].map((f) => <option key={f}>{f}</option>)}</select></label>
                <label>Posição<select value={state.captionOptions.position} onChange={(e) => set({ captionOptions: { ...state.captionOptions, position: e.target.value } })}><option value="top">Topo</option><option value="middle">Meio</option><option value="lower">Inferior (área segura)</option><option value="bottom">Base</option></select></label>
                <label>Cor<input type="color" value={state.captionOptions.color} onChange={(e) => set({ captionOptions: { ...state.captionOptions, color: e.target.value.toUpperCase() } })} /></label>
                <label>Destaque<input type="color" value={state.captionOptions.highlightColor} onChange={(e) => set({ captionOptions: { ...state.captionOptions, highlightColor: e.target.value.toUpperCase() } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={state.captionOptions.uppercase} onChange={(e) => set({ captionOptions: { ...state.captionOptions, uppercase: e.target.checked } })} />MAIÚSCULAS</label>
              </div>
              <div className="cue-list">
                {visibleCues.length === 0 && <p className="hint">Nenhuma legenda neste intervalo.</p>}
                {visibleCues.map((c) => {
                  const i = cues.indexOf(c)
                  return (
                    <div key={`${c.start}-${i}`} className={`cue ${activeCue === c ? 'active' : ''}`}>
                      <button type="button" className="cue-time" onClick={() => seekAbs(c.start)}>{preciseClock(c.start - state.start)}</button>
                      <input aria-label={`Legenda ${i + 1}`} value={c.text} onChange={(e) => { const next = [...cues]; next[i] = { ...c, text: e.target.value, words: null }; setCues(next); setCuesDirty(true) }} />
                      <button type="button" className="cue-del" aria-label="Remover legenda" onClick={() => { setCues(cues.filter((x) => x !== c)); setCuesDirty(true) }}>×</button>
                    </div>
                  )
                })}
                <button type="button" className="secondary small" onClick={() => {
                  const s = Math.max(state.start, Math.min(now, state.end - 1))
                  setCues([...cues, { start: round(s), end: round(Math.min(state.end, s + 2.5)), text: 'Nova legenda' }].sort((a, b) => a.start - b.start))
                  setCuesDirty(true)
                }}>+ Legenda em {preciseClock(Math.max(0, now - state.start))}</button>
              </div>
            </>
          )}

          <div className="render-box">
            {task && (
              <div className="task-status">
                <small>{task.step}</small>
                <ProgressBar value={task.progress} label="Renderização" />
                {task.status === 'completed' && task.payload?.resultClipId && (
                  <button type="button" className="link" onClick={() => navigate('library', data.clip.projectId)}>Ver na biblioteca →</button>
                )}
                {task.status === 'failed' && <p className="error">{task.error}</p>}
              </div>
            )}
            <button type="button" className="primary" disabled={rendering || !validRange} onClick={() => render('version')}>✦ Salvar como nova versão</button>
            <button type="button" className="ghost-danger" disabled={rendering || !validRange} onClick={() => render('replace')}>Substituir original</button>
            <p className="hint">A exportação final é renderizada pelo FFmpeg (H.264/AAC, sem marca-d'água). A prévia acima é uma aproximação rápida.</p>
          </div>
        </div>
      </div>
    </>
  )
}

const round = (n) => Math.round(n * 100) / 100

function Timeline({ wave, offset, segDur, state, now, pct, onSeek, onChange }) {
  const ref = useRef(null)
  const canvasRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !wave?.peaks?.length) return
    const ctx = c.getContext?.('2d')
    if (!ctx) return
    const w = (c.width = c.clientWidth * 2)
    const h = (c.height = c.clientHeight * 2)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,120,170,0.55)'
    const n = wave.peaks.length
    for (let i = 0; i < n; i++) {
      const v = wave.peaks[i]
      const bh = Math.max(1, v * h * 0.95)
      ctx.fillRect((i / n) * w, (h - bh) / 2, Math.max(1, w / n - 0.5), bh)
    }
  }, [wave])

  const toAbs = (clientX) => {
    const rect = ref.current.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return round(offset + f * segDur)
  }
  const onPointerDown = (e, which) => {
    e.stopPropagation()
    drag.current = which
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => {
    if (!drag.current) return
    const t = toAbs(e.clientX)
    if (drag.current === 'start') onChange({ start: Math.min(t, state.end - 3) })
    else onChange({ end: Math.max(t, state.start + 3) })
  }

  return (
    <div className="timeline" ref={ref} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} onClick={(e) => !drag.current && onSeek(toAbs(e.clientX))} role="slider" aria-label="Linha do tempo" aria-valuemin={0} aria-valuemax={segDur} aria-valuenow={now - offset}>
      <canvas ref={canvasRef} className="wave" />
      <div className="sel" style={{ left: pct(state.start), width: `calc(${pct(state.end)} - ${pct(state.start)})` }} />
      <div className="handle start" style={{ left: pct(state.start) }} onPointerDown={(e) => onPointerDown(e, 'start')} aria-label="Ajustar início" />
      <div className="handle end" style={{ left: pct(state.end) }} onPointerDown={(e) => onPointerDown(e, 'end')} aria-label="Ajustar fim" />
      <div className="playhead" style={{ left: pct(now) }} />
      <span className="tl-label left">{clock(offset)}</span>
      <span className="tl-label right">{clock(offset + segDur)}</span>
    </div>
  )
}

function CaptionPreview({ cue, now, options }) {
  const words = cue.words?.length ? cue.words : cue.text.split(' ').map((w, i, arr) => ({ word: w, start: cue.start + ((cue.end - cue.start) * i) / arr.length, end: cue.start + ((cue.end - cue.start) * (i + 1)) / arr.length }))
  const highlight = options.style === 'viral' || options.style === 'neon'
  return (
    <div className={`caption-preview style-${options.style} pos-${options.position} size-${options.size}`} style={{ color: options.color, fontFamily: `'${options.font}', 'Arial Black', sans-serif`, '--hl': options.style === 'neon' ? '#5CF2FF' : options.highlightColor }}>
      {words.map((w, i) => {
        const text = options.uppercase ? String(w.word).toUpperCase() : w.word
        const active = highlight && now >= w.start && now < (words[i + 1]?.start ?? cue.end)
        return <span key={i} className={active ? 'hl' : ''}>{text} </span>
      })}
    </div>
  )
}
