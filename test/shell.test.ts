import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { shellQuote, ensureGitignore, validateBackend, ALLOWED_BACKENDS, stripGraphifyNoise } from "../src/shell"

const TMP = join(import.meta.dir, ".tmp-shell")

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

// ── shellQuote ──────────────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'")
  })

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  it("handles empty strings", () => {
    expect(shellQuote("")).toBe("''")
  })

  it("handles strings with spaces and special chars", () => {
    const result = shellQuote("hello world && rm -rf /")
    expect(result).toBe("'hello world && rm -rf /'")
  })

  it("handles multiple embedded quotes", () => {
    expect(shellQuote("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''")
  })

  it("neutralizes shell injection payloads", () => {
    expect(shellQuote("gemini; echo PWNED")).toBe("'gemini; echo PWNED'")
    expect(shellQuote("gemini$(touch /tmp/x)")).toBe("'gemini$(touch /tmp/x)'")
  })
})

// ── validateBackend (C1) ─────────────────────────────────────────────────────

describe("validateBackend", () => {
  it("accepts every allowed backend and normalizes case/whitespace", () => {
    for (const backend of ALLOWED_BACKENDS) {
      const result = validateBackend(backend)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(backend)
    }
  })

  it("normalizes mixed case and surrounding whitespace to lowercase", () => {
    const result = validateBackend("  GEMINI  ")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("gemini")
  })

  it("accepts claude-cli", () => {
    const result = validateBackend("claude-cli")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("claude-cli")
  })

  it("treats undefined as omit (ok with no value)", () => {
    const result = validateBackend(undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeUndefined()
  })

  it("treats empty string as omit (ok with no value)", () => {
    const result = validateBackend("")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeUndefined()
  })

  it("treats 'auto' as omit (ok with no value)", () => {
    const result = validateBackend("auto")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeUndefined()
  })

  it("rejects unknown backends", () => {
    const result = validateBackend("gpt5")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("gpt5")
  })

  it("rejects an injection payload with a semicolon", () => {
    const result = validateBackend("gemini; echo PWNED")
    expect(result.ok).toBe(false)
  })

  it("rejects a command-substitution injection payload", () => {
    const result = validateBackend("gemini$(touch /tmp/x)")
    expect(result.ok).toBe(false)
  })

  it("rejects 'evil'", () => {
    const result = validateBackend("evil")
    expect(result.ok).toBe(false)
  })
})

// ── stripGraphifyNoise (T-CS3-8) ─────────────────────────────────────────────

describe("stripGraphifyNoise", () => {
  it("returns empty string for empty input", () => {
    expect(stripGraphifyNoise("")).toBe("")
  })

  it("leaves no-warning input unchanged", () => {
    const stderr = "real progress line\nanother line"
    expect(stripGraphifyNoise(stderr)).toBe(stderr)
  })

  it("strips a single skew-warning line", () => {
    const stderr =
      "skill is from graphify 0.8.51, package is 0.9.0. Run 'graphify install' to update."
    expect(stripGraphifyNoise(stderr)).toBe("")
  })

  it("strips a skew-warning line prefixed with 'warning:'", () => {
    const stderr =
      "warning: skill is from graphify 0.8.51, package is 0.9.0. Run 'graphify install' to update."
    expect(stripGraphifyNoise(stderr)).toBe("")
  })

  it("strips multiple skew-warning lines while preserving real content", () => {
    const stderr = [
      "skill is from graphify 0.8.51, package is 0.9.0. Run 'graphify install' to update.",
      "real error: something broke",
      "skill is from graphify 0.8.50, package is 0.9.0. Run 'graphify install' to update.",
      "another real line",
    ].join("\n")
    expect(stripGraphifyNoise(stderr)).toBe("real error: something broke\nanother real line")
  })

  it("preserves real errors unchanged", () => {
    const stderr = "Traceback (most recent call last):\n  File x, line 1\nValueError: boom"
    expect(stripGraphifyNoise(stderr)).toBe(stderr)
  })

  it("preserves leading/interior real lines when a skew line is interleaved", () => {
    const stderr = [
      "[graphify extract] scanning /repo",
      "skill is from graphify 0.8.51, package is 0.9.0. Run 'graphify install' to update.",
      "[graphify extract] done",
    ].join("\n")
    expect(stripGraphifyNoise(stderr)).toBe(
      "[graphify extract] scanning /repo\n[graphify extract] done",
    )
  })
})

// ── ensureGitignore ─────────────────────────────────────────────────────────

describe("ensureGitignore", () => {
  it("creates .gitignore with graphify-out/ when none exists", () => {
    const updated = ensureGitignore(TMP)
    expect(updated).toBe(true)
    const content = readFileSync(join(TMP, ".gitignore"), "utf-8")
    expect(content).toContain("graphify-out/")
  })

  it("returns false when graphify-out/ already present", () => {
    writeFileSync(join(TMP, ".gitignore"), "node_modules/\ngraphify-out/\n", "utf-8")
    const updated = ensureGitignore(TMP)
    expect(updated).toBe(false)
  })

  it("adds graphify-out/ to existing .gitignore", () => {
    writeFileSync(join(TMP, ".gitignore"), "node_modules/\ndist/\n", "utf-8")
    const updated = ensureGitignore(TMP)
    expect(updated).toBe(true)
    const content = readFileSync(join(TMP, ".gitignore"), "utf-8")
    expect(content).toContain("node_modules/")
    expect(content).toContain("graphify-out/")
  })

  it("removes legacy entries and adds new one", () => {
    writeFileSync(
      join(TMP, ".gitignore"),
      "graphify-out/cache/\ngraphify-out/.graphify_python\nother-stuff/\n",
      "utf-8"
    )
    const updated = ensureGitignore(TMP)
    expect(updated).toBe(true)
    const content = readFileSync(join(TMP, ".gitignore"), "utf-8")
    expect(content).not.toContain("graphify-out/cache/")
    expect(content).not.toContain("graphify-out/.graphify_python")
    expect(content).toContain("other-stuff/")
    expect(content).toContain("graphify-out/")
  })

  it("preserves other entries and ends with newline", () => {
    writeFileSync(join(TMP, ".gitignore"), "*.log\n.env\n", "utf-8")
    ensureGitignore(TMP)
    const content = readFileSync(join(TMP, ".gitignore"), "utf-8")
    expect(content).toContain("*.log")
    expect(content).toContain(".env")
    expect(content).toContain("graphify-out/")
    expect(content.endsWith("\n")).toBe(true)
  })
})
