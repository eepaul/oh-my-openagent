import {
  isRealUserMessage,
  isRealUserTextPart,
  type InternalInitiatorMessageLike,
} from "../../shared/internal-initiator-marker"

type ResumableHumanInputOptions = {
  readonly compactionGraceActive: boolean
}

export function isResumableHumanInput(
  message: InternalInitiatorMessageLike,
  options: ResumableHumanInputOptions,
): boolean {
  if (!isRealUserMessage(message) || options.compactionGraceActive) {
    return false
  }

  const firstRealTextPart = message.parts?.find(isRealUserTextPart)
  return firstRealTextPart !== undefined && !firstRealTextPart.text.trimStart().startsWith("/")
}
