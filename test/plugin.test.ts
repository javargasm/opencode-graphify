import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join, resolve } from "path"
import plugin, {
  buildExtractCommand,
  buildAddCommand,
  shouldNudgeGraphFirst,
  buildDiagnoseCommand,
  buildExportCommand,
  shapeBenchmarkOutput,
} from "../src/index"

const TMP = join(import.meta.dir, ".tmp-plugin")
const INDEX_SRC = resolve(import.meta.dir, "..", "src", "index.ts")

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

function scaffoldGraph(root: string) {
  const dir = join(root, "graphify-out")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ nodes: [], links: [] }), "utf-8")
}

describe("plugin export shape", () => {
  it("has a string id", () => {
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id).toBe("graphify")
  })

  it("exports server as a function", () => {
    expect(typeof plugin.server).toBe("function")
  })

  it("server is an async function (returns Promise)", () => {
    // The V1 plugin contract: server(input, options?) => Promise<Hooks>
    // We verify the function exists and has the right arity
    expect(plugin.server.length).toBeGreaterThanOrEqual(1)
  })
})

// ── buildExtractCommand (A-R1 / A-R2) ────────────────────────────────────────

describe("buildExtractCommand", () => {
  it("omits --backend when backend is undefined (auto-detect)", () => {
    const cmd = buildExtractCommand("/repo/proj", undefined)
    expect(cmd).not.toContain("--backend")
    expect(cmd).toContain("graphify extract '/repo/proj'")
  })

  it("omits --backend when backend is 'auto'", () => {
    const cmd = buildExtractCommand("/repo/proj", "auto")
    expect(cmd).not.toContain("--backend")
  })

  it("omits --backend when backend is empty string", () => {
    const cmd = buildExtractCommand("/repo/proj", "")
    expect(cmd).not.toContain("--backend")
  })

  it("includes shell-quoted --backend for an allowed backend", () => {
    const cmd = buildExtractCommand("/repo/proj", "claude")
    expect(cmd).toContain("--backend 'claude'")
  })

  it("normalizes case for an allowed backend", () => {
    const cmd = buildExtractCommand("/repo/proj", "GEMINI")
    expect(cmd).toContain("--backend 'gemini'")
  })

  it("throws on an unknown backend before building a command", () => {
    expect(() => buildExtractCommand("/repo/proj", "gpt5")).toThrow(/unknown backend/i)
  })

  it("throws on an injection payload and never interpolates it", () => {
    expect(() => buildExtractCommand("/repo/proj", "gemini; echo PWNED")).toThrow(
      /unknown backend/i,
    )
    expect(() => buildExtractCommand("/repo/proj", "gemini$(touch /tmp/x)")).toThrow(
      /unknown backend/i,
    )
  })

  // ── --api-timeout threading (T-CS2-4 / C-F2 / C-AC5) ───────────────────────

  it("omits --api-timeout when apiTimeout is undefined", () => {
    const cmd = buildExtractCommand("/repo/proj", undefined, undefined)
    expect(cmd).not.toContain("--api-timeout")
  })

  it("appends --api-timeout when apiTimeout is a positive integer", () => {
    const cmd = buildExtractCommand("/repo/proj", undefined, 45)
    expect(cmd).toContain("--api-timeout 45")
  })

  it("appends --api-timeout alongside --backend", () => {
    const cmd = buildExtractCommand("/repo/proj", "claude", 30)
    expect(cmd).toContain("--backend 'claude'")
    expect(cmd).toContain("--api-timeout 30")
  })

  it("ignores a non-positive or non-integer apiTimeout", () => {
    expect(buildExtractCommand("/repo/proj", undefined, 0)).not.toContain("--api-timeout")
    expect(buildExtractCommand("/repo/proj", undefined, -10)).not.toContain("--api-timeout")
    expect(buildExtractCommand("/repo/proj", undefined, 12.5)).not.toContain("--api-timeout")
  })

  // ── --force passthrough (T-CS3-6 / v0.9.0 collided-node recovery) ──────────

  it("omits --force by default (3-arg call sites unaffected)", () => {
    expect(buildExtractCommand("/repo/proj")).not.toContain("--force")
    expect(buildExtractCommand("/repo/proj", "claude")).not.toContain("--force")
    expect(buildExtractCommand("/repo/proj", "claude", 30)).not.toContain("--force")
  })

  it("omits --force when the force flag is false", () => {
    expect(buildExtractCommand("/repo/proj", undefined, undefined, false)).not.toContain("--force")
  })

  it("appends --force when the force flag is true", () => {
    const cmd = buildExtractCommand("/repo/proj", undefined, undefined, true)
    expect(cmd).toContain("--force")
  })

  it("appends --force alongside backend and api-timeout in a stable order", () => {
    const cmd = buildExtractCommand("/repo/proj", "claude", 30, true)
    expect(cmd).toContain("graphify extract '/repo/proj'")
    expect(cmd).toContain("--backend 'claude'")
    expect(cmd).toContain("--api-timeout 30")
    expect(cmd).toContain("--force")
    // ordering is stable: backend, then api-timeout, then force
    expect(cmd.indexOf("--backend")).toBeLessThan(cmd.indexOf("--api-timeout"))
    expect(cmd.indexOf("--api-timeout")).toBeLessThan(cmd.indexOf("--force"))
  })
})

