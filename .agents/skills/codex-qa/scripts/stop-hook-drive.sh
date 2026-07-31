#!/usr/bin/env bash
# stop-hook-drive.sh - FIRST-PARTY proof for OMO Stop hooks. It installs the
# local plugin into an isolated CODEX_HOME, writes a Boulder fixture only after
# the app-server allocates the live session ID, and captures the corresponding
# hook/started, hook/completed, and hook stdout entries.
#
#   --self-test                  runs waiting_on_human (no block) and active
#                                (block) control cases. (default)
#   --status <active|waiting_on_human>
#                                runs one fixture case with its expected result.
#   --keep                       preserves the isolated CODEX_HOME.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

cqa_assert_live_fixture() {
  local status="$1" out="$2"
  printf '%s' "$out" | jq -e --arg status "$status" '
    .stopFixture.status == $status and .stopFixture.sessionId == .threadId
  ' >/dev/null
}

cqa_assert_start_work_stop_hook() {
  local out="$1"
  printf '%s' "$out" | jq -e '
    [
      .hooks[]
      | select(
          .eventName == "stop"
          and ((.sourcePath // "") | contains("start-work-continuation"))
        )
      | .method
    ] as $notifications
    | ($notifications | index("hook/started") != null)
      and ($notifications | index("hook/completed") != null)
  ' >/dev/null
}

cqa_assert_block_decision() {
  local expected="$1" out="$2"
  local filter='
    [
      .hookDecisions[]?
      | select(
          .eventName == "stop"
          and ((.sourcePath // "") | contains("start-work-continuation"))
        )
    ]
    | any(.[]; .decision == "block")
  '
  if [ "$expected" = "block" ]; then
    printf '%s' "$out" | jq -e "$filter" >/dev/null
  else
    ! printf '%s' "$out" | jq -e "$filter" >/dev/null
  fi
}

cqa_run_stop_fixture() {
  local status="$1" expected="$2" out rc=0
  out="$(STOP_FIXTURE_STATUS="$status" EXPECT_HOOK="stop" ALLOW_BLOCKED_HOOK="stop" CAPTURE_HOOK_OUTPUT="stop" PROMPT="say hello" DEADLINE_MS="${DEADLINE_MS:-90000}" \
    node "$SCRIPT_DIR/lib/app-server-client.mjs")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'STOP_FIXTURE_STATUS=%s EXPECTED_DECISION=%s\n%s\n' "$status" "$expected" "$out"
    cqa_fail "app-server turn failed for $status"
    return 1
  fi
  cqa_assert_live_fixture "$status" "$out" || { cqa_fail "fixture did not bind the live thread ID"; return 1; }
  cqa_assert_start_work_stop_hook "$out" || { cqa_fail "start-work-continuation Stop hook notifications missing"; return 1; }
  cqa_assert_block_decision "$expected" "$out" || { cqa_fail "unexpected Stop decision for $status"; return 1; }
  printf 'STOP_FIXTURE_STATUS=%s EXPECTED_DECISION=%s\n' "$status" "$expected"
  printf '%s' "$out" | jq '{
    ok,
    turnStatus,
    threadId,
    turnId,
    stopFixture,
    hooks: [
      .hooks[]
      | select(.eventName == "stop" and ((.sourcePath // "") | contains("start-work-continuation")))
      | {method, eventName, status, sourcePath}
    ],
    hookDecisions
  }'
  cqa_pass "$status fixture: live Stop hook fired with expected $expected decision"
}

cqa_prepare_stop_hook() {
  cqa_require codex node jq || return 1
  cqa_guard_real_home
  printf 'REAL_CODEX_CONFIG_SHA256_BEFORE=%s\n' "$CQA_REAL_HOME_SUM"
  cqa_mk_isolated_home
  export QA_CWD="$CODEX_HOME/stop-hook-project"
  mkdir -p "$QA_CWD"
  cqa_log "installing local omo build into $CODEX_HOME ..."
  cqa_install_local_omo || { tail -20 "$CQA_HOME_ROOT/install.log" >&2; return 1; }
  grep -q 'omo@sisyphuslabs' "$CODEX_HOME/config.toml" || { cqa_fail "omo not enabled in isolated config.toml"; return 1; }
  cqa_start_mock || return 1
}

cqa_finish_stop_hook() {
  printf 'REAL_CODEX_CONFIG_SHA256_AFTER=%s\n' "$(cqa_real_home_config_sum)"
  cqa_assert_real_home_unchanged
}

MODE="--self-test"; STATUS=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) MODE="$1"; shift ;;
    --status) MODE="--status"; STATUS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) cqa_log "unknown option: $1"; exit 2 ;;
  esac
done

if [ "$KEEP" = "1" ]; then trap - EXIT; fi

if [ "$MODE" = "--status" ]; then
  cqa_prepare_stop_hook || exit $?
  case "$STATUS" in
    active) cqa_run_stop_fixture active block ;;
    waiting_on_human) cqa_run_stop_fixture waiting_on_human no-block ;;
    *) cqa_fail "--status must be active or waiting_on_human"; exit 2 ;;
  esac
  rc=$?
  cqa_finish_stop_hook || rc=1
  exit "$rc"
fi

cqa_prepare_stop_hook || exit $?
cqa_run_stop_fixture waiting_on_human no-block || exit $?
cqa_run_stop_fixture active block || exit $?
cqa_finish_stop_hook
