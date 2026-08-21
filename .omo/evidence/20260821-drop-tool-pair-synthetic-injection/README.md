# Remove the tool-pair-repair-injector transform hook

**Date:** 2026-08-21
**Branch:** `chore/drop-tool-pair-synthetic-injection`
**Base:** `876f28a00` (upstream dev sync merge)
**Change scope:** `packages/omo-opencode/src/hooks/anthropic-context-window-limit-recovery/`,
`packages/omo-opencode/src/hooks/tool-pair-validator/types.ts`,
`packages/omo-opencode/src/plugin/{messages-transform.ts,hooks/create-{transform,core}-hooks.ts}`,
`packages/omo-opencode/src/config/schema/hooks.ts`.
**Plan:** `.omo/plans/20260821-drop-tool-pair-synthetic-injection.md`

## WHAT WAS TESTED

1. **Static before/after on the shipped bundle.** `grep -c toolPairRepairInjector dist/index.js`
   on this branch's build vs the `dev` build in the main checkout, plus the
   `MESSAGES_TRANSFORM_HOOKS` list on both sides. Proves the hook is gone from the artifact
   that actually ships, not just from source.
2. **Unit gates.** `bun run typecheck`, `bun run build`, targeted `bun test` over
   `hooks/tool-pair-validator`, `hooks/anthropic-context-window-limit-recovery`, and `plugin/`,
   then the full root `bun test`.
3. **Real opencode, isolated sandbox.** Built the plugin from this worktree, registered it by
   absolute path in a sandbox `opencode.json`, and drove a real `opencode run` that had to call a
   tool and then answer. Driver: `run-qa.sh` (checked in beside this file, re-runnable).
4. **Control run without the plugin.** Same sandbox recipe, no plugin, to attribute provider
   failures correctly.

## WHAT WAS OBSERVED

### 1. Static before/after

```
本分支 dist/index.js:   0      # toolPairRepairInjector occurrences
dev    dist/index.js:   3

transform chain (MESSAGES_TRANSFORM_HOOKS)
  dev:  btwSideContextInjector, contextInjectorMessagesTransform, teamModeStatusInjector,
        teamMailboxInjector, toolPairRepairInjector, toolPairValidator,
        monitorStatusInjector, categorySkillReminder            (8 entries)
  here: btwSideContextInjector, contextInjectorMessagesTransform, teamModeStatusInjector,
        teamMailboxInjector, toolPairValidator,
        monitorStatusInjector, categorySkillReminder            (7 entries)
```

### 2. Unit gates

```
bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json   -> exit 0
bun run typecheck                                           -> exit 0
bun run build                                               -> exit 0

bun test packages/omo-opencode/src/hooks/tool-pair-validator \
         packages/omo-opencode/src/hooks/anthropic-context-window-limit-recovery \
         packages/omo-opencode/src/plugin
  696 pass  0 fail  (91 files)
```

That targeted run includes upstream's `conversion-invariant.test.ts`, whose
"it added no part type that the conversion would discard" case is the guard written against
exactly this defect class.

Full root suite: `16443 pass / 34 skip / 16 fail`. Every failure was attributed:

| Failure | Attribution |
|---|---|
| `auto-update-checker/checker > getLatestVersion` (5) | pre-existing, network-dependent |
| `codex components doctor check` (3) | pre-existing, host `~/.omo/runtime/ast-grep` pollution |
| `GPT Mini reference audit` | pre-existing on `backup/dev-before-upstream-sync-20260821` |
| `OpenCode adapter Bun runtime audit` | pre-existing on the same baseline |
| `validatePluginConfig canonical agent model chains` | pre-existing on the same baseline |
| `sisyphus-task > sync continuation preserves variant` | pre-existing on the same baseline |
| `checkExtensionCurrent` | pre-existing on plain `origin/dev`; 30s terser timeout |
| `TaskManager claim characterization` | flaky under full-suite load; passes 3/3 in isolation |
| `config source discovery > loads skills from local sources path` | flaky under full-suite load; passes in isolation |
| `assembled DAG runtime > ... shipped RPC receives the recovery scheduler overflow` | worktree-environment artifact: 300 ms hard timeout in the test helper. Reproduced on a **plain `dev`** detached worktree with the identical symlinked-`node_modules` layout, and passes in the main checkout. `git diff --stat dev -- packages/omo-senpi/src packages/senpi-task/src` is empty on this branch. |

Zero failures attributable to this change.

### 3. Real opencode, isolated sandbox

opencode **1.18.19**. Sandbox isolates `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` /
`XDG_CACHE_HOME`, `TMPDIR`, **and `HOME`** (the Claude Code compatibility loaders read
`~/.claude.json`, `~/.claude/skills`, `~/.agents`). Only `auth.json` was copied in.

