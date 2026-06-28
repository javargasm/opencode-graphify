// @ts-nocheck
/** @jsxImportSource @opentui/solid */

/**
 * opencode-graphify TUI plugin
 *
 * Adds graphify features to the OpenCode terminal UI:
 * 1. Command palette — keymap commands with slash names
 * 2. Sidebar — live graph root status panel
 * 3. Toasts — notifications on tool completion
 */

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { execSync } from "child_process"
import {
  discoverGraphRootInfos,
  formatAge,
  formatSize,
  isStale,
  readGraphStats,
  type GraphRootInfo,
} from "./discovery"

// ── Constants ───────────────────────────────────────────────────────────

const GRAPHIFY_TOOLS = new Set([
  "graphify_status", "graphify_build", "graphify_query", "graphify_path",
  "graphify_explain", "graphify_affected", "graphify_update", "graphify_add",
  "graphify_export", "graphify_diagnose", "graphify_benchmark",
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
}

const cmd = {
  status: "graphify.status",
  build: "graphify.build",
  query: "graphify.query",
  update: "graphify.update",
  explain: "graphify.explain",
  affected: "graphify.affected",
  path: "graphify.path",
  export: "graphify.export",
  toggle: "graphify.toggle",
} as const

const allCommands = [
  cmd.status, cmd.build, cmd.query, cmd.update,
  cmd.explain, cmd.affected, cmd.path, cmd.export, cmd.toggle,
] as const

/**
 * Read the current git HEAD commit for a directory (TU-2 staleness).
 * Synchronous + defensive: any failure (non-git dir, missing git) -> null.
 */
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

/**
 * Whether a graph root is stale: its recorded built_at_commit differs from the
 * directory's current HEAD. Never throws — any git/stat failure -> not stale.
 */
function isRootStale(root: GraphRootInfo): boolean {
  try {
    const builtAtCommit = readGraphStats(root.path)?.builtAtCommit ?? null
    return isStale(builtAtCommit, readHeadCommit(root.path))
  } catch {
    return false
  }
}

/**
 * Whether the `graphify` CLI is installed and runnable. Synchronous +
 * defensive: any failure (binary missing) -> false. Probed once at plugin
 * startup; the version warning graphify prints to stderr is ignored.
 */
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

// ── TUI Plugin ──────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  const [roots, setRoots] = createSignal<GraphRootInfo[]>(discoverGraphRootInfos(directory))

  // Sidebar panel collapse state (▼ expanded / ▶ collapsed). Collapsed shows a
  // one-line summary so the panel takes minimal vertical space.
  const [collapsed, setCollapsed] = createSignal(false)

  // Whether the graphify CLI is installed — probed once at startup. Drives the
  // green "OK" / yellow "not installed" badge in the panel header.
  const [installed] = createSignal(isGraphifyInstalled())

  // Theme colors for the status badge (fall back to hex if theme unavailable).
  const okColor = () => api.theme?.current?.success ?? "#3fb950"
  const warnColor = () => api.theme?.current?.warning ?? "#d29922"

  // Refresh is event-driven (message.part.updated on build/update/export
  // completion) plus the initial discovery above — no periodic polling (TU-4).

  const getSessionID = () => {
    const current = api.route.current
    if (current.name === "session" && current.params?.sessionID) {
      return current.params.sessionID
    }
    return null
  }

  // ── 1. Commands via keymap.registerLayer ─────────────────────────────

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: cmd.status,
        title: "Graphify status",
        desc: "Check graph status across all repos",
        category: "Graphify",
        slashName: "graphify-status",
        run() {
          const rootList = roots()
          if (rootList.length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs detected. Use /graphify-build first." })
            return
          }

          const lines = rootList.map((r) =>
            `· ${r.name} — ${formatSize(r.sizeMb, r.sizeBytes)} · ${formatAge(r.ageMinutes)}${isRootStale(r) ? " ⚠ stale" : ""}\n  ${r.path}`
          ).join("\n")

          api.ui.dialog.replace(() => (
            <api.ui.Dialog size="medium" onClose={() => api.ui.dialog.clear()}>
              <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
                <text bold>{"🧩 Graphify Status"}</text>
                <text>{`${rootList.length} graph(s) found:\n\n${lines}`}</text>
              </box>
            </api.ui.Dialog>
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.build,
        title: "Build knowledge graph",
        desc: "Build graphify knowledge graph from a directory",
        category: "Graphify",
        slashName: "graphify-build",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }

          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Build Knowledge Graph"
              placeholder="Directory path (leave empty for current)"
              onConfirm={(path: string) => {
                api.ui.dialog.clear()
                const targetPath = path.trim() || "."
                api.ui.toast({
                  variant: "info",
                  message: `Building graph for: ${targetPath}...`,
                  duration: 4000,
                })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_build tool on: ${targetPath}`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start build: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.query,
        title: "Query knowledge graph",
        desc: "Ask a question about the codebase",
        category: "Graphify",
        slashName: "graphify-query",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Query Knowledge Graph"
              placeholder="How does the auth system work?"
              onConfirm={(question: string) => {
                api.ui.dialog.clear()
                const q = question.trim()
                if (!q) return
                api.ui.toast({
                  variant: "info",
                  message: "Querying knowledge graph...",
                  duration: 4000,
                })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_query tool to answer: ${q}`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start query: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.update,
        title: "Update knowledge graph",
        desc: "Re-sync graph after code changes (no LLM cost)",
        category: "Graphify",
        slashName: "graphify-update",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.toast({
            variant: "info",
            message: "Updating knowledge graph...",
            duration: 4000,
          })
          api.client.session.prompt({
            sessionID,
            parts: [
              {
                type: "text",
                text: "Use the graphify_update tool to update the knowledge graph.",
              },
            ],
          }).catch((err) => {
            api.ui.toast({
              variant: "error",
              message: `Failed to start update: ${err.message || err}`,
            })
          })
        },
      },
      {
        namespace: "palette",
        name: cmd.explain,
        title: "Explain a node",
        desc: "Explain a node and its connections in the graph",
        category: "Graphify",
        slashName: "graphify-explain",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Explain Node"
              placeholder="Node label (e.g. UserService.create)"
              onConfirm={(node: string) => {
                api.ui.dialog.clear()
                const n = node.trim()
                if (!n) return
                api.ui.toast({ variant: "info", message: `Explaining: ${n}...`, duration: 4000 })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_explain tool to explain: ${n}`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start explain: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.affected,
        title: "Impact of a node",
        desc: "Find what depends on a node (impact radius)",
        category: "Graphify",
        slashName: "graphify-affected",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Impact Analysis"
              placeholder="Node label to assess"
              onConfirm={(node: string) => {
                api.ui.dialog.clear()
                const n = node.trim()
                if (!n) return
                api.ui.toast({ variant: "info", message: `Analyzing impact of: ${n}...`, duration: 4000 })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_affected tool to assess the impact of: ${n}`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start impact analysis: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.path,
        title: "Path between nodes",
        desc: "Find the shortest path between two nodes",
        category: "Graphify",
        slashName: "graphify-path",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Path Between Nodes"
              placeholder="from → to (e.g. UserService.create → Database.insert)"
              onConfirm={(value: string) => {
                api.ui.dialog.clear()
                const raw = value.trim()
                if (!raw) return
                const [from, to] = raw.split(/\s*(?:→|->|,)\s*/)
                if (!from || !to) {
                  api.ui.toast({
                    variant: "warning",
                    message: "Enter two nodes separated by → (e.g. A → B).",
                  })
                  return
                }
                api.ui.toast({ variant: "info", message: `Finding path: ${from} → ${to}...`, duration: 4000 })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_path tool to find the path from "${from}" to "${to}".`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start path search: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.export,
        title: "Export visualization",
        desc: "Export an interactive HTML visualization of the graph",
        category: "Graphify",
        slashName: "graphify-export",
        run() {
          const sessionID = getSessionID()
          if (!sessionID) {
            api.ui.toast({ variant: "warning", message: "Please open a session first to run this command." })
            return
          }
          if (roots().length === 0) {
            api.ui.toast({ variant: "warning", message: "No graphs found. Use /graphify-build first." })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Export Visualization"
              placeholder="Format: callflow-html (default) or tree"
              onConfirm={(format: string) => {
                api.ui.dialog.clear()
                const fmt = format.trim() === "tree" ? "tree" : "callflow-html"
                api.ui.toast({ variant: "info", message: `Exporting ${fmt}...`, duration: 4000 })
                api.client.session.prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: `Use the graphify_export tool with format: ${fmt}`,
                    },
                  ],
                }).catch((err) => {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to start export: ${err.message || err}`,
                  })
                })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        namespace: "palette",
        name: cmd.toggle,
        title: "Toggle Graphify panel",
        desc: "Collapse or expand the Graphify sidebar panel",
        category: "Graphify",
        slashName: "graphify-toggle",
        run() {
          setCollapsed((c) => !c)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("graphify", allCommands),
  })

  // ── 2. Sidebar slot ─────────────────────────────────────────────────

  api.slots.register({
    order: 80,
    slots: {
      sidebar_content() {
        const rootList = roots()
        const count = rootList.length
        const arrow = collapsed() ? "▸" : "▾"
        const ok = installed()
        return (
          <box flexDirection="column" paddingLeft={1}>
            {/* Clickable header: toggles collapse on click (like the host's
                MCP/sidebar sections). Status badge is green OK when the
                graphify CLI is installed, yellow when it is not. */}
            <box onMouseDown={() => setCollapsed((c) => !c)}>
              <text bold>
                <span>{`${arrow} 🧩 Graphify${count > 0 ? ` (${count})` : ""}  `}</span>
                <span fg={ok ? okColor() : warnColor()}>
                  {ok ? "OK" : "not installed"}
                </span>
              </text>
            </box>
            <Show when={!collapsed()}>
              <Show
                when={ok}
                fallback={
                  <text dim>{"  CLI missing — pip install graphifyy"}</text>
                }
              >
                <Show
                  when={count > 0}
                  fallback={<text dim>{"  no graph — /graphify-build"}</text>}
                >
                  <For each={rootList}>
                    {(root) => (
                      <text>{`  · ${root.name}  ${formatSize(root.sizeMb, root.sizeBytes)} · ${formatAge(root.ageMinutes)}${isRootStale(root) ? " ⚠" : ""}`}</text>
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

  // ── 3. Toast on tool completion ─────────────────────────────────────

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
      if (part.tool === "graphify_build" || part.tool === "graphify_update" || part.tool === "graphify_export") {
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

// ── Export ─────────────────────────────────────────────────────────────

const plugin = { id: "graphify", tui }
export default plugin
