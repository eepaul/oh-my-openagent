import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isContinuableStatus,
	parseBoulderWorkStatus,
	readContinuationState,
} from "../src/boulder-reader.js";
import { cleanupBoulderWorkspaces, createBoulderJson, createWorkspace } from "./fixtures/boulder-workspace.js";

const SCAFFOLD_PLAN_MARKDOWN = readFileSync(new URL("./fixtures/plan-scaffold.md", import.meta.url), "utf8");

afterEach(() => {
	cleanupBoulderWorkspaces();
});

describe("start-work boulder state reader", () => {
	it("#given waiting_on_human status #when parsed and evaluated #then it is legal but not continuable", () => {
		// given
		const rawStatus = "waiting_on_human";

		// when
		const status = parseBoulderWorkStatus(rawStatus);

		// then
		expect(status).toBe("waiting_on_human");
		expect(isContinuableStatus(status)).toBe(false);
	});

	it("#given active codex work with remaining checklist #when state is read #then continuation fields match baseline", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "active", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: SCAFFOLD_PLAN_MARKDOWN,
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toEqual({
			planName: "launch-plan",
			planPath: join(workspace, ".omo", "plans", "plan.md"),
			boulderPath: join(workspace, ".omo", "boulder.json"),
			ledgerPath: join(workspace, ".omo", "start-work", "ledger.jsonl"),
			worktreePath: null,
			checklist: {
				completed: 2,
				remaining: 2,
				total: 4,
				nextTaskLabel: "1. Implement checklist parser parity",
			},
		});
	});

	it("#given completed codex work #when state is read #then continuation is absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "completed", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given paused codex work with remaining checklist #when state is read #then continuation is present", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "paused", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state?.planName).toBe("launch-plan");
		expect(state?.checklist).toEqual({ completed: 0, remaining: 1, total: 1, nextTaskLabel: "1. First" });
	});

	it("#given waiting_on_human codex work with remaining checklist #when state is read #then continuation is absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "waiting_on_human", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. Wait for the human\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given an unknown codex work status #when state is read #then continuation remains absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "unrecognized", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. Preserve fail-closed parsing\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given active codex work with no remaining checklist items #when state is read #then final gate continuation remains present", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "active", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [x] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state?.checklist).toEqual({ completed: 1, remaining: 0, total: 1, nextTaskLabel: null });
	});

	it("#given active codex work with no readable checklist #when state is read #then continuation remains absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "active", sessionIds: ["codex:sess_abc"] }),
			planMarkdown: "# Plan\n\nNo checklist yet.\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given corrupt boulder JSON #when state is read #then continuation is absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: "{",
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given bare boulder session id #when codex state is read #then continuation is absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: createBoulderJson({ status: "active", sessionIds: ["sess_abc"] }),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});

	it("#given works omit the codex session but stale mirror matches #when state is read #then continuation is absent", () => {
		// given
		const workspace = createWorkspace({
			boulderJson: JSON.stringify({
				schema_version: 2,
				active_work_id: "work_1",
				works: {
					work_1: {
						work_id: "work_1",
						active_plan: ".omo/plans/plan.md",
						plan_name: "current-work",
						status: "active",
						started_at: "2026-06-13T00:00:00.000Z",
						session_ids: ["opencode:sess_other"],
					},
				},
				active_plan: ".omo/plans/plan.md",
				plan_name: "stale-mirror",
				status: "active",
				started_at: "2026-06-12T00:00:00.000Z",
				session_ids: ["codex:sess_abc"],
			}),
			planMarkdown: "# Plan\n\n## TODOs\n- [ ] 1. First\n",
		});

		// when
		const state = readContinuationState(workspace, "sess_abc");

		// then
		expect(state).toBeNull();
	});
});
