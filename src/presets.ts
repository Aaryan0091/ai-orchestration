import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

export interface InstallAgentPresetsOptions {
  force?: boolean
  sourceDirectory?: string
  targetDirectory: string
}

export interface InstallAgentPresetsResult {
  installed: readonly string[]
  skipped: readonly string[]
  targetDirectory: string
}

const bundledAgents = resolve(import.meta.dir, "../.opencode/agents")

export async function installAgentPresets(
  options: InstallAgentPresetsOptions,
): Promise<InstallAgentPresetsResult> {
  const sourceDirectory = resolve(options.sourceDirectory ?? bundledAgents)
  const targetDirectory = resolve(options.targetDirectory, ".opencode/agents")
  const profileNames = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort()

  await mkdir(targetDirectory, { recursive: true })

  const installed: string[] = []
  const skipped: string[] = []

  for (const profileName of profileNames) {
    const destination = join(targetDirectory, basename(profileName))
    const content = await readFile(join(sourceDirectory, profileName), "utf8")

    try {
      await writeFile(destination, content, { encoding: "utf8", flag: options.force ? "w" : "wx" })
      installed.push(profileName)
    } catch (error) {
      if (!options.force && isAlreadyPresent(error)) {
        skipped.push(profileName)
        continue
      }
      throw error
    }
  }

  return { installed, skipped, targetDirectory }
}

function isAlreadyPresent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
