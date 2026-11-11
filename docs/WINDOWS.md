# Windows: instalação, GPU e solução de problemas

Testado como alvo: Acer Nitro V15 · RTX 3050 · 16 GB RAM · Windows · Python 3.12 · Node 22/24.

## Pré-requisitos
| Programa | Como instalar |
|---|---|
| Node.js 22 LTS (22.13+) ou 24 LTS | https://nodejs.org — o banco usa o SQLite embutido do Node (`node:sqlite`), sem compilação |
| Python 3.12 | https://python.org (marque **Add python.exe to PATH**) |
| FFmpeg “full” (libx264, libass, NVENC) | `winget install Gyan.FFmpeg` e reabra o terminal |

No PowerShell, use `npm.cmd` se a política de execução bloquear `npm`.

## Instalação
1. Coloque o projeto em `C:\Users\PC\clipforge-ai` (faça backup da pasta antiga — veja “Atualizando da v0” no README).
2. Dê dois cliques em **`install-windows.bat`**. Ele instala as dependências do Node, cria `ai-service\.venv`, instala NumPy e yt-dlp e **pergunta** antes de instalar o faster-whisper. Nenhum modelo de IA é baixado nessa etapa.
3. Dê dois cliques em **`start-clipforge.bat`**. O navegador abre em `http://localhost:3001`.
4. Em **Configurações → Diagnóstico**, confira os itens e clique em **Baixar** no modelo Whisper desejado.

## Qual modelo Whisper usar
| Modelo | Download | Recomendado para |
|---|---|---|
| base | ~145 MB | CPU; testes rápidos |
| small | ~484 MB | **RTX 3050 com CUDA** (bom equilíbrio PT-BR) |
| medium / turbo | ~1,5 GB | GPU, quando precisão importa mais que tempo |

Não há benchmark deste notebook feito por nós — meça com uma live real (o tempo de cada etapa aparece no projeto e em `storage/logs`).

## Whisper na GPU (CUDA)
O faster-whisper (CTranslate2) precisa de **cuBLAS e cuDNN 9 para CUDA 12**. Se o diagnóstico mostrar “GPU para Whisper: CPU” mesmo com a RTX 3050:
```bat
ai-service\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*
```
e adicione as pastas `bin` desses pacotes ao `PATH` (ver documentação do faster-whisper). Se a GPU falhar no meio da transcrição, o ClipForge continua automaticamente na CPU e registra um aviso no projeto.

## Renderização na GPU (NVENC)
Configurações → Codificador: **Auto** usa NVENC quando o teste real de codificação passa; se uma renderização NVENC falhar, ela é refeita com libx264.

## Problemas comuns
| Sintoma | Solução |
|---|---|
| “Programa não encontrado: ffmpeg.exe” | Defina `FFMPEG_PATH` e `FFPROBE_PATH` em `backend\.env` com o caminho completo |
| “A porta 3001 já está em uso” | Feche a outra janela do ClipForge ou defina `PORT` em `backend\.env` |
| Legendas não aparecem | Diagnóstico precisa mostrar libass ✓, faster-whisper ✓ e o modelo baixado; veja os avisos do projeto |
| YouTube falha | `ai-service\.venv\Scripts\python.exe -m pip install -U yt-dlp` |
| Node antigo | O backend recusa iniciar abaixo do Node 22.13 e diz o motivo |
