/**
 * Plugin configuration — resolves user options with defaults.
 */

import type { PluginOptions } from "@opencode-ai/plugin"

export interface GraphifyConfig {
  pythonPath: string
  outputDir: string
  semanticBackend: string
  reportMaxChars: number
  maxSessionAugments: number
  /**
   * When true, the agent-adoption nudge (see shouldNudgeGraphFirst) emits
   * stronger advisory steering toward the graphify_* tools. Still fail-open —
   * never blocks or fails the command (spec B-R3).
   */
  forceGraphFirst: boolean
  /**
   * Optional positive-integer seconds passed through to `graphify extract`
   * as `--api-timeout <n>`. Undefined → the flag is omitted (CLI default).
   */
  apiTimeout?: number
  /**
   * When true (default), the system-prompt orientation hook is "always on":
   * even in repos with NO graph yet, it injects a short note telling the agent
   * graphify is available and how to build a graph. When false, orientation is
   * only injected once a graph exists (the original behavior).
   */
  alwaysActive: boolean
  /**
   * When true (default), graphify_* native tools structurally refuse to
   * execute when called by any agent other than the dedicated `graphify`
   * subagent. This forces the primary agent to delegate Graphify work via
   * the task tool (subagent_type: 'graphify') instead of calling the tools
   * directly. Set to false to allow direct calls from any agent (advisory
   * system-prompt text only).
   */
  enforceDelegation: boolean
}

export const DEFAULT_CONFIG: GraphifyConfig = {
  pythonPath: "python3",
  outputDir: "graphify-out",
  semanticBackend: "auto",
  reportMaxChars: 6000,
  maxSessionAugments: 8,
  forceGraphFirst: false,
  // apiTimeout intentionally omitted (undefined) — the flag is not passed
  // unless the user configures a positive integer.
  alwaysActive: true,
  enforceDelegation: true,
}

export function resolveConfig(options?: PluginOptions): GraphifyConfig {
  if (!options) return { ...DEFAULT_CONFIG }
  return {
    pythonPath: typeof options.pythonPath === "string" ? options.pythonPath : DEFAULT_CONFIG.pythonPath,
    outputDir: typeof options.outputDir === "string" ? options.outputDir : DEFAULT_CONFIG.outputDir,
    semanticBackend: typeof options.semanticBackend === "string" ? options.semanticBackend : DEFAULT_CONFIG.semanticBackend,
    reportMaxChars: typeof options.reportMaxChars === "number" ? options.reportMaxChars : DEFAULT_CONFIG.reportMaxChars,
    maxSessionAugments: typeof options.maxSessionAugments === "number" ? options.maxSessionAugments : DEFAULT_CONFIG.maxSessionAugments,
    forceGraphFirst: typeof options.forceGraphFirst === "boolean" ? options.forceGraphFirst : DEFAULT_CONFIG.forceGraphFirst,
    apiTimeout:
      typeof options.apiTimeout === "number" && Number.isInteger(options.apiTimeout) && options.apiTimeout > 0
        ? options.apiTimeout
        : DEFAULT_CONFIG.apiTimeout,
    alwaysActive: typeof options.alwaysActive === "boolean" ? options.alwaysActive : DEFAULT_CONFIG.alwaysActive,
    enforceDelegation: typeof options.enforceDelegation === "boolean" ? options.enforceDelegation : DEFAULT_CONFIG.enforceDelegation,
  }
}
