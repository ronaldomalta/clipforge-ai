# Testes — o que foi executado de verdade

Ambiente da validação: contêiner Linux (2 vCPU Xeon, 7,8 GB RAM, **sem GPU**), Node 22.23, Python 3.13, FFmpeg 6.1 (libx264, libass), faster-whisper 1.2.1 **sem modelos** (o ambiente não acessa o HuggingFace). Data: 10/11/2026.

## Suítes automatizadas (todas passando)
| Suíte | Resultado | Cobre |
|---|---|---|
| `npm --prefix backend test` | **17/17** | CSRF/Host/Origin; validação de upload (extensão, arquivo falso “.mp4”, opções, sem arquivo); pipeline real com FFmpeg (vídeo+áudio, 720×1280, 30 fps preservado, duração, miniatura, Range 206); aprovar/descartar/lote, IDs inválidos e repetidos; **persistência após reinício**; finalizar revisão exige confirmação, apaga só o descartado, mantém o aprovado e o original; exportação; path traversal em mídia e IDs; **60 fps vertical mantido**; **vídeo sem áudio** (gera trilha silenciosa) em 16:9; 1:1 com smart crop; **editor: legendas digitadas queimadas numa nova versão**, SRT relativo ao novo início, original intacto, “substituir” exige confirmação, intervalo fora do trecho rejeitado; cancelamento de projeto em andamento; exclusão bloqueada durante processamento; **migração dos JSON da v0**; pasta de gravações processada no lugar e nunca apagada; geração ASS/SRT, filtros FFmpeg, FPS, validações |
| `npm --prefix frontend test` | **7/7** | navegação; validação do formulário; arquivo de tipo inválido; nota e seleção múltipla + aprovar em lote (com cabeçalho anti-CSRF); diálogo de confirmação (cancelar e confirmar); explicação da nota; banner de servidor offline |
| `python -m pytest ai-service` | **23/23** | léxico com/sem acento e limites de palavra; pistas genéricas; títulos fundamentados; vídeo plano → nenhum destaque; evento → janela com contexto e reação; não partir frases; sem sobreposição; penalidade de repetição; “só volume alto” penalizado; duração automática limitada; vídeo curto; detecção de silêncio/tom estável/impacto em áudio real; clarão em vídeo real; passada de keyframes; cortes de transcrição em silêncio; **modelo não baixado → erro claro, sem download**; vídeo sem áudio; **fixture ponta a ponta** (encontra explosão ≈120 s e fuga ≈240 s, ignora música alta 60–90 s, gera menos clipes que o pedido, reaproveita cache) |
| `oxlint` / `vite build` | sem erros (avisos de estilo apenas) / build ok | |

## Execuções manuais
- **E2E via API** (`scripts/e2e-smoke.js`) com uma gravação sintética de 5 min (fala em PT gerada por espeak-ng, explosão + clarão + tela sem cor, música alta, ação com ruído visual): 43 s até concluir; 2 clipes (notas 86 e 81) nos dois eventos encadeados; aviso honesto “Só 2 de 5 momentos atingiram a nota mínima”; aprovar 1, descartar 1, finalizar → 1 arquivo apagado; 4 versões no editor com legendas **Classic, Viral (com smart crop), Neon e Minimal** renderizadas e conferidas visualmente em quadros extraídos.
- **Vídeo longo**: 60 min (720p, 2,4 GB) analisados em **118 s** com pico de **192 MB de RAM** (sem transcrição). Projeção grosseira para 4 h neste contêiner: ~8 min de análise sem Whisper — a transcrição é a etapa dominante e depende do seu hardware.
- **Interface**: todas as páginas abertas no Chromium headless (desktop 1440 px e celular 390 px) sem erros de console.
- **Migração** dos 6 projetos do seu `storage/jobs` (cópia): importados; os 3 MP4 existentes tocam; os 12 clipes cujos arquivos não estavam no ZIP aparecem como “Arquivo ausente”.

## Pendente de validação no seu PC (não foi possível aqui)
- [ ] **Transcrição real com faster-whisper** em PT-BR e EN (o código roda, mas não havia modelo para baixar) e, com ela, **legendas automáticas** a partir da fala.
- [ ] Whisper na **GPU (CUDA)** da RTX 3050 e fallback GPU→CPU.
- [ ] **NVENC** (o teste real de codificação roda no diagnóstico; aqui não há GPU).
- [ ] Importação do **YouTube** (sem rede para o YouTube aqui; a URL é validada e o código do yt-dlp é o mesmo que já funcionava na v0, com fallback para versões antigas).
- [ ] Reprodução dos MP4 no Chrome/Edge (o Chromium de testes não tem H.264; os arquivos foram validados com ffprobe).
- [ ] Scripts `.bat` (escritos para cmd do Windows, não executados aqui).
- [ ] Uma live real de 3–4 h: tempo total e qualidade dos cortes escolhidos.

### Roteiro sugerido
1. `install-windows.bat` → `start-clipforge.bat` → Configurações → Diagnóstico → baixar `base` (ou `small` com CUDA).
2. Vídeo de 2 min com fala, 3 clipes de 15 s, legendas ligadas → conferir legendas sincronizadas.
3. Uma live real com 10 × 30 s → conferir notas/motivos, aprovar/descartar, finalizar, exportar.
4. `node scripts\e2e-smoke.js caminho\video.mp4` para repetir o fluxo automaticamente.
