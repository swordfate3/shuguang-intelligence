#!/bin/sh
# All container-specific paths are owned here; subject state and model calls stay in Dawn.
set -eu
umask 077
APP=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)
DATA=${DAWN_DATA_DIR:-/data}
MAIN="$APP/packages/dawn/src/main.ts"
MANAGE="$APP/docker/manage.ts"
case "$DATA" in /*) ;; *) printf '%s\n' 'DAWN_DATA_DIR must be an absolute private directory.' >&2; exit 1 ;; esac
export DAWN_DATA_DIR="$DATA"
command=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
  help|--help|-h)
    cat <<'HELP'
Dawn container (no automatic initialization, wake, generation or learning)
  setup                                         Guided first setup or validate/reuse existing private files
  init <id> <name> <total-calls> <learning-calls>  Explicit new v3 + fixed sample pack + service token
  model-config                                  Offline interactive wizard; new model.json only
  credentials                                   Hidden interactive key entry; new model.env only
  serve                                         Foreground model service; fails if setup is missing
  pi [Pi arguments...]                           Pi + Dawn extension + fixed loopback connection
  request <command...>                           Standalone control client (status/wake/sleep/say/model controls)
  status | budget | learning-status              Safe queries (budget/learning-status open existing DB)
  learning-run                                  Foreground approved learning; stop same-DB serve first
  learning-stop                                 Permanently revoke learning authorization
  learning-recover                              Only after ALL same-DB services/runners have stopped
  shell                                         Interactive Bash, no automatic model-key injection
Examples: request wake 0; request model-status; request thinking 0 high
Model key is never a command argument. Configure only with credentials in a TTY.
HELP
    ;;
  setup)
    [ "$#" -eq 0 ] || exit 1
    exec node "$APP/docker/setup.ts"
    ;;
  init)
    if [ "$#" -ne 4 ]; then printf '%s\n' 'Usage: init <id> <name> <total-calls> <learning-calls>' >&2; exit 1; fi
    node "$MANAGE" verify-directory
    for file in "$DATA/subject.sqlite" "$DATA/service.token"; do
      if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\n' 'Initialization refused: database or service token already exists; no overwrite or automatic cleanup.' >&2; exit 1; fi
    done
    node "$MAIN" learning-init --db "$DATA/subject.sqlite" --id "$1" --name "$2" \
      --limit "$3" --learning-limit "$4" --pack "$APP/config/learning-pack.example.json"
    exec node "$MAIN" token-init --token-file "$DATA/service.token"
    ;;
  model-config)
    [ "$#" -eq 0 ] || exit 1
    node "$MANAGE" verify-directory
    exec node "$MAIN" model-config --output "$DATA/model.json"
    ;;
  credentials)
    [ "$#" -eq 0 ] || exit 1
    exec node "$MANAGE" credentials
    ;;
  serve)
    [ "$#" -eq 0 ] || exit 1
    node "$MANAGE" verify-files
    exec node --env-file="$DATA/model.env" "$MAIN" serve --subject-db "$DATA/subject.sqlite" \
      --token-file "$DATA/service.token" --port 7341 --model-config "$DATA/model.json"
    ;;
  pi)
    # Pi receives a token PATH, never Dawn's model credentials. Explicit -e works with a fresh Pi home volume.
    export DAWN_ENDPOINT=http://127.0.0.1:7341
    export DAWN_TOKEN_FILE="$DATA/service.token"
    exec pi -e "$APP/packages/pi-extension/src/index.ts" "$@"
    ;;
  request)
    exec node "$MAIN" request --endpoint http://127.0.0.1:7341 --token-file "$DATA/service.token" -- "$@"
    ;;
  status)
    [ "$#" -eq 0 ] || exit 1
    exec node "$MAIN" request --endpoint http://127.0.0.1:7341 --token-file "$DATA/service.token" -- status
    ;;
  budget)
    [ "$#" -eq 0 ] || exit 1
    exec node "$MAIN" subject-budget --db "$DATA/subject.sqlite"
    ;;
  learning-status|learning-stop|learning-recover)
    [ "$#" -eq 0 ] || exit 1
    exec node "$MAIN" "$command" --db "$DATA/subject.sqlite"
    ;;
  learning-run)
    [ "$#" -eq 0 ] || exit 1
    node "$MANAGE" verify-files
    exec node --env-file="$DATA/model.env" "$MAIN" learning-run --db "$DATA/subject.sqlite" --model-config "$DATA/model.json"
    ;;
  shell)
    [ "$#" -eq 0 ] || exit 1
    exec /bin/bash
    ;;
  *)
    printf '%s\n' 'Unknown container command. Run: dawn-container help' >&2
    exit 1
    ;;
esac
