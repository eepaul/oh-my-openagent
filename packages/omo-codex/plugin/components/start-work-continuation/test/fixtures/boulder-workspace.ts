import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanupRoots: string[] = [];

type WorkspaceInput = {
	readonly boulderJson: string;
	readonly planMarkdown: string;
};

type BoulderInput = {
	readonly status: string;
	readonly sessionIds: readonly string[];
};

export function cleanupBoulderWorkspaces(): void {
	for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function createPlan(markdown: string): string {
	const root = mkdtempSync(join(tmpdir(), "codex-continuation-plan-"));
	cleanupRoots.push(root);
	const planPath = join(root, "plan.md");
	writeFileSync(planPath, markdown);
	return planPath;
}

export function createWorkspace(input: WorkspaceInput): string {
	const root = mkdtempSync(join(tmpdir(), "codex-continuation-reader-"));
	cleanupRoots.push(root);
	mkdirSync(join(root, ".omo", "plans"), { recursive: true });
	writeFileSync(join(root, ".omo", "plans", "plan.md"), input.planMarkdown);
	writeFileSync(join(root, ".omo", "boulder.json"), input.boulderJson);
	return root;
}

export function createBoulderJson(input: BoulderInput): string {
	const work = {
		work_id: "work_1",
		active_plan: ".omo/plans/plan.md",
		plan_name: "launch-plan",
		status: input.status,
		started_at: "2026-06-13T00:00:00.000Z",
		session_ids: input.sessionIds,
	};
	return JSON.stringify({
		schema_version: 2,
		active_work_id: "work_1",
		works: { work_1: work },
		active_plan: ".omo/plans/plan.md",
		plan_name: "legacy-launch-plan",
		started_at: "2026-06-13T00:00:00.000Z",
		status: input.status,
		session_ids: input.sessionIds,
	});
}
