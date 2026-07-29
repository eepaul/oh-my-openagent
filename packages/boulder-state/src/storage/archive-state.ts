import { existsSync, renameSync } from "node:fs"
import { resolve } from "node:path"

import { getBoulderFilePath } from "./path"

export function archiveBoulderState(directory: string, now: () => Date = () => new Date()): string | null {
  const filePath = resolve(getBoulderFilePath(directory))
  if (!existsSync(filePath)) return null

  const timestamp = now().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}/, "")
  const archivePathPrefix = `${filePath}.stopped-${timestamp}`
  let archivePath = archivePathPrefix
  let collisionIndex = 2

  while (existsSync(archivePath)) {
    archivePath = `${archivePathPrefix}-${collisionIndex}`
    collisionIndex += 1
  }

  renameSync(filePath, archivePath)
  return archivePath
}
