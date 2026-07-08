// @ts-nocheck
/** @jsxImportSource @opentui/solid */

/**
 * opencode-graphify TUI plugin
 *
 * Adds graphify features to the OpenCode terminal UI:
 * 1. Single `/graphify` command — opens a modal menu with all operations
 * 2. Sidebar — live graph root status panel
 * 3. Toasts — notifications on tool completion
 */

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { execSync } from "child_process"
import {
  discoverGraphRootInfos,
  formatAge,
  formatSize,
  isStale,
  readGraphStats,
  type GraphRootInfo,
} from "./discovery"


const GRAPHIFY_TOOLS = new Set([
  "graphify_status", "graphify_build", "graphify_query", "graphify_path",
  "graphify_explain", "graphify_affected", "graphify_update", "graphify_add",
  "graphify_export", "graphify_diagnose", "graphify_benchmark",
  "graphify_save_result",
])

const TOOL_LABELS: Record<string, string> = {
  graphify_status: "Status check",
  graphify_build: "Graph built",
  graphify_query: "Query complete",
  graphify_path: "Path found",
  graphify_explain: "Explanation ready",
  graphify_affected: "Impact analysis done",
  graphify_update: "Graph updated",
  graphify_add: "URL added",
  graphify_export: "Visualization exported",
  graphify_diagnose: "Diagnostics ready",
  graphify_benchmark: "Benchmark complete",
  graphify_save_result: "Result saved",
}

const EXPORT_FORMATS_LIST = [
  "callflow-html", "tree", "html", "obsidian", "wiki",
  "svg", "graphml", "neo4j", "falkordb",
]

function readHeadCommit(dir: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null
  } catch {
    return null
  }
}

function isRootStale(root: GraphRootInfo): boolean {
  try {
    const builtAtCommit = readGraphStats(root.path)?.builtAtCommit ?? null
    return isStale(builtAtCommit, readHeadCommit(root.path))
  } catch {
    return false
  }
}

function isGraphifyInstalled(): boolean {
  try {
    execSync("graphify --version", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

interface MenuOption {
  icon: string
  label: string
  desc: string
  requiresGraph: boolean
  requiresSession: boolean
  run: (api: TuiPluginApi, ctx: MenuCtx) => void
}

interface MenuCtx {
  directory: string
  roots: () => GraphRootInfo[]
  sessionID: () => string | null
  setCollapsed: (fn: (c: boolean) => boolean) => void
}

function sendPrompt(api: TuiPluginApi, sessionID: string, text: string, errMsg: string) {
  api.client.session.prompt({
    sessionID,
    parts: [{ type: "text", text }],
  }).catch((err: any) => {
    api.ui.toast({ variant: "error", message: errMsg.replace("{}", err.message || err) })
  })
}

function graphifySkillPrompt(operation: string, toolName: string, details: string) {
  return [
    "Use the graphify skill.",
    "Delegate this Graphify operation to the dedicated `graphify` subagent.",
    `The subagent should prefer the native ${toolName} tool when available.`,
    "",
    `Operation: ${operation}`,
    details,
  ].join("\n")
}

function openPrompt(
  api: TuiPluginApi,
  title: string,
  placeholder: string,
  onConfirm: (value: string) => void,
) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={title}
      placeholder={placeholder}
      onConfirm={onConfirm}
      onCancel={() => api.ui.dialog.clear()}
    />
  ))
}

