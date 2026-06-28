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
      `Run \`graphify extract ${paramPath}\` to build it first.`
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
      `Run \`graphify extract .\` to build one first.`
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

/** Graph statistics derived from a graphify-out/graph.json (contract C2). */
export interface GraphStats {
  nodes: number
  edges: number
  builtAtCommit: string | null
  sizeBytes: number
  mtimeMs: number
}

/**
 * Read node/edge stats from <root>/graphify-out/graph.json (contract C2).
 *
 * - nodes from `nodes.length`.
 * - edges from `links.length` (primary, post-cluster) with `edges.length`
 *   fallback (raw extraction).
 * - builtAtCommit from `built_at_commit` when present, else null.
 * - sizeBytes/mtimeMs from the file's stat.
 *
 * Pure, synchronous and defensive: returns null (never throws) when the file
 * is missing, unreadable, or contains malformed JSON.
 */
export function readGraphStats(root: string): GraphStats | null {
  const graphPath = join(root, GRAPH_FILE)
  try {
    const stat = statSync(graphPath)
    const json = JSON.parse(readFileSync(graphPath, "utf-8"))
    const nodes = Array.isArray(json.nodes) ? json.nodes.length : 0
    const edges = Array.isArray(json.links)
      ? json.links.length
      : Array.isArray(json.edges)
        ? json.edges.length
        : 0
    const builtAtCommit =
      typeof json.built_at_commit === "string" ? json.built_at_commit : null
    return {
      nodes,
      edges,
      builtAtCommit,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  } catch {
    return null
  }
}

/**
 * Parse the community count from `graphify cluster-only` stdout.
 * Returns null when no count is present.
 */
export function readCommunityCount(stdout: string): number | null {
  const match = stdout.match(/(\d[\d,]*)\s+communit(?:y|ies)/i)
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
}

/** Human-readable listing of detected graph roots. */
export function listGraphRootsDescription(graphRoots: Map<string, string>): string {
  if (graphRoots.size === 0) return "No graphs detected."
  const lines = Array.from(graphRoots.entries()).map(
    ([name, path]) => `  - ${name}: ${path}`
  )
  return `Detected graph roots:\n${lines.join("\n")}`
}

/**
 * Detailed graph-root info for the TUI sidebar/status panel (contract C4 / TU-1).
 *
 * Shared single source of truth: both the server and the TUI import this so the
 * tests exercise the real code instead of a divergent copy.
 */
export interface GraphRootInfo {
  name: string
  path: string
  sizeMb: string
  ageMinutes: number
}

/**
 * Scan a directory and its immediate children for graphify-out/graph.json,
 * returning size/age details for each root (contract C4 / TU-1).
 *
 * Same traversal rules as discoverGraphRoots (root dir + immediate
 * non-skipped, non-dotfile subdirs). sizeMb is a one-decimal string from the
 * graph file size; ageMinutes is the rounded minutes since its mtime. Defensive:
 * on stat failure sizeMb is "?" and ageMinutes is -1; never throws.
 */
export function discoverGraphRootInfos(directory: string): GraphRootInfo[] {
  const roots: GraphRootInfo[] = []

  const tryAdd = (name: string, dir: string) => {
    const graphPath = join(dir, GRAPH_FILE)
    if (!existsSync(graphPath)) return
    try {
      const stat = statSync(graphPath)
      roots.push({
        name,
        path: dir,
        sizeMb: (stat.size / 1024 / 1024).toFixed(1),
        ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 1000 / 60),
      })
    } catch {
      roots.push({ name, path: dir, sizeMb: "?", ageMinutes: -1 })
    }
  }

  tryAdd(basename(directory), directory)

  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
      tryAdd(entry.name, join(directory, entry.name))
    }
  } catch {
    // directory not readable
  }

  return roots
}

/**
 * Format an age in minutes as a human-readable relative string (contract C4).
 * Negative -> "unknown"; <1 -> "just now"; <60 -> "Nm ago"; <1440 -> "Nh ago";
 * otherwise "Nd ago".
 */
export function formatAge(minutes: number): string {
  if (minutes < 0) return "unknown"
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Decide whether a graph is stale relative to the current git HEAD (T-CS3-1 /
 * contract C4 TU-2). Pure — performs NO git calls; callers pass the resolved
 * HEAD commit.
 *
 * A graph is stale ONLY when both its built_at_commit and the head commit are
 * known (non-empty strings) and differ. When either side is null/empty the
 * commit is unknown, and unknown is treated as NOT stale (non-git dir, raw
 * extraction without built_at_commit, etc.).
 */
export function isStale(
  builtAtCommit: string | null,
  headCommit: string | null,
): boolean {
  if (!builtAtCommit || !headCommit) return false
  return builtAtCommit !== headCommit
}
