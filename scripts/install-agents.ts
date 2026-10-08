#!/usr/bin/env bun

import { resolve } from "node:path"

import { parseInstallerArguments } from "../src/cli.ts"
import { installAgentPresets } from "../src/presets.ts"

let parsed
try {
  parsed = parseInstallerArguments(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const result = await installAgentPresets({
  force: parsed.force,
  targetDirectory: resolve(parsed.target ?? process.cwd()),
})

console.log(`Agent profiles: ${result.targetDirectory}`)
console.log(`Installed: ${result.installed.length}; skipped: ${result.skipped.length}`)
