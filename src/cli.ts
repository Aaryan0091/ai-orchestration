export interface InstallerArguments {
  force: boolean
  target?: string
}

export function parseInstallerArguments(arguments_: readonly string[]): InstallerArguments {
  let force = false
  let target: string | undefined

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (argument === "--force") {
      if (force) throw new Error("Duplicate option: --force")
      force = true
      continue
    }

    if (argument === "--target") {
      if (target) throw new Error("Duplicate option: --target")

      const value = arguments_[index + 1]
      if (!value || value.startsWith("-")) {
        throw new Error("Missing directory after --target")
      }

      target = value
      index += 1
      continue
    }

    if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`)
    }

    throw new Error(`Unexpected positional argument: ${argument}`)
  }

  return target ? { force, target } : { force }
}
