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
}

export const DEFAULT_CONFIG: GraphifyConfig = {
  pythonPath: "python3",
  outputDir: "graphify-out",
  semanticBackend: "gemini",
  reportMaxChars: 6000,
  maxSessionAugments: 8,
}

export function resolveConfig(options?: PluginOptions): GraphifyConfig {
  if (!options) return { ...DEFAULT_CONFIG }
  return {
    pythonPath: typeof options.pythonPath === "string" ? options.pythonPath : DEFAULT_CONFIG.pythonPath,
    outputDir: typeof options.outputDir === "string" ? options.outputDir : DEFAULT_CONFIG.outputDir,
    semanticBackend: typeof options.semanticBackend === "string" ? options.semanticBackend : DEFAULT_CONFIG.semanticBackend,
    reportMaxChars: typeof options.reportMaxChars === "number" ? options.reportMaxChars : DEFAULT_CONFIG.reportMaxChars,
    maxSessionAugments: typeof options.maxSessionAugments === "number" ? options.maxSessionAugments : DEFAULT_CONFIG.maxSessionAugments,
  }
}
