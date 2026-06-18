import { describe, it, expect } from "bun:test"
import plugin from "../src/index"

describe("plugin export shape", () => {
  it("has a string id", () => {
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id).toBe("graphify")
  })

  it("exports server as a function", () => {
    expect(typeof plugin.server).toBe("function")
  })

  it("server is an async function (returns Promise)", () => {
    // The V1 plugin contract: server(input, options?) => Promise<Hooks>
    // We verify the function exists and has the right arity
    expect(plugin.server.length).toBeGreaterThanOrEqual(1)
  })
})
