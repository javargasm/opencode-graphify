/**
 * opencode-graphify — OpenCode plugin for graphify knowledge graphs.
 *
 * Wraps the graphify CLI as native OpenCode tools with multi-repo support,
 * system prompt injection, and tool result augmentation.
 *
 * @see https://github.com/safishamsi/graphify
 */

import { existsSync } from "fs"
import { resolve, join, basename } from "path"
import { tool } from "@opencode-ai/plugin"
import type { PluginInput, Hooks, PluginOptions, Config } from "@opencode-ai/plugin"

import { resolveConfig } from "./config"
import { discoverGraphRoots, resolveGraphRoot, readBounded, listGraphRootsDescription, readGraphStats, readCommunityCount, GRAPH_FILE } from "./discovery"
import { exec, shellQuote, ensureGitignore, validateBackend } from "./shell"

const z = tool.schema

export const GRAPHIFY_AGENT_NAME = "graphify"

const GRAPHIFY_TOOL_NAMES = [
  "graphify_status",
  "graphify_build",
  "graphify_query",
  "graphify_path",
  "graphify_explain",
  "graphify_affected",
  "graphify_update",
  "graphify_add",
  "graphify_diagnose",
  "graphify_export",
  "graphify_benchmark",
  "graphify_save_result",
] as const

type GraphifyAgentConfig = NonNullable<Config["agent"]>[string]

export function createGraphifyAgentConfig(): GraphifyAgentConfig {
  return {
    description:
      "Runs graphify commands and graphify_* tools for graph-enabled projects.",
    mode: "subagent",
    hidden: false,
    color: "info",
    tools: {
      bash: true,
      read: true,
      glob: true,
      grep: true,
      ...Object.fromEntries(GRAPHIFY_TOOL_NAMES.map((name) => [name, true])),
    },
    permission: {
      edit: "deny",
      bash: {
        "*": "ask",
        "graphify": "allow",
        "graphify *": "allow",
        "uv tool run graphifyy *": "allow",
        "python* -m graphify *": "allow",
      },
    },
    prompt: [
      "You are the Graphify runner subagent for OpenCode.",
      "",
      "Scope:",
      "- Execute graphify graph commands and native graphify_* tools for the current project.",
      "- Prefer native graphify_* tools over raw shell when a matching tool exists.",
      "- Use raw `graphify ...` shell commands only for graphify subcommands not exposed as native tools.",
      "- Start with graphify_status to detect graph roots unless the caller already provided one.",
      "- If a graph exists, answer architecture, dependency, impact, and cross-file questions with graphify_query/path/explain/affected.",
      "- If no graph exists, do not invent graph facts; build one only when the caller explicitly asks.",
      "- After code changes in a graph-enabled repo, run graphify_update when asked to refresh the graph.",
      "- Save non-trivial or surprising query outcomes with graphify_save_result.",
      "- Reference graphify nodes by LABEL, not by non-persistent node IDs.",
      "- Never edit project files directly; only graphify commands may create or update graphify artifacts.",
      "",
      "Return a concise summary with the graph root, command/tool used, key result, and any follow-up needed.",
    ].join("\n"),
  }
}

export function registerGraphifyAgent(config: Config): boolean {
  config.agent ??= {}
  if (config.agent[GRAPHIFY_AGENT_NAME]) return false
  config.agent[GRAPHIFY_AGENT_NAME] = createGraphifyAgentConfig()
  return true
}

/**
 * Wrap every graphify_* tool's `execute` so it refuses to run when called by
 * any agent other than the dedicated `graphify` subagent. This structurally
 * enforces delegation: the primary agent cannot call graphify_* tools directly
 * — it must delegate via the task tool (subagent_type: 'graphify').
 *
 * The guard returns a clear ToolResult telling the caller to delegate, rather
 * than throwing, so the LLM gets actionable redirection. When enforcement is
 * disabled (enforceDelegation: false), tools pass through unwrapped.
 */
export function wrapToolsWithDelegationGuard(
  tools: Record<string, ReturnType<typeof tool>>,
  enforce: boolean,
): Record<string, ReturnType<typeof tool>> {
  if (!enforce) return tools
  const wrapped: Record<string, ReturnType<typeof tool>> = {}
  for (const [name, def] of Object.entries(tools)) {
    const originalExecute = def.execute
    wrapped[name] = {
      ...def,
      async execute(args: any, ctx: any) {
        if (ctx?.agent && ctx.agent !== GRAPHIFY_AGENT_NAME) {
          return {
            title: `Delegation required: ${name}`,
            output: [
              `This tool (${name}) is restricted to the '${GRAPHIFY_AGENT_NAME}' subagent.`,
              `Delegate this Graphify work by calling the task tool with subagent_type: '${GRAPHIFY_AGENT_NAME}'.`,
              `The subagent will execute the graphify command and return the result.`,
            ].join("\n"),
          }
        }
        return originalExecute(args, ctx)
      },
    }
  }
  return wrapped
}

function graphifyDelegationInstruction(): string {
  return [
    `Primary-agent delegation rule (ENFORCED): graphify_* tools are restricted to the dedicated ${GRAPHIFY_AGENT_NAME} subagent.`,
    "Calling them from any other agent returns a refusal that tells you to delegate.",
    `Delegate ALL Graphify work by calling the task tool with subagent_type: '${GRAPHIFY_AGENT_NAME}'.`,
    "This includes graphify_status, graphify_build, graphify_query, graphify_path, graphify_explain, graphify_affected, graphify_update, graphify_add, graphify_diagnose, graphify_export, graphify_benchmark, graphify_save_result, and raw `graphify ...` shell commands.",
    `If you are already running as the ${GRAPHIFY_AGENT_NAME} subagent, execute the Graphify work directly instead of delegating again.`,
  ].join("\n")
}

