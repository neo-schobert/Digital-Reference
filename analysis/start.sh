#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lancement unifié du Digital Reference Explorer
#
#   ./start.sh          ouvre une FENÊTRE DE TERMINAL dédiée qui exécute
#                       l'application ; FERMER CETTE FENÊTRE (ou Ctrl+C)
#                       arrête proprement backend + frontend.
#   ./start.sh --run    mode interne : exécution réelle (c'est ce que la
#                       fenêtre lance). Utilisable aussi directement si l'on
#                       veut tout garder dans le terminal courant.
#
# Au démarrage, les ports nécessaires (backend + frontend) sont libérés :
# tout processus qui écoute encore dessus est arrêté.
# Ports personnalisés : DR_BACKEND_PORT=… DR_FRONTEND_PORT=… ./start.sh
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$ROOT/$(basename "${BASH_SOURCE[0]}")"
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

BACKEND_PORT="${DR_BACKEND_PORT:-3178}"
FRONTEND_PORT="${DR_FRONTEND_PORT:-5173}"
TITLE="Digital Reference Explorer  —  fermer cette fenêtre = tout arrêter"

info() { printf '\033[1;34m[start]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[erreur]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Mode lanceur : ouvre une fenêtre de terminal qui exécute « $SELF --run ».
# Si aucun terminal graphique n'est disponible (ou pas de session graphique),
# on bascule en exécution directe dans le terminal courant.
# ---------------------------------------------------------------------------
if [ "${1:-}" != "--run" ]; then
  # Fichier témoin : écrit par le mode --run dès son démarrage. On ne déclare
  # la fenêtre « ouverte » que si le témoin apparaît ; sinon on essaie le
  # terminal suivant, et en dernier recours on exécute ici même.
  STAMP="$LOG_DIR/run.started"
  rm -f "$STAMP"
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    tried=""
    for term in ptyxis gnome-terminal konsole xfce4-terminal kitty alacritty foot x-terminal-emulator xterm; do
      command -v "$term" >/dev/null 2>&1 || continue
      real="$(readlink -f "$(command -v "$term")")"
      case " $tried " in *" $real "*) continue ;; esac   # même binaire déjà essayé
      tried="$tried $real"
      TERMLOG="$LOG_DIR/terminal-$term.log"
      # Tous lancés en arrière-plan : certains clients (ptyxis, kitty…)
      # ne rendent pas la main tant que la fenêtre est ouverte.
      case "$term" in
        ptyxis)
          ptyxis --new-window -T "$TITLE" -d "$ROOT" -- "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        gnome-terminal)
          gnome-terminal --title="$TITLE" -- "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        konsole)
          konsole -p tabtitle="$TITLE" -e "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        xfce4-terminal)
          xfce4-terminal -T "$TITLE" -x "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        kitty|foot)
          "$term" "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        alacritty)
          alacritty -T "$TITLE" -e "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
        x-terminal-emulator|xterm)
          "$term" -T "$TITLE" -e "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT" >"$TERMLOG" 2>&1 & disown ;;
      esac
      for i in $(seq 1 17); do
        [ -f "$STAMP" ] && break
        sleep 0.3
      done
      if [ -f "$STAMP" ]; then
        info "Fenêtre de terminal ouverte ($term)."
        info "Fermer cette fenêtre (ou Ctrl+C dedans) arrêtera backend et frontend."
        exit 0
      fi
      err "La fenêtre $term ne s'est pas ouverte (journal : $TERMLOG) — essai suivant…"
    done
    err "Aucune fenêtre de terminal n'a pu être ouverte — exécution dans ce terminal."
  else
    info "Pas de session graphique — exécution dans ce terminal."
  fi
  exec "$SELF" --run "$BACKEND_PORT" "$FRONTEND_PORT"
fi

# ---------------------------------------------------------------------------
# Mode --run : exécution réelle.
# ---------------------------------------------------------------------------
BACKEND_PORT="${2:-$BACKEND_PORT}"
FRONTEND_PORT="${3:-$FRONTEND_PORT}"

# Témoin lu par le mode lanceur : la fenêtre a bien démarré.
echo "$$" >"$LOG_DIR/run.started"

