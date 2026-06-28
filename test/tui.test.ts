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
import { discoverGraphRootInfos, formatAge } from "../src/discovery"

// ── Test helpers ──────────────────────────────────────────────────────

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

// ── Discovery logic tests (canonical impl in ../src/discovery) ────────

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
    const roots = discoverGraphRootInfos(tempDir)
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

    const roots = discoverGraphRootInfos(tempDir)
    expect(roots).toHaveLength(2)
    const names = roots.map((r) => r.name).sort()
    expect(names).toEqual(["backend", "front"])
  })

  it("returns empty for directory without graphs", () => {
    const roots = discoverGraphRootInfos(tempDir)
    expect(roots).toHaveLength(0)
  })

  it("skips node_modules and hidden directories", () => {
    mkdirSync(join(tempDir, "node_modules", "some-pkg"), { recursive: true })
    mkdirSync(join(tempDir, ".hidden"), { recursive: true })
    createGraph(join(tempDir, "node_modules", "some-pkg"))
    createGraph(join(tempDir, ".hidden"))

    const roots = discoverGraphRootInfos(tempDir)
    expect(roots).toHaveLength(0)
  })

  it("includes both root and subdirectory graphs", () => {
    createGraph(tempDir)
    mkdirSync(join(tempDir, "api"), { recursive: true })
    createGraph(join(tempDir, "api"))

    const roots = discoverGraphRootInfos(tempDir)
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

describe("TUI staleness indicator (T-CS4-2)", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("imports isStale and readGraphStats from ./discovery", () => {
    expect(content).toContain("isStale")
    expect(content).toContain("readGraphStats")
  })

  it("reads the current git HEAD via rev-parse", () => {
    expect(content).toContain("rev-parse")
  })

  it("references built_at_commit / builtAtCommit", () => {
    expect(content).toMatch(/built_at_commit|builtAtCommit/)
  })

  it("renders a stale marker in the sidebar", () => {
    expect(content).toMatch(/⚠|stale/)
  })
})

describe("TUI palette parity (T-CS4-3)", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("defines command name constants for explain, affected, path, export", () => {
    expect(content).toContain('"graphify.explain"')
    expect(content).toContain('"graphify.affected"')
    expect(content).toContain('"graphify.path"')
    expect(content).toContain('"graphify.export"')
  })

  it("defines slashNames for the new commands", () => {
    expect(content).toContain('"graphify-explain"')
    expect(content).toContain('"graphify-affected"')
    expect(content).toContain('"graphify-path"')
    expect(content).toContain('"graphify-export"')
  })

  it("adds the new commands to allCommands", () => {
    const match = content.match(/const allCommands = \[([\s\S]*?)\]/)
    expect(match).not.toBeNull()
    const list = match![1]
    expect(list).toContain("cmd.explain")
    expect(list).toContain("cmd.affected")
    expect(list).toContain("cmd.path")
    expect(list).toContain("cmd.export")
  })

  it("references the native tools for each new command run()", () => {
    expect(content).toContain("graphify_explain")
    expect(content).toContain("graphify_affected")
    expect(content).toContain("graphify_path")
    expect(content).toContain("graphify_export")
  })
})

describe("TUI polling cadence (T-CS4-3 / TU-4)", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("does not poll every 30 seconds", () => {
    expect(content).not.toContain("30_000")
    expect(content).not.toContain("30000")
  })

  it("either removes setInterval or uses an interval >= 120s", () => {
    const matches = [...content.matchAll(/setInterval\([^,]*,\s*([\d_]+)/g)]
    for (const m of matches) {
      const ms = parseInt(m[1].replace(/_/g, ""), 10)
      expect(ms).toBeGreaterThanOrEqual(120_000)
    }
  })

  it("keeps the event-driven refresh on message.part.updated", () => {
    expect(content).toContain("message.part.updated")
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

describe("TUI sidebar size + collapse (panel UX)", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("uses formatSize instead of a hardcoded ' MB' suffix", () => {
    expect(content).toContain("formatSize")
    // the old always-MB rendering must be gone
    expect(content).not.toContain("} MB · ${formatAge")
  })

  it("has a collapse signal and a collapse/expand arrow", () => {
    expect(content).toContain("collapsed")
    expect(content).toMatch(/▾|▸/)
  })

  it("registers a toggle command in the palette and allCommands", () => {
    expect(content).toContain('"graphify.toggle"')
    expect(content).toContain('"graphify-toggle"')
    const match = content.match(/const allCommands = \[([\s\S]*?)\]/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("cmd.toggle")
  })

  it("uses a smaller bullet glyph for graph entries (not the large ●)", () => {
    // sidebar/status entries should use the small middle dot, not the big bullet
    expect(content).not.toContain("● ${root.name}")
  })
})

describe("TUI clickable header + status badge", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("makes the header clickable via onMouseDown to toggle collapse", () => {
    expect(content).toContain("onMouseDown")
    expect(content).toMatch(/onMouseDown=\{[^}]*setCollapsed/)
  })

  it("probes whether the graphify CLI is installed", () => {
    expect(content).toContain("isGraphifyInstalled")
    expect(content).toContain("graphify --version")
  })

  it("renders a green OK badge when installed and yellow when not", () => {
    expect(content).toContain('"OK"')
    expect(content).toContain('"not installed"')
    // green for OK, yellow for missing — via theme success/warning or hex fallback
    expect(content).toMatch(/success|#3fb950/)
    expect(content).toMatch(/warning|#d29922/)
  })

  it("colors the badge with a fg span", () => {
    expect(content).toMatch(/<span fg=\{/)
  })
})
