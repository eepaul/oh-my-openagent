#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/paul/projects/oh-my-openagent"
EVIDENCE_DIR="$REPO_ROOT/.omo/evidence/20260726-merge-origin-dev"
REAL_HOME="$HOME"
REAL_DB="$REAL_HOME/.local/share/opencode/opencode.db"
DB_BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session' 2>/dev/null || printf 'n/a')"
ROOT="$(mktemp -d -t omo-merge-qa.XXXXXX)"
FAKE_PID=""

cleanup() {
  if [[ -n "$FAKE_PID" ]]; then
    kill "$FAKE_PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT

mkdir -p "$ROOT/home" "$ROOT/data" "$ROOT/config/opencode" "$ROOT/cache" "$ROOT/state" "$ROOT/project" "$ROOT/captures"
export HOME="$ROOT/home"
export XDG_DATA_HOME="$ROOT/data"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_CACHE_HOME="$ROOT/cache"
export XDG_STATE_HOME="$ROOT/state"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1

CAPTURE_DIR="$ROOT/captures" FAKE_PORT=0 node \
  "$REPO_ROOT/.omo/evidence/20260724-sisyphus-opus5-prompt/capture-fake-llm.mjs" \
  > "$ROOT/fake-llm.log" 2>&1 &
FAKE_PID="$!"

PORT=""
for _ in $(seq 1 50); do
  PORT="$(perl -ne 'print "$1\n" if /listening on (\d+)/' "$ROOT/fake-llm.log" | perl -ne 'print if $. == 1')"
  [[ -n "$PORT" ]] && break
  sleep 0.2
done
[[ -n "$PORT" ]]

cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://$REPO_ROOT/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-5.5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-key",
        "baseURL": "http://127.0.0.1:$PORT/v1",
        "timeout": 30000
      },
      "models": {
        "gpt-5.5": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  }
}
JSONC

printf '%s\n' '{"telemetry":false,"agents":{"sisyphus":{"model":"openai/gpt-5.5"}}}' \
  > "$XDG_CONFIG_HOME/opencode/oh-my-openagent.json"

git -C "$ROOT/project" init -q
timeout 120 opencode run "MERGE_QA reply with a short acknowledgement" \
  --agent sisyphus -m openai/gpt-5.5 --format json \
  > "$EVIDENCE_DIR/opencode-local-plugin-run.jsonl" \
  2> "$EVIDENCE_DIR/opencode-local-plugin-run.stderr"

rg -q 'FAKE_OK' "$EVIDENCE_DIR/opencode-local-plugin-run.jsonl"
test -n "$(ls -A "$ROOT/captures")"

export HOME="$REAL_HOME"
DB_AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session' 2>/dev/null || printf 'n/a')"
{
  printf 'real-db-session-count-before=%s\n' "$DB_BEFORE"
  printf 'real-db-session-count-after=%s\n' "$DB_AFTER"
  printf 'local-plugin=file://%s/packages/omo-opencode/src/index.ts\n' "$REPO_ROOT"
  printf 'fake-model-response=FAKE_OK\n'
  printf 'result=%s\n' "$([[ "$DB_BEFORE" == "$DB_AFTER" ]] && printf PASS || printf FAIL)"
} > "$EVIDENCE_DIR/opencode-local-plugin-summary.txt"

[[ "$DB_BEFORE" == "$DB_AFTER" ]]