// ── buildDiagnoseCommand (T-CS3-2 / C-T2) ────────────────────────────────────

describe("buildDiagnoseCommand", () => {
  it("builds the base diagnose multigraph --json command", () => {
    expect(buildDiagnoseCommand()).toBe("graphify diagnose multigraph --json")
  })

  it("ignores an undefined maxExamples", () => {
    expect(buildDiagnoseCommand({})).toBe("graphify diagnose multigraph --json")
    expect(buildDiagnoseCommand({ maxExamples: undefined })).toBe(
      "graphify diagnose multigraph --json",
    )
  })

  it("appends --max-examples for a positive integer", () => {
    expect(buildDiagnoseCommand({ maxExamples: 10 })).toBe(
      "graphify diagnose multigraph --json --max-examples 10",
    )
  })

  it("ignores a non-positive or non-integer maxExamples", () => {
    expect(buildDiagnoseCommand({ maxExamples: 0 })).not.toContain("--max-examples")
    expect(buildDiagnoseCommand({ maxExamples: -3 })).not.toContain("--max-examples")
    expect(buildDiagnoseCommand({ maxExamples: 2.5 })).not.toContain("--max-examples")
  })
})

// ── buildExportCommand (T-CS3-3 / C-T1) ──────────────────────────────────────

describe("buildExportCommand", () => {
  it("defaults to callflow-html", () => {
    expect(buildExportCommand()).toBe("graphify export callflow-html")
    expect(buildExportCommand(undefined)).toBe("graphify export callflow-html")
  })

  it("builds callflow-html explicitly", () => {
    expect(buildExportCommand("callflow-html")).toBe("graphify export callflow-html")
  })

  it("builds the separate `graphify tree` command for the tree format", () => {
    expect(buildExportCommand("tree")).toBe("graphify tree")
  })

  it("falls back to callflow-html for an unknown format", () => {
    expect(buildExportCommand("svg" as any)).toBe("graphify export callflow-html")
    expect(buildExportCommand("obsidian" as any)).toBe("graphify export callflow-html")
  })

  it("never emits the nonexistent --obsidian/--svg flags", () => {
    expect(buildExportCommand("tree")).not.toContain("--obsidian")
    expect(buildExportCommand("callflow-html")).not.toContain("--svg")
  })
})

// ── shapeBenchmarkOutput (T-CS3-4 / C-T3) ────────────────────────────────────

