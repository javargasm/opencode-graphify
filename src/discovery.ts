/**
 * Graph discovery — finds graphify-out/graph.json in a directory and its
 * immediate subdirectories for multi-repo workspace support.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join, resolve, basename } from "path"

export const GRAPH_FILE = "graphify-out/graph.json"

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "target",
  ".next", ".nuxt", "__pycache__", ".venv", "venv", "env",
  ".cache", ".turbo", ".parcel-cache", "coverage", ".pytest_cache",
  ".ruff_cache", ".mypy_cache", ".tox", ".gradle", "out",
  ".opencode", ".pi", ".claude",
])

/**
 * Scan a directory and its immediate children for graphify-out/graph.json.
 * Returns a Map of repo-name → absolute-path.
 */
export function discoverGraphRoots(directory: string): Map<string, string> {
  const roots = new Map<string, string>()

  if (existsSync(join(directory, GRAPH_FILE))) {
    roots.set(basename(directory), directory)
  }

  try {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith(".")) continue
      const sub = join(directory, entry.name)
      if (existsSync(join(sub, GRAPH_FILE))) {
        roots.set(entry.name, sub)
      }
    }
  } catch {
    // directory not readable
  }

  return roots
}

/**
 * Resolve a user-provided path parameter to a concrete graph root.
 * Falls back to the single detected root when unambiguous.
 */
export function resolveGraphRoot(
  paramPath: string | undefined,
  directory: string,
  graphRoots: Map<string, string>,
): string {
  if (paramPath) {
    const abs = resolve(directory, paramPath)
    if (existsSync(join(abs, GRAPH_FILE))) return abs
    const byName = graphRoots.get(paramPath)
    if (byName) return byName
    throw new Error(
      `No graph found at ${abs}/${GRAPH_FILE}. ` +
      `Run \`graphify ${paramPath}\` to build it first.`
    )
  }

  if (graphRoots.size === 1) {
    return graphRoots.values().next().value!
  }

  if (graphRoots.has(basename(directory))) {
    return graphRoots.get(basename(directory))!
  }

  if (graphRoots.size === 0) {
    throw new Error(
      `No graphify-out/graph.json found in ${directory} or its subdirectories. ` +
      `Run \`graphify .\` to build one first.`
    )
  }

  const available = Array.from(graphRoots.keys()).join(", ")
  throw new Error(
    `Multiple graph roots found: ${available}. ` +
    `Pass a \`path\` parameter to specify which repo to target.`
  )
}

/** Read a file's content bounded to maxChars. */
export function readBounded(filePath: string, maxChars: number): string | undefined {
  try {
    const buf = readFileSync(filePath, "utf-8")
    return buf.length > maxChars ? buf.slice(0, maxChars) + "…" : buf
  } catch {
    return undefined
  }
}

/** Human-readable listing of detected graph roots. */
export function listGraphRootsDescription(graphRoots: Map<string, string>): string {
  if (graphRoots.size === 0) return "No graphs detected."
  const lines = Array.from(graphRoots.entries()).map(
    ([name, path]) => `  - ${name}: ${path}`
  )
  return `Detected graph roots:\n${lines.join("\n")}`
}
