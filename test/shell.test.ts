import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { shellQuote, ensureGitignore } from "../src/shell"

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