describe("shapeBenchmarkOutput", () => {
  it("returns an unavailable message on the AST-only 'No matching nodes' case", () => {
    const shaped = shapeBenchmarkOutput(
      "Benchmark error: No matching nodes found for sample questions. Build the graph first.",
      0,
    )
    expect(shaped.available).toBe(false)
    expect(shaped.title.toLowerCase()).toContain("unavailable")
    expect(shaped.output.toLowerCase()).toMatch(/ast-only|semantically|build the graph/)
  })

  it("returns an unavailable message on a non-zero exit code", () => {
    const shaped = shapeBenchmarkOutput("some failure", 1)
    expect(shaped.available).toBe(false)
    expect(shaped.title.toLowerCase()).toContain("unavailable")
  })

  it("passes through a real benchmark summary when present", () => {
    const summary = "Token reduction: 92% (naive 50000 -> graphify 4000 tokens)"
    const shaped = shapeBenchmarkOutput(summary, 0)
    expect(shaped.available).toBe(true)
    expect(shaped.output).toContain(summary)
  })

  it("treats empty output as unavailable rather than a summary", () => {
    const shaped = shapeBenchmarkOutput("", 0)
    expect(shaped.available).toBe(false)
  })
})

// ── buildAddCommand (T-CS2-4 / C-F1) ─────────────────────────────────────────

describe("buildAddCommand", () => {
  it("includes the shell-quoted url", () => {
    const cmd = buildAddCommand("https://example.com/x", {})
    expect(cmd).toContain("graphify add 'https://example.com/x'")
  })

  it("appends shell-quoted --author when provided", () => {
    const cmd = buildAddCommand("https://example.com/x", { author: "Ada Lovelace" })
    expect(cmd).toContain("--author 'Ada Lovelace'")
  })

  it("appends shell-quoted --contributor when provided", () => {
    const cmd = buildAddCommand("https://example.com/x", { contributor: "me" })
    expect(cmd).toContain("--contributor 'me'")
  })

  it("includes both author and contributor when both provided", () => {
    const cmd = buildAddCommand("https://example.com/x", { author: "A", contributor: "B" })
    expect(cmd).toContain("--author 'A'")
    expect(cmd).toContain("--contributor 'B'")
  })

  it("omits flags when not provided", () => {
    const cmd = buildAddCommand("https://example.com/x", {})
    expect(cmd).not.toContain("--author")
    expect(cmd).not.toContain("--contributor")
  })

  it("neutralizes an injection payload in the url via shellQuote", () => {
    const cmd = buildAddCommand("https://x/$(touch /tmp/pwn)", {})
    expect(cmd).toContain("'https://x/$(touch /tmp/pwn)'")
  })

  it("is a single graphify invocation (no chained update)", () => {
    const cmd = buildAddCommand("https://example.com/x", {})
    // exactly one occurrence of "graphify"
    expect(cmd.match(/graphify/g)?.length).toBe(1)
    expect(cmd).not.toContain("graphify update")
  })
})

// ── graphify_add: no redundant second update (T-CS2-4 / C-AC4) ────────────────

describe("graphify_add structure", () => {
  it("does not issue a second standalone `graphify update` after add", () => {
    const src = readFileSync(INDEX_SRC, "utf-8")
    // The graphify_add execute body must not chain a separate update call —
    // `graphify add` already updates the graph (C-F1 / PL-7).
    expect(src).not.toContain("graphify update ${shellQuote(graphRoot)}`, graphRoot)")
  })
})

// ── shouldNudgeGraphFirst predicate (T-CS2-2 / contract C3 / B-R1..R6) ───────

