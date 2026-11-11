# ClipForge AI — API local

Base: `http://localhost:3001`. Todas as respostas são JSON (exceto mídia). Erros: `{ "error": "mensagem em pt-BR", "code": "..." }`.

**Requisições que alteram dados** (`POST`, `PUT`, `DELETE`) precisam do cabeçalho `X-ClipForge-Client: 1`. Isso força um *preflight* CORS, que o servidor recusa para origens desconhecidas — sites aleatórios não conseguem disparar ações no app local. O servidor também recusa `Host` diferente de `localhost`/`127.0.0.1` (proteção contra DNS rebinding).

## Sistema
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Status, versão, fila |
| GET | `/api/system/diagnostics[?refresh=1]` | Node, FFmpeg/FFprobe, libx264, libass, NVENC (teste real), Python, NumPy, faster-whisper, yt-dlp, CUDA, modelos baixados, fontes |
| GET | `/api/system/info` | Sistema, GPU, uso de armazenamento, resultado da migração JSON→SQLite |
| GET/POST | `/api/system/models/download` | Estado / iniciar download **explícito** de um modelo Whisper `{ "model": "base" }` |
| POST | `/api/system/cleanup` | Remove temporários de tarefas inativas |
| POST | `/api/system/backup` | Backup consistente do banco (`VACUUM INTO`) |
| GET/PUT | `/api/settings` | Configurações (validadas; campos desconhecidos são rejeitados) |
| GET | `/api/stats` | Números do dashboard |
| GET | `/api/storage` | Uso de disco por categoria |

## Projetos
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/projects/upload` | multipart: `video` + opções (abaixo). O arquivo é validado com ffprobe |
| POST | `/api/projects` | `{ source: { type: "youtube", url } \| { type: "library", token }, options }` |
| POST | `/api/videos/info` | `{ url }` → título, duração, miniatura (yt-dlp) |
| GET | `/api/library/recordings` | Vídeos nas pastas de gravações configuradas (token opaco por arquivo) |
| GET | `/api/projects` / `/api/projects/:id` | Lista / detalhe com clipes |
| POST | `/api/projects/:id/cancel` | Cancela a tarefa (mata FFmpeg/Python) |
| POST | `/api/projects/:id/retry` | Retoma projeto falho/interrompido/cancelado (reaproveita etapas prontas) |
| POST | `/api/projects/:id/review/finalize` | `{ confirm: true }` — apaga os arquivos dos clipes **descartados** |
| POST | `/api/projects/:id/export` | Copia os aprovados (+SRT) para a pasta de saída |
| DELETE | `/api/projects/:id` | `{ confirm: true }` — apaga clipes e cópias gerenciadas; nunca a gravação original |
| GET | `/api/projects/:id/transcript` | Transcrição com timestamps por palavra |

**Opções de geração:** `count` 1–20 · `duration` 15/30/45/60/90/`"auto"` · `format` `9:16`/`16:9`/`1:1` · `framing` `fit_blur`/`smart_crop`/`center_crop` · `quality` `high`/`balanced`/`fast` · `smart`, `captions`, `autoEdit` (bool) · `captionStyle` `classic`/`viral`/`neon`/`minimal` · `language` `auto`/`pt`/`en` · `allowModelDownload` (bool).

## Clipes
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/clips[?status=&projectId=]` | Lista |
| GET | `/api/clips/:id` | Detalhe (nota, motivos, penalidades, transcrição) |
| POST | `/api/clips/:id/approve` · `/discard` · `/reset` | Estado de revisão |
| POST | `/api/clips/batch` | `{ ids, action: approve\|discard\|pending\|delete\|export, confirm }` |
| DELETE | `/api/clips/:id` | `{ confirm: true }` |
| GET | `/api/clips/:id/editor` | Trecho de origem salvo, legendas editáveis, tarefa ativa |
| GET | `/api/clips/:id/preview` · `/waveform` | Prévia H.264 leve do trecho / forma de onda |
| PUT | `/api/clips/:id/captions` | `{ cues: [{ start, end, text }] }` (tempos absolutos na gravação) |
| POST | `/api/clips/:id/render` | `{ start, end, format, framing, custom, quality, autoEdit, captionsEnabled, captionOptions, mode: "version"\|"replace", confirmReplace }` → tarefa |
| POST | `/api/clips/:id/export` | Copia para a pasta de saída |
| GET | `/api/tasks/:id` · POST `/api/tasks/:id/cancel` | Progresso / cancelamento de renderizações do editor |

## Mídia
`/media/clips/:file`, `/media/thumbs/:file`, `/media/captions/:file` (`?download=1` para baixar com nome amigável), `/media/fonts/:file`. Só são servidos arquivos com nome seguro **e** registrados no banco; suporta `Range` (player de vídeo).

## Compatibilidade com a v0
`POST /api/jobs/upload`, `POST /api/jobs/youtube`, `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/finalize-selection` e `/clips/:file` continuam funcionando.