```
OPENCODE_VERSION=1.18.19
MODEL=kimi-for-coding/kimi-for-coding-highspeed
RUN_EXIT=0
QA_SESSION_IDS=ses_fdd29d679ffep0VNAd9ZHbFrOd
QA_SESSIONS_LEAKED_INTO_REAL_DB=0
REAL_DB_SESSIONS_ROOTED_IN_SANDBOX=0
ISOLATION=OK
REAL_DB_COUNT_DELTA=0
SANDBOX_SESSIONS=1
PLUGIN_LOG_LINES=27
INJECTOR_MENTIONS_IN_PLUGIN_LOG=0
RUN_TEXT_EVENTS=1
```

Plugin loaded into the sandbox with no host-config leak (`plugin.log`):

```
[oh-my-openagent] ENTRY - plugin loading {"directory":"/tmp/omo-qa-drop-injector.JqnwjC/project"}
[tool-registry] Built tool registry {"totalTools":14,"teamModeEnabled":false,"teamToolCount":0}
Loaded 0 plugins with 0 commands, 0 skills, 0 agents, 0 MCP servers
[connected-providers-cache] Fetched connected providers {"count":5,...}
```

The run exercised a **real OpenCode `ToolPart`** and then answered (`opencode-run.jsonl`):

```
step_start
tool_use   part.type="tool"  tool="read"  callID="tool_ZziL5n6SOiJrFm7Syb9RTDQx"  state.status="completed"
step_finish  reason="tool-calls"
step_start
text       "DONE"
step_finish  reason="stop"
```

Two steps means the transform chain ran at least twice, and the second pass saw a message array
containing that completed `tool` part. With the injector removed the chain completed, the request
was built, and the session finished cleanly.

**Isolation is asserted by identity, not by a count.** This host runs its own interactive opencode,
so the raw `session` count moves on its own: an earlier attempt showed a `+1` delta that resolved to
a host session in `/home/paul/projects/opencode-mods`, unrelated to the sandbox. The binding
assertions are that the QA session id does not exist in the real DB and that no real-DB session is
rooted under `omo-qa-drop-injector`. Both are `0`.

### 4. Control run (no plugin)

Two providers fail in this sandbox for reasons outside the plugin, confirmed by running the same
prompt with **no plugin registered**:

- `opencode/*` -> `APIError 401 CreditsError: Insufficient balance` (opencode Zen billing)
- `anthropic/*`, `opencode-go/*` -> `UnknownError: Unexpected server error` **with and without the
  plugin**, so not attributable to this change

`kimi-for-coding/*` and `openai/*` both complete. The recorded run uses kimi.

## WHY IT IS ENOUGH

- The static before/after proves the hook is absent from the shipped bundle, which is what a user
  actually loads; a source-only diff would not.
- The targeted unit run includes upstream's conversion-invariant guard, so the property this change
  relies on ("nothing injects a part type the conversion discards") is machine-checked, not asserted
  in prose.
- The real run drives the exact shape that motivated the hook: an assistant turn carrying a genuine
  `ToolPart`, through the transform chain, on real opencode. It completes.
- The control run separates provider/billing failures from plugin failures, so `RUN_EXIT=0` on kimi
  is a real signal rather than a lucky provider.
- Every full-suite failure is individually attributed to a named baseline, including the one
  senpi failure, which was reproduced on plain `dev` in an identically-configured worktree.

**Residual risk.** Reactive `tool_pair_mismatch` recovery no longer short-circuits on the
per-`messageIndex`/`toolUseID` idempotency set, so a repeated mismatch now runs the summarize retry
each time instead of returning early. It stays bounded by `RETRY_CONFIG.maxAttempts` (2). This path
is not covered by the live run above, because provoking a real `tool_pair_mismatch` 400 requires an
Anthropic-family provider, and the two available ones fail in this sandbox for billing/auth reasons.
It is covered by unit tests in `recovery-hook.test.ts`.

## WHAT WAS OMITTED

- `auth.json` was copied into the sandbox but is not reproduced here. No tokens, API keys, or auth
  headers appear in any artifact; `plugin.log` and `opencode-run.jsonl` were checked for them.
- `plugin.log` is the sandbox-local plugin log only. It contains sandbox filesystem paths and no
  credentials.
- The provider error payloads quoted above are trimmed to the error type and message; the billing
  URL contains a workspace id and is reproduced only because it is already user-visible in the CLI.

## ARTIFACTS

| File | Contents |
|---|---|
| `run-qa.sh` | The driver. Re-runnable: `QA_MODEL=<model> bash run-qa.sh` |
| `summary.txt` | Machine-readable assertion block from the recorded run |
| `opencode-run.jsonl` | Full structured event stream of the recorded run |
| `opencode-run.stderr` | stderr of the recorded run (empty) |
| `plugin.log` | Sandbox-local oh-my-openagent plugin log |