describe("shouldNudgeGraphFirst", () => {
  // POSITIVE — broad raw codebase searches when a graph exists.
  it("nudges on recursive grep over the cwd", () => {
    expect(shouldNudgeGraphFirst("grep -r foo .", 1)).toBe(true)
  })

  it("nudges on grep -rn into a directory", () => {
    expect(shouldNudgeGraphFirst('grep -rn "thing" src/', 1)).toBe(true)
  })

  it("nudges on ripgrep", () => {
    expect(shouldNudgeGraphFirst("rg pattern", 1)).toBe(true)
  })

  it("nudges on ag (silver searcher)", () => {
    expect(shouldNudgeGraphFirst("ag pattern", 1)).toBe(true)
  })

  it("nudges on find with a path arg", () => {
    expect(shouldNudgeGraphFirst("find . -name '*.ts'", 1)).toBe(true)
  })

  it("nudges on a multi-file cat sweep", () => {
    expect(shouldNudgeGraphFirst("cat src/a.ts src/b.ts src/c.ts", 1)).toBe(true)
  })

  it("nudges on a glob cat sweep", () => {
    expect(shouldNudgeGraphFirst("cat src/*.ts", 1)).toBe(true)
  })

  // NEGATIVE — never nudge in these cases.
  it("does NOT nudge when there are no graph roots", () => {
    expect(shouldNudgeGraphFirst("grep -r foo .", 0)).toBe(false)
  })

  it("does NOT nudge a command that already uses graphify", () => {
    expect(shouldNudgeGraphFirst('graphify query "x"', 1)).toBe(false)
  })

  it("does NOT nudge a piped grep used as an output filter", () => {
    expect(shouldNudgeGraphFirst("ps aux | grep x", 1)).toBe(false)
  })

  it("does NOT nudge a single small file read", () => {
    expect(shouldNudgeGraphFirst("cat package.json", 1)).toBe(false)
  })

  it("does NOT nudge an empty command", () => {
    expect(shouldNudgeGraphFirst("", 1)).toBe(false)
  })

  // FAIL-OPEN / robustness — pure, never throws on weird input.
  it("is pure and never throws on weird input", () => {
    expect(() => shouldNudgeGraphFirst("   ", 1)).not.toThrow()
    expect(() => shouldNudgeGraphFirst("\u0000\u0001", 1)).not.toThrow()
    expect(() => shouldNudgeGraphFirst(undefined as any, 1)).not.toThrow()
    expect(() => shouldNudgeGraphFirst("grep", undefined as any)).not.toThrow()
  })

  it("does NOT nudge a non-search command", () => {
    expect(shouldNudgeGraphFirst("ls -la", 1)).toBe(false)
    expect(shouldNudgeGraphFirst("npm run build", 1)).toBe(false)
  })

  it("strips leading env-assignments and sudo before evaluating", () => {
    expect(shouldNudgeGraphFirst("FOO=bar grep -r baz .", 1)).toBe(true)
  })
})

// ── system.transform v0.9.0 node-ID note (T-CS2-5) ───────────────────────────

describe("system.transform node-ID guidance", () => {
  it("documents that node IDs are path-based and non-persistent across rebuilds", () => {
    const src = readFileSync(INDEX_SRC, "utf-8")
    // Per #2585: agents should reference nodes by LABEL, not by a persisted ID,
    // because v0.9.0 node IDs are full-repo-path-based and regenerated on rebuild.
    expect(src).toMatch(/label/i)
    expect(src).toMatch(/node id/i)
  })
})

// ── system.transform always-on orientation (alwaysActive) ───────────────────

describe("system.transform always-active orientation", () => {
  async function loadHooks(dir: string, options?: any) {
    const fakeInput: any = {
      directory: dir,
      worktree: dir,
      $: () => ({}),
      client: {},
      project: { id: "test", worktree: dir },
    }
    return plugin.server(fakeInput, options)
  }

  it("injects an orientation note even when NO graph exists (default alwaysActive)", async () => {
    // TMP has no graphify-out/graph.json
    const hooks = await loadHooks(TMP)
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const output: any = { system: [] }
    await transform({}, output)
    expect(output.system.length).toBeGreaterThan(0)
    const text = output.system.join("\n").toLowerCase()
    expect(text).toContain("graphify")
    // it should mention how to build a graph since none exists
    expect(text).toContain("graphify_build")
  })

  it("injects nothing when no graph exists AND alwaysActive is disabled", async () => {
    const hooks = await loadHooks(TMP, { alwaysActive: false })
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const output: any = { system: [] }
    await transform({}, output)
    expect(output.system.length).toBe(0)
  })

  it("still injects the full graph context when a graph exists", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const output: any = { system: [] }
    await transform({}, output)
    const text = output.system.join("\n")
    expect(text).toContain("knowledge graph")
    expect(text).toContain("graphify_query")
  })
})

