import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { discoverGraphRoots, resolveGraphRoot, readBounded, listGraphRootsDescription } from "../src/discovery"

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
