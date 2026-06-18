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
import { discoverGraphRoots, resolveGraphRoot, readBounded, listGraphRootsDescription, GRAPH_FILE } from "./discovery"
import { exec, shellQuote, ensureGitignore } from "./shell"

const z = tool.schema

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
          "LLM backend: gemini, claude, openai, deepseek, ollama, bedrock, kimi, claude-cli"
        ),
        no_viz: z.boolean().optional().describe("Skip HTML visualization generation"),
        obsidian: z.boolean().optional().describe("Generate Obsidian vault"),
        svg: z.boolean().optional().describe("Export graph.svg"),
      },
      async execute(args, ctx) {
        const targetDir = args.path ? resolve(directory, args.path) : directory
        const backend = args.backend ?? config.semanticBackend
        const gitignoreUpdated = ensureGitignore(targetDir)

        const extractCmd = `graphify extract ${shellQuote(targetDir)} --backend ${backend}`
        const extractResult = await exec($, extractCmd, targetDir)
        if (extractResult.exitCode !== 0) {
          throw new Error(`graphify extract failed: ${extractResult.stderr || extractResult.stdout}`)
        }

        const vizFlag = args.no_viz ? " --no-viz" : ""
        const clusterCmd = `graphify cluster-only ${shellQuote(targetDir)}${vizFlag}`
        const clusterResult = await exec($, clusterCmd, targetDir)

        const stdout = extractResult.stdout
        const match = stdout.match(
          /(\d[\d,]*)\s+nodes?,\s*(\d[\d,]*)\s+edges?,\s*(\d[\d,]*)\s+communities/i
        )
        const nodes = match ? parseInt(match[1].replace(/,/g, ""), 10) : 0
        const edges = match ? parseInt(match[2].replace(/,/g, ""), 10) : 0
        const communities = match ? parseInt(match[3].replace(/,/g, ""), 10) : 0

        refreshRoots()

        return {
          title: `Graph built: ${nodes} nodes, ${edges} edges, ${communities} communities`,
          output: [
            `Graph built successfully at ${targetDir}:`,
            `  Nodes: ${nodes}`,
            `  Edges: ${edges}`,
            `  Communities: ${communities}`,
            `  Output: ${config.outputDir}/`,
            gitignoreUpdated ? "  .gitignore updated for graphify artifacts." : "",
            clusterResult.exitCode !== 0 ? `\nWarning: report generation had issues: ${clusterResult.stderr}` : "",
            extractResult.stdout,
          ].filter(Boolean).join("\n"),
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

        const nodeMatch = result.stdout.match(/(\d[\d,]*)\s+nodes?/i)
        const edgeMatch = result.stdout.match(/(\d[\d,]*)\s+edges?/i)
        const filesMatch = result.stdout.match(/(\d+)\s+(?:files?|re-extracted)/i)

        const nodes = nodeMatch ? parseInt(nodeMatch[1].replace(/,/g, ""), 10) : 0
        const edges = edgeMatch ? parseInt(edgeMatch[1].replace(/,/g, ""), 10) : 0
        const files = filesMatch ? parseInt(filesMatch[1], 10) : 0

        refreshRoots()

        return {
          title: `Updated: ${files} files, ${nodes} nodes @ ${basename(graphRoot)}`,
          output: [
            `Graph updated at ${graphRoot}:`,
            `  Re-extracted files: ${files}`,
            `  Current nodes: ${nodes}`,
            `  Current edges: ${edges}`,
            result.stdout.trim(),
          ].join("\n"),
          metadata: { repo: graphRoot, files, nodes, edges },
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

        let cmd = `graphify add ${shellQuote(args.url)}`
        if (args.author) cmd += ` --author ${shellQuote(args.author)}`
        if (args.contributor) cmd += ` --contributor ${shellQuote(args.contributor)}`

        const addResult = await exec($, cmd, graphRoot)
        if (addResult.exitCode !== 0) {
          throw new Error(`Failed to add URL: ${addResult.stderr || addResult.stdout}`)
        }

        const updateResult = await exec($, `graphify update ${shellQuote(graphRoot)}`, graphRoot)

        return {
          title: `Added ${args.url}`,
          output: [
            `Added ${args.url} to corpus at ${graphRoot}.`,
            addResult.stdout.trim(),
            updateResult.exitCode === 0
              ? `Graph updated: ${updateResult.stdout.trim()}`
              : `Warning: graph update had issues: ${updateResult.stderr}`,
          ].join("\n"),
          metadata: { url: args.url, repo: graphRoot },
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
      if (input.tool !== "shell" && input.tool !== "bash") return
      if (!output.args?.command) return

      const cmd = typeof output.args.command === "string" ? output.args.command : ""
      if (!cmd.includes("graphify")) return

      if (cmd.match(/^\s*graphify\s+(query|path|explain|affected|build|extract|update|add)\s/)) {
        output.args.command =
          'echo "[graphify plugin] Tip: use the native graphify_* tools instead of CLI for better integration." && ' +
          cmd
      }
    },
  }

  return hooks
}

export default {
  id: "graphify",
  server: GraphifyPlugin,
}
