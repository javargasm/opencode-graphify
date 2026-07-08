import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join, resolve } from "path"
import plugin, {
  buildExtractCommand,
  buildAddCommand,
  shouldNudgeGraphFirst,
  buildDiagnoseCommand,
  buildExportCommand,
  EXPORT_FORMATS,
  shapeBenchmarkOutput,
  buildSaveResultCommand,
  buildMultiRootWarning,
  createGraphifyAgentConfig,
  registerGraphifyAgent,
  wrapToolsWithDelegationGuard,
  GRAPHIFY_AGENT_NAME,
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
    expect(plugin.id).toBe("javargasm-graphify")
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

// ── global graphify subagent registration ───────────────────────────────────

describe("graphify subagent registration", () => {
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

  it("registers a global graphify subagent through the config hook", async () => {
    const hooks = await loadHooks(TMP)
    const config: any = {}

    await (hooks as any).config(config)

    const agent = config.agent[GRAPHIFY_AGENT_NAME]
    expect(agent).toBeDefined()
    expect(agent.mode).toBe("subagent")
    expect(agent.permission.edit).toBe("deny")
    expect(agent.tools.graphify_status).toBe(true)
    expect(agent.tools.graphify_query).toBe(true)
    expect(agent.prompt).toContain("graphify_status")
    expect(agent.prompt).toContain("graphify_save_result")
  })

  it("does not overwrite a user-defined graphify agent", () => {
    const existing = { mode: "subagent", prompt: "custom graphify runner" }
    const config: any = { agent: { [GRAPHIFY_AGENT_NAME]: existing } }

    expect(registerGraphifyAgent(config)).toBe(false)
    expect(config.agent[GRAPHIFY_AGENT_NAME]).toBe(existing)
  })

  it("creates an agent that prefers native graphify tools over raw shell", () => {
    const agent = createGraphifyAgentConfig() as any
    expect(agent.prompt).toContain("Prefer native graphify_* tools")
    expect(agent.tools.bash).toBe(true)
    expect(agent.permission.bash["graphify *"]).toBe("allow")
    expect(agent.permission.bash["*"]).toBe("ask")
  })
})

// ── delegation guard (enforceDelegation) ─────────────────────────────────────

describe("wrapToolsWithDelegationGuard", () => {
  function makeMockTool(name: string) {
    let called = false
    const execute = async (_args: any, _ctx: any) => {
      called = true
      return { title: `${name} ran`, output: "ok" }
    }
    return { def: { description: `mock ${name}`, args: {}, execute }, wasCalled: () => called }
  }

  it("blocks a non-graphify agent and returns a delegation message", async () => {
    const { def, wasCalled } = makeMockTool("graphify_query")
    const wrapped = wrapToolsWithDelegationGuard({ graphify_query: def as any }, true)
    const result: any = await wrapped.graphify_query.execute({}, { agent: "general" })
    expect(wasCalled()).toBe(false)
    expect(result.title).toContain("Delegation required")
    expect(result.output).toContain("subagent_type: 'graphify'")
  })

  it("allows the graphify subagent to call through to the original execute", async () => {
    const { def, wasCalled } = makeMockTool("graphify_query")
    const wrapped = wrapToolsWithDelegationGuard({ graphify_query: def as any }, true)
    const result: any = await wrapped.graphify_query.execute({}, { agent: GRAPHIFY_AGENT_NAME })
    expect(wasCalled()).toBe(true)
    expect(result.output).toBe("ok")
  })

  it("passes tools through unwrapped when enforce is false", async () => {
    const { def, wasCalled } = makeMockTool("graphify_status")
    const wrapped = wrapToolsWithDelegationGuard({ graphify_status: def as any }, false)
    const result: any = await wrapped.graphify_status.execute({}, { agent: "general" })
    expect(wasCalled()).toBe(true)
    expect(result.output).toBe("ok")
  })

  it("applies the guard to every graphify_* tool via the plugin tool hook", async () => {
    const fakeInput: any = {
      directory: TMP, worktree: TMP, $: () => ({}), client: {},
      project: { id: "test", worktree: TMP },
    }
    const hooks = await plugin.server(fakeInput)
    const tools = hooks.tool as Record<string, any>
    for (const name of [
      "graphify_status", "graphify_query", "graphify_path", "graphify_explain",
      "graphify_affected", "graphify_update", "graphify_add", "graphify_diagnose",
      "graphify_export", "graphify_benchmark", "graphify_save_result", "graphify_build",
    ]) {
      const result: any = await tools[name].execute({}, { agent: "general" })
      expect(result.title).toContain("Delegation required")
    }
  })

  it("does not guard tools when enforceDelegation is false", async () => {
    const fakeInput: any = {
      directory: TMP, worktree: TMP, $: () => ({}), client: {},
      project: { id: "test", worktree: TMP },
    }
    const hooks = await plugin.server(fakeInput, { enforceDelegation: false })
    const tools = hooks.tool as Record<string, any>
    // graphify_status catches exec errors, so it returns a normal result —
    // the guard is NOT the one refusing.
    const result: any = await tools.graphify_status.execute({}, { agent: "general" })
    expect(result.title).not.toContain("Delegation required")
  })
})

describe("delegation enforcement in tool.execute.before tips", () => {
  async function loadHooks(dir: string, options?: any) {
    const fakeInput: any = {
      directory: dir, worktree: dir, $: () => ({}), client: {},
      project: { id: "test", worktree: dir },
    }
    return plugin.server(fakeInput, options)
  }

  it("does NOT inject tips for graphify CLI when enforceDelegation is true", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP) // default: enforceDelegation = true
    const before = (hooks as any)["tool.execute.before"]
    const cmd = 'graphify query "how does auth work"'
    const output: any = { args: { command: cmd } }
    await before({ tool: "shell", args: { command: cmd } }, output)
    // hook is a no-op when enforcement is on — command untouched
    expect(output.args.command).toBe(cmd)
  })

  it("keeps the native-tools tip when enforcement is disabled", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP, { enforceDelegation: false })
    const before = (hooks as any)["tool.execute.before"]
    const cmd = 'graphify query "how does auth work"'
    const output: any = { args: { command: cmd } }
    await before({ tool: "shell", args: { command: cmd } }, output)
    expect(output.args.command).toContain("native graphify_* tools")
    expect(output.args.command).not.toContain("Delegation enforced")
  })

  it("does NOT inject tips for raw searches when enforceDelegation is true", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP) // default: enforceDelegation = true
    const before = (hooks as any)["tool.execute.before"]
    const cmd = "grep -r foo ."
    const output: any = { args: { command: cmd } }
    await before({ tool: "shell", args: { command: cmd } }, output)
    // hook is a no-op when enforcement is on — command untouched
    expect(output.args.command).toBe(cmd)
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

