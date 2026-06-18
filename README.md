# opencode-graphify

OpenCode plugin for [graphify](https://github.com/safishamsi/graphify) — wraps the graphify CLI as native tools so the agent can build, query, and navigate a knowledge graph of your codebase.

## Features

- **8 native tools**: `graphify_status`, `graphify_build`, `graphify_query`, `graphify_path`, `graphify_explain`, `graphify_affected`, `graphify_update`, `graphify_add`
- **Multi-repo support**: auto-discovers `graphify-out/graph.json` in the project root and immediate subdirectories
- **System prompt injection**: when graphs exist, appends orientation context with available roots and GRAPH_REPORT snippets
- **Tool result augmentation**: suggests graphify queries for large, architecture-related shell/read results
- **`.gitignore` management**: auto-adds `graphify-out/` and cleans up legacy entries

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

## Configuration

Pass options as a tuple in `opencode.json`:

```json
{
  "plugin": [
    ["opencode-graphify", {
      "pythonPath": "python3",
      "semanticBackend": "gemini",
      "reportMaxChars": 6000,
      "maxSessionAugments": 8
    }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `pythonPath` | `"python3"` | Python executable for the graphify CLI |
| `semanticBackend` | `"gemini"` | LLM backend for `graphify_build` |
| `outputDir` | `"graphify-out"` | Output directory name |
| `reportMaxChars` | `6000` | Max chars to read from GRAPH_REPORT.md |
| `maxSessionAugments` | `8` | Max tool-result augmentations per session |

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
