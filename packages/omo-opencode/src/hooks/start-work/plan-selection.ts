import { statSync } from "node:fs"
import { getPlanName, getPlanProgress } from "../../features/boulder-state"
import { isPlanLifecycleComplete } from "@oh-my-opencode/boulder-state"
import type { BoulderWorkResumeOption } from "../../features/boulder-state"
import { formatWaitingOnHumanStatus } from "./context-info-formatters"

function normalizePlanLookupValue(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function findPlanByName(plans: readonly string[], requestedName: string): string | null {
  const lowerName = requestedName.toLowerCase()
  const normalizedRequestedName = normalizePlanLookupValue(requestedName)
  const exactMatch = plans.find((planPath) => getPlanName(planPath).toLowerCase() === lowerName)
  if (exactMatch) return exactMatch

  const normalizedExactMatch = plans.find(
    (planPath) => normalizePlanLookupValue(getPlanName(planPath)) === normalizedRequestedName,
  )
  if (normalizedExactMatch) return normalizedExactMatch

  const partialMatch = plans.find((planPath) => getPlanName(planPath).toLowerCase().includes(lowerName))
  if (partialMatch) return partialMatch

  return (
    plans.find((planPath) =>
      normalizePlanLookupValue(getPlanName(planPath)).includes(normalizedRequestedName),
    ) ?? null
  )
}

export function pickPreferredIncompletePlan(
  incompletePlans: readonly string[],
  preferredPlanPath: string | null,
): string | null {
  if (!preferredPlanPath) {
    return null
  }

  return incompletePlans.find((planPath) => planPath === preferredPlanPath) ?? null
}

export function formatIncompletePlanList(
  plans: readonly string[],
  includeModifiedTime: boolean,
  resumeOptions: readonly BoulderWorkResumeOption[] = [],
): string {
  return plans
    .map((planPath, index) => {
      const progress = getPlanProgress(planPath)
      const option = resumeOptions.find((candidate) => candidate.active_plan === planPath)
      const waiting = formatWaitingOnHumanStatus({
        planPath,
        status: option?.status,
        waiting: option?.waiting,
      })
      const waitingStatus = waiting ? ` - ${waiting}` : ""
      const modified = includeModifiedTime
        ? ` - Modified: ${new Date(statSync(planPath).mtimeMs).toISOString()}`
        : ""

      return `${index + 1}. [${getPlanName(planPath)}]${modified} - Progress: ${progress.completed}/${progress.total}${waitingStatus}`
    })
    .join("\n")
}

export function buildMissingPlanContext(
  explicitPlanName: string,
  allPlans: readonly string[],
  resumeOptions: readonly BoulderWorkResumeOption[] = [],
): string {
  const incompletePlans = allPlans.filter((planPath) => !isPlanLifecycleComplete(planPath))
  if (incompletePlans.length > 0) {
    return `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".

Available incomplete plans:
${formatIncompletePlanList(incompletePlans, false, resumeOptions)}

Ask the user which plan to work on.`
  }

  return `
## Plan Not Found

 Could not find a plan matching "${explicitPlanName}".
 No incomplete plans available. Create a new plan using the Prometheus agent.`
}
