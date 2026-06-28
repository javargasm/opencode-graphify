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
import type { PluginInput, Hooks, PluginOptions } from "@opencode-ai/plugin"

import { resolveConfig } from "./config"
import { discoverGraphRoots, resolveGraphRoot, readBounded, listGraphRootsDescription, readGraphStats, readCommunityCount, GRAPH_FILE } from "./discovery"
import { exec, shellQuote, ensureGitignore, validateBackend } from "./shell"

const z = tool.schema

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
 * Build the visual-export command (T-CS3-3 / C-T1). `tree` is a SEPARATE
 * top-level command (`graphify tree`); everything else (default + unknown)
 * maps to `graphify export callflow-html`. There are no --obsidian/--svg flags
 * in graphify, so they are never emitted.
 */
export function buildExportCommand(format?: "callflow-html" | "tree"): string {
  return format === "tree" ? "graphify tree" : "graphify export callflow-html"
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

        return {
          title: installed ? `graphify v${version}` : "graphify not installed",
          output: [
            `Installed: ${installed ? "yes" : "no"}`,
            `Version: ${version}`,
            rootsDesc,
            targetInfo,
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
        "Export a visual HTML artifact from the knowledge graph. `callflow-html` emits a " +
        "Mermaid-based architecture/call-flow HTML; `tree` emits a collapsible D3 tree HTML. " +
        "Writes into graphify-out/. Multi-repo: pass `path` to target a specific repo.",
      args: {
        path: z.string().optional().describe("Repo directory or name to export from"),
        format: z.enum(["callflow-html", "tree"]).optional().describe(
          "Export format: callflow-html (default) or tree"
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
  }

  // ── Hooks ─────────────────────────────────────────────────────────────

  const hooks: Hooks = {
    tool: tools,

    "experimental.chat.system.transform": async (_input, output) => {
      refreshRoots()
      if (graphRoots.size === 0) return

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
      parts.push("")
      parts.push(
        "Note: graphify node IDs are full-repo-path-based and NON-persistent across rebuilds — " +
        "reference nodes by LABEL (not by a stored node ID) in queries.",
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
      try {
        if (input.tool !== "shell" && input.tool !== "bash") return
        if (!output.args?.command) return
        const cmd = typeof output.args.command === "string" ? output.args.command : ""
        if (!cmd) return

        // Branch 1 — command already uses graphify: keep the v1 "use native
        // tools for better integration" tip.
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