/**
 * Build the `graphify extract` command for a target directory.
 *
 * The backend is enum-validated (contract C1) before interpolation: when it
 * resolves to auto/empty/undefined the `--backend` flag is omitted entirely
 * (the CLI auto-detects); when it is an allowed backend it is appended
 * shell-quoted (defense-in-depth alongside validation). An unknown or
 * injection-bearing backend throws before any command is constructed.
 *
 * `apiTimeout` (optional positive integer seconds) is appended as
 * `--api-timeout <n>` when set; non-positive / non-integer values are ignored.
 *
 * `force` (optional, T-CS3-6) appends `--force` to run a fresh full extraction
 * that overwrites graph.json even with fewer nodes — the recovery path for
 * same-named nodes that collided before graphify v0.9.0's full-path node IDs.
 * Flag order is stable: backend, then api-timeout, then force.
 */
export function buildExtractCommand(
  targetDir: string,
  backend?: string,
  apiTimeout?: number,
  force?: boolean,
): string {
  const validation = validateBackend(backend)
  if (!validation.ok) throw new Error(validation.error)
  const backendFlag = validation.value ? ` --backend ${shellQuote(validation.value)}` : ""
  const timeoutFlag =
    typeof apiTimeout === "number" && Number.isInteger(apiTimeout) && apiTimeout > 0
      ? ` --api-timeout ${apiTimeout}`
      : ""
  const forceFlag = force ? " --force" : ""
  return `graphify extract ${shellQuote(targetDir)}${backendFlag}${timeoutFlag}${forceFlag}`
}

/**
 * Build the `graphify diagnose multigraph --json` command (T-CS3-2 / C-T2).
 *
 * Runs with cwd = the resolved graph root (like query/path/explain), so it
 * relies on graphify's default graph path. `maxExamples`, when a positive
 * integer, is appended as `--max-examples N`; other values are ignored.
 */
export function buildDiagnoseCommand(opts: { maxExamples?: number } = {}): string {
  let cmd = "graphify diagnose multigraph --json"
  const { maxExamples } = opts
  if (typeof maxExamples === "number" && Number.isInteger(maxExamples) && maxExamples > 0) {
    cmd += ` --max-examples ${maxExamples}`
  }
  return cmd
}

/**
 * All export formats supported by `graphify export <format>` (graphify 0.9.5+).
 * `tree` is a separate top-level command (`graphify tree`), not under
 * `graphify export`, but is included here as a unified format selector.
 */
export const EXPORT_FORMATS = [
  "callflow-html", "tree", "html", "obsidian", "wiki",
  "svg", "graphml", "neo4j", "falkordb",
] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/**
 * Build the visual-export command (T-CS3-3 / C-T1). `tree` is a SEPARATE
 * top-level command (`graphify tree`); all other recognized formats map to
 * `graphify export <format>`. An unknown or undefined format falls back to
 * `graphify export callflow-html` (the default).
 */
export function buildExportCommand(format?: ExportFormat): string {
  if (format === "tree") return "graphify tree"
  if (format && (EXPORT_FORMATS as readonly string[]).includes(format)) {
    return `graphify export ${format}`
  }
  return "graphify export callflow-html"
}

/** Shaped benchmark result (T-CS3-4 / C-T3). */
export interface BenchmarkShape {
  available: boolean
  title: string
  output: string
}

/**
 * Shape `graphify benchmark` output (T-CS3-4 / C-T3). Benchmarking needs a
 * semantically-built graph; on AST-only/empty graphs graphify prints
 * "No matching nodes found …" (still exit 0). Degrade gracefully: a non-zero
 * exit, empty output, or a "no matching nodes"/"build the graph first" message
 * yields an informative "unavailable" result rather than a thrown error.
 */
export function shapeBenchmarkOutput(stdout: string, exitCode: number): BenchmarkShape {
  const text = (stdout ?? "").trim()
  const noNodes = /no matching nodes/i.test(text) || /build the graph first/i.test(text)
  if (exitCode !== 0 || text === "" || noNodes) {
    return {
      available: false,
      title: "Benchmark unavailable (graph may be AST-only or empty)",
      output:
        "Benchmark unavailable — the graph appears to be AST-only or empty (no semantic nodes " +
        "to sample). Build the graph with a semantic backend (graphify_build) to enable " +
        "token-reduction benchmarking." +
        (text ? `\n\nCLI output:\n${text}` : ""),
    }
  }
  return { available: true, title: "Benchmark", output: text }
}

/**
 * Build the `graphify add <url>` command. `add` already updates the graph, so
 * callers must NOT chain a second `graphify update` (contract C-F1 / PL-7).
 * All interpolations are shell-quoted.
 */
export function buildAddCommand(
  url: string,
  opts: { author?: string; contributor?: string } = {},
): string {
  let cmd = `graphify add ${shellQuote(url)}`
  if (opts.author) cmd += ` --author ${shellQuote(opts.author)}`
  if (opts.contributor) cmd += ` --contributor ${shellQuote(opts.contributor)}`
  return cmd
}

/** Valid `--outcome` values for `graphify save-result` (graphify >= 0.9.2). */
export const SAVE_RESULT_OUTCOMES = ["useful", "dead_end", "corrected"] as const
export type SaveResultOutcome = (typeof SAVE_RESULT_OUTCOMES)[number]

