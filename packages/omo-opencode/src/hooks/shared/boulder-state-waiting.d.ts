import "@oh-my-opencode/boulder-state"

declare module "@oh-my-opencode/boulder-state" {
  export function checkPlanWaiting(
    directory: string,
    work: { readonly work_id: string },
  ): { readonly waiting: boolean; readonly stale: "runnable" | "complete" | null }
  export function enterWaitingOnHuman(
    directory: string,
    workId: string,
    meta: { readonly reason: string; readonly source: "plan-blocked" | "question-tool"; readonly question_call_id?: string },
  ): boolean
  export function resumeFromHuman(directory: string, workId: string): boolean
}
