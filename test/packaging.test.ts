import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Host } from "@opencode/plugin/host"

import { parseInstallerArguments } from "../src/cli.ts"
import { installAgentPresets } from "../src/presets.ts"
import { AGENT_IDS } from "../src/shared/types.ts"

const projectRoot = join(import.meta.dir, "..")
const profileDirectory = join(projectRoot, ".opencode/agents")

describe("package entrypoints", () => {
  test("OpenCode Host.resolve finds the local server and TUI entries", () => {
    const entrypoints = Host.resolve({ directory: projectRoot })

    expect(entrypoints.server).toEndWith("/server.ts")
    expect(entrypoints.tui).toEndWith("/tui.ts")
  })

  test("OpenCode Host.load imports local and package-resolved entrypoints", async () => {
    const targets = [
      Host.resolve({ directory: projectRoot }),
      Host.resolve({ directory: projectRoot, name: "opencode-orchestrator" }),
    ]

    for (const entrypoints of targets) {
      expect(entrypoints.server).toBeDefined()
      expect(entrypoints.tui).toBeDefined()

      const server = await Host.load(entrypoints.server as string)
      const tui = await Host.load(entrypoints.tui as string)

      expect(server).toHaveProperty("default")
      expect(tui).toHaveProperty("default")
    }
  })
})

describe("agent profiles", () => {
  test("inventory matches the shared agent contract", async () => {
    const files = (await readdir(profileDirectory))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""))
      .sort()

    expect(files).toEqual([...AGENT_IDS].sort())
  })

  test("uses V2 frontmatter fields and the orchestrator accent", async () => {
    for (const agentID of AGENT_IDS) {
      const profile = await readFile(join(profileDirectory, `${agentID}.md`), "utf8")
      const frontmatter = profile.match(/^---\n([\s\S]*?)\n---/)?.[1]

      expect(frontmatter).toBeDefined()
      expect(frontmatter).toContain("description:")
      expect(frontmatter).toMatch(/mode: (primary|subagent|all)/)
      expect(frontmatter).toMatch(/steps: [1-9][0-9]*/)
      expect(frontmatter).not.toMatch(/^(prompt|permission|tools|disable|maxSteps):/m)
    }

    const orchestrator = await readFile(join(profileDirectory, "orchestrator.md"), "utf8")
    expect(orchestrator).toContain('color: "#a8f5e9"')
  })

  test("installer copies profiles without overwriting existing files", async () => {
    const target = await mkdtemp(join(tmpdir(), "opencode-orchestrator-"))

    try {
      const first = await installAgentPresets({ targetDirectory: target })
      const second = await installAgentPresets({ targetDirectory: target })

      expect(first.installed).toHaveLength(AGENT_IDS.length)
      expect(first.skipped).toHaveLength(0)
      expect(second.installed).toHaveLength(0)
      expect(second.skipped).toHaveLength(AGENT_IDS.length)
    } finally {
      await rm(target, { force: true, recursive: true })
    }
  })

  test("force replaces an existing profile", async () => {
    const target = await mkdtemp(join(tmpdir(), "opencode-orchestrator-force-"))

    try {
      await installAgentPresets({ targetDirectory: target })
      const installedProfile = join(target, ".opencode/agents/orchestrator.md")
      await writeFile(installedProfile, "changed", "utf8")

      const result = await installAgentPresets({ force: true, targetDirectory: target })

      expect(result.installed).toHaveLength(AGENT_IDS.length)
      expect(result.skipped).toHaveLength(0)
      expect(await readFile(installedProfile, "utf8")).toContain('color: "#a8f5e9"')
    } finally {
      await rm(target, { force: true, recursive: true })
    }
  })
})

describe("installer CLI", () => {
  test("parses target and force in either order", () => {
    expect(parseInstallerArguments(["--force", "--target", "project"])).toEqual({
      force: true,
      target: "project",
    })
  })

  test("rejects another option as the target value", () => {
    expect(() => parseInstallerArguments(["--target", "--force"])).toThrow(
      "Missing directory after --target",
    )
  })

  test("rejects unknown, positional, and duplicate arguments", () => {
    expect(() => parseInstallerArguments(["--taret", "/tmp/project", "--force"])).toThrow(
      "Unknown option: --taret",
    )
    expect(() => parseInstallerArguments(["/tmp/project"])).toThrow(
      "Unexpected positional argument: /tmp/project",
    )
    expect(() => parseInstallerArguments(["--target", "/tmp/one", "--target", "/tmp/two"])).toThrow(
      "Duplicate option: --target",
    )
    expect(() => parseInstallerArguments(["--force", "--force"])).toThrow(
      "Duplicate option: --force",
    )
  })

  test("CLI exits with an error when --target has no directory", async () => {
    const process_ = Bun.spawn(["bun", "scripts/install-agents.ts", "--target", "--force"], {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    })

    const [exitCode, errorOutput] = await Promise.all([
      process_.exited,
      new Response(process_.stderr).text(),
    ])

    expect(exitCode).toBe(1)
    expect(errorOutput).toContain("Missing directory after --target")
  })
})

describe("sample configuration", () => {
  test("uses V2 plural keys and does not select an agent before presets are installed", async () => {
    const sample = await readFile(join(projectRoot, "examples/opencode.jsonc"), "utf8")

    expect(sample).toContain('"plugins"')
    expect(sample).not.toContain('"plugin"')
    expect(sample).not.toContain('"default_agent"')
  })
})