# Arrêt propre : déclenché à la sortie, quelle qu'en soit la cause —
# fermeture de la fenêtre (SIGHUP), Ctrl+C (SIGINT), kill (SIGTERM), erreur.
VITE_PID=""
cleanup() {
  local code=$?
  trap - EXIT
  if [ -n "$VITE_PID" ]; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  if [ -f "$LOG_DIR/backend.pid" ]; then
    kill "$(cat "$LOG_DIR/backend.pid")" 2>/dev/null || true
    rm -f "$LOG_DIR/backend.pid"
  fi
  # Filet de sécurité : processus résiduels (repris de l'ancien stop.sh)
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  pkill -f "vite --port" 2>/dev/null || true
  # Ne retirer le témoin que s'il est à nous (une nouvelle instance a pu
  # écrire le sien pendant que celle-ci s'arrête).
  if [ "$(cat "$LOG_DIR/run.started" 2>/dev/null)" = "$$" ]; then
    rm -f "$LOG_DIR/run.started"
  fi
  info "Backend et frontend arrêtés."
  # En cas d'erreur (hors signal), on laisse la fenêtre ouverte pour lire
  # le message avant qu'elle ne disparaisse.
  if [ "$code" -ne 0 ] && [ "$code" -lt 128 ]; then
    read -rp "Appuyez sur Entrée pour fermer cette fenêtre…" _ 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# 1. Libération des ports nécessaires : tout processus qui écoute encore
#    sur le port backend ou frontend est arrêté (TERM, puis KILL si besoin).
# ---------------------------------------------------------------------------
clear_port() {
  local port="$1" name="$2" pids i
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  info "Port $port ($name) occupé — arrêt du/des processus $(echo $pids | tr '\n' ' ')…"
  kill $pids 2>/dev/null || true
  for i in $(seq 1 10); do
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    sleep 0.5
  done
  err "Le port $port résiste — arrêt forcé (kill -9)."
  kill -9 $pids 2>/dev/null || true
  sleep 0.5
}

rm -f "$LOG_DIR/backend.pid"
clear_port "$BACKEND_PORT" "backend"
clear_port "$FRONTEND_PORT" "frontend"

# ---------------------------------------------------------------------------
# 2. Node.js : PATH courant, puis emplacements usuels (installation locale,
#    nvm), sinon on explique comment l'installer sans droits root.
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME/.local/opt/node22/bin" "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$candidate/node" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  err "Node.js est introuvable sur cette machine."
  cat >&2 <<'EOF'
Installation sans droits root (recommandée) — copiez-collez :

  mkdir -p ~/.local/opt && cd ~/.local/opt \
    && curl -L -o node.tar.xz https://nodejs.org/dist/v22.17.1/node-v22.17.1-linux-x64.tar.xz \
    && tar xf node.tar.xz && rm node.tar.xz \
    && mv node-v22.17.1-linux-x64 node22 \
    && echo 'export PATH="$HOME/.local/opt/node22/bin:$PATH"' >> ~/.bashrc \
    && export PATH="$HOME/.local/opt/node22/bin:$PATH"

Puis relancez ce script.
EOF
  exit 1
fi
info "node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------
# 3. Dépendances npm, avec diagnostic clair en cas d'échec
# ---------------------------------------------------------------------------
explain_npm_failure() {
  local log="$1"
  err "L'installation des dépendances a échoué. Dernières lignes du journal ($log) :"
  tail -n 15 "$log" >&2
  echo >&2
  if grep -qE 'EACCES|EPERM' "$log"; then
    err "Cause probable : PERMISSIONS insuffisantes."
    cat >&2 <<EOF
  - Vérifiez que le dossier vous appartient :  ls -ld "$ROOT"
  - Si le cache npm est en cause :             sudo chown -R \$(id -u):\$(id -g) ~/.npm
  - N'utilisez PAS sudo npm install : corrigez plutôt les droits ci-dessus.
EOF
  elif grep -qE 'ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|407|proxy' "$log"; then
    err "Cause probable : RÉSEAU (pas d'accès à registry.npmjs.org, proxy d'entreprise ?)."
    cat >&2 <<'EOF'
  - Testez :  curl -I https://registry.npmjs.org
  - Derrière un proxy :  npm config set proxy http://... && npm config set https-proxy http://...
EOF
  elif grep -q 'ENOSPC' "$log"; then
    err "Cause probable : DISQUE PLEIN. Libérez de l'espace puis relancez (df -h)."
  else
    err "Cause non identifiée automatiquement — lisez le journal complet ci-dessus."
  fi
  exit 1
}

ensure_deps() {
  local dir="$1" name="$2"
  if [ ! -d "$dir/node_modules" ]; then
    info "Installation des dépendances $name (première exécution)…"
    if ! (cd "$dir" && npm install >"$LOG_DIR/npm-$name.log" 2>&1); then
      explain_npm_failure "$LOG_DIR/npm-$name.log"
    fi
    info "Dépendances $name installées."
  fi
}

ensure_deps "$ROOT/backend" "backend"
ensure_deps "$ROOT/frontend" "frontend"

# ---------------------------------------------------------------------------
# 4. Backend en arrière-plan
# ---------------------------------------------------------------------------
info "Démarrage du backend sur le port $BACKEND_PORT…"
(
  cd "$ROOT/backend"
  DR_BACKEND_PORT="$BACKEND_PORT" nohup npx tsx src/server.ts \
    >"$LOG_DIR/backend.log" 2>&1 &
  echo $! >"$LOG_DIR/backend.pid"
)

BACKEND_PID="$(cat "$LOG_DIR/backend.pid")"

for i in $(seq 1 60); do
  if curl -sf "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    err "Le backend s'est arrêté au démarrage. Journal :"
    tail -n 25 "$LOG_DIR/backend.log" >&2
    exit 1
  fi
  if [ "$i" -eq 60 ]; then
    err "Le backend ne répond pas après 30 s. Journal :"
    tail -n 25 "$LOG_DIR/backend.log" >&2
    exit 1
  fi
  sleep 0.5
done
info "Backend prêt : http://localhost:$BACKEND_PORT (log : $LOG_DIR/backend.log)"

# ---------------------------------------------------------------------------
# 5. Frontend — --open lance le navigateur automatiquement.
#    Vite tourne en arrière-plan et le script attend via « wait » : ainsi,
#    fermer la fenêtre de terminal (SIGHUP) ou Ctrl+C interrompt le wait
#    immédiatement et cleanup() arrête Vite ET le backend. (En avant-plan,
#    bash différerait le trap tant que Vite tourne — et Vite ignore SIGHUP.)
# ---------------------------------------------------------------------------
info "Démarrage du frontend sur le port $FRONTEND_PORT — le navigateur va s'ouvrir…"
info "Pour tout arrêter : fermez cette fenêtre, ou Ctrl+C."
cd "$ROOT/frontend"
DR_BACKEND_PORT="$BACKEND_PORT" npx vite --port "$FRONTEND_PORT" --strictPort --open &
VITE_PID=$!
wait "$VITE_PID"
