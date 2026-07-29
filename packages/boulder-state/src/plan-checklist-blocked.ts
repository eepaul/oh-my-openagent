const SIMPLE_BLOCKED_CHECKBOX_PATTERN = /^[-*][ \t]*\[[ \t]*~[ \t]*\][ \t]+.+$/
const TODO_BLOCKED_CHECKBOX_PATTERN = /^- \[~\] [1-9]\d*\. .+$/
const FINAL_WAVE_BLOCKED_CHECKBOX_PATTERN = /^- \[~\] F[1-9]\d*\. .+$/i

export function isBlockedSimpleCheckbox(line: string): boolean {
  return SIMPLE_BLOCKED_CHECKBOX_PATTERN.test(line)
}

export function isBlockedStructuredCheckbox(
  line: string,
  section: "todo" | "final-wave",
): boolean {
  const pattern = section === "todo" ? TODO_BLOCKED_CHECKBOX_PATTERN : FINAL_WAVE_BLOCKED_CHECKBOX_PATTERN
  return pattern.test(line)
}
