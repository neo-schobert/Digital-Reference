#!/usr/bin/env bash
# Enregistre la vidéo de démo du Digital Reference Explorer.
#
#   ./record.sh                 démo en anglais (par défaut)
#   ./record.sh --lang fr       démo en français
#   ./record.sh --fast          réutilise l'alignement déjà calculé (pas d'appel LLM)
#   ./record.sh --silent        pas de voix off (sous-titres incrustés seulement)
#
# L'app doit tourner (../start.sh) : le script s'arrête proprement sinon.
set -euo pipefail
cd "$(dirname "$0")"

[ -d "$HOME/.local/opt/node22/bin" ] && export PATH="$HOME/.local/opt/node22/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

command -v node >/dev/null || { echo "Node.js introuvable (voir ../start.sh)"; exit 1; }

if [ ! -d node_modules/playwright ]; then
  echo "· installation de Playwright…"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent
fi

if ! node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1; then
  echo "· téléchargement du navigateur…"
  npx playwright install chromium
fi

if ! python3 -c "import edge_tts" 2>/dev/null; then
  echo "· installation de edge-tts (voix off)…"
  python3 -m pip install --user --break-system-packages --quiet edge-tts
fi

if [ ! -x "${FFMPEG:-$HOME/.local/bin/ffmpeg}" ] && ! command -v ffmpeg >/dev/null; then
  echo "· téléchargement de ffmpeg (statique, sans droits root)…"
  mkdir -p "$HOME/.local/bin" && tmp=$(mktemp -d)
  curl -sL -o "$tmp/ff.tar.xz" https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar xf "$tmp/ff.tar.xz" -C "$tmp"
  cp "$tmp"/ffmpeg-*-amd64-static/ffmpeg "$HOME/.local/bin/ffmpeg"
  chmod +x "$HOME/.local/bin/ffmpeg"; rm -rf "$tmp"
fi
command -v ffmpeg >/dev/null && export FFMPEG="${FFMPEG:-$(command -v ffmpeg)}"

exec node record.mjs "$@"
