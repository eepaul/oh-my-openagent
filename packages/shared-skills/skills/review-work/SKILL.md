---
name: review-work
description: "Post-implementation review built for the adaptive-workflow Spec model. Spawns 5 independent review lanes in ONE turn using parallel task calls: Spec conformance, verification evidence, code quality, security, context mining. Every lane must PASS. Use before handing work back, before a PR, or when the user asks to review completed work. Triggers: 'review work', 'review my work', 'review changes', 'QA my work', 'verify implementation', 'check my work', 'validate changes', 'post-implementation review'."
---

# Review Work

Five independent reviewers, launched in one turn, all must pass.

**The value here is independence, not checklists.** Each lane starts with a fresh context, so it does not inherit the implementer's anchoring. Tell each lane what it OWNS and what evidence it must produce. Do not hand it a checklist to tick through: a capable reviewer finds the things a checklist would have missed, and a checklist quietly caps the search at its own items.

## Phase 0: Anchor on the Spec

adaptive-workflow puts the authority in `docs/specs/<story-slug>/spec.md`: User Story, Verification Contract, Known Constraints, Execution Boundary, and optionally Spec Change Impact. **Read it first.** It is the standard every lane judges against, so you pass its path to every lane rather than re-deriving the goal from chat history.

If no `spec.md` exists, say so explicitly and review against the user's stated objective. Do not invent a Spec, and do not fail the work merely for lacking one.

Also collect:

- The diff and changed file list, against the right base (`git diff main...HEAD`, `git diff HEAD~1`, or the branch point).
- How to exercise the real surface: the CLI command, HTTP entrypoint, job, or script a real consumer would use.

Review a PR or branch from a dedicated worktree (`git worktree add`). The main checkout is read-only context.

Lanes read files and run commands themselves. Give them paths, the spec path, and the base ref. Do not paste whole file contents into prompts.

## Phase 1: Launch 5 lanes in ONE turn

Put all five `task` calls in a single message. opencode executes tool calls from the same message concurrently, so this is real parallelism with no background machinery. Model diversity across lanes is deliberate: correlated blind spots are the failure mode this skill exists to prevent.

| # | Lane | Agent | Owns |
|---|------|-------|------|
| 1 | Spec conformance & scope discipline | `oracle` | Did we build exactly what the Spec says, and nothing else? |
| 2 | Verification evidence | `general` | Is the claimed evidence real, and does it come from the real surface? |
| 3 | Code quality | `review-claude-agent` | Would a senior engineer approve this diff? |
| 4 | Security | `oracle` | What can an attacker or a careless operator do with this? |
| 5 | Context mining | `general` | Is there something we should have known but did not? |

Every lane prompt states: the spec path, the base ref, the changed files, and this instruction — **open the first line of your reply with exactly one of `PASS`, `FAIL`, or `INCONCLUSIVE`, then report findings in whatever structure serves the reader.** Do not prescribe an output template beyond that first line; reviewers write better reports in their own structure, and the first line is all the aggregation needs.

### Lane 1: Spec conformance & scope discipline (`oracle`)

Judge the implementation against all four Spec parts. Every observable outcome in the User Story must hold. Every Known Constraint must be satisfied with code evidence. The Execution Boundary must not have been crossed. If the Story had a Spec Change Impact review, its confirmed disposition must be recorded in section 5 of `spec.md`.

Then check the other direction, which is the one implementers miss: **scope creep and process tax.** adaptive-workflow forbids adding unrequested design layers, freeze gates, reviewers, governance artifacts, typed stubs built to constrain future work, and speculative abstraction. Anything added that the Spec did not ask for is a finding, not a bonus.

### Lane 2: Verification evidence (`general`)

This lane owns the question adaptive-workflow cares about most: **was the real surface actually observed, or did green tests get substituted for it?**

Re-run the Verification Contract's stated observation through the public entrypoint yourself. Compare what you observe against the recorded Observation. If the Proposal planned one thing and the implementation observed another, the Limitations must have been updated to match.

Then audit new and modified tests against the workflow's rules: no test may cover behavior that was not first implemented and observed through the real surface (a Bug-fix replay of an already-observed failure is the sole exception); tests added purely for coverage, for per-function completeness, for implementation details, for guessing at unobserved external behavior, or built on speculative mocks do not earn their maintenance cost. Deleting, weakening, or skipping an existing test is an automatic FAIL.

Also confirm temporary data and side effects were cleaned up.

### Lane 3: Code quality (`review-claude-agent`)

Standard: would you approve this PR without comments? Judge correctness, consistency with the patterns in neighboring files, readability, error handling, type safety, performance, and the abstraction level. Report findings as CRITICAL / MAJOR / MINOR / NITPICK; only CRITICAL and MAJOR block.

Do not request intermediate design artifacts. Internal module boundaries, types, and call chains are the implementer's to choose.

### Lane 4: Security (`oracle`)

Look only for what an attacker or a careless operator could do, and for irreversible or destructive behavior reachable from a public entrypoint. Ignore style and architecture unless they create the risk. Rank by exploitability, not by category name. Report severity CRITICAL / HIGH / MEDIUM / LOW; CRITICAL and HIGH block.

### Lane 5: Context mining (`general`)

Search everything reachable for context that should have informed this work: `git log` and `git blame` on the changed files, reverted commits, `gh issue list` / `gh pr list` and past review comments, files that import the changed modules, docs and configs that reference the changed behavior, and any Slack or Notion MCP tools available. Report what you searched and what you deliberately skipped, so the gaps are visible.

## Phase 2: Aggregate

Wait for all five. Record each verdict the moment it lands; never lose a completed lane's result because another is still running.

A lane that returns without a usable verdict is `INCONCLUSIVE`, never `PASS`. Respawn it once, scoped smaller. If it fails again, leave it `INCONCLUSIVE` and report it by name. Re-review after fixes is a fresh spawn scoped to the delta, never a follow-up to a reviewer carrying stale context.

## Phase 3: Verdict

- All five `PASS` → **REVIEW PASSED**
- Any `FAIL` → **REVIEW FAILED**
- Any `INCONCLUSIVE` and none failed → **REVIEW INCONCLUSIVE** (not an approval)

Report a one-line-per-lane verdict table, then the blocking issues deduplicated and ordered by what to fix first, each naming the file and the concrete fix. If passed, keep it short: the verdict, and any non-blocking suggestions worth a moment. Do not turn a passing review into a lecture.
