# opencode-graphify

OpenCode plugin for [graphify](https://github.com/safishamsi/graphify) — wraps the graphify CLI as native tools so the agent can build, query, and navigate a knowledge graph of your codebase.

## Features

- **11 native tools**: `graphify_status`, `graphify_build`, `graphify_query`, `graphify_path`, `graphify_explain`, `graphify_affected`, `graphify_update`, `graphify_add`, `graphify_diagnose`, `graphify_export`, `graphify_benchmark`
- **Multi-repo support**: auto-discovers `graphify-out/graph.json` in the project root and immediate subdirectories
- **Always-on orientation**: injects a short graphify note into the system prompt in *every* repo — even before a graph exists — so the agent knows it's available and how to build one (toggle with `alwaysActive`)
- **Fail-open nudge**: when a graph exists and the agent runs a broad raw `grep`/`rg`/`find`/`cat` sweep, a non-blocking tip steers it toward `graphify_query`/`graphify_explain`. It never blocks or fails the command (nudge, not force)
- **Tool result augmentation**: suggests graphify queries for large, architecture-related shell/read results
- **graphify 0.9.0 aware**: reads node/edge counts straight from `graph.json` (`links`/`edges` + `built_at_commit`), reminds the agent that node IDs are path-based and non-persistent (query by label), and strips graphify's stderr version-skew warnings from tool output
- **`.gitignore` management**: auto-adds `graphify-out/` and cleans up legacy entries
- **Hardened**: the `--backend` value is enum-validated and shell-quoted before execution (no shell injection)

## Install

### As a file plugin (local)

Copy or symlink the plugin into your project:

```bash
# In your project directory
mkdir -p .opencode/plugins
cp path/to/opencode-graphify/src/index.ts .opencode/plugins/graphify.ts
```

Then in your `opencode.json`:

```json
{
  "plugin": [".opencode/plugins/graphify.ts"]
}
```

### As an npm package

```bash
npm install opencode-graphify
```

Then in your `opencode.json`:

```json
{
  "plugin": ["opencode-graphify"]
}
```

### Always active in every repo (global)

Registering the plugin in a project's `opencode.json` only loads it for that
project. To make graphify available in **every** repo you open with OpenCode,
register it once in your **global** config at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-graphify"]
}
```

With the global registration in place, the plugin's `alwaysActive` option
(default `true`) ensures the agent is told graphify is available in every repo —
**even repos that don't have a graph yet** — along with how to build one. This
only injects a short orientation note into the system prompt; it does **not**
build a graph or spend any LLM tokens automatically. Build a graph yourself with
`graphify_build` (or the `/graphify-build` TUI command) when you want one.

To opt out of the always-on note (only orient once a graph exists), set
`alwaysActive` to `false`:

```json
{
  "plugin": [["opencode-graphify", { "alwaysActive": false }]]
}
```

## Configuration

Pass options as a tuple in `opencode.json`:

```json
{
  "plugin": [
    ["opencode-graphify", {
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

> **Note:** `semanticBackend` defaults to `"auto"`. Earlier versions defaulted to
> `"gemini"`; if you relied on that implicitly, set `"semanticBackend": "gemini"`
> explicitly. The `pythonPath` option still exists for backward compatibility but
> is currently unused (the plugin calls the `graphify` binary directly).

## Prerequisites

Install the graphify CLI:

```bash
pip install graphifyy
```

## Development

```bash
bun install
bun test
bun test --watch
```

## License

MIT