// ── tool.execute.before fail-open advisory (T-CS2-2 / B-R2 / B-AC5) ──────────

describe("tool.execute.before nudge hook", () => {
  async function loadHooks(dir: string) {
    const fakeInput: any = {
      directory: dir,
      worktree: dir,
      $: () => ({}),
      client: {},
      project: { id: "test", worktree: dir },
    }
    return plugin.server(fakeInput)
  }

  it("injects advisory context for a raw search but keeps the command runnable", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const before = (hooks as any)["tool.execute.before"]
    const output: any = { args: { command: "grep -r foo ." } }
    await before({ tool: "shell", args: { command: "grep -r foo ." } }, output)
    // command preserved (still ends with the user's actual command)
    expect(output.args.command).toContain("grep -r foo .")
    // advisory steers toward graphify tools
    expect(output.args.command.toLowerCase()).toContain("graphify")
  })

  it("does not alter a graphify command beyond the existing tip", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const before = (hooks as any)["tool.execute.before"]
    const output: any = { args: { command: "ls -la" } }
    await before({ tool: "shell", args: { command: "ls -la" } }, output)
    // plain command not a broad search → untouched
    expect(output.args.command).toBe("ls -la")
  })

  it("never throws even when output args are malformed (fail-open)", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const before = (hooks as any)["tool.execute.before"]
    // missing args / non-string command must not throw
    await expect(before({ tool: "shell", args: {} }, {})).resolves.toBeUndefined()
    await expect(
      before({ tool: "shell", args: { command: 42 } }, { args: { command: 42 } }),
    ).resolves.toBeUndefined()
  })

  it("ignores non-shell tools", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const before = (hooks as any)["tool.execute.before"]
    const output: any = { args: { command: "grep -r foo ." } }
    await before({ tool: "read", args: { command: "grep -r foo ." } }, output)
    expect(output.args.command).toBe("grep -r foo .")
  })
})

// ── graphify_build schema (A-R3 / A-AC3) ─────────────────────────────────────

async function loadTools() {
  const fakeInput: any = {
    directory: TMP,
    worktree: TMP,
    $: () => ({}),
    client: {},
    project: { id: "test", worktree: TMP },
  }
  const hooks = await plugin.server(fakeInput)
  return hooks.tool as Record<string, any>
}

describe("graphify_build schema", () => {
  it("no longer declares the dead obsidian arg", async () => {
    const tools = await loadTools()
    expect("obsidian" in tools.graphify_build.args).toBe(false)
  })

  it("no longer declares the dead svg arg", async () => {
    const tools = await loadTools()
    expect("svg" in tools.graphify_build.args).toBe(false)
  })

  it("still declares path, backend and no_viz", async () => {
    const tools = await loadTools()
    expect("path" in tools.graphify_build.args).toBe(true)
    expect("backend" in tools.graphify_build.args).toBe(true)
    expect("no_viz" in tools.graphify_build.args).toBe(true)
  })

  it("declares the force recovery arg (T-CS3-6)", async () => {
    const tools = await loadTools()
    expect("force" in tools.graphify_build.args).toBe(true)
  })
})

// ── new tools: diagnose / export / benchmark (T-CS3-2/3/4) ───────────────────

describe("new graphify tools registration", () => {
  it("registers graphify_diagnose with path + maxExamples args", async () => {
    const tools = await loadTools()
    expect(tools.graphify_diagnose).toBeDefined()
    expect("path" in tools.graphify_diagnose.args).toBe(true)
    expect("maxExamples" in tools.graphify_diagnose.args).toBe(true)
  })

  it("registers graphify_export with path + format args", async () => {
    const tools = await loadTools()
    expect(tools.graphify_export).toBeDefined()
    expect("path" in tools.graphify_export.args).toBe(true)
    expect("format" in tools.graphify_export.args).toBe(true)
  })

  it("registers graphify_benchmark with a path arg", async () => {
    const tools = await loadTools()
    expect(tools.graphify_benchmark).toBeDefined()
    expect("path" in tools.graphify_benchmark.args).toBe(true)
  })
})
