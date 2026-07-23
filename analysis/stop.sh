#!/usr/bin/env bash
# Arrête le backend (et un éventuel frontend Vite résiduel) du
# Digital Reference Explorer.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/.logs"

stopped=0

if [ -f "$LOG_DIR/backend.pid" ]; then
  PID="$(cat "$LOG_DIR/backend.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "[stop] backend arrêté (pid $PID)"
    stopped=1
  fi
  rm -f "$LOG_DIR/backend.pid"
fi

# Filet de sécurité : processus lancés depuis ce dossier
if pkill -f "tsx src/server.ts" 2>/dev/null; then
  echo "[stop] processus backend résiduels arrêtés"
  stopped=1
fi
if pkill -f "vite --port" 2>/dev/null; then
  echo "[stop] frontend Vite arrêté"
  stopped=1
fi

if [ "$stopped" -eq 0 ]; then
  echo "[stop] rien à arrêter"
fi
