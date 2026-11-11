import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'

const project = {
  id: 'p1', name: 'live-gta.mp4', status: 'completed', progress: 100, step: 'Concluído!', createdAt: '2026-11-10T10:00:00Z',
  settings: { count: 3, duration: 30, format: '9:16' }, media: { duration: 3600, width: 1920, height: 1080, fps: 60 },
  analysis: { engine: 'clipforge-multisignal-v1', warnings: [], capabilities: { transcription: true, vision: true }, language: 'pt' },
  counts: { total: 3, pending: 1, approved: 1, discarded: 1 },
  clips: [
    { id: 'c1', title: '“MEU DEUS!”', start: 100, end: 130, duration: 30, score: 87, reasons: ['Reação intensa do jogador'], penalties: [], status: 'approved', fileStatus: 'ok', url: '/media/clips/c1.mp4', downloadUrl: '/media/clips/c1.mp4?download=1', editable: true, version: 1, breakdown: { reaction: 1 } },
    { id: 'c2', title: 'AÇÃO INTENSA', start: 400, end: 430, duration: 30, score: 61, reasons: ['Movimento visual elevado'], penalties: [], status: 'discarded', fileStatus: 'ok', url: '/media/clips/c2.mp4', downloadUrl: '/x', editable: true, version: 1 },
    { id: 'c3', title: 'MOMENTO', start: 900, end: 930, duration: 30, score: 55, reasons: [], penalties: [], status: 'pending', fileStatus: 'ok', url: '/media/clips/c3.mp4', downloadUrl: '/y', editable: true, version: 1 },
  ],
}

function mockApi(routes) {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const method = init.method || 'GET'
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ')
      return m === method && (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path.split('?')[0] === p)
    })
    const value = key ? (typeof routes[key] === 'function' ? routes[key](path, init) : routes[key]) : {}
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

const base = {
  'GET /api/health': { status: 'ok', queue: { running: 0, queued: 0 } },
  'GET /api/stats': { projects: { total: 1, completed: 1, processing: 0 }, clips: { generated: 3, approved: 1, discarded: 1 }, processedSeconds: 3600, storage: { totalBytes: 1024 }, recent: [] },
  'GET /api/projects': [project],
  'GET /api/projects/p1': project,
  'GET /api/system/diagnostics': { models: [{ name: 'base', sizeMB: 145, cached: true }], python: { faster_whisper: '1.2' }, checks: [], system: {} },
  'GET /api/settings': { whisperModel: 'base' },
}

describe('ClipForge UI', () => {
  it('navigates between pages from the sidebar', async () => {
    mockApi(base)
    render(<App />)
    expect(await screen.findByText('CLIPES GERADOS')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Criar cortes/ }))
    expect(await screen.findByText(/02 \/ Configurar geração/)).toBeInTheDocument()
    expect(window.location.hash).toBe('#/create')
  })

  it('validates the create form before uploading', async () => {
    const calls = mockApi(base)
    window.location.hash = '#/create'
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /Gerar clipes agora/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Escolha uma gravação/)
    expect(calls.some((c) => c.path.includes('/upload'))).toBe(false)
  })

  it('rejects unsupported file types on the client', async () => {
    mockApi(base)
    window.location.hash = '#/create'
    render(<App />)
    const input = await screen.findByTestId('file-input')
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Formato não suportado/)
  })

  it('shows clips with score, supports multi-select and batch approve', async () => {
    const calls = mockApi({ ...base, 'POST /api/clips/batch': { clips: [] } })
    window.location.hash = '#/library/p1'
    render(<App />)
    expect(await screen.findByText('“MEU DEUS!”')).toBeInTheDocument()
    expect(screen.getByText('87')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Selecionar todos' }))
    expect(screen.getByText(/3 selecionado/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Aprovar selecionados/ }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/clips/batch')).toBeTruthy())
    const call = calls.find((c) => c.path === '/api/clips/batch')
    expect(call.body).toEqual({ ids: ['c1', 'c2', 'c3'], action: 'approve' })
    expect(call.headers['X-ClipForge-Client']).toBe('1')
    await userEvent.click(screen.getByRole('button', { name: 'Desmarcar todos' }))
    expect(screen.getByText(/0 selecionado/)).toBeInTheDocument()
  })

  it('asks for confirmation before deleting discarded clips and can be canceled', async () => {
    const calls = mockApi({ ...base, 'POST /api/projects/p1/review/finalize': { deleted: 1, kept: 2 } })
    window.location.hash = '#/library/p1'
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Finalizar revisão' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Excluir 1 clipe\(s\) descartado/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(calls.some((c) => c.path.endsWith('/review/finalize'))).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: 'Finalizar revisão' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Excluir 1 arquivo/ }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/review/finalize'))?.body).toEqual({ confirm: true }))
    expect(await screen.findByText(/1 excluído/)).toBeInTheDocument()
  })

  it('explains the score without calling it a virality probability', async () => {
    mockApi(base)
    window.location.hash = '#/library/p1'
    render(<App />)
    const buttons = await screen.findAllByRole('button', { name: /Por que essa nota/ })
    await userEvent.click(buttons[0])
    expect(screen.getByText(/não é probabilidade de viralizar/)).toBeInTheDocument()
    expect(screen.getByText('Reação intensa do jogador')).toBeInTheDocument()
  })

  it('shows an offline banner when the server is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    render(<App />)
    expect(await screen.findByText(/servidor local não está respondendo/)).toBeInTheDocument()
  })
})