/** Options for {@link buildSaveResultCommand}. */
export interface SaveResultOptions {
  question: string
  /** Inline answer. Mutually exclusive with `answerFile`. */
  answer?: string
  /**
   * Path to a file holding the answer (graphify 0.9.2 `--answer-file`, #1502).
   * Lets a long/multi-line answer come from a file instead of an inline shell
   * argument. Mutually exclusive with `answer`.
   */
  answerFile?: string
  type?: string
  /** Node labels this answer drew on; emitted under a single `--nodes` flag. */
  nodes?: string[]
  outcome?: SaveResultOutcome
  correction?: string
  memoryDir?: string
}

/**
 * Build the `graphify save-result` command (graphify >= 0.9.2 reflect loop).
 *
 * Persists a query outcome into graphify's memory so future sessions can learn
 * which graph traversals were useful, dead ends, or needed correction.
 *
 * Contract:
 *  - EXACTLY ONE of `answer` / `answerFile` must be provided (the CLI accepts
 *    either; supplying neither or both is a caller error and throws before any
 *    command string is built).
 *  - `outcome`, when present, is enum-validated against {@link SAVE_RESULT_OUTCOMES}
 *    before interpolation (defense-in-depth alongside shell-quoting); an unknown
 *    value throws.
 *  - `nodes` emits a single `--nodes a b c` flag (argparse `nargs="*"`), each
 *    label shell-quoted; an empty array omits the flag.
 *  - every free-text value is shell-quoted.
 */
export function buildSaveResultCommand(opts: SaveResultOptions): string {
  const hasAnswer = typeof opts.answer === "string" && opts.answer.length > 0
  const hasAnswerFile = typeof opts.answerFile === "string" && opts.answerFile.length > 0
  if (hasAnswer && hasAnswerFile) {
    throw new Error(
      "save-result accepts exactly one of answer or answerFile, not both",
    )
  }
  if (!hasAnswer && !hasAnswerFile) {
    throw new Error("save-result requires an answer or an answer-file")
  }
  if (opts.outcome !== undefined && !(SAVE_RESULT_OUTCOMES as readonly string[]).includes(opts.outcome)) {
    throw new Error(
      `unknown outcome '${opts.outcome}'; allowed: ${SAVE_RESULT_OUTCOMES.join(", ")}`,
    )
  }

  let cmd = `graphify save-result --question ${shellQuote(opts.question)}`
  cmd += hasAnswer
    ? ` --answer ${shellQuote(opts.answer as string)}`
    : ` --answer-file ${shellQuote(opts.answerFile as string)}`
  if (opts.type) cmd += ` --type ${shellQuote(opts.type)}`
  if (Array.isArray(opts.nodes) && opts.nodes.length > 0) {
    cmd += ` --nodes ${opts.nodes.map(shellQuote).join(" ")}`
  }
  if (opts.outcome) cmd += ` --outcome ${opts.outcome}`
  if (opts.correction) cmd += ` --correction ${shellQuote(opts.correction)}`
  if (opts.memoryDir) cmd += ` --memory-dir ${shellQuote(opts.memoryDir)}`
  return cmd
}

/**
 * Build the multi-repo ambiguity warning for `graphify_status` when called
 * without a `path` and more than one graph root is detected. Every OTHER
 * graphify_* tool requires `path` in this situation (resolveGraphRoot throws
 * "Multiple graph roots found"), but that only surfaces reactively once the
 * agent tries to use one of them. This makes the ambiguity visible up front,
 * at the point where the agent is orienting itself.
 *
 * PURE: no fs, no throw — returns null when there is nothing to warn about
 * (0 or 1 roots).
 */
export function buildMultiRootWarning(rootNames: string[]): string | null {
  if (rootNames.length <= 1) return null
  return [
    `Note: ${rootNames.length} graph roots detected and no \`path\` was given.`,
    "Every other graphify_* tool call in this session must include `path` " +
      `(one of: ${rootNames.join(", ")}) or it will fail with "Multiple graph roots found".`,
  ].join("\n")
}

/**
 * Decide whether a raw shell command should be nudged toward the graphify_*
 * tools (contract C3, change set B). PURE + fail-open: no fs, no throw — any
 * unexpected input returns false.
 *
 * Heuristic (advisory only, never blocks):
 *  - Never nudge when graphRootCount <= 0 (no graph to steer to) or when the
 *    command already invokes `graphify`.
 *  - Only the FIRST pipeline/sequence segment is evaluated, so a search tool
 *    used as a downstream output filter (e.g. `ps aux | grep x`) is ignored.
 *  - Leading env-assignments (`VAR=val`) and a leading `sudo` are stripped.
 *  - grep/egrep/fgrep → nudge when a recursive flag (-r/-R/--recursive) OR a
 *    path/dir/`.`/glob arg is present (a bare `grep pat` reading stdin is not).
 *  - rg/ag/ack → recursive by default, so the tool name alone nudges.
 *  - find → nudge when a path arg (the conventional first positional) is given.
 *  - cat → nudge on a bulk read: a glob (`*`/`?`) or more than one file arg
 *    (a single small `cat file` read is not nudged).
 *  - anything else → no nudge.
 */
