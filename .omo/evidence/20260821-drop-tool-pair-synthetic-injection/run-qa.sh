#!/usr/bin/env bash
# QA driver for: remove the tool-pair-repair-injector transform hook.
# Drives a REAL opencode run against the plugin built from this worktree, inside a
# sandbox that isolates the XDG dirs AND the user home, so the real opencode DB and
# the real ~/.config/opencode are never touched.
set -uo pipefail

WORKTREE="${WORKTREE:-/home/paul/projects/oh-my-openagent-wt/chore/drop-tool-pair-synthetic-injection}"
EVIDENCE_DIR="$WORKTREE/.omo/evidence/20260821-drop-tool-pair-synthetic-injection"
MODEL="${QA_MODEL:-opencode/claude-haiku-4-5}"
mkdir -p "$EVIDENCE_DIR"

REAL_DB="$(opencode db path 2>/dev/null)"
BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/omo-qa-drop-injector.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

mkdir -p "$SANDBOX"/{data,config,state,cache,home,tmp,project}
cp "$HOME/.local/share/opencode/auth.json" "$SANDBOX/data/opencode-auth.json" 2>/dev/null || true
mkdir -p "$SANDBOX/data/opencode"
cp "$HOME/.local/share/opencode/auth.json" "$SANDBOX/data/opencode/auth.json" 2>/dev/null || true

cat > "$SANDBOX/project/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$WORKTREE/dist/index.js"]
}
JSON
printf 'qa probe file\n' > "$SANDBOX/project/probe.txt"

export XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state" XDG_CACHE_HOME="$SANDBOX/cache"
export HOME="$SANDBOX/home" TMPDIR="$SANDBOX/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1

mkdir -p "$HOME/.local/share/opencode"
cp "$SANDBOX/data/opencode/auth.json" "$HOME/.local/share/opencode/auth.json" 2>/dev/null || true

cd "$SANDBOX/project"
timeout 300 opencode run "Read probe.txt and reply with exactly DONE." \
  --format json --model "$MODEL" > "$EVIDENCE_DIR/opencode-run.jsonl" 2>"$EVIDENCE_DIR/opencode-run.stderr"
RUN_EXIT=$?

find "$SANDBOX/tmp" -name 'oh-my-opencode.log' -exec cp {} "$EVIDENCE_DIR/plugin.log" \; 2>/dev/null
SANDBOX_SESSIONS="$(sqlite3 "$SANDBOX/data/opencode/opencode.db" 'SELECT count(*) FROM session' 2>/dev/null || echo 'n/a')"
AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"

# The host runs its own interactive opencode, so a raw count delta is noise. The
# meaningful isolation proof is identity: no session created by this run, and no
# session rooted in the sandbox, may appear in the real DB.
QA_SESSION_IDS="$(grep -o '"sessionID":"[^"]*"' "$EVIDENCE_DIR/opencode-run.jsonl" 2>/dev/null | cut -d'"' -f4 | sort -u)"
LEAKED_BY_ID=0
for sid in $QA_SESSION_IDS; do
  n="$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session WHERE id='$sid'")"
  LEAKED_BY_ID=$((LEAKED_BY_ID + n))
done
LEAKED_BY_DIR="$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session WHERE directory LIKE '%omo-qa-drop-injector%'")"

{
  echo "OPENCODE_VERSION=$(opencode --version 2>/dev/null | head -1)"
  echo "MODEL=$MODEL"
  echo "RUN_EXIT=$RUN_EXIT"
  echo "SANDBOX=$SANDBOX"
  echo "REAL_DB=$REAL_DB"
  echo "REAL_DB_SESSIONS_BEFORE=$BEFORE"
  echo "REAL_DB_SESSIONS_AFTER=$AFTER"
  echo "SANDBOX_SESSIONS=$SANDBOX_SESSIONS"
  echo "QA_SESSION_IDS=$(echo $QA_SESSION_IDS)"
  echo "QA_SESSIONS_LEAKED_INTO_REAL_DB=$LEAKED_BY_ID"
  echo "REAL_DB_SESSIONS_ROOTED_IN_SANDBOX=$LEAKED_BY_DIR"
  echo "ISOLATION=$([ "$LEAKED_BY_ID" = "0" ] && [ "$LEAKED_BY_DIR" = "0" ] && echo OK || echo VIOLATED)"
  echo "REAL_DB_COUNT_DELTA=$((AFTER - BEFORE))  # host also runs its own opencode; see WHAT WAS OBSERVED"
  echo "PLUGIN_LOG_LINES=$(wc -l < "$EVIDENCE_DIR/plugin.log" 2>/dev/null || echo 0)"
  echo "INJECTOR_MENTIONS_IN_PLUGIN_LOG=$(grep -c 'toolPairRepairInjector\|tool-pair-repair-injector' "$EVIDENCE_DIR/plugin.log" 2>/dev/null | head -1)"
  echo "TOOL_PAIR_VALIDATOR_LINES=$(grep -c 'tool-pair-validator' "$EVIDENCE_DIR/plugin.log" 2>/dev/null | head -1)"
  echo "RUN_TEXT_EVENTS=$(grep -c '"type":"text"' "$EVIDENCE_DIR/opencode-run.jsonl" 2>/dev/null | head -1)"
} | tee "$EVIDENCE_DIR/summary.txt"
