import type { OpencodeClient } from "./types"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { inheritApprovals, listApprovedDirectories } from "../../shared/external-directory-approvals"
import { QUESTION_DENIED_SESSION_PERMISSION, withExternalDirectoryApprovalRules } from "../../shared/question-denied-session-permission"

export async function createSyncSession(
  client: OpencodeClient,
  input: {
    parentSessionID: string
    agentToUse: string
    description: string
    defaultDirectory: string
    categoryModel?: DelegatedModelConfig
  }
): Promise<{ ok: true; sessionID: string; parentDirectory: string } | { ok: false; error: string }> {
  const parentSession = client.session.get
    ? await client.session.get({ path: { id: input.parentSessionID } }).catch(() => null)
    : null
  const parentDirectory = parentSession?.data?.directory ?? input.defaultDirectory

  const sessionPermission = withExternalDirectoryApprovalRules(
    QUESTION_DENIED_SESSION_PERMISSION,
    listApprovedDirectories(input.parentSessionID),
  )

  const createResult = await client.session.create({
    body: {
      parentID: input.parentSessionID,
      title: `${input.description} (@${input.agentToUse} subagent)`,
      permission: sessionPermission,
      ...(input.categoryModel
        ? {
            model: {
              id: input.categoryModel.modelID,
              providerID: input.categoryModel.providerID,
              ...(input.categoryModel.variant ? { variant: input.categoryModel.variant } : {}),
            },
          }
        : {}),
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }

  const sessionID = createResult.data.id
  inheritApprovals(input.parentSessionID, sessionID)

  return { ok: true, sessionID, parentDirectory }
}
