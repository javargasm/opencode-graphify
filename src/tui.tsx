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

// ── Discovery ───────────────────────────────────────────────────────────

const GRAPH_FILE = "graphify-out/graph.json"
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
  const fs = require("fs")
  const path = require("path")
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

// ── Constants ───────────────────────────────────────────────────────────

const GRAPHIFY_TOOLS = new Set([
  "graphify_status", "graphify_build", "graphify_query", "graphify_path",
  "graphify_explain", "graphify_affected", "graphify_update", "graphify_add",
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
}

const cmd = {
  status: "graphify.status",
  build: "graphify.build",
  query: "graphify.query",
  update: "graphify.update",
} as const

const allCommands = [cmd.status, cmd.build, cmd.query, cmd.update] as const

// ── TUI Plugin ──────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  const [roots, setRoots] = createSignal<GraphRoot[]>(discoverRoots(directory))

  const refreshInterval = setInterval(() => {
    setRoots(discoverRoots(directory))
  }, 30_000)

  api.lifecycle.onDispose(() => clearInterval(refreshInterval))

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
            `● ${r.name} — ${r.sizeMb} MB · ${formatAge(r.ageMinutes)}\n  ${r.path}`
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
    ],
    bindings: api.tuiConfig.keybinds.gather("graphify", allCommands),
  })

  // ── 2. Sidebar slot ─────────────────────────────────────────────────

  api.slots.register({
    order: 80,
    slots: {
      sidebar_content() {
        return (
          <box flexDirection="column" paddingLeft={1}>
            <text bold>{"🧩 Graphify"}</text>
            <Show
              when={roots().length > 0}
              fallback={<text>{"  No graphs detected"}</text>}
            >
              <For each={roots()}>
                {(root) => (
                  <text>{`  ● ${root.name} · ${root.sizeMb} MB · ${formatAge(root.ageMinutes)}`}</text>
                )}
              </For>
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
      if (part.tool === "graphify_build" || part.tool === "graphify_update") {
        setRoots(discoverRoots(directory))
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