const MENU_OPTIONS: MenuOption[] = [
  {
    icon: "📊",
    label: "Status",
    desc: "Check graph status across all repos",
    requiresGraph: false,
    requiresSession: false,
    run(api, ctx) {
      const rootList = ctx.roots()
      if (rootList.length === 0) {
        api.ui.toast({ variant: "warning", message: "No graphs detected. Build one first." })
        return
      }
      const lines = rootList.map((r) =>
        `· ${r.name} — ${formatSize(r.sizeMb, r.sizeBytes)} · ${formatAge(r.ageMinutes)}${isRootStale(r) ? " ⚠ stale" : ""}\n  ${r.path}`
      ).join("\n")
      api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
          title="🧩 Graphify Status"
          message={`${rootList.length} graph(s) found:\n\n${lines}`}
          onConfirm={() => api.ui.dialog.clear()}
        />
      ))
    },
  },
  {
    icon: "🔨",
    label: "Build",
    desc: "Build knowledge graph from a directory",
    requiresGraph: false,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) {
        api.ui.toast({ variant: "warning", message: "Open a session first." })
        return
      }
      openPrompt(api, "Build Knowledge Graph", "Directory path (leave empty for current)", (path) => {
        api.ui.dialog.clear()
        const targetPath = path.trim() || "."
        api.ui.toast({ variant: "info", message: `Building graph for: ${targetPath}...`, duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Build knowledge graph", "graphify_build", `Target path: ${targetPath}`), `Failed to start build: {}`)
      })
    },
  },
  {
    icon: "❓",
    label: "Query",
    desc: "Ask a question about the codebase",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Query Knowledge Graph", "How does the auth system work?", (question) => {
        api.ui.dialog.clear()
        const q = question.trim()
        if (!q) return
        api.ui.toast({ variant: "info", message: "Querying knowledge graph...", duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Query knowledge graph", "graphify_query", `Question: ${q}`), `Failed to start query: {}`)
      })
    },
  },
  {
    icon: "🔄",
    label: "Update",
    desc: "Re-sync graph after code changes (no LLM cost)",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      api.ui.toast({ variant: "info", message: "Updating knowledge graph...", duration: 4000 })
      sendPrompt(api, sessionID, graphifySkillPrompt("Update knowledge graph", "graphify_update", "Target path: current project"), `Failed to start update: {}`)
    },
  },
  {
    icon: "🔍",
    label: "Explain",
    desc: "Explain a node and its connections in the graph",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Explain Node", "Node label (e.g. UserService.create)", (node) => {
        api.ui.dialog.clear()
        const n = node.trim()
        if (!n) return
        api.ui.toast({ variant: "info", message: `Explaining: ${n}...`, duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Explain graph node", "graphify_explain", `Node label: ${n}`), `Failed to start explain: {}`)
      })
    },
  },
  {
    icon: "💥",
    label: "Affected",
    desc: "Find what depends on a node (impact radius)",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Impact Analysis", "Node label to assess", (node) => {
        api.ui.dialog.clear()
        const n = node.trim()
        if (!n) return
        api.ui.toast({ variant: "info", message: `Analyzing impact of: ${n}...`, duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Analyze affected nodes", "graphify_affected", `Node label: ${n}`), `Failed to start impact analysis: {}`)
      })
    },
  },
  {
    icon: "🛤️",
    label: "Path",
    desc: "Find the shortest path between two nodes",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Path Between Nodes", "from → to (e.g. UserService.create → Database.insert)", (value) => {
        api.ui.dialog.clear()
        const raw = value.trim()
        if (!raw) return
        const [from, to] = raw.split(/\s*(?:→|->|,)\s*/)
        if (!from || !to) {
          api.ui.toast({ variant: "warning", message: "Enter two nodes separated by → (e.g. A → B)." })
          return
        }
        api.ui.toast({ variant: "info", message: `Finding path: ${from} → ${to}...`, duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Find path between nodes", "graphify_path", `From: ${from}\nTo: ${to}`), `Failed to start path search: {}`)
      })
    },
  },
  {
    icon: "📤",
    label: "Export",
    desc: "Export visualization (callflow-html, tree, html, obsidian, wiki, svg, graphml, neo4j, falkordb)",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Export Visualization", "Format: callflow-html (default), tree, html, obsidian, wiki, svg, graphml, neo4j, falkordb", (format) => {
        api.ui.dialog.clear()
        const fmt = format.trim().toLowerCase()
        const valid = EXPORT_FORMATS_LIST.includes(fmt) ? fmt : "callflow-html"
        api.ui.toast({ variant: "info", message: `Exporting ${valid}...`, duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Export graph artifact", "graphify_export", `Format: ${valid}`), `Failed to start export: {}`)
      })
    },
  },
  {
    icon: "🌐",
    label: "Add URL",
    desc: "Fetch a URL (paper, PDF, page) and add it to the knowledge graph",
    requiresGraph: false,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Add URL to Graph", "URL to fetch (https://...)", (url) => {
        api.ui.dialog.clear()
        const u = url.trim()
        if (!u) return
        api.ui.toast({ variant: "info", message: "Adding URL to graph...", duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Add URL to graph corpus", "graphify_add", `URL: ${u}`), `Failed to add URL: {}`)
      })
    },
  },
  {
    icon: "🩺",
    label: "Diagnose",
    desc: "Check for edge-collapse risk and graph integrity issues",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      api.ui.toast({ variant: "info", message: "Running graph diagnostics...", duration: 4000 })
      sendPrompt(api, sessionID, graphifySkillPrompt("Diagnose graph integrity", "graphify_diagnose", "Target path: current project"), `Failed to start diagnose: {}`)
    },
  },
  {
    icon: "⚡",
    label: "Benchmark",
    desc: "Measure token reduction vs a naive full-corpus read",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      api.ui.toast({ variant: "info", message: "Running benchmark...", duration: 4000 })
      sendPrompt(api, sessionID, graphifySkillPrompt("Benchmark graph token reduction", "graphify_benchmark", "Target path: current project"), `Failed to start benchmark: {}`)
    },
  },
  {
    icon: "💾",
    label: "Save Result",
    desc: "Record a graph query outcome for the reflect feedback loop",
    requiresGraph: true,
    requiresSession: true,
    run(api, ctx) {
      const sessionID = ctx.sessionID()
      if (!sessionID) { api.ui.toast({ variant: "warning", message: "Open a session first." }); return }
      openPrompt(api, "Save Query Result", "Question that was asked (then describe the answer in the prompt)", (question) => {
        api.ui.dialog.clear()
        const q = question.trim()
        if (!q) return
        api.ui.toast({ variant: "info", message: "Saving query result...", duration: 4000 })
        sendPrompt(api, sessionID, graphifySkillPrompt("Save graph query result", "graphify_save_result", `Question: ${q}`), `Failed to save result: {}`)
      })
    },
  },
  {
    icon: "🔧",
    label: "Toggle Panel",
    desc: "Collapse or expand the Graphify sidebar panel",
    requiresGraph: false,
    requiresSession: false,
    run(_api, ctx) {
      ctx.setCollapsed((c) => !c)
    },
  },
]


