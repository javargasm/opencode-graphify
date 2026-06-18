/**
 * Shell execution helper and .gitignore management.
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { PluginInput } from "@opencode-ai/plugin"

/** Single-quote a shell argument safely. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Shell result shape. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Execute a shell command via Bun.$ with cwd. */
export async function exec(
  $: PluginInput["$"],
  command: string,
  cwd: string,
): Promise<ExecResult> {
  try {
    const result = await $`sh -c ${command}`.cwd(cwd).quiet().nothrow()
    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
      exitCode: result.exitCode,
    }
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    }
  }
}

// ── .gitignore management ───────────────────────────────────────────────────

const GITIGNORE_REQUIRED = ["graphify-out/"]
const GITIGNORE_LEGACY = [
  "graphify-out/cache/",
  "graphify-out/.graphify_python",
  "graphify-out/.graphify_root",
  "graphify-out/cost.json",
  "/graphify-out/",
]

/**
 * Ensure .gitignore at `cwd` contains `graphify-out/` and remove legacy entries.
 * Returns true if the file was updated.
 */
export function ensureGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, ".gitignore")
  let original = ""
  try {
    original = readFileSync(gitignorePath, "utf-8")
  } catch {
    original = ""
  }

  const lines = original.length > 0 ? original.split(/\r?\n/) : []
  const filtered = lines.filter((line) => {
    const trimmed = line.trim()
    return !GITIGNORE_LEGACY.includes(trimmed)
  })

  for (const entry of GITIGNORE_REQUIRED) {
    if (!filtered.some((line) => line.trim() === entry)) {
      filtered.push(entry)
    }
  }

  let next = filtered.join("\n")
  if (next.length > 0 && !next.endsWith("\n")) next += "\n"

  if (next === original) return false

  writeFileSync(gitignorePath, next, "utf-8")
  return true
}
