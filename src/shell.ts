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

/**
 * LLM backends graphify accepts. Used to enum-validate the `--backend` flag
 * before it is ever interpolated into a shell command (defense against
 * injection — see validateBackend).
 */
export const ALLOWED_BACKENDS = [
  "gemini", "kimi", "claude", "openai", "deepseek", "ollama", "bedrock", "claude-cli",
] as const

export type BackendValidation =
  | { ok: true; value?: string }
  | { ok: false; error: string }

/**
 * Validate a backend string before it reaches the shell (contract C1).
 * - undefined / "" / "auto" → { ok: true, value: undefined } (omit the flag; CLI auto-detects).
 * - an allowed backend (case-insensitive, trimmed) → { ok: true, value: <normalized lowercase> }.
 * - anything else (including injection payloads) → { ok: false, error }.
 */
export function validateBackend(backend?: string): BackendValidation {
  const normalized = (backend ?? "").trim().toLowerCase()
  if (normalized === "" || normalized === "auto") return { ok: true, value: undefined }
  if ((ALLOWED_BACKENDS as readonly string[]).includes(normalized)) {
    return { ok: true, value: normalized }
  }
  return {
    ok: false,
    error: `unknown backend '${backend}'; allowed: ${ALLOWED_BACKENDS.join(", ")} (or omit/"auto" to auto-detect)`,
  }
}

/** Shell result shape. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Remove graphify's stderr "skew warning" lines (T-CS3-8).
 *
 * graphify's own skill/package version mismatch emits lines like:
 *   "skill is from graphify 0.8.51, package is 0.9.0. Run 'graphify install' to update."
 * optionally prefixed with "warning:". These pollute parsed tool output but are
 * not real errors. This strips ONLY those lines; every other stderr line
 * (including real errors) is preserved verbatim. Pure and defensive — empty
 * input returns empty, no-warning input is returned unchanged.
 */
export function stripGraphifyNoise(stderr: string): string {
  if (!stderr) return ""
  const SKEW =
    /^\s*(?:warning:\s*)?skill is from graphify .* package is .* Run 'graphify install' to update\.?\s*$/i
  return stderr
    .split("\n")
    .filter((line) => !SKEW.test(line))
    .join("\n")
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
      // stdout is NEVER altered; only stderr is cleaned of graphify's skew
      // skill/package-version warning lines (T-CS3-8) so all tools benefit.
      stderr: stripGraphifyNoise(result.stderr?.toString() ?? ""),
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