const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  const [roots, setRoots] = createSignal<GraphRootInfo[]>(discoverGraphRootInfos(directory))
  const [collapsed, setCollapsed] = createSignal(false)
  const [installed] = createSignal(isGraphifyInstalled())

  const okColor = () => api.theme?.current?.success ?? "#3fb950"
  const warnColor = () => api.theme?.current?.warning ?? "#d29922"

  const getSessionID = () => {
    const current = api.route.current
    if (current.name === "session" && current.params?.sessionID) {
      return current.params.sessionID
    }
    return null
  }

  const ctx: MenuCtx = {
    directory,
    roots,
    sessionID: getSessionID,
    setCollapsed,
  }

  function openGraphifyMenu() {
    const hasGraph = roots().length > 0
    const options = MENU_OPTIONS.map((opt) => {
      const disabled = opt.requiresGraph && !hasGraph
      const title = `${opt.icon}  ${opt.label}`
      const description = `${opt.desc}${disabled ? " (needs graph)" : ""}`
      return {
        title,
        value: opt.label,
        description,
        disabled,
        onSelect: () => {
          api.ui.dialog.clear()
          opt.run(api, ctx)
        },
      }
    })

    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="🧩 Graphify"
        placeholder="Select an operation..."
        options={options}
        flat={true}
        skipFilter={false}
        onSelect={(option: any) => {
          if (option?.onSelect) option.onSelect()
        }}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "graphify.menu",
        title: "Graphify",
        desc: "Open the Graphify menu with all operations",
        category: "Graphify",
        slashName: "graphify",
        run() {
          openGraphifyMenu()
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("graphify", ["graphify.menu"]),
  })


  api.slots.register({
    order: 80,
    slots: {
      sidebar_content() {
        const rootList = roots()
        const count = rootList.length
        const arrow = collapsed() ? "▶" : "▼"
        const ok = installed()
        return (
          <box flexDirection="column">
            <box onMouseDown={() => setCollapsed((c) => !c)}>
              <text bold>
                <span>{`${arrow} Graphify${count > 0 ? ` (${count})` : ""}  `}</span>
                <span style={{ fg: ok ? okColor() : warnColor() }}>
                  {ok ? "OK" : "not installed"}
                </span>
              </text>
            </box>
            <Show when={!collapsed()}>
              <Show
                when={ok}
                fallback={<text dim>{"  CLI missing — pip install graphifyy"}</text>}
              >
                <Show
                  when={count > 0}
                  fallback={<text dim>{"  no graph — /graphify"}</text>}
                >
                  <For each={rootList}>
                    {(root) => (
                      <box flexDirection="column">
                        <text>{`  📁 ${root.name}${isRootStale(root) ? " ⚠" : ""}`}</text>
                        <text dim>{`    ${formatSize(root.sizeMb, root.sizeBytes)} · ${formatAge(root.ageMinutes)}`}</text>
                      </box>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </box>
        )
      },
    },
  })


  const offEvent = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (!part || part.type !== "tool") return
    if (!GRAPHIFY_TOOLS.has(part.tool)) return

    if (part.state?.status === "completed") {
      api.ui.toast({
        variant: "success",
        title: TOOL_LABELS[part.tool] ?? part.tool,
        message: part.state.title?.slice(0, 120) || "Done",
        duration: 4000,
      })
      if (part.tool === "graphify_build" || part.tool === "graphify_update" || part.tool === "graphify_export" || part.tool === "graphify_add") {
        setRoots(discoverGraphRootInfos(directory))
      }
    }

    if (part.state?.status === "error") {
      api.ui.toast({
        variant: "error",
        title: `${part.tool} failed`,
        message: part.state.error?.slice(0, 120) ?? "Unknown error",
        duration: 5000,
      })
    }
  })

  api.lifecycle.onDispose(() => offEvent())
}


const plugin = { id: "javargasm-graphify", tui }
export default plugin
