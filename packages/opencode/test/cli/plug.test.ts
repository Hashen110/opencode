import { describe, expect, test } from "bun:test"
import { patchPluginList, pluginSpec } from "../../src/cli/cmd/plug"

describe("cli.plug.spec", () => {
  test("reads string entries", () => {
    expect(pluginSpec("acme@1.2.3")).toBe("acme@1.2.3")
  })

  test("reads tuple entries", () => {
    expect(pluginSpec(["acme@1.2.3", { flag: true }])).toBe("acme@1.2.3")
  })

  test("ignores invalid entries", () => {
    expect(pluginSpec([123, { flag: true }])).toBeUndefined()
    expect(pluginSpec({ spec: "acme@1.2.3" })).toBeUndefined()
  })
})

describe("cli.plug.patch", () => {
  test("adds missing package", () => {
    const out = patchPluginList(["other@1.0.0"], "acme@1.2.3")
    expect(out.mode).toBe("add")
    expect(out.list).toEqual(["other@1.0.0", "acme@1.2.3"])
  })

  test("does nothing for exact duplicate", () => {
    const list = ["acme@1.2.3"]
    const out = patchPluginList(list, "acme@1.2.3")
    expect(out.mode).toBe("noop")
    expect(out.list).toEqual(list)
  })

  test("does nothing for same package with different version by default", () => {
    const list = ["acme@1.2.3"]
    const out = patchPluginList(list, "acme@2.0.0")
    expect(out.mode).toBe("noop")
    expect(out.list).toEqual(list)
  })

  test("treats scoped packages as one package", () => {
    const list = ["@scope/acme@1.2.3"]
    const out = patchPluginList(list, "@scope/acme@2.0.0")
    expect(out.mode).toBe("noop")
    expect(out.list).toEqual(list)
  })

  test("ignores file plugins when matching package names", () => {
    const list = ["file:///tmp/acme.ts"]
    const out = patchPluginList(list, "acme@1.2.3")
    expect(out.mode).toBe("add")
    expect(out.list).toEqual(["file:///tmp/acme.ts", "acme@1.2.3"])
  })

  test("replaces package version with force for string entries", () => {
    const out = patchPluginList(["acme@1.2.3"], "acme@2.0.0", true)
    expect(out.mode).toBe("replace")
    expect(out.list).toEqual(["acme@2.0.0"])
  })

  test("replaces package version with force for tuple entries while keeping options", () => {
    const opts = { flag: true }
    const out = patchPluginList([["acme@1.2.3", opts]], "acme@2.0.0", true)
    expect(out.mode).toBe("replace")
    expect(out.list).toEqual([["acme@2.0.0", opts]])
  })

  test("replaces first duplicate and removes extra duplicates with force", () => {
    const out = patchPluginList(["acme@1.0.0", ["acme@1.1.0", { mode: "fast" }], "other@1.0.0"], "acme@2.0.0", true)
    expect(out.mode).toBe("replace")
    expect(out.list).toEqual(["acme@2.0.0", "other@1.0.0"])
  })

  test("keeps tuple shape when first duplicate is tuple", () => {
    const opts = { mode: "safe" }
    const out = patchPluginList([["acme@1.0.0", opts], "acme@1.1.0", "other@1.0.0"], "acme@2.0.0", true)
    expect(out.mode).toBe("replace")
    expect(out.list).toEqual([["acme@2.0.0", opts], "other@1.0.0"])
  })

  test("keeps no-op when forced install already matches existing single entry", () => {
    const list = ["acme@2.0.0"]
    const out = patchPluginList(list, "acme@2.0.0", true)
    expect(out.mode).toBe("noop")
    expect(out.list).toEqual(list)
  })

  test("ignores malformed entries while patching", () => {
    const bad: unknown = [123, { flag: true }]
    const out = patchPluginList([bad], "acme@1.2.3")
    expect(out.mode).toBe("add")
    expect(out.list).toEqual([bad, "acme@1.2.3"])
  })
})
