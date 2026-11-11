# Arquitetura

```text
┌──────────── navegador (React + Vite) ────────────┐
│ Dashboard · Criar · Meus clipes · Editor · Live  │
└───────────────┬──────────────────────────────────┘
                │ /api, /media  (mesma origem; Vite proxy em dev)
┌───────────────▼──────────────────────────────────┐
│ backend (Node 22, Express 5)                     │
│  middleware/security  host + origem + cabeçalho  │
│  routes/*  → services: pipeline, clip-service    │
│  queue.js  fila persistente (tasks), cancelamento│
│  db.js     SQLite nativo (node:sqlite), migrações│
│  render.js FFmpeg: enquadramento, zoom, legendas │
│  captions.js ASS (libass) + SRT                  │
└──────┬───────────────────────────┬───────────────┘
       │ spawn (sem shell)         │ spawn
┌──────▼─────────────┐   ┌─────────▼───────────────┐
│ ai-service (Python)│   │ FFmpeg / FFprobe / yt-dlp│
│ clipforge_ai/*     │   └─────────────────────────┘
└────────────────────┘
```

## Fluxo de um projeto
1. **Importação** — upload (cópia gerenciada em `storage/uploads/<id>`), YouTube (yt-dlp) ou **pasta de gravações** (o arquivo é lido no lugar; nunca copiado, alterado ou apagado).
2. **Análise** (`ai-service/analyze.py --config …`), com progresso real em linhas `@@CF {json}`:
   - FFmpeg decodifica o áudio **uma vez** para um WAV 16 kHz mono em disco; as features são calculadas em blocos de 60 s (RAM constante).
   - **Transcrição** faster-whisper em blocos de ~5 min cortados em pontos de silêncio, com timestamps por palavra, VAD, filtro de alucinações, GPU (int8_float16) com fallback para CPU (int8). Modelos só são usados se já estiverem baixados, ou com permissão explícita.
   - **Visão em 2 passadas**: (a) só keyframes do vídeo inteiro (`-skip_frame nokey`, 64×36) → atividade visual e mudanças de cena; (b) 4 fps/160×90 **apenas nas janelas candidatas** → movimento, centróide do movimento (smart crop), clarões, perda súbita de cor, fade para preto.
   - **Cache** por impressão digital do arquivo: transcrição, features de áudio e passada visual não são recalculadas ao reprocessar o mesmo vídeo.
3. **Pontuação** (`scoring.py`): componentes 0–1 em escalas **absolutas** (dB acima do nível local de 2 min, diferença de pixels, acertos lexicais) → nota 0–100 com penalidades de silêncio, “só volume alto” e repetição. Janela posicionada para manter o início do acontecimento e a reação; cortes ajustados para não partir frases. Se nada passar da nota mínima, **menos clipes** são gerados e o usuário é avisado.
4. **Trechos de origem**: para cada clipe, um trecho com ±30 s é salvo por *stream copy* alinhado a keyframe (sem perda e rápido). Isso permite reeditar depois sem manter a live inteira.
5. **Renderização**: filtro único do FFmpeg (fit_blur / smart crop / central / personalizado, zoom suave no pico, cor, loudnorm, legendas ASS com fontes embutidas). Os arquivos ASS e as fontes ficam na pasta de trabalho e o FFmpeg roda com `cwd` nela — sem caminhos `C:\…` dentro do filtro (o problema de escape no Windows desaparece). FPS da fonte preservado (máx. 60), NVENC opcional com fallback para libx264, verificação com ffprobe de vídeo+áudio+duração.
6. **Revisão**: aprovar/descartar (persistente) → “Finalizar revisão” apaga só os descartados, por nome de arquivo registrado no banco.

## Persistência (SQLite)
Tabelas: `projects`, `clips` (versões via `parent_id`, lápide `file_status='deleted'` para estatísticas), `transcripts`, `tasks`, `settings`, `exports`, `legacy_imports`, `schema_migrations`. WAL, chaves estrangeiras, backup diário com `VACUUM INTO` (7 mantidos). Os JSON antigos de `storage/jobs` são importados uma vez e **não são apagados**.

## Fila
`tasks` persiste cada trabalho (`process_project`, `render_clip`). Limite de concorrência configurável (1–2), *gate* de memória livre (≥1 GB), cancelamento que mata a árvore de processos (`taskkill /T` no Windows), tarefas interrompidas por reinício ficam como “Interrompido” e podem ser retomadas (etapas prontas são reaproveitadas).

## Segurança
Servidor em `127.0.0.1`; verificação de `Host` e `Origin`; cabeçalho obrigatório em mutações (anti-CSRF, inclusive multipart); nada de shell (`spawn` com lista de argumentos); URL do YouTube normalizada para `watch?v=<id de 11 caracteres>`; IDs e nomes de arquivo validados por regex; exclusões só dentro dos diretórios gerenciados, de arquivos comuns, por nomes vindos do banco; tokens opacos para gravações, revalidados com `realpath`; erros sem stack/caminhos para o cliente.

## Pontos de extensão
- Captura contínua de lives: a fila já aceita novos tipos de tarefa; uma tarefa “watch folder” pode enfileirar `process_project` por arquivo novo.
- Modelos visuais semânticos (ex.: CLIP via onnxruntime) podem entrar como mais um componente em `window_components` sem mudar a API.
