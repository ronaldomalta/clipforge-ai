# ClipForge AI — Vice City Studio

**Transforme lives de 3–4 horas em clipes curtos, legendados e prontos para TikTok, Reels e Shorts — tudo no seu PC, sem marca-d'água, sem assinatura e sem enviar a gravação para serviços pagos.**

React + Vite · Node.js 22 (Express 5, SQLite embutido) · Python (NumPy, faster-whisper) · FFmpeg

![CI](https://img.shields.io/badge/tests-node%3Atest%20%C2%B7%20vitest%20%C2%B7%20pytest-ff649e)

## O que ele faz
1. **Importa** um arquivo (MP4, MKV, MOV, WEBM, AVI), um link do YouTube, ou uma gravação da sua **pasta do OBS/TikTok LIVE Studio** — esta última sem copiar o arquivo de horas.
2. **Analisa** áudio, fala e imagem e dá a cada trecho candidato uma **nota 0–100 explicada** (“Reação intensa: voz +15 dB acima do nível local”, “Clarão súbito na imagem”, “Expressões: “meu deus”, “não acredito””).
3. **Gera** 1–20 clipes de 15/30/45/60/90 s ou duração automática, em 9:16, 16:9 ou 1:1, com legendas animadas e edição automática.
4. Você **revisa**: assiste, aprova, descarta, edita; ao finalizar, só os descartados são apagados (com confirmação). A gravação original nunca é tocada.
5. **Exporta** os aprovados (MP4 H.264/AAC + SRT) para a sua pasta de saída.

## A “IA”, sem exagero
A seleção combina sinais **medidos de verdade** — não é um modelo que “entende” o jogo, e a nota **não é probabilidade de viralizar**:

| Sinal | Como é medido |
|---|---|
| Energia do áudio | dB acima do nível local (mediana móvel de 2 min), não volume absoluto |
| Reação emocional | voz (pela transcrição) alta em relação ao nível local |
| Relevância da fala | léxico PT-BR/EN de reações + exclamações, repetições (“corre corre”), risadas, interjeições curtas — expressões fora da lista também pontuam |
| Impacto sonoro | subida brusca, espectro ruidoso e não-vocal (explosões, batidas, tiros) |
| Ação visual | movimento entre quadros, clarões súbitos, perda súbita de cor (comum em morte/“wasted”), mudanças de cena |
| Penalidades | silêncio, “só volume alto” (música/ruído constante), repetição de conteúdo parecido |

Os pesos e a nota mínima são configuráveis. Se não houver momentos bons o bastante, **o app gera menos clipes e avisa** em vez de inventar destaques. Os títulos sugeridos citam o que o streamer realmente disse; sem fala, descrevem só os sinais medidos.

## Instalação no Windows
Requisitos: **Node.js 22.13+** (ou 24 LTS), **Python 3.12**, **FFmpeg “full”** (`winget install Gyan.FFmpeg`).

```bat
install-windows.bat      :: dependências + ambiente Python (pergunta antes do faster-whisper)
start-clipforge.bat      :: abre http://localhost:3001
```
Depois, em **Configurações → Diagnóstico**, baixe o modelo Whisper (o download é sempre uma ação sua). Detalhes de GPU/CUDA, NVENC e problemas comuns: [docs/WINDOWS.md](docs/WINDOWS.md).

Diagnóstico pelo terminal: `node scripts\doctor.mjs`. Modo desenvolvimento (hot reload em http://localhost:5173): `dev-windows.bat`.

### Atualizando da v0
Faça backup de `C:\Users\PC\clipforge-ai`, copie os arquivos novos por cima **mantendo a pasta `storage`** e rode `install-windows.bat`. Na primeira execução os projetos de `storage/jobs/*.json` são importados para o SQLite (os JSON ficam intactos). Clipes antigos aparecem na biblioteca sem nota (a pontuação antiga não é comparável) e sem edição (a v0 não guardava o trecho de origem).

## Uso
- **Criar cortes** → escolha fonte e opções → *Gerar clipes agora*. O progresso mostra as etapas reais (extraindo áudio 12:30 de 3:58:00, transcrevendo…, renderizando clipe 2/5…). Dá para cancelar e retomar.
- **Live AI** → configure a pasta de gravações em Configurações e processe a live no lugar.
- **Meus clipes** → assistir, “Por que essa nota?”, aprovar/descartar (individual ou em lote), *Finalizar revisão*, exportar.
- **Editor** → timeline com forma de onda, início/fim arrastáveis, legendas editáveis (Classic, Viral, Neon, Minimal; fonte, cor, tamanho, posição), enquadramento (completa com fundo desfocado, smart crop, central, personalizado), prévia ao vivo e exportação como **nova versão** (ou substituição, com confirmação).

## Arquitetura
```text
frontend/   React + Vite (UI Vice City)             → docs/ARCHITECTURE.md
backend/    Express 5 · SQLite (node:sqlite) · fila → docs/API.md
ai-service/ clipforge_ai: audio, transcribe, semantic, vision, scoring, titles
assets/fonts  fontes OFL das legendas · scripts/  doctor, e2e, install
storage/    (gerado) db, clips, segments, thumbs, captions, cache, logs, backups
```

## Testes
```bash
npm --prefix backend test          # node:test — API, segurança, FFmpeg real, editor, fila, migração
npm --prefix frontend test         # vitest + Testing Library
python -m pytest ai-service -q     # semântica, pontuação, áudio/visão com mídia gerada, fixture ponta a ponta
node scripts/e2e-smoke.js video.mp4   # contra um servidor rodando
```
O que foi executado e o que ainda depende do seu PC: [docs/TESTING.md](docs/TESTING.md). O GitHub Actions roda as três suítes a cada push.

## Limitações conhecidas
- A visão computacional é heurística e genérica (movimento, clarões, cor, cenas); não reconhece “perseguição policial” por si só.
- Sem transcrição (faster-whisper/modelo ausente) a seleção usa só áudio e imagem e as legendas automáticas ficam desligadas — você ainda pode digitar legendas no editor.
- Captura de lives em tempo real, publicação automática e integração com OBS ainda não existem.
- O upload pelo navegador copia o arquivo; para lives longas prefira a pasta de gravações.
- Use o importador do YouTube apenas com vídeos seus ou autorizados.

## Licenças
Código do projeto: do autor. Fontes das legendas: SIL Open Font License 1.1 (veja `assets/fonts`). FFmpeg, faster-whisper e yt-dlp são dependências externas com suas próprias licenças.
