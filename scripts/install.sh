#!/usr/bin/env bash
# Linux/macOS equivalent of install-windows.bat (useful for development and CI).
set -euo pipefail
cd "$(dirname "$0")/.."
npm --prefix backend install --no-audit --no-fund
npm --prefix frontend install --no-audit --no-fund
[ -x ai-service/.venv/bin/python ] || python3 -m venv ai-service/.venv
ai-service/.venv/bin/python -m pip install -q --upgrade pip
ai-service/.venv/bin/python -m pip install -q "numpy>=1.26,<3" "yt-dlp>=2025.1.1"
read -r -p "Instalar faster-whisper (transcrição/legendas, ~150 MB)? [s/N] " ans
if [[ "${ans,,}" == s* ]]; then ai-service/.venv/bin/python -m pip install "faster-whisper>=1.1,<2"; fi
npm --prefix frontend run build
node scripts/doctor.mjs || true
echo "Pronto. Inicie com: npm start  (abre em http://localhost:3001)"