// ── buildMultiRootWarning (graphify_status multi-repo ambiguity UX) ─────────

describe("buildMultiRootWarning", () => {
  it("returns null for zero roots", () => {
    expect(buildMultiRootWarning([])).toBeNull()
  })

  it("returns null for exactly one root (unambiguous)", () => {
    expect(buildMultiRootWarning(["frontend"])).toBeNull()
  })

  it("warns and lists every root name when there are 2+ roots", () => {
    const warning = buildMultiRootWarning(["frontend", "backend"])
    expect(warning).not.toBeNull()
    expect(warning).toContain("2 graph roots detected")
    expect(warning).toContain("frontend")
    expect(warning).toContain("backend")
    expect(warning).toContain("Multiple graph roots found")
  })

  it("warns for 3+ roots too", () => {
    const warning = buildMultiRootWarning(["a", "b", "c"])
    expect(warning).toContain("3 graph roots detected")
    expect(warning).toContain("a, b, c")
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

  it("builds `graphify export html` for the html format", () => {
    expect(buildExportCommand("html")).toBe("graphify export html")
  })

  it("builds `graphify export obsidian` for the obsidian format", () => {
    expect(buildExportCommand("obsidian")).toBe("graphify export obsidian")
  })

  it("builds `graphify export wiki` for the wiki format", () => {
    expect(buildExportCommand("wiki")).toBe("graphify export wiki")
  })

  it("builds `graphify export svg` for the svg format", () => {
    expect(buildExportCommand("svg")).toBe("graphify export svg")
  })

  it("builds `graphify export graphml` for the graphml format", () => {
    expect(buildExportCommand("graphml")).toBe("graphify export graphml")
  })

  it("builds `graphify export neo4j` for the neo4j format", () => {
    expect(buildExportCommand("neo4j")).toBe("graphify export neo4j")
  })

  it("builds `graphify export falkordb` for the falkordb format", () => {
    expect(buildExportCommand("falkordb")).toBe("graphify export falkordb")
  })

  it("falls back to callflow-html for an unknown format", () => {
    expect(buildExportCommand("unknown" as any)).toBe("graphify export callflow-html")
    expect(buildExportCommand("pdf" as any)).toBe("graphify export callflow-html")
  })
})

describe("EXPORT_FORMATS constant", () => {
  it("includes all 9 formats (8 export subcommands + tree)", () => {
    expect(EXPORT_FORMATS).toContain("callflow-html")
    expect(EXPORT_FORMATS).toContain("tree")
    expect(EXPORT_FORMATS).toContain("html")
    expect(EXPORT_FORMATS).toContain("obsidian")
    expect(EXPORT_FORMATS).toContain("wiki")
    expect(EXPORT_FORMATS).toContain("svg")
    expect(EXPORT_FORMATS).toContain("graphml")
    expect(EXPORT_FORMATS).toContain("neo4j")
    expect(EXPORT_FORMATS).toContain("falkordb")
    expect(EXPORT_FORMATS).toHaveLength(9)
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

// ── graphify_status: multi-root ambiguity warning (integration) ─────────────

describe("graphify_status multi-root warning", () => {
  async function loadTools(dir: string) {
    const fakeInput: any = {
      directory: dir, worktree: dir, $: () => ({}), client: {},
      project: { id: "test", worktree: dir },
    }
    const hooks = await plugin.server(fakeInput, { enforceDelegation: false })
    return hooks.tool as Record<string, any>
  }

  it("warns when called without `path` and multiple roots exist", async () => {
    scaffoldGraph(join(TMP, "frontend"))
    scaffoldGraph(join(TMP, "backend"))
    const tools = await loadTools(TMP)
    const result: any = await tools.graphify_status.execute({}, { agent: "general" })
    expect(result.output).toContain("2 graph roots detected")
    expect(result.output).toContain("frontend")
    expect(result.output).toContain("backend")
    expect(result.output).toContain("Multiple graph roots found")
  })

  it("does not warn when a single root exists", async () => {
    scaffoldGraph(TMP)
    const tools = await loadTools(TMP)
    const result: any = await tools.graphify_status.execute({}, { agent: "general" })
    expect(result.output).not.toContain("graph roots detected")
  })

  it("does not warn when `path` is explicitly given, even with multiple roots", async () => {
    scaffoldGraph(join(TMP, "frontend"))
    scaffoldGraph(join(TMP, "backend"))
    const tools = await loadTools(TMP)
    const result: any = await tools.graphify_status.execute({ path: "frontend" }, { agent: "general" })
    expect(result.output).not.toContain("graph roots detected")
    expect(result.output).toContain("Target:")
  })

  it("does not warn when no graphs exist at all", async () => {
    const tools = await loadTools(TMP)
    const result: any = await tools.graphify_status.execute({}, { agent: "general" })
    expect(result.output).not.toContain("graph roots detected")
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

// ── buildSaveResultCommand (v0.9.2 reflect loop / save-result) ───────────────

describe("buildSaveResultCommand", () => {
  it("includes the shell-quoted question and --answer", () => {
    const cmd = buildSaveResultCommand({
      question: "how does auth work?",
      answer: "JWT middleware in src/auth.ts",
    })
    expect(cmd).toContain("graphify save-result")
    expect(cmd).toContain("--question 'how does auth work?'")
    expect(cmd).toContain("--answer 'JWT middleware in src/auth.ts'")
  })

  it("uses --answer-file instead of --answer when answerFile is given", () => {
    const cmd = buildSaveResultCommand({
      question: "q",
      answerFile: "/tmp/answer.md",
    })
    expect(cmd).toContain("--answer-file '/tmp/answer.md'")
    expect(cmd).not.toContain(" --answer '")
  })

  it("throws when neither answer nor answerFile is provided", () => {
    expect(() => buildSaveResultCommand({ question: "q" })).toThrow(
      /answer|answer-file/i,
    )
  })

  it("throws when both answer and answerFile are provided", () => {
    expect(() =>
      buildSaveResultCommand({ question: "q", answer: "a", answerFile: "/tmp/a" }),
    ).toThrow(/both|exactly one/i)
  })

  it("appends shell-quoted --type when provided", () => {
    const cmd = buildSaveResultCommand({
      question: "q",
      answer: "a",
      type: "architecture",
    })
    expect(cmd).toContain("--type 'architecture'")
  })

  it("appends each node label shell-quoted under a single --nodes flag", () => {
    const cmd = buildSaveResultCommand({
      question: "q",
      answer: "a",
      nodes: ["UserService.create", "Database.insert"],
    })
    expect(cmd).toContain("--nodes 'UserService.create' 'Database.insert'")
  })

  it("omits --nodes when the array is empty", () => {
    const cmd = buildSaveResultCommand({ question: "q", answer: "a", nodes: [] })
    expect(cmd).not.toContain("--nodes")
  })

  it("appends a valid --outcome", () => {
    expect(
      buildSaveResultCommand({ question: "q", answer: "a", outcome: "useful" }),
    ).toContain("--outcome useful")
    expect(
      buildSaveResultCommand({ question: "q", answer: "a", outcome: "dead_end" }),
    ).toContain("--outcome dead_end")
    expect(
      buildSaveResultCommand({ question: "q", answer: "a", outcome: "corrected" }),
    ).toContain("--outcome corrected")
  })

  it("throws on an invalid outcome before building a command", () => {
    expect(() =>
      buildSaveResultCommand({ question: "q", answer: "a", outcome: "great" as any }),
    ).toThrow(/outcome/i)
  })

  it("appends shell-quoted --correction and --memory-dir when provided", () => {
    const cmd = buildSaveResultCommand({
      question: "q",
      answer: "a",
      correction: "actually it's in src/login.ts",
      memoryDir: "/repo/graphify-out/memory",
    })
    expect(cmd).toContain("--correction 'actually it'\\''s in src/login.ts'")
    expect(cmd).toContain("--memory-dir '/repo/graphify-out/memory'")
  })

  it("neutralizes injection payloads via shellQuote", () => {
    const cmd = buildSaveResultCommand({
      question: "q$(touch /tmp/pwn)",
      answer: "a; rm -rf /",
    })
    expect(cmd).toContain("'q$(touch /tmp/pwn)'")
    expect(cmd).toContain("'a; rm -rf /'")
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
    expect(text).toContain("dedicated subagent: graphify")
    expect(text).toContain("enforced")
    expect(text).toContain("restricted to the dedicated graphify subagent")
    expect(text).toContain("raw `graphify ...` shell commands")
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
    expect(text).toContain("Dedicated subagent: graphify")
    expect(text).toContain("ENFORCED")
    expect(text).toContain("restricted to the dedicated")
    expect(text).toContain("If you are already running as the graphify subagent")
  })

  it("orients the agent on the full tool surface, not just the read tools", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const output: any = { system: [] }
    await transform({}, output)
    const text = output.system.join("\n")
    // navigation/query surface
    for (const t of [
      "graphify_query",
      "graphify_path",
      "graphify_explain",
      "graphify_affected",
      "graphify_update",
      "graphify_add",
      "graphify_diagnose",
      "graphify_export",
      "graphify_benchmark",
    ]) {
      expect(text).toContain(t)
    }
  })

  it("instructs the agent to record outcomes via graphify_save_result (reflect loop)", async () => {
    scaffoldGraph(TMP)
    const hooks = await loadHooks(TMP)
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const output: any = { system: [] }
    await transform({}, output)
    const text = output.system.join("\n")
    expect(text).toContain("graphify_save_result")
    // the reflect loop only works if the agent is told WHEN to call it
    expect(text.toLowerCase()).toMatch(/useful|dead_end|dead end|corrected|outcome/)
  })
})

// ── tool.execute.before fail-open advisory (T-CS2-2 / B-R2 / B-AC5) ──────────

describe("tool.execute.before nudge hook", () => {
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

  it("injects advisory context for a raw search but keeps the command runnable", async () => {
    scaffoldGraph(TMP)
    // Advisory tips only fire when enforceDelegation is false — when enforcement
    // is on (default), the hook is a no-op to avoid confusing the subagent.
    const hooks = await loadHooks(TMP, { enforceDelegation: false })
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

  it("registers graphify_save_result with question/answer/answerFile/nodes/outcome args", async () => {
    const tools = await loadTools()
    expect(tools.graphify_save_result).toBeDefined()
    expect("question" in tools.graphify_save_result.args).toBe(true)
    expect("answer" in tools.graphify_save_result.args).toBe(true)
    expect("answerFile" in tools.graphify_save_result.args).toBe(true)
    expect("nodes" in tools.graphify_save_result.args).toBe(true)
    expect("outcome" in tools.graphify_save_result.args).toBe(true)
  })
})
