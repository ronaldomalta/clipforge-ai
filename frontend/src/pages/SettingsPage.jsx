import { useEffect, useState } from 'react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { useFeedback } from '../components/Feedback'
import { Segmented, Toggle } from '../components/Bits'
import { bytes } from '../utils'

const WEIGHT_LABELS = {
  reaction: 'Reação emocional', speech: 'Relevância da fala', audio: 'Energia do áudio', visual: 'Ação visual',
  context: 'Contexto', scene: 'Dinâmica de cena', silencePenalty: 'Penalidade: silêncio', repetitionPenalty: 'Penalidade: repetição',
  loudOnlyPenalty: 'Penalidade: só volume alto',
}

export default function SettingsPage() {
  const { toast } = useFeedback()
  const [form, setForm] = useState(null)
  const [recDirsText, setRecDirsText] = useState('')
  const [saving, setSaving] = useState(false)
  const diag = usePoll(() => api('/api/system/diagnostics'), 0)
  const info = usePoll(() => api('/api/system/info'), 0)
  const download = usePoll(() => api('/api/system/models/download'), (d) => (d?.status === 'running' ? 2000 : 0))

  useEffect(() => {
    api('/api/settings').then((s) => {
      setForm(s)
      setRecDirsText((s.recordingsDirs || []).join('\n'))
    }).catch((e) => toast(e.message, 'error'))
  }, [toast])

  if (!form) return <p className="hint">Carregando configurações…</p>
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  async function save() {
    setSaving(true)
    try {
      const patch = {
        outputDir: form.outputDir, recordingsDirs: recDirsText.split('\n').map((s) => s.trim()).filter(Boolean),
        defaultQuality: form.defaultQuality, language: form.language, whisperModel: form.whisperModel, device: form.device,
        encoder: form.encoder, maxConcurrentJobs: form.maxConcurrentJobs, sourceRetention: form.sourceRetention,
        tempRetentionHours: form.tempRetentionHours, allowModelDownload: form.allowModelDownload, visionEnabled: form.visionEnabled,
        minScore: form.minScore, weights: form.weights, captions: form.captions,
      }
      const saved = await api('/api/settings', { method: 'PUT', body: patch })
      setForm(saved)
      toast('Configurações salvas.')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function startDownload(model) {
    try {
      await api('/api/system/models/download', { method: 'POST', body: { model } })
      toast(`Baixando modelo ${model}…`)
      download.refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const d = diag.data
  const storage = info.data?.storage
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">LOCAL CONFIGURATION</span>
        <h1>Configurações <em>do estúdio.</em></h1>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <h3>Pastas e arquivos</h3>
          <label className="field">Pasta de saída (exportação dos aprovados)
            <input value={form.outputDir} onChange={(e) => set({ outputDir: e.target.value })} placeholder="C:\Users\PC\Videos\ClipForge" />
          </label>
          <label className="field">Pastas de gravações (uma por linha, somente leitura)
            <textarea rows={3} value={recDirsText} onChange={(e) => setRecDirsText(e.target.value)} placeholder={'C:\\Users\\PC\\Videos\\OBS'} />
          </label>
          <label className="field">Depois de processar um upload/YouTube
            <select value={form.sourceRetention} onChange={(e) => set({ sourceRetention: e.target.value })}>
              <option value="segments">Guardar só os trechos dos clipes (economiza espaço)</option>
              <option value="full">Guardar a cópia completa</option>
            </select>
          </label>
          <label className="field">Limpar temporários após (horas)
            <input type="number" min="1" max="720" value={form.tempRetentionHours} onChange={(e) => set({ tempRetentionHours: Number(e.target.value) })} />
          </label>
          <p className="hint">Os trechos salvos (≈30 s antes e depois de cada clipe) permitem reeditar depois. Ao excluir um clipe, o trecho dele também é apagado. A gravação original nunca é apagada.</p>
        </section>

        <section className="panel">
          <h3>Processamento e IA</h3>
          <label className="field">Qualidade padrão
            <Segmented label="Qualidade padrão" value={form.defaultQuality} onChange={(v) => set({ defaultQuality: v })} options={[{ value: 'high', label: 'Alta' }, { value: 'balanced', label: 'Equilibrada' }, { value: 'fast', label: 'Rápida' }]} />
          </label>
          <label className="field">Idioma da transcrição
            <Segmented label="Idioma" value={form.language} onChange={(v) => set({ language: v })} options={[{ value: 'auto', label: 'Automático' }, { value: 'pt', label: 'Português' }, { value: 'en', label: 'Inglês' }]} />
          </label>
          <label className="field">Modelo Whisper
            <select value={form.whisperModel} onChange={(e) => set({ whisperModel: e.target.value })}>
              {(d?.models || [{ name: form.whisperModel }]).map((m) => (
                <option key={m.name} value={m.name}>{m.name}{m.sizeMB ? ` (~${m.sizeMB} MB)` : ''}{m.cached ? ' ✓ baixado' : ''}</option>
              ))}
            </select>
          </label>
          <p className="hint">RTX 3050 + 16 GB: <strong>small</strong> na GPU é um bom equilíbrio; na CPU prefira <strong>base</strong>. Modelos maiores são mais precisos e mais lentos.</p>
          <label className="field">Whisper em
            <Segmented label="Dispositivo" value={form.device} onChange={(v) => set({ device: v })} options={[{ value: 'auto', label: 'Auto (GPU se der)' }, { value: 'cuda', label: 'GPU' }, { value: 'cpu', label: 'CPU' }]} />
          </label>
          <label className="field">Codificador de vídeo
            <Segmented label="Codificador" value={form.encoder} onChange={(v) => set({ encoder: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'nvenc', label: 'NVENC (GPU)' }, { value: 'cpu', label: 'CPU (x264)' }]} />
          </label>
          <label className="field">Processamentos simultâneos
            <Segmented label="Simultâneos" value={form.maxConcurrentJobs} onChange={(v) => set({ maxConcurrentJobs: v })} options={[{ value: 1, label: '1 (recomendado)' }, { value: 2, label: '2' }]} />
          </label>
          <Toggle label="Visão computacional" hint="Movimento, clarões, perda de cor e cenas" checked={form.visionEnabled} onChange={(v) => set({ visionEnabled: v })} />
          <Toggle label="Permitir baixar modelos automaticamente" hint="Desligado: você baixa manualmente no diagnóstico" checked={form.allowModelDownload} onChange={(v) => set({ allowModelDownload: v })} />
          <label className="field">Nota mínima para virar clipe: <strong>{form.minScore}</strong>
            <input type="range" min="0" max="90" value={form.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} />
          </label>
          <details>
            <summary>Pesos da pontuação (calibração)</summary>
            {Object.entries(form.weights).map(([k, v]) => (
              <label key={k} className="field weight">{WEIGHT_LABELS[k] || k}: <strong>{v.toFixed(1)}</strong>
                <input type="range" min="0" max="3" step="0.1" value={v} onChange={(e) => set({ weights: { ...form.weights, [k]: Number(e.target.value) } })} />
              </label>
            ))}
          </details>
        </section>

        <section className="panel">
          <h3>Legendas (padrão)</h3>
          <Segmented label="Estilo" value={form.captions.style} onChange={(v) => set({ captions: { ...form.captions, style: v } })} options={[{ value: 'classic', label: 'Classic' }, { value: 'viral', label: 'Viral' }, { value: 'neon', label: 'Neon' }, { value: 'minimal', label: 'Minimal' }]} />
          <div className="caption-grid">
            <label>Fonte<select value={form.captions.font} onChange={(e) => set({ captions: { ...form.captions, font: e.target.value } })}>{['Montserrat ExtraBold', 'Montserrat Black', 'Anton', 'Bebas Neue'].map((f) => <option key={f}>{f}</option>)}</select></label>
            <label>Tamanho<select value={form.captions.size} onChange={(e) => set({ captions: { ...form.captions, size: e.target.value } })}>{['S', 'M', 'L', 'XL'].map((f) => <option key={f}>{f}</option>)}</select></label>
            <label>Posição<select value={form.captions.position} onChange={(e) => set({ captions: { ...form.captions, position: e.target.value } })}><option value="top">Topo</option><option value="middle">Meio</option><option value="lower">Inferior (área segura)</option><option value="bottom">Base</option></select></label>
            <label>Cor<input type="color" value={form.captions.color} onChange={(e) => set({ captions: { ...form.captions, color: e.target.value.toUpperCase() } })} /></label>
            <label>Destaque<input type="color" value={form.captions.highlightColor} onChange={(e) => set({ captions: { ...form.captions, highlightColor: e.target.value.toUpperCase() } })} /></label>
          </div>
          <button type="button" className="primary save" disabled={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar configurações'}</button>
        </section>

        <section className="panel">
          <div className="detail-head">
            <h3>Diagnóstico de dependências</h3>
            <button type="button" className="secondary small" onClick={() => api('/api/system/diagnostics?refresh=1').then(diag.setData).catch((e) => toast(e.message, 'error'))}>↻ Verificar de novo</button>
          </div>
          {!d ? <p className="hint">Verificando…</p> : (
            <>
              <p className={d.ready ? 'ok-text' : 'error'}>{d.ready ? '✓ Tudo pronto para processar vídeos.' : '✕ Há dependências obrigatórias faltando.'}</p>
              <ul className="checks">
                {d.checks.map((c) => (
                  <li key={c.id} className={c.ok ? 'ok' : c.optional ? 'opt' : 'bad'}>
                    <span>{c.ok ? '✓' : c.optional ? '○' : '✕'}</span>
                    <div><strong>{c.label}</strong>{c.version && <small> {c.version}</small>}{c.hint && <small className="check-hint">{c.hint}</small>}</div>
                  </li>
                ))}
              </ul>
              <h4>Modelos Whisper</h4>
              <ul className="checks">
                {d.models.map((m) => (
                  <li key={m.name} className={m.cached ? 'ok' : 'opt'}>
                    <span>{m.cached ? '✓' : '○'}</span>
                    <div><strong>{m.name}</strong><small> ~{m.sizeMB} MB</small></div>
                    {!m.cached && d.python?.faster_whisper && (
                      <button type="button" className="secondary small" disabled={download.data?.status === 'running'} onClick={() => startDownload(m.name)}>Baixar</button>
                    )}
                  </li>
                ))}
              </ul>
              {download.data?.status === 'running' && <p className="hint">Baixando {download.data.model} do HuggingFace…</p>}
              {download.data?.status === 'failed' && <p className="error">Download falhou: {download.data.error}</p>}
              {download.data?.status === 'done' && <p className="ok-text">Modelo {download.data.model} baixado.</p>}
            </>
          )}
        </section>

        <section className="panel">
          <h3>Sistema e armazenamento</h3>
          {d && (
            <ul className="kv">
              <li><span>Sistema</span><strong>{d.system.platform}</strong></li>
              <li><span>CPU</span><strong>{d.system.cpus} ({d.system.cores} threads)</strong></li>
              <li><span>RAM</span><strong>{bytes(d.system.freeMemBytes)} livres de {bytes(d.system.totalMemBytes)}</strong></li>
              <li><span>GPU</span><strong>{d.gpu?.length ? d.gpu.map((g) => `${g.name} (${g.memory})`).join(', ') : 'Não detectada (nvidia-smi)'}</strong></li>
            </ul>
          )}
          {storage && (
            <ul className="kv">
              <li><span>Total usado</span><strong>{bytes(storage.totalBytes)}</strong></li>
              {storage.freeBytes != null && <li><span>Livre no disco</span><strong>{bytes(storage.freeBytes)}</strong></li>}
              {Object.entries(storage.parts).map(([k, v]) => <li key={k}><span>{k}</span><strong>{bytes(v.bytes)} ({v.files})</strong></li>)}
            </ul>
          )}
          <div className="row-actions">
            <button type="button" className="secondary small" onClick={() => api('/api/system/cleanup', { method: 'POST' }).then((r) => { toast(`${r.removed} item(ns) temporário(s) removido(s).`); info.refresh() }).catch((e) => toast(e.message, 'error'))}>Limpar temporários</button>
            <button type="button" className="secondary small" onClick={() => api('/api/system/backup', { method: 'POST' }).then((r) => toast(`Backup criado: ${r.file}`)).catch((e) => toast(e.message, 'error'))}>Backup do banco</button>
          </div>
        </section>
      </div>
    </>
  )
}
