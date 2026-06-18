import { describe, it, expect } from "bun:test"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config"

describe("resolveConfig", () => {
  it("returns defaults when no options provided", () => {
    const config = resolveConfig()
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it("returns defaults when options is undefined", () => {
    const config = resolveConfig(undefined)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it("overrides pythonPath when provided", () => {
    const config = resolveConfig({ pythonPath: "/usr/bin/python" })
    expect(config.pythonPath).toBe("/usr/bin/python")
    expect(config.outputDir).toBe(DEFAULT_CONFIG.outputDir)
  })

  it("overrides semanticBackend when provided", () => {
    const config = resolveConfig({ semanticBackend: "claude" })
    expect(config.semanticBackend).toBe("claude")
  })

  it("overrides numeric options", () => {
    const config = resolveConfig({ reportMaxChars: 3000, maxSessionAugments: 4 })
    expect(config.reportMaxChars).toBe(3000)
    expect(config.maxSessionAugments).toBe(4)
  })

  it("ignores invalid types and uses defaults", () => {
    const config = resolveConfig({
      pythonPath: 42,
      semanticBackend: true,
      reportMaxChars: "not a number",
    })
    expect(config.pythonPath).toBe(DEFAULT_CONFIG.pythonPath)
    expect(config.semanticBackend).toBe(DEFAULT_CONFIG.semanticBackend)
    expect(config.reportMaxChars).toBe(DEFAULT_CONFIG.reportMaxChars)
  })

  it("does not mutate DEFAULT_CONFIG", () => {
    const before = { ...DEFAULT_CONFIG }
    resolveConfig({ outputDir: "custom-out" })
    expect(DEFAULT_CONFIG).toEqual(before)
  })
})
