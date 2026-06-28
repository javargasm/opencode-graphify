import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { discoverGraphRoots, resolveGraphRoot, readBounded, listGraphRootsDescription, readGraphStats, discoverGraphRootInfos, formatAge, formatSize, isStale } from "../src/discovery"

const TMP = join(import.meta.dir, ".tmp-discovery")

function scaffold(...structure: string[]) {
  for (const rel of structure) {
    const abs = join(TMP, rel)
    if (rel.endsWith("/")) {
      mkdirSync(abs, { recursive: true })
    } else {
      mkdirSync(join(abs, ".."), { recursive: true })
      writeFileSync(abs, "{}", "utf-8")
    }
  }
}

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

// ── discoverGraphRoots ──────────────────────────────────────────────────────

describe("discoverGraphRoots", () => {
  it("returns empty map when no graphs exist", () => {
    mkdirSync(join(TMP, "empty-project"), { recursive: true })
    const roots = discoverGraphRoots(join(TMP, "empty-project"))
    expect(roots.size).toBe(0)
  })

  it("finds graph in the root directory", () => {
    scaffold("graphify-out/graph.json")
    const roots = discoverGraphRoots(TMP)
    expect(roots.size).toBe(1)
    expect(roots.has(".tmp-discovery")).toBe(true)
  })

  it("finds graphs in immediate subdirectories (multi-repo)", () => {
    scaffold(
      "frontend/graphify-out/graph.json",
      "backend/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    expect(roots.size).toBe(2)
    expect(roots.has("frontend")).toBe(true)
    expect(roots.has("backend")).toBe(true)
  })

  it("finds both root and subdirectory graphs", () => {
    scaffold(
      "graphify-out/graph.json",
      "api/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    expect(roots.size).toBe(2)
    expect(roots.has("api")).toBe(true)
  })

  it("skips node_modules and dotfiles", () => {
    scaffold(
      "node_modules/graphify-out/graph.json",
      ".git/graphify-out/graph.json",
      ".hidden/graphify-out/graph.json",
      "real-project/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    expect(roots.size).toBe(1)
    expect(roots.has("real-project")).toBe(true)
  })

  it("skips all known infrastructure dirs", () => {
    scaffold(
      "dist/graphify-out/graph.json",
      "build/graphify-out/graph.json",
      ".venv/graphify-out/graph.json",
      "coverage/graphify-out/graph.json",
      "__pycache__/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    expect(roots.size).toBe(0)
  })

  it("handles non-existent directory gracefully", () => {
    const roots = discoverGraphRoots(join(TMP, "does-not-exist"))
    expect(roots.size).toBe(0)
  })
})

// ── resolveGraphRoot ────────────────────────────────────────────────────────

describe("resolveGraphRoot", () => {
  it("returns single root when no path given and only one root", () => {
    scaffold("frontend/graphify-out/graph.json")
    const roots = discoverGraphRoots(TMP)
    const result = resolveGraphRoot(undefined, TMP, roots)
    expect(result).toBe(join(TMP, "frontend"))
  })

  it("resolves by name when path matches a root key", () => {
    scaffold(
      "frontend/graphify-out/graph.json",
      "backend/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    const result = resolveGraphRoot("backend", TMP, roots)
    expect(result).toBe(join(TMP, "backend"))
  })

  it("resolves by relative path when graph exists there", () => {
    scaffold("some/nested/graphify-out/graph.json")
    const roots = new Map<string, string>()
    const result = resolveGraphRoot("some/nested", TMP, roots)
    expect(result).toBe(join(TMP, "some/nested"))
  })

  it("throws when path has no graph and no matching root", () => {
    const roots = new Map<string, string>()
    expect(() => resolveGraphRoot("nope", TMP, roots)).toThrow(/No graph found/)
  })

  it("throws when no roots and no path given", () => {
    const roots = new Map<string, string>()
    expect(() => resolveGraphRoot(undefined, TMP, roots)).toThrow(/No graphify-out/)
  })

  it("throws with available roots when multiple roots and no path", () => {
    scaffold(
      "a/graphify-out/graph.json",
      "b/graphify-out/graph.json",
    )
    const roots = discoverGraphRoots(TMP)
    expect(() => resolveGraphRoot(undefined, TMP, roots)).toThrow(/Multiple graph roots/)
  })

  // ── PL-6 / T-CS2-3: help text references the real build command ──────────

  it("references `graphify extract <path>` (not a bare build) when path has no graph", () => {
    const roots = new Map<string, string>()
    let message = ""
    try {
      resolveGraphRoot("nope", TMP, roots)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("graphify extract")
    // must NOT reference the nonexistent bare-build form `graphify nope`
    expect(message).not.toMatch(/graphify nope\b/)
  })

  it("references `graphify extract .` (not a bare `graphify .`) when no roots exist", () => {
    const roots = new Map<string, string>()
    let message = ""
    try {
      resolveGraphRoot(undefined, TMP, roots)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("graphify extract .")
    // must NOT reference the nonexistent bare-build form `graphify .`
    expect(message).not.toMatch(/graphify \.(?!\w)(?! extract)/)
    expect(message).not.toMatch(/`graphify \.`/)
  })
})

// ── readBounded ─────────────────────────────────────────────────────────────

describe("readBounded", () => {
  it("reads full content when under limit", () => {
    const file = join(TMP, "small.txt")
    mkdirSync(TMP, { recursive: true })
    writeFileSync(file, "hello world", "utf-8")
    expect(readBounded(file, 100)).toBe("hello world")
  })

  it("truncates content exceeding limit", () => {
    const file = join(TMP, "big.txt")
    mkdirSync(TMP, { recursive: true })
    writeFileSync(file, "a".repeat(200), "utf-8")
    const result = readBounded(file, 50)!
    expect(result.length).toBe(51) // 50 chars + "…"
    expect(result.endsWith("…")).toBe(true)
  })

  it("returns undefined for missing files", () => {
    expect(readBounded(join(TMP, "nope.txt"), 100)).toBeUndefined()
  })
})

// ── listGraphRootsDescription ───────────────────────────────────────────────

describe("listGraphRootsDescription", () => {
  it("returns 'No graphs detected.' for empty map", () => {
    expect(listGraphRootsDescription(new Map())).toBe("No graphs detected.")
  })

  it("lists roots with name and path", () => {
    const roots = new Map([
      ["frontend", "/repo/frontend"],
      ["backend", "/repo/backend"],
    ])
    const result = listGraphRootsDescription(roots)
    expect(result).toContain("frontend: /repo/frontend")
    expect(result).toContain("backend: /repo/backend")
    expect(result).toStartWith("Detected graph roots:")
  })
})

// ── readGraphStats (C2) ──────────────────────────────────────────────────────

function writeGraph(root: string, json: unknown | string) {
  const dir = join(root, "graphify-out")
  mkdirSync(dir, { recursive: true })
  const content = typeof json === "string" ? json : JSON.stringify(json)
  writeFileSync(join(dir, "graph.json"), content, "utf-8")
}

describe("readGraphStats", () => {
  it("reads node count from nodes.length and edges from links.length (post-cluster)", () => {
    const root = join(TMP, "clustered")
    writeGraph(root, {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      links: [{ source: "a", target: "b" }, { source: "b", target: "c" }],
      built_at_commit: "abc123",
    })
    const stats = readGraphStats(root)
    expect(stats).not.toBeNull()
    expect(stats!.nodes).toBe(3)
    expect(stats!.edges).toBe(2)
    expect(stats!.builtAtCommit).toBe("abc123")
  })

  it("falls back to edges.length when links is absent (raw extraction)", () => {
    const root = join(TMP, "raw")
    writeGraph(root, {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ source: "a", target: "b" }],
    })
    const stats = readGraphStats(root)
    expect(stats).not.toBeNull()
    expect(stats!.nodes).toBe(2)
    expect(stats!.edges).toBe(1)
    expect(stats!.builtAtCommit).toBeNull()
  })

  it("prefers links over edges when both are present", () => {
    const root = join(TMP, "both")
    writeGraph(root, {
      nodes: [{ id: "a" }],
      links: [{ source: "a", target: "a" }, { source: "a", target: "a" }],
      edges: [{ source: "a", target: "a" }],
    })
    const stats = readGraphStats(root)
    expect(stats!.edges).toBe(2)
  })

  it("returns zeros for an empty graph", () => {
    const root = join(TMP, "empty")
    writeGraph(root, { nodes: [], links: [] })
    const stats = readGraphStats(root)
    expect(stats!.nodes).toBe(0)
    expect(stats!.edges).toBe(0)
  })

  it("includes sizeBytes and mtimeMs from the graph file", () => {
    const root = join(TMP, "sized")
    writeGraph(root, { nodes: [{ id: "a" }], links: [] })
    const stats = readGraphStats(root)
    expect(typeof stats!.sizeBytes).toBe("number")
    expect(stats!.sizeBytes).toBeGreaterThan(0)
    expect(typeof stats!.mtimeMs).toBe("number")
  })

  it("returns null when the graph file is missing", () => {
    expect(readGraphStats(join(TMP, "does-not-exist"))).toBeNull()
  })

  it("returns null (never throws) on malformed JSON", () => {
    const root = join(TMP, "broken")
    writeGraph(root, "{ this is not valid json ")
    expect(readGraphStats(root)).toBeNull()
  })
})

// ── discoverGraphRootInfos (C4 / TU-1) ───────────────────────────────────────

describe("discoverGraphRootInfos", () => {
  it("finds graph in the root directory with sizeMb + ageMinutes shape", () => {
    writeGraph(TMP, { nodes: [], links: [] })
    const infos = discoverGraphRootInfos(TMP)
    expect(infos).toHaveLength(1)
    expect(infos[0].path).toBe(TMP)
    expect(infos[0].name).toBe(".tmp-discovery")
    // sizeMb is a string like "0.1" (toFixed(1))
    expect(typeof infos[0].sizeMb).toBe("string")
    expect(parseFloat(infos[0].sizeMb)).toBeGreaterThanOrEqual(0)
    // ageMinutes is a rounded non-negative number for a fresh file
    expect(typeof infos[0].ageMinutes).toBe("number")
    expect(infos[0].ageMinutes).toBeGreaterThanOrEqual(0)
  })

  it("finds graphs in immediate subdirectories", () => {
    writeGraph(join(TMP, "frontend"), { nodes: [], links: [] })
    writeGraph(join(TMP, "backend"), { nodes: [], links: [] })
    const infos = discoverGraphRootInfos(TMP)
    expect(infos).toHaveLength(2)
    const names = infos.map((i) => i.name).sort()
    expect(names).toEqual(["backend", "frontend"])
  })

  it("returns empty array for directory without graphs", () => {
    mkdirSync(join(TMP, "empty-project"), { recursive: true })
    expect(discoverGraphRootInfos(join(TMP, "empty-project"))).toHaveLength(0)
  })

  it("skips node_modules and dotfiles", () => {
    writeGraph(join(TMP, "node_modules", "some-pkg"), { nodes: [], links: [] })
    writeGraph(join(TMP, ".hidden"), { nodes: [], links: [] })
    writeGraph(join(TMP, "real-project"), { nodes: [], links: [] })
    const infos = discoverGraphRootInfos(TMP)
    expect(infos).toHaveLength(1)
    expect(infos[0].name).toBe("real-project")
  })

  it("includes both root and subdirectory graphs", () => {
    writeGraph(TMP, { nodes: [], links: [] })
    writeGraph(join(TMP, "api"), { nodes: [], links: [] })
    const infos = discoverGraphRootInfos(TMP)
    expect(infos).toHaveLength(2)
  })

  it("handles non-existent directory gracefully", () => {
    expect(discoverGraphRootInfos(join(TMP, "does-not-exist"))).toHaveLength(0)
  })
})

// ── formatAge (C4 / TU-1) ────────────────────────────────────────────────────

describe("formatAge", () => {
  it("formats negative as unknown", () => expect(formatAge(-1)).toBe("unknown"))
  it("formats zero as just now", () => expect(formatAge(0)).toBe("just now"))
  it("formats minutes", () => {
    expect(formatAge(5)).toBe("5m ago")
    expect(formatAge(59)).toBe("59m ago")
  })
  it("formats hours", () => {
    expect(formatAge(60)).toBe("1h ago")
    expect(formatAge(180)).toBe("3h ago")
  })
  it("formats days", () => {
    expect(formatAge(1440)).toBe("1d ago")
    expect(formatAge(4320)).toBe("3d ago")
  })
})

// ── formatSize (sidebar size fix) ────────────────────────────────────────────

describe("formatSize", () => {
  it("returns '?' for the unknown sentinel", () => {
    expect(formatSize("?")).toBe("?")
  })

  it("shows KB for small graphs (the 0.0 MB bug)", () => {
    // A 50 KB graph used to render as '0.0 MB'; now it reads in KB.
    expect(formatSize("0.0", 51445)).toBe("50 KB")
  })

  it("shows bytes for tiny files", () => {
    expect(formatSize("0.0", 512)).toBe("512 B")
  })

  it("shows MB for large graphs", () => {
    expect(formatSize("2.4", 2_517_000)).toBe("2.4 MB")
  })

  it("falls back to the sizeMb string when no byte count is given", () => {
    expect(formatSize("2.4")).toBe("2.4 MB")
  })
})

// ── isStale (T-CS3-1) ─────────────────────────────────────────────────────────

describe("isStale", () => {
  it("is stale when both commits are known and differ", () => {
    expect(isStale("abc123", "def456")).toBe(true)
  })

  it("is not stale when both commits are known and equal", () => {
    expect(isStale("abc123", "abc123")).toBe(false)
  })

  it("is not stale when builtAtCommit is null (unknown)", () => {
    expect(isStale(null, "def456")).toBe(false)
  })

  it("is not stale when headCommit is null (unknown / non-git)", () => {
    expect(isStale("abc123", null)).toBe(false)
  })

  it("is not stale when both are null", () => {
    expect(isStale(null, null)).toBe(false)
  })

  it("is not stale when either is an empty string (unknown)", () => {
    expect(isStale("", "def456")).toBe(false)
    expect(isStale("abc123", "")).toBe(false)
    expect(isStale("", "")).toBe(false)
  })
})

