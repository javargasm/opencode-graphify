# @javargasm/opencode-graphify

Knowledge graph plugin for [OpenCode](https://opencode.ai). Wraps the [graphify](https://github.com/safishamsi/graphify) CLI as 12 native tools so the agent can build, query, and navigate a persistent knowledge graph of your codebase — with community detection, god nodes, and cross-file relationships.

## Features

- **12 native tools** — `graphify_status`, `graphify_build`, `graphify_query`, `graphify_path`, `graphify_explain`, `graphify_affected`, `graphify_update`, `graphify_add`, `graphify_diagnose`, `graphify_export`, `graphify_benchmark`, `graphify_save_result`
- **Unified `/graphify` TUI command** — opens a modal menu with all 13 operations (status, build, query, update, explain, affected, path, export, add URL, diagnose, benchmark, save result, toggle panel). Graph operations are skill/subagent-guided: the menu prompt asks the session to use the graphify skill and delegate to the dedicated `graphify` subagent, which then prefers the native `graphify_*` tools
- **Live sidebar panel** — auto-discovers `graphify-out/graph.json` in the project root and immediate subdirectories; shows graph root, size, age, and staleness with native `▼`/`▶` chevrons and folder icons
- **Always-on orientation** — injects a short graphify note into the system prompt in *every* repo, even before a graph exists, so the agent knows it's available and how to build one (toggle with `alwaysActive`)
- **Global `graphify` subagent** — registers a `graphify` subagent that can run graphify commands and native `graphify_*` tools in any project where the plugin is loaded
- **Fail-open nudge** — when a graph exists and the agent runs a broad raw `grep`/`rg`/`find`/`cat` sweep, a non-blocking tip steers it toward `graphify_query`/`graphify_explain`. It never blocks or fails the command
- **Tool result augmentation** — suggests graphify queries for large, architecture-related shell/read results
- **graphify 0.9.5 aware** — reads node/edge counts straight from `graph.json` (`links`/`edges` + `built_at_commit`), reminds the agent that node IDs are path-based and non-persistent (query by label), and strips graphify's stderr version-skew warnings from tool output. The TUI export command supports all 9 formats (callflow-html, tree, html, obsidian, wiki, svg, graphml, neo4j, falkordb)
- **Reflect loop** — `graphify_save_result` records a query's outcome (`useful`/`dead_end`/`corrected`) into graphify's memory, with `answer` or `answerFile` for long answers (graphify ≥ 0.9.2). Accessible from the unified `/graphify` TUI menu
- **`.gitignore` management** — auto-adds `graphify-out/` and cleans up legacy entries
- **Hardened** — the `--backend` value is enum-validated and shell-quoted before execution (no shell injection)

## Installation

### From npm (recommended)

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@javargasm/opencode-graphify"
  ]
}
```

OpenCode will auto-install the package on startup. You can also install via CLI:

```bash
opencode plugin @javargasm/opencode-graphify
```

### From local source

1. Clone the repository:

```bash
git clone https://github.com/javargasm/opencode-graphify.git
cd opencode-graphify
```

2. Install dependencies:

```bash
bun install
```

3. Register the plugin in your `opencode.json` using the absolute path to the entry point:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/absolute/path/to/opencode-graphify/src/index.ts"
  ]
}
```

### Always active in every repo (global)

Registering the plugin in a project's `opencode.json` only loads it for that project. To make graphify available in **every** repo you open with OpenCode, register it once in your **global** config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@javargasm/opencode-graphify"
  ]
}
```

With the global registration in place, the plugin's `alwaysActive` option (default `true`) ensures the agent is told graphify is available in every repo — **even repos that don't have a graph yet** — along with how to build one. This only injects a short orientation note into the system prompt; it does **not** build a graph or spend any LLM tokens automatically. Build a graph yourself with `graphify_build` (or the Build option in the `/graphify` TUI menu) when you want one.

The plugin also registers a global `graphify` subagent. Use it when you want a focused worker to run graphify commands, query/path/explain traversals, updates, exports, diagnostics, benchmarks, or `graphify_save_result` without mixing that work into the main conversation. OpenCode loads plugin config at startup, so restart OpenCode after installing or updating this plugin to see the subagent.

## Configuration

Pass options as a tuple in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@javargasm/opencode-graphify", {
      "semanticBackend": "auto",
      "alwaysActive": true,
      "forceGraphFirst": false,
      "reportMaxChars": 6000,
      "maxSessionAugments": 8
    }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `semanticBackend` | `"auto"` | LLM backend for `graphify_build`. `"auto"` (or empty) omits `--backend` so the CLI auto-detects from your configured API key. Explicit values are validated against `gemini`, `kimi`, `claude`, `openai`, `deepseek`, `ollama`, `bedrock`, `claude-cli`. |
| `alwaysActive` | `true` | Inject the graphify orientation note in every repo, even before a graph exists. Set `false` to stay silent until a graph is built. |
| `forceGraphFirst` | `false` | Strengthen the fail-open nudge wording when the agent runs raw `grep`/`find`/`cat` searches. Still never blocks the command. |
| `apiTimeout` | _(unset)_ | Positive integer seconds passed to `graphify extract` as `--api-timeout <n>`. Omitted when unset. |
| `outputDir` | `"graphify-out"` | Output directory name. |
| `reportMaxChars` | `6000` | Max chars to read from `GRAPH_REPORT.md` for system-prompt context. |
| `maxSessionAugments` | `8` | Max tool-result augmentations per session. |

To opt out of the always-on note (only orient once a graph exists), set `alwaysActive` to `false`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@javargasm/opencode-graphify", { "alwaysActive": false }]
  ]
}
```

