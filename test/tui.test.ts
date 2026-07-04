/**
 * Tests for the TUI plugin module shape, discovery logic, and configuration.
 *
 * NOTE: These tests validate the TUI plugin's internal logic without requiring
 * the actual OpenCode TUI runtime (solid-js, @opentui/solid). The JSX rendering
 * is tested structurally since the TUI runtime provides those APIs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { discoverGraphRootInfos, formatAge } from "../src/discovery"

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

  it("registers a single /graphify command with slashName", () => {
    expect(content).toContain("slashName")
    expect(content).toContain('"graphify"')
  })

  it("registers command with name, title, desc, category, run", () => {
    for (const field of ["name:", "title:", "desc:", "category:", "run()"]) {
      expect(content).toContain(field)
    }
  })

  it("uses api.tuiConfig.keybinds.gather for bindings", () => {
    expect(content).toContain("api.tuiConfig.keybinds.gather")
  })
})

describe("TUI staleness indicator", () => {
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

describe("TUI unified /graphify menu command", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("registers a single graphify.menu command", () => {
    expect(content).toContain('"graphify.menu"')
  })

  it("uses slashName 'graphify' (not graphify-status etc)", () => {
    expect(content).toContain('slashName: "graphify"')
  })

  it("does NOT register individual slash commands for each operation", () => {
    expect(content).not.toContain('"graphify-status"')
    expect(content).not.toContain('"graphify-build"')
    expect(content).not.toContain('"graphify-query"')
    expect(content).not.toContain('"graphify-update"')
    expect(content).not.toContain('"graphify-explain"')
    expect(content).not.toContain('"graphify-affected"')
    expect(content).not.toContain('"graphify-path"')
    expect(content).not.toContain('"graphify-export"')
    expect(content).not.toContain('"graphify-toggle"')
  })

  it("defines MENU_OPTIONS array with all 13 operations", () => {
    expect(content).toContain("MENU_OPTIONS")
    for (const label of [
      "Status", "Build", "Query", "Update", "Explain",
      "Affected", "Path", "Export", "Add URL",
      "Diagnose", "Benchmark", "Save Result", "Toggle Panel",
    ]) {
      expect(content).toContain(`label: "${label}"`)
    }
  })

  it("opens a DialogSelect modal when the command runs", () => {
    expect(content).toContain("openGraphifyMenu")
    expect(content).toContain("api.ui.dialog.replace")
    expect(content).toContain("DialogSelect")
  })

  it("maps MENU_OPTIONS into DialogSelect options with title, value, description, disabled, onSelect", () => {
    expect(content).toContain("MENU_OPTIONS.map")
    expect(content).toContain("disabled")
    expect(content).toContain("onSelect")
  })

  it("uses flat layout (no grouped categories)", () => {
    expect(content).toContain("flat={true}")
  })

  it("uses skill/subagent guided prompts instead of direct primary-agent tool calls", () => {
    expect(content).toContain("graphifySkillPrompt")
    expect(content).toContain("Use the graphify skill.")
    expect(content).toContain("Delegate this Graphify operation to the dedicated `graphify` subagent.")
    expect(content).toContain("The subagent should prefer the native")
    expect(content).not.toContain("Use the graphify_build tool")
    expect(content).not.toContain("Use the graphify_query tool")
  })

  it("each skill-guided operation references its preferred native graphify tool", () => {
    for (const tool of [
      "graphify_build", "graphify_query", "graphify_update",
      "graphify_explain", "graphify_affected", "graphify_path",
      "graphify_export", "graphify_add", "graphify_diagnose",
      "graphify_benchmark", "graphify_save_result",
    ]) {
      expect(content).toContain(tool)
    }
  })
})

describe("TUI menu disabled state for graph-less options", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("marks options that require a graph with requiresGraph: true", () => {
    expect(content).toContain("requiresGraph")
    expect(content).toContain("requiresSession")
  })

  it("marks disabled options with 'needs graph' suffix in description", () => {
    expect(content).toContain("needs graph")
  })
})

describe("TUI export formats in menu", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("lists all 9 export formats in the Export option description", () => {
    expect(content).toContain("callflow-html")
    expect(content).toContain("tree")
    expect(content).toContain("html")
    expect(content).toContain("obsidian")
    expect(content).toContain("wiki")
    expect(content).toContain("svg")
    expect(content).toContain("graphml")
    expect(content).toContain("neo4j")
    expect(content).toContain("falkordb")
  })
})

describe("TUI polling cadence", () => {
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

describe("TUI graphify tools (toast registry)", () => {
  const TOOLS = new Set([
    "graphify_status", "graphify_build", "graphify_query", "graphify_path",
    "graphify_explain", "graphify_affected", "graphify_update", "graphify_add",
    "graphify_export", "graphify_diagnose", "graphify_benchmark",
    "graphify_save_result",
  ])

  it("contains all 12 tools", () => {
    expect(TOOLS.size).toBe(12)
  })

  it("does not match non-graphify tools", () => {
    expect(TOOLS.has("shell")).toBe(false)
    expect(TOOLS.has("read")).toBe(false)
  })
})

describe("TUI sidebar size + collapse", () => {
  const content = readFileSync(join(__dirname, "..", "src", "tui.tsx"), "utf-8")

  it("uses formatSize instead of a hardcoded ' MB' suffix", () => {
    expect(content).toContain("formatSize")
    expect(content).not.toContain("} MB · ${formatAge")
  })

  it("has a collapse signal and a collapse/expand arrow", () => {
    expect(content).toContain("collapsed")
    expect(content).toMatch(/▼|▶/)
  })

  it("uses the same plain chevron header style as native sidebar sections", () => {
    expect(content).toContain("`${arrow} Graphify")
    expect(content).not.toContain("`${arrow} 🧩 Graphify")
  })

  it("uses a folder icon for graph entries", () => {
    expect(content).toContain("📁 ${root.name}")
    expect(content).not.toContain("● ${root.name}")
    expect(content).not.toContain("· ${root.name}")
  })

  it("does not add extra left padding to the sidebar section", () => {
    expect(content).not.toContain('<box flexDirection="column" paddingLeft={1}>')
  })

  it("renders root metadata on a separate dim line to avoid narrow sidebar wrapping", () => {
    expect(content).toContain("<text dim>{`    ${formatSize(root.sizeMb, root.sizeBytes)} · ${formatAge(root.ageMinutes)}`}</text>")
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
    expect(content).toMatch(/success|#3fb950/)
    expect(content).toMatch(/warning|#d29922/)
  })

  it("colors the badge with a style span (OpenTUI ignores bare `fg` on span)", () => {
    expect(content).toMatch(/<span style=\{\{\s*fg:/)
    expect(content).not.toMatch(/<span fg=\{/)
  })
})
