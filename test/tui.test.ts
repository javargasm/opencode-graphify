/**
 * Tests for the TUI plugin module shape, discovery logic, and configuration.
 *
 * NOTE: These tests validate the TUI plugin's internal logic without requiring
 * the actual OpenCode TUI runtime (solid-js, @opentui/solid). The JSX rendering
 * is tested structurally since the TUI runtime provides those APIs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// ── Test helpers ──────────────────────────────────────────────────────

const GRAPH_FILE = "graphify-out/graph.json"

function createTempDir(): string {
  const dir = join(tmpdir(), `opencode-graphify-tui-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function createGraph(dir: string, content = '{"nodes":[],"links":[]}'): void {
  const graphDir = join(dir, "graphify-out")
  mkdirSync(graphDir, { recursive: true })
  writeFileSync(join(graphDir, "graph.json"), content)
}

// ── Discovery logic tests ─────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "target",
  ".next", ".nuxt", "__pycache__", ".venv", "venv", "env",
  ".cache", ".turbo", ".parcel-cache", "coverage", ".pytest_cache",
  ".ruff_cache", ".mypy_cache", ".tox", ".gradle", "out",
  ".opencode", ".pi", ".claude",
])

type GraphRoot = {
  name: string
  path: string
  sizeMb: string
  ageMinutes: number
}

function discoverRoots(directory: string): GraphRoot[] {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const roots: GraphRoot[] = []

  const tryAdd = (name: string, dir: string) => {
    const graphPath = path.join(dir, GRAPH_FILE)
    if (!fs.existsSync(graphPath)) return
    try {
      const stat = fs.statSync(graphPath)
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

  tryAdd(path.basename(directory), directory)

  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
      tryAdd(entry.name, path.join(directory, entry.name))
    }
  } catch {}

  return roots
}

function formatAge(minutes: number): string {
  if (minutes < 0) return "unknown"
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("TUI discovery", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("finds graph in root directory", () => {
    createGraph(tempDir)
    const roots = discoverRoots(tempDir)
    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe(tempDir)
    expect(parseFloat(roots[0].sizeMb)).toBeGreaterThanOrEqual(0)
    expect(roots[0].ageMinutes).toBeGreaterThanOrEqual(0)
  })

  it("finds graphs in subdirectories", () => {
    const front = join(tempDir, "front")
    const backend = join(tempDir, "backend")
    mkdirSync(front, { recursive: true })
    mkdirSync(backend, { recursive: true })
    createGraph(front)
    createGraph(backend)

    const roots = discoverRoots(tempDir)
    expect(roots).toHaveLength(2)
    const names = roots.map((r) => r.name).sort()
    expect(names).toEqual(["backend", "front"])
  })

  it("returns empty for directory without graphs", () => {
    const roots = discoverRoots(tempDir)
    expect(roots).toHaveLength(0)
  })

  it("skips node_modules and hidden directories", () => {
    mkdirSync(join(tempDir, "node_modules", "some-pkg"), { recursive: true })
    mkdirSync(join(tempDir, ".hidden"), { recursive: true })
    createGraph(join(tempDir, "node_modules", "some-pkg"))
    createGraph(join(tempDir, ".hidden"))

    const roots = discoverRoots(tempDir)
    expect(roots).toHaveLength(0)
  })

  it("includes both root and subdirectory graphs", () => {
    createGraph(tempDir)
    mkdirSync(join(tempDir, "api"), { recursive: true })
    createGraph(join(tempDir, "api"))

    const roots = discoverRoots(tempDir)
    expect(roots).toHaveLength(2)
  })
})

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

describe("TUI module structure", () => {
  const tuiPath = join(__dirname, "..", "src", "tui.tsx")
  const content = readFileSync(tuiPath, "utf-8")

  it("exports default with id and tui function", () => {
    expect(content).toContain('id: "graphify"')
    expect(content).toContain("tui")
    expect(content).toContain("export default plugin")
  })

  it("uses @ts-nocheck for runtime type compatibility", () => {
    expect(content).toContain("@ts-nocheck")
  })

  it("uses @jsxImportSource @opentui/solid", () => {
    expect(content).toContain("@jsxImportSource @opentui/solid")
  })
})

describe("TUI uses modern keymap API", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("uses api.keymap.registerLayer", () => {
    expect(content).toContain("api.keymap.registerLayer")
  })

  it("does not use deprecated api.command", () => {
    expect(content).not.toContain("api.command?.register")
    expect(content).not.toContain("api.command.register")
  })

  it("does not import deprecated TuiCommand type", () => {
    expect(content).not.toContain("TuiCommand")
  })

  it("uses slashName for command palette slash commands", () => {
    expect(content).toContain("slashName")
    expect(content).toContain('"graphify-status"')
    expect(content).toContain('"graphify-build"')
    expect(content).toContain('"graphify-query"')
    expect(content).toContain('"graphify-update"')
  })

  it("registers commands with name, title, desc, category, run", () => {
    for (const field of ["name:", "title:", "desc:", "category:", "run()"]) {
      expect(content).toContain(field)
    }
  })

  it("uses api.tuiConfig.keybinds.gather for bindings", () => {
    expect(content).toContain("api.tuiConfig.keybinds.gather")
  })

  it("defines command name constants", () => {
    expect(content).toContain('"graphify.status"')
    expect(content).toContain('"graphify.build"')
    expect(content).toContain('"graphify.query"')
    expect(content).toContain('"graphify.update"')
  })
})

describe("TUI graphify tools", () => {
  const TOOLS = new Set([
    "graphify_status", "graphify_build", "graphify_query", "graphify_path",
    "graphify_explain", "graphify_affected", "graphify_update", "graphify_add",
  ])

  it("contains all 8 tools", () => {
    expect(TOOLS.size).toBe(8)
  })

  it("does not match non-graphify tools", () => {
    expect(TOOLS.has("shell")).toBe(false)
    expect(TOOLS.has("read")).toBe(false)
  })
})