export function shouldNudgeGraphFirst(command: string, graphRootCount: number): boolean {
  try {
    if (!(typeof graphRootCount === "number" && graphRootCount > 0)) return false
    if (typeof command !== "string") return false
    const trimmed = command.trim()
    if (trimmed === "") return false
    if (/\bgraphify\b/.test(trimmed)) return false

    // Evaluate only the leading pipeline/sequence segment.
    const firstSegment = trimmed.split(/\||&&|;/)[0].trim()
    const tokens = firstSegment.split(/\s+/).filter(Boolean)

    // Strip leading env-assignments (VAR=val) and a leading `sudo`.
    let i = 0
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
    if (tokens[i] === "sudo") i++

    const cmd = tokens[i]
    if (!cmd) return false
    const rest = tokens.slice(i + 1)

    const isPathLike = (a: string): boolean =>
      !a.startsWith("-") &&
      (a === "." || a === ".." || a.includes("/") || a.includes("*") || a.includes("?"))

    if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep") {
      const hasRecursive = rest.some(
        (a) => a === "--recursive" || /^-{1,2}[A-Za-z]*[rR]/.test(a),
      )
      const hasPathOrGlob = rest.some(isPathLike)
      return hasRecursive || hasPathOrGlob
    }

    if (cmd === "rg" || cmd === "ag" || cmd === "ack") {
      // Recursive code searchers by default.
      return true
    }

    if (cmd === "find") {
      // find's search path is the leading positional(s) before any -expression
      // flag (e.g. `find . -name x`). A bare `find -name x` has no path.
      const leading: string[] = []
      for (const a of rest) {
        if (a.startsWith("-")) break
        leading.push(a)
      }
      return leading.length > 0
    }

    if (cmd === "cat") {
      const fileArgs = rest.filter((a) => !a.startsWith("-"))
      const hasGlob = fileArgs.some((a) => a.includes("*") || a.includes("?"))
      return hasGlob || fileArgs.length > 1
    }

    return false
  } catch {
    return false
  }
}

const GraphifyPlugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> => {
  const config = resolveConfig(options)
  const directory = input.directory
  const $ = input.$

  let augmentHits = 0
  const augmentedCache = new Set<string>()
  let graphRoots = discoverGraphRoots(directory)

  function refreshRoots() {
    graphRoots = discoverGraphRoots(directory)
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  const tools: Record<string, ReturnType<typeof tool>> = {
    graphify_status: tool({
      description:
        "Report the installed graphify CLI version, detected graph roots, and graph stats. " +
        "Multi-repo aware: auto-discovers graphify-out/graph.json in the project and its immediate subdirectories. " +
        "Pass `path` to check a specific repo.",
      args: {
        path: z.string().optional().describe(
          "Repo directory to check (name or relative path). If omitted, shows all detected roots."
        ),
      },
      async execute(args, ctx) {
        refreshRoots()

        let version = "unknown"
        let installed = false
        try {
          const r = await exec($, "graphify --version 2>/dev/null || echo 'not found'", directory)
          const raw = r.stdout.trim()
          if (!raw.includes("not found")) {
            version = raw.replace(/^graphify\s*/i, "").replace(/^v/, "")
            installed = true
          }
        } catch {}

        const rootsDesc = listGraphRootsDescription(graphRoots)

        let targetInfo = ""
        if (args.path) {
          try {
            const root = resolveGraphRoot(args.path, directory, graphRoots)
            const { statSync } = await import("fs")
            const graphPath = join(root, GRAPH_FILE)
            const stat = statSync(graphPath)
            const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
            const age = Math.round((Date.now() - stat.mtimeMs) / 1000 / 60)
            targetInfo = `\nTarget: ${root}\nGraph size: ${sizeMb} MB\nLast modified: ${age} minutes ago`
          } catch (err) {
            targetInfo = `\nTarget: ${args.path} — ${err instanceof Error ? err.message : "not found"}`
          }
        }

        // Proactively surface multi-root ambiguity (UX improvement): without
        // this, the agent only discovers "Multiple graph roots found" when it
        // later calls graphify_query/path/explain/etc. without `path`.
        const multiRootWarning = !args.path
          ? buildMultiRootWarning(Array.from(graphRoots.keys()))
          : null

        return {
          title: installed ? `graphify v${version}` : "graphify not installed",
          output: [
            `Installed: ${installed ? "yes" : "no"}`,
            `Version: ${version}`,
            rootsDesc,
            targetInfo,
            multiRootWarning ? `\n${multiRootWarning}` : "",
            "",
            installed ? "" : "Install with: pip install graphifyy && graphify install",
          ].filter(Boolean).join("\n"),
        }
      },
    }),

    graphify_build: tool({
      description:
        "Build a knowledge graph from a directory. Runs the full pipeline: file detection, " +
        "entity/relationship extraction (via LLM), community detection, and output generation " +
        "(HTML, JSON, GRAPH_REPORT.md). Call this before graphify_query/path/explain.",
      args: {
        path: z.string().optional().describe("Directory to build graph from (defaults to auto-detect)"),
        backend: z.string().optional().describe(
          "LLM backend: gemini, claude, openai, deepseek, ollama, bedrock, kimi, claude-cli (omit/\"auto\" to auto-detect)"
        ),
        no_viz: z.boolean().optional().describe("Skip HTML visualization generation"),
        force: z.boolean().optional().describe(
          "Force a fresh full extraction, overwriting graph.json even if fewer nodes — " +
          "use to recover same-named nodes that collided before graphify v0.9.0's full-path node IDs"
        ),
      },
      async execute(args, ctx) {
        const targetDir = args.path ? resolve(directory, args.path) : directory
        const backend = args.backend ?? config.semanticBackend
        const gitignoreUpdated = ensureGitignore(targetDir)

        // Enum-validate + shell-quote the backend before exec (contract C1);
        // throws on unknown/injection input so it is never interpolated raw.
        // apiTimeout (when configured) is threaded as --api-timeout (C-F2).
        // force (when requested) appends --force for v0.9.0 collided-node
        // recovery (T-CS3-6).
        const extractCmd = buildExtractCommand(targetDir, backend, config.apiTimeout, args.force)
        const extractResult = await exec($, extractCmd, targetDir)
        if (extractResult.exitCode !== 0) {
          throw new Error(`graphify extract failed: ${extractResult.stderr || extractResult.stdout}`)
        }

        const vizFlag = args.no_viz ? " --no-viz" : ""
        const clusterCmd = `graphify cluster-only ${shellQuote(targetDir)}${vizFlag}`
        const clusterResult = await exec($, clusterCmd, targetDir)

        // Derive node/edge counts from graph.json (contract C2), not stdout
        // regex. Communities are not a top-level graph.json key, so parse them
        // from the cluster-only stdout when present.
        const stats = readGraphStats(targetDir)
        const nodes = stats?.nodes ?? 0
        const edges = stats?.edges ?? 0
        const communities = readCommunityCount(clusterResult.stdout)

        refreshRoots()

        const communitiesLine =
          communities !== null ? `  Communities: ${communities}` : ""
        const titleCommunities =
          communities !== null ? `, ${communities} communities` : ""

        return {
          title: `Graph built: ${nodes} nodes, ${edges} edges${titleCommunities}`,
          output: [
            `Graph built successfully at ${targetDir}:`,
            `  Nodes: ${nodes}`,
            `  Edges: ${edges}`,
            communitiesLine,
            `  Output: ${config.outputDir}/`,
            gitignoreUpdated ? "  .gitignore updated for graphify artifacts." : "",
            clusterResult.exitCode !== 0 ? `\nWarning: report generation had issues: ${clusterResult.stderr}` : "",
            extractResult.stdout,
          ].filter(Boolean).join("\n"),
          metadata: { repo: targetDir, nodes, edges, communities },
        }
      },
    }),

    graphify_query: tool({
      description:
        "Ask a natural-language question about the codebase using the knowledge graph. " +
        "Uses BFS (broad context) or DFS (trace a path) traversal of graphify-out/graph.json. " +
        "Prefer this over grep/find for 'how does X work', 'what calls Y', or 'trace data flow' questions. " +
        "Multi-repo: pass `path` to query a specific repo.",
      args: {
        question: z.string().describe("Natural-language question to traverse the graph for"),
        mode: z.enum(["bfs", "dfs"]).optional().describe(
          "Traversal: bfs = broad context (default), dfs = trace a specific path"
        ),
        budget: z.number().int().optional().describe("Token budget for the answer (default 2000)"),
        path: z.string().optional().describe("Repo directory or name to query (auto-detects if omitted)"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const modeFlag = args.mode === "dfs" ? " --dfs" : ""
        const budget = args.budget ?? 2000

        const cmd = `graphify query ${shellQuote(args.question)}${modeFlag} --budget ${budget}`
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Query failed: ${result.stderr}`)
        }

        return {
          title: `Query result @ ${basename(graphRoot)}`,
          output: result.stdout.trim() || "(no output)",
          metadata: { repo: graphRoot },
        }
      },
    }),

    graphify_path: tool({
      description:
        "Find the shortest path between two concepts in the knowledge graph. " +
        "Pass the node labels you want to connect.",
      args: {
        from: z.string().describe("Starting node label (e.g. 'UserService.create')"),
        to: z.string().describe("Target node label (e.g. 'Database.insert')"),
        path: z.string().optional().describe("Repo directory or name to query"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const cmd = `graphify path ${shellQuote(args.from)} ${shellQuote(args.to)}`
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Path search failed: ${result.stderr}`)
        }

        return {
          title: `Path: ${args.from} → ${args.to} @ ${basename(graphRoot)}`,
          output: result.stdout.trim() || "(no path found)",
          metadata: { repo: graphRoot },
        }
      },
    }),

    graphify_explain: tool({
      description:
        "Plain-language explanation of a single node and its neighbors in the knowledge graph. " +
        "Shows what a concept is, what it connects to, and its role in the system.",
      args: {
        concept: z.string().describe("Node label or concept name to explain"),
        path: z.string().optional().describe("Repo directory or name to query"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const cmd = `graphify explain ${shellQuote(args.concept)}`
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Explain failed: ${result.stderr}`)
        }

        return {
          title: `Explain: ${args.concept} @ ${basename(graphRoot)}`,
          output: result.stdout.trim() || "(no output)",
          metadata: { repo: graphRoot },
        }
      },
    }),

    graphify_affected: tool({
      description:
        "Reverse traversal from a node to find what depends on it (impact radius). " +
        "Useful before refactoring to understand the blast radius of a change.",
      args: {
        node: z.string().describe("Node label whose impact you want to assess"),
        depth: z.number().int().optional().describe("Reverse-traversal depth (default 2)"),
        path: z.string().optional().describe("Repo directory or name to query"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        let cmd = `graphify affected ${shellQuote(args.node)}`
        if (typeof args.depth === "number") cmd += ` --depth ${args.depth}`

        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Affected search failed: ${result.stderr}`)
        }

        return {
          title: `Impact: ${args.node} @ ${basename(graphRoot)}`,
          output: result.stdout.trim() || "(no output)",
          metadata: { repo: graphRoot },
        }
      },
    }),

    graphify_update: tool({
      description:
        "Re-extract code files and update the knowledge graph. AST-only — no LLM, no API cost. " +
        "Use after modifying code to keep the graph in sync.",
      args: {
        path: z.string().optional().describe("Repo directory or name to update (auto-detects if omitted)"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const cmd = `graphify update ${shellQuote(graphRoot)}`
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0) {
          throw new Error(`graphify update failed: ${result.stderr || result.stdout}`)
        }

        // Derive nodes/edges from graph.json (contract C2). graphify update
        // emits no reliable "N files" token, so we do not claim a files count
        // — we report only what is known from the refreshed graph.
        const stats = readGraphStats(graphRoot)
        const nodes = stats?.nodes ?? 0
        const edges = stats?.edges ?? 0

        refreshRoots()

        return {
          title: `Updated: ${nodes} nodes, ${edges} edges @ ${basename(graphRoot)}`,
          output: [
            `Graph updated at ${graphRoot}:`,
            `  Current nodes: ${nodes}`,
            `  Current edges: ${edges}`,
            result.stdout.trim(),
          ].join("\n"),
          metadata: { repo: graphRoot, nodes, edges },
        }
      },
    }),

    graphify_add: tool({
      description:
        "Fetch a URL (paper, tweet, PDF, webpage) and add it to the corpus, " +
        "then update the graph automatically.",
      args: {
        url: z.string().describe("URL to fetch and add to the corpus"),
        author: z.string().optional().describe("Author of the content"),
        contributor: z.string().optional().describe("Who added this to the corpus"),
        path: z.string().optional().describe("Repo directory or name to add content to"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)

        // `graphify add` already updates the graph, so we issue exactly ONE
        // invocation here — no redundant follow-up `graphify update` (C-F1).
        const cmd = buildAddCommand(args.url, {
          author: args.author,
          contributor: args.contributor,
        })

        const addResult = await exec($, cmd, graphRoot)
        if (addResult.exitCode !== 0) {
          throw new Error(`Failed to add URL: ${addResult.stderr || addResult.stdout}`)
        }

        refreshRoots()

        return {
          title: `Added ${args.url}`,
          output: [
            `Added ${args.url} to corpus at ${graphRoot} (graph updated).`,
            addResult.stdout.trim(),
          ].filter(Boolean).join("\n"),
          metadata: { url: args.url, repo: graphRoot },
        }
      },
    }),

    graphify_diagnose: tool({
      description:
        "Diagnose same-endpoint edge-collapse risk in the knowledge graph (graphify diagnose " +
        "multigraph). Reports node/edge counts and how many edges collapse when parallel " +
        "same-endpoint edges are merged — useful for judging whether the graph loses detail. " +
        "Multi-repo: pass `path` to target a specific repo.",
      args: {
        path: z.string().optional().describe("Repo directory or name to diagnose"),
        maxExamples: z.number().int().optional().describe(
          "Max same-endpoint collapse examples to include (default: graphify's own default)"
        ),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const cmd = buildDiagnoseCommand({ maxExamples: args.maxExamples })
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Diagnose failed: ${result.stderr || "(no output)"}`)
        }

        // Parse the JSON defensively — never hard-throw on a parse miss; fall
        // back to the raw stdout with a note so the agent still gets signal.
        let parsed: any = null
        try {
          parsed = JSON.parse(result.stdout)
        } catch {
          parsed = null
        }

        if (!parsed || typeof parsed !== "object" || !parsed.summary) {
          return {
            title: `Diagnose: ${basename(graphRoot)}`,
            output:
              "Could not parse diagnose JSON; raw output below.\n\n" +
              (result.stdout.trim() || "(no output)"),
            metadata: { repo: graphRoot },
          }
        }

        const s = parsed.summary
        const collapsed =
          (Number(s.directed_same_endpoint_collapsed_edges) || 0) +
          (Number(s.undirected_same_endpoint_collapsed_edges) || 0)
        const groups = Number(s.same_endpoint_group_count) || 0
        const risk =
          collapsed > 0 || groups > 0
            ? `edge-collapse risk: ${groups} same-endpoint group(s), ${collapsed} collapsed edge(s)`
            : "edge-collapse risk: none detected"

        return {
          title: `Diagnose: ${basename(graphRoot)}`,
          output: [
            `Nodes: ${s.node_count ?? "?"}`,
            `Raw edges: ${s.raw_edge_count ?? "?"}`,
            `Directed collapsed edges: ${s.directed_same_endpoint_collapsed_edges ?? 0}`,
            `Undirected collapsed edges: ${s.undirected_same_endpoint_collapsed_edges ?? 0}`,
            `Same-endpoint groups: ${groups}`,
            `Effective directed: ${s.effective_directed ?? "?"}`,
            "",
            risk,
          ].join("\n"),
          metadata: { repo: graphRoot, summary: s },
        }
      },
    }),

    graphify_export: tool({
      description:
        "Export a visual or structured artifact from the knowledge graph. " +
        "Formats: callflow-html (Mermaid architecture/call-flow HTML, default), " +
        "tree (collapsible D3 tree HTML), html (standard graph HTML), " +
        "obsidian (Obsidian vault), wiki (agent-crawlable wiki), " +
        "svg (embeddable SVG), graphml (Gephi/yEd), " +
        "neo4j (Cypher file or --push), falkordb (Cypher file or --push). " +
        "Writes into graphify-out/. Multi-repo: pass `path` to target a specific repo.",
      args: {
        path: z.string().optional().describe("Repo directory or name to export from"),
        format: z.enum(EXPORT_FORMATS).optional().describe(
          "Export format (default: callflow-html)"
        ),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const format = args.format ?? "callflow-html"
        const cmd = buildExportCommand(format)
        const result = await exec($, cmd, graphRoot)

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          throw new Error(`Export failed: ${result.stderr || "(no output)"}`)
        }

        // Surface the written HTML path when graphify prints one; else fall
        // back to the raw stdout.
        const out = result.stdout.trim()
        const htmlMatch = out.match(/\S*graphify-out\/\S+\.html/)
        const writtenPath = htmlMatch ? htmlMatch[0] : null

        return {
          title: `Exported ${format} @ ${basename(graphRoot)}`,
          output: writtenPath
            ? `Exported ${format} to ${writtenPath}`
            : out || `Exported ${format} (no path reported).`,
          metadata: { repo: graphRoot, format, path: writtenPath },
        }
      },
    }),

    graphify_benchmark: tool({
      description:
        "Measure token reduction vs a naive full-corpus approach for the knowledge graph " +
        "(graphify benchmark). Requires a semantically-built graph; on AST-only or empty " +
        "graphs it reports gracefully that benchmarking is unavailable. " +
        "Multi-repo: pass `path` to target a specific repo.",
      args: {
        path: z.string().optional().describe("Repo directory or name to benchmark"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)
        const result = await exec($, "graphify benchmark", graphRoot)

        // Degrade gracefully — never hard-throw on AST-only/empty graphs.
        const shaped = shapeBenchmarkOutput(result.stdout, result.exitCode)

        return {
          title: `${shaped.title} @ ${basename(graphRoot)}`,
          output: shaped.output,
          metadata: { repo: graphRoot, available: shaped.available },
        }
      },
    }),

    graphify_save_result: tool({
      description:
        "Record the outcome of a graph query into graphify's memory (graphify >= 0.9.2) so " +
        "future sessions learn which traversals are useful, dead ends, or need correction. " +
        "Provide the question and EITHER an inline `answer` OR an `answerFile` path (for long/" +
        "multi-line answers). Optionally tag the node labels you relied on and the outcome.",
      args: {
        question: z.string().describe("The question that was asked"),
        answer: z.string().optional().describe(
          "Inline answer text (mutually exclusive with answerFile)"
        ),
        answerFile: z.string().optional().describe(
          "Path to a file holding the answer — use for long/multi-line answers (mutually exclusive with answer)"
        ),
        type: z.string().optional().describe("Query type/category tag (free-form)"),
        nodes: z.array(z.string()).optional().describe(
          "Node labels the answer drew on (reference by label, not by non-persistent node ID)"
        ),
        outcome: z.enum(["useful", "dead_end", "corrected"]).optional().describe(
          "How the answer turned out: useful, dead_end, or corrected"
        ),
        correction: z.string().optional().describe(
          "If the answer was wrong, the corrected version (pairs with outcome=corrected)"
        ),
        path: z.string().optional().describe("Repo directory or name whose memory to write"),
      },
      async execute(args, ctx) {
        refreshRoots()
        const graphRoot = resolveGraphRoot(args.path, directory, graphRoots)

        // buildSaveResultCommand enforces exactly-one-of answer/answerFile and
        // enum-validates outcome before any shell string is constructed.
        const cmd = buildSaveResultCommand({
          question: args.question,
          answer: args.answer,
          answerFile: args.answerFile,
          type: args.type,
          nodes: args.nodes,
          outcome: args.outcome,
          correction: args.correction,
        })

        const result = await exec($, cmd, graphRoot)
        if (result.exitCode !== 0) {
          throw new Error(`save-result failed: ${result.stderr || result.stdout || "(no output)"}`)
        }

        return {
          title: `Saved result @ ${basename(graphRoot)}`,
          output: result.stdout.trim() || `Recorded query outcome at ${graphRoot}.`,
          metadata: { repo: graphRoot, outcome: args.outcome ?? null },
        }
      },
    }),
  }

  // ── Hooks ─────────────────────────────────────────────────────────────

  const hooks: Hooks = {
    config: async (input) => {
      registerGraphifyAgent(input)
    },

    tool: wrapToolsWithDelegationGuard(tools, config.enforceDelegation),

    "experimental.chat.system.transform": async (_input, output) => {
      refreshRoots()

      // Always-on orientation: when no graph exists yet but alwaysActive is set,
      // inject a short note so the agent knows graphify is available and how to
      // build a graph. When alwaysActive is false, stay silent until a graph
      // exists (the original behavior).
      if (graphRoots.size === 0) {
        if (!config.alwaysActive) return
        output.system.push(
          [
            "[Graphify available] No knowledge graph has been built for this project yet.",
            "Graphify provides token-efficient architecture, concept, and cross-file " +
              "navigation via a precomputed knowledge graph — prefer it over broad raw " +
              "grep/find sweeps for 'how does X work' / 'what depends on Y' questions.",
            "Build one to enable the graphify_* query tools:",
            "  - graphify_build: build the knowledge graph (run once, then graphify_update to refresh)",
            `Dedicated subagent: ${GRAPHIFY_AGENT_NAME} can run graphify commands/tools globally when this plugin is loaded.`,
            graphifyDelegationInstruction(),
          ].join("\n"),
        )
        return
      }

      const parts: string[] = [
        `[Graphify active] This project has ${graphRoots.size} knowledge graph(s).`,
      ]

      for (const [name, root] of graphRoots) {
        const reportPath = join(root, config.outputDir, "GRAPH_REPORT.md")
        const wikiPath = join(root, config.outputDir, "wiki", "index.md")
        const hasReport = existsSync(reportPath)
        const hasWiki = existsSync(wikiPath)
        const artifacts = ["graph.json", hasReport ? "GRAPH_REPORT.md" : "", hasWiki ? "wiki/" : ""]
          .filter(Boolean).join(", ")
        parts.push(`  - ${name}: ${artifacts}`)
      }

      parts.push("")
      parts.push("Use the graphify tools for architecture, concept, and cross-file questions:")
      parts.push("  - graphify_query: natural-language questions about the codebase")
      parts.push("  - graphify_path: shortest path between two concepts")
      parts.push("  - graphify_explain: explain a single node and its neighbors")
      parts.push("  - graphify_affected: impact analysis before refactoring")
      parts.push("  - graphify_update: re-sync the graph after code changes (free, no LLM)")
      parts.push("  - graphify_add: ingest a URL (paper/page/PDF) into the graph")
      parts.push("  - graphify_diagnose: check same-endpoint edge-collapse / graph-detail risk")
      parts.push("  - graphify_export: export visual/structured artifacts (callflow-html, tree, html, obsidian, wiki, svg, graphml, neo4j, falkordb)")
      parts.push("  - graphify_benchmark: measure token reduction vs a naive full-corpus read")
      parts.push("")
      parts.push(
        `Dedicated subagent: ${GRAPHIFY_AGENT_NAME} - delegate graphify command execution ` +
          "and graph traversal to it when a focused graph worker is useful.",
      )
      parts.push(graphifyDelegationInstruction())
      parts.push("")
      parts.push(
        "After a graph query, record the outcome with graphify_save_result so future " +
          "sessions learn which traversals work (the reflect loop, graphify >= 0.9.2): " +
          "pass the question, the answer (or answerFile for long answers), the node LABELs " +
          "you used, and an outcome of useful | dead_end | corrected (add correction when " +
          "the answer was wrong). Worth doing for non-trivial or surprising findings.",
      )
      parts.push("")
      parts.push(
        "Note: graphify node IDs are full-repo-path-based and NON-persistent across rebuilds — " +
        "reference nodes by LABEL (not by a stored node ID) in queries and in graphify_save_result.",
      )

      for (const [name, root] of graphRoots) {
        const reportPath = join(root, config.outputDir, "GRAPH_REPORT.md")
        const snippet = readBounded(reportPath, config.reportMaxChars)
        if (snippet) {
          const truncated = snippet.length > 800 ? snippet.slice(0, 800) + "…" : snippet
          parts.push(`\n[${name}] Report summary:\n${truncated}`)
          break
        }
      }

      for (const [name, root] of graphRoots) {
        const wikiPath = join(root, config.outputDir, "wiki", "index.md")
        const snippet = readBounded(wikiPath, 400)
        if (snippet) {
          parts.push(`\n[${name}] Wiki:\n${snippet}`)
          break
        }
      }

      output.system.push(parts.join("\n"))
    },

    "tool.execute.after": async (input, output) => {
      if (graphRoots.size === 0) return
      if (augmentHits >= config.maxSessionAugments) return

      const relevantTools = ["shell", "bash", "read", "grep", "find"]
      if (!relevantTools.some((t) => input.tool.includes(t))) return

      const outputLines = output.output.split("\n").length
      if (outputLines < 8) return

      const cacheKey = `${input.tool}:${JSON.stringify(input.args).slice(0, 200)}`.toLowerCase()
      if (augmentedCache.has(cacheKey)) return

      const architecturePatterns = [
        "architecture", "layer", "component", "module", "subsystem",
        "pipeline", "community", "cluster", "relate", "connect",
        "depends", "touches", "impact", "cross-file", "system",
        "graph", "graphify", "knowledge graph",
      ]
      const combined = `${output.output} ${JSON.stringify(input.args)}`.toLowerCase()
      const hasArchPattern = architecturePatterns.some((p) => combined.includes(p))
      const isLargeResult = outputLines >= 20

      if (!hasArchPattern && !isLargeResult) return

      augmentedCache.add(cacheKey)
      augmentHits++

      const rootsList = Array.from(graphRoots.keys()).join(", ")
      output.output += [
        "",
        "---",
        `[Graphify] This result spans multiple files/concepts. For architecture context, use:`,
        `  graphify_query({ question: "How do these files relate in the system?" })`,
        `Available graph roots: ${rootsList}`,
        "---",
      ].join("\n")
    },

    "tool.execute.before": async (input, output) => {
      // FAIL-OPEN (spec B-R2): this hook is advisory only. It must NEVER throw,
      // block, or alter exit behavior — only optionally prepend a non-fatal
      // `echo … &&` tip that preserves the user's actual command. Any internal
      // error is swallowed so the command always runs unchanged.
      //
      // When enforceDelegation is true, this hook is a NO-OP for tip injection.
      // The hook's input has no `agent` field, so it cannot distinguish the
      // primary agent from the `graphify` subagent. Prepending "Delegation
      // enforced" to the subagent's own shell commands confuses it (it treats
      // the stderr line as an error/external injection and aborts). Structural
      // enforcement is handled by the execute-time guard on native graphify_*
      // tools; the system prompt handles the rest. Advisory tips are only
      // emitted when enforcement is off (the original pre-enforcement behavior).
      try {
        if (config.enforceDelegation) return
        if (input.tool !== "shell" && input.tool !== "bash") return
        if (!output.args?.command) return
        const cmd = typeof output.args.command === "string" ? output.args.command : ""
        if (!cmd) return

        // Branch 1 — command already uses graphify: keep the v1 "use native
        // tools for better integration" tip (advisory only, enforcement off).
        if (cmd.includes("graphify")) {
          if (cmd.match(/^\s*graphify\s+(query|path|explain|affected|build|extract|update|add)\s/)) {
            output.args.command =
              'echo "[graphify plugin] Tip: use the native graphify_* tools instead of CLI for better integration." >&2 && ' +
              cmd
          }
          return
        }

        // Branch 2 — broad raw search while a graph exists: nudge toward the
        // graphify_* tools (contract C3). Stronger wording under forceGraphFirst.
        if (shouldNudgeGraphFirst(cmd, graphRoots.size)) {
          const tip = config.forceGraphFirst
            ? "[graphify plugin] Graph-first is enabled: prefer graphify_query/graphify_explain over raw search for architecture, concept, and cross-file questions."
            : "[graphify plugin] Tip: for architecture/concept/cross-file questions, graphify_query or graphify_explain is usually faster and more accurate than a raw search."
          output.args.command = `echo ${shellQuote(tip)} >&2 && ${cmd}`
        }
      } catch {
        // fail-open: never block or alter the command on error
      }
    },
  }

  return hooks
}

export default {
  id: "graphify",
  server: GraphifyPlugin,
}
