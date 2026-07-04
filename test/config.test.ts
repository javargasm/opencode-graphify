import { describe, it, expect } from "bun:test"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config"

describe("resolveConfig", () => {
  it("returns defaults when no options provided", () => {
    const config = resolveConfig()
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it("defaults semanticBackend to 'auto' (CLI auto-detects)", () => {
    expect(DEFAULT_CONFIG.semanticBackend).toBe("auto")
    expect(resolveConfig().semanticBackend).toBe("auto")
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

  // ── forceGraphFirst (T-CS2-1 / B-R3) ──────────────────────────────────────

  it("defaults forceGraphFirst to false", () => {
    expect(DEFAULT_CONFIG.forceGraphFirst).toBe(false)
    expect(resolveConfig().forceGraphFirst).toBe(false)
  })

  it("resolves forceGraphFirst to true when passed true", () => {
    expect(resolveConfig({ forceGraphFirst: true }).forceGraphFirst).toBe(true)
  })

  it("ignores a non-boolean forceGraphFirst and falls back to default", () => {
    expect(resolveConfig({ forceGraphFirst: "yes" }).forceGraphFirst).toBe(false)
    expect(resolveConfig({ forceGraphFirst: 1 }).forceGraphFirst).toBe(false)
  })

  // ── apiTimeout (T-CS2-1 / C-F2) ───────────────────────────────────────────

  it("defaults apiTimeout to undefined (flag omitted)", () => {
    expect(DEFAULT_CONFIG.apiTimeout).toBeUndefined()
    expect(resolveConfig().apiTimeout).toBeUndefined()
  })

  it("resolves apiTimeout to a positive integer when provided", () => {
    expect(resolveConfig({ apiTimeout: 30 }).apiTimeout).toBe(30)
  })

  it("ignores a non-number apiTimeout and falls back to undefined", () => {
    expect(resolveConfig({ apiTimeout: "30" }).apiTimeout).toBeUndefined()
    expect(resolveConfig({ apiTimeout: true }).apiTimeout).toBeUndefined()
  })

  it("ignores a non-positive or non-integer apiTimeout", () => {
    expect(resolveConfig({ apiTimeout: 0 }).apiTimeout).toBeUndefined()
    expect(resolveConfig({ apiTimeout: -5 }).apiTimeout).toBeUndefined()
    expect(resolveConfig({ apiTimeout: 12.5 }).apiTimeout).toBeUndefined()
  })

  // ── alwaysActive (always-on orientation note) ─────────────────────────────

  it("defaults alwaysActive to true", () => {
    expect(DEFAULT_CONFIG.alwaysActive).toBe(true)
    expect(resolveConfig().alwaysActive).toBe(true)
  })

  it("resolves alwaysActive to false when passed false", () => {
    expect(resolveConfig({ alwaysActive: false }).alwaysActive).toBe(false)
  })

  it("ignores a non-boolean alwaysActive and falls back to default", () => {
    expect(resolveConfig({ alwaysActive: "no" }).alwaysActive).toBe(true)
    expect(resolveConfig({ alwaysActive: 0 }).alwaysActive).toBe(true)
  })

  // ── enforceDelegation (structural subagent enforcement) ─────────────────

  it("defaults enforceDelegation to true", () => {
    expect(DEFAULT_CONFIG.enforceDelegation).toBe(true)
    expect(resolveConfig().enforceDelegation).toBe(true)
  })

  it("resolves enforceDelegation to false when passed false", () => {
    expect(resolveConfig({ enforceDelegation: false }).enforceDelegation).toBe(false)
  })

  it("ignores a non-boolean enforceDelegation and falls back to default", () => {
    expect(resolveConfig({ enforceDelegation: "no" }).enforceDelegation).toBe(true)
    expect(resolveConfig({ enforceDelegation: 0 }).enforceDelegation).toBe(true)
  })
})