## Prerequisites

Install the graphify CLI:

```bash
pip install graphifyy
```

## Usage

Once the plugin is loaded, the agent gains access to 12 native `graphify_*` tools and the `/graphify` TUI menu.

### Building a graph

Run `graphify_build` from the agent, or open the `/graphify` menu in the TUI and select **Build**. The plugin auto-discovers `graphify-out/graph.json` in the project root and immediate subdirectories.

### Querying the graph

Ask the agent any architecture, dependency, or cross-file question. When a graph exists, the plugin nudges the agent toward `graphify_query` / `graphify_explain` instead of raw `grep`/`find` sweeps.

### TUI sidebar

The sidebar panel shows live graph status with native chevrons and folder icons:

```
▼ Graphify (1)  OK
  📁 opencode-graphify
    117 KB · 10m ago
```

Stale graphs (where `built_at_commit` differs from `git HEAD`) are marked with `⚠`.

### TUI menu

Type `/graphify` to open the modal menu with all 13 operations. Graph operations are skill/subagent-guided: the menu prompt asks the session to use the graphify skill and delegate to the dedicated `graphify` subagent.

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- TypeScript ≥ 5.0
- [graphify](https://github.com/safishamsi/graphify) CLI (`pip install graphifyy`)

### Commands

```bash
# Install dependencies
bun install

# Type-check
bun run typecheck

# Run tests
bun test

# Run tests in watch mode
bun test --watch
```

### Project Structure

```
src/
├── index.ts        # Plugin entry: tools, hooks, subagent registration, system-prompt orientation
├── config.ts       # Plugin configuration resolver (GraphifyConfig + defaults)
├── discovery.ts    # Graph root discovery, stat parsing, formatAge/formatSize, staleness check
├── shell.ts        # Shell exec helper, shell quoting, gitignore management, backend validation
└── tui.tsx         # TUI plugin: unified /graphify menu, sidebar panel, toast notifications
test/
├── config.test.ts      # Configuration resolver tests
├── discovery.test.ts   # Graph discovery and formatting tests
├── plugin.test.ts      # Plugin tools, hooks, and agent registration tests
├── shell.test.ts       # Shell helpers and validation tests
└── tui.test.ts         # TUI menu, sidebar, and rendering tests
```

### Release

Patch/minor releases are tagged with `vX.Y.Z`. Pushing a tag triggers `.github/workflows/release.yml`, which runs type-check, tests, builds the package, and publishes to npm with provenance through npm trusted publishing.

Required npm setup:

- Configure npm trusted publishing for `@javargasm/opencode-graphify` and allow the GitHub workflow `.github/workflows/release.yml`

Release commands:

```bash
bun run typecheck
bun run test
bun run build
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   OpenCode   │────▶│  opencode-graphify  │────▶│  graphify CLI    │
│   Agent      │     │  (plugin)           │     │  (Python)        │
│              │     │                     │     │                  │
│  graphify_*  │◀────│  12 native tools    │◀────│  graph.json      │
│  tools       │     │  + TUI + subagent   │     │  GRAPH_REPORT.md │
└──────────────┘     └─────────────────────┘     └──────────────────┘
                            │
                            │ Injects:
                            │ • System-prompt orientation (alwaysActive)
                            │ • Fail-open nudge on raw grep/find
                            │ • Tool-result augmentation
                            │ • graphify subagent registration
                            ▼
                     ┌─────────────┐
                     │  TUI        │
                     │  /graphify  │
                     │  sidebar    │
                     │  toasts     │
                     └─────────────┘
```

The plugin wraps the graphify CLI as 12 native OpenCode tools. The server plugin (`src/index.ts`) handles tool registration, system-prompt hooks, and the `graphify` subagent. The TUI plugin (`src/tui.tsx`) provides the unified `/graphify` menu, sidebar panel, and toast notifications.

## License

MIT
