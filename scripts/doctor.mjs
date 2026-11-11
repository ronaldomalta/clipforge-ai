#!/usr/bin/env node
// Dependency check with clear instructions (no installs, no downloads).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
let failed = 0

// Mirror backend config: read FFMPEG_PATH / PYTHON_PATH from backend/.env or .env if set.
const env = { ...process.env }
for (const f of [join(root, 'backend', '.env'), join(root, '.env')]) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const venvPy = win ? join(root, 'ai-service', '.venv', 'Scripts', 'python.exe') : join(root, 'ai-service', '.venv', 'bin', 'python')
const python = env.PYTHON_PATH || (existsSync(venvPy) ? venvPy : win ? 'python' : 'python3')
const ffmpeg = env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = env.FFPROBE_PATH || (env.FFMPEG_PATH ? join(dirname(env.FFMPEG_PATH), win ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe')

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
function line(ok, label, detail, hint, optional = false) {
  const mark = ok ? '✓' : optional ? '○' : '✕'
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok && hint) console.log(`    → ${hint}`)
  if (!ok && !optional) failed += 1
}

console.log('\nClipForge AI — diagnóstico\n')
const [maj, min] = process.versions.node.split('.').map(Number)
line(maj > 22 || (maj === 22 && min >= 13), 'Node.js', process.versions.node, 'Instale o Node.js 22 LTS (22.13+) ou 24 LTS: https://nodejs.org')

const ff = run(ffmpeg, ['-hide_banner', '-version'])
line(ff.status === 0, 'FFmpeg', ff.status === 0 ? ff.stdout.split('\n')[0].split(' ')[2] : ffmpeg, 'winget install Gyan.FFmpeg  (ou defina FFMPEG_PATH no backend\\.env)')
const fp = run(ffprobe, ['-hide_banner', '-version'])
line(fp.status === 0, 'FFprobe', fp.status === 0 ? 'ok' : ffprobe, 'Defina FFPROBE_PATH apontando para ffprobe.exe')
if (ff.status === 0) {
  const enc = run(ffmpeg, ['-hide_banner', '-encoders']).stdout || ''
  const flt = run(ffmpeg, ['-hide_banner', '-filters']).stdout || ''
  line(/libx264/.test(enc), 'FFmpeg com libx264', '', 'Use uma build "full" (gyan.dev)')
  line(/\bass\b/.test(flt), 'FFmpeg com libass (legendas)', '', 'Use uma build "full" (gyan.dev)')
  line(/h264_nvenc/.test(enc), 'NVENC disponível na build', '', 'Opcional (aceleração por GPU NVIDIA)', true)
}

const py = run(python, [join(root, 'ai-service', 'doctor.py')])
if (py.status !== 0) {
  line(false, 'Python', python, 'Instale Python 3.10–3.12 (python.org, marque "Add to PATH") e rode install-windows.bat')
} else {
  const d = JSON.parse(py.stdout.trim().split(/\r?\n/).pop())
  line(true, 'Python', `${d.python} (${d.executable})`)
  line(!!d.numpy, 'NumPy', d.numpy, 'Rode install-windows.bat (cria ai-service\\.venv)')
  line(!!d.faster_whisper, 'faster-whisper', d.faster_whisper, 'Necessário para transcrição/legendas: rode install-windows.bat e aceite instalar', true)
  line(!!d.yt_dlp, 'yt-dlp', d.yt_dlp, `${python} -m pip install -U yt-dlp`, true)
  line(d.cuda_devices > 0, 'CUDA para o Whisper', d.cuda_devices ? `${d.cuda_devices} GPU(s)` : 'CPU', 'Opcional: precisa de cuBLAS/cuDNN (CUDA 12) — veja docs/WINDOWS.md', true)
  line((d.models_cached || []).length > 0, 'Modelos Whisper baixados', (d.models_cached || []).join(', ') || 'nenhum', 'Baixe em Configurações → Diagnóstico (o download é sempre explícito)', true)
}

line(existsSync(join(root, 'backend', 'node_modules')), 'Dependências do backend', '', 'npm.cmd --prefix backend install')
line(existsSync(join(root, 'frontend', 'node_modules')), 'Dependências do frontend', '', 'npm.cmd --prefix frontend install')
line(existsSync(join(root, 'frontend', 'dist', 'index.html')), 'Interface compilada', '', 'npm.cmd --prefix frontend run build', true)

console.log(failed ? `\n${failed} item(ns) obrigatório(s) faltando.\n` : '\nTudo pronto! Rode start-clipforge.bat\n')
process.exit(failed ? 1 : 0)
