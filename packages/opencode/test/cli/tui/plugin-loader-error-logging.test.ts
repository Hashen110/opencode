import { expect, spyOn, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { CliRenderer } from "@opentui/core"
import { tmpdir } from "../../fixture/fixture"
import { TuiConfig } from "../../../src/config/tui"
import { createPluginKeybind } from "../../../src/cli/cmd/tui/context/plugin-keybinds"

const { TuiPlugin } = await import("../../../src/cli/cmd/tui/plugin/runtime")

test("logs useful details when a tui plugin import fails", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const bad = path.join(dir, "bad-plugin.ts")
      const spec = pathToFileURL(bad).href
      await Bun.write(
        bad,
        `import "./missing-module.ts"

export default {
  tui: async () => {},
}
`,
      )
      return { spec }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const name = path.parse(new URL(tmp.extra.spec).pathname).name
  const get = spyOn(TuiConfig, "get").mockResolvedValue({
    plugin: [tmp.extra.spec],
    plugin_meta: {
      [name]: {
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
    },
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const err = spyOn(console, "error").mockImplementation(() => {})
  let selected = "opencode"
  const renderer = {
    ...Object.create(null),
    once(this: CliRenderer) {
      return this
    },
  } satisfies CliRenderer
  const kv: Record<string, unknown> = {}
  const keybind = {
    parse: (evt: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; super?: boolean }) => ({
      name: evt.name ?? "",
      ctrl: evt.ctrl ?? false,
      meta: evt.meta ?? false,
      shift: evt.shift ?? false,
      super: evt.super,
      leader: false,
    }),
    match: () => false,
    print: (key: string) => key,
  }

  try {
    await TuiPlugin.init({
      client: createOpencodeClient({
        baseUrl: "http://localhost:4096",
      }),
      event: {
        on: () => () => {},
      },
      renderer,
      command: {
        register: () => () => {},
        trigger: () => {},
      },
      route: {
        register: () => () => {},
        navigate: () => {},
        get current() {
          return { name: "home" as const }
        },
      },
      ui: {
        Dialog: () => null,
        DialogAlert: () => null,
        DialogConfirm: () => null,
        DialogPrompt: () => null,
        DialogSelect: () => null,
        toast: () => {},
        dialog: {
          replace: () => {},
          clear: () => {},
          setSize: () => {},
          get size() {
            return "medium" as const
          },
          get depth() {
            return 0
          },
          get open() {
            return false
          },
        },
      },
      keybind: {
        ...keybind,
        create(defaults, overrides) {
          return createPluginKeybind(keybind, defaults, overrides)
        },
      },
      kv: {
        get(key, fallback) {
          return (kv[key] ?? fallback) as never
        },
        set(key, value) {
          kv[key] = value
        },
        get ready() {
          return true
        },
      },
      state: {
        session: {
          diff() {
            return []
          },
          todo() {
            return []
          },
        },
        lsp() {
          return []
        },
        mcp() {
          return []
        },
      },
      theme: {
        get current() {
          return {}
        },
        get selected() {
          return selected
        },
        has() {
          return false
        },
        set(name) {
          selected = name
          return true
        },
        async install() {
          throw new Error("base theme.install should not run")
        },
        mode() {
          return "dark" as const
        },
        get ready() {
          return true
        },
      },
    })

    const call = err.mock.calls.find(
      (item) => typeof item[0] === "string" && item[0].includes("failed to load tui plugin"),
    )
    expect(call).toBeDefined()
    if (!call) return

    expect(String(call[0])).toContain("failed to load tui plugin:")
    const data = call[1] as Record<string, unknown>
    expect(data.path).toBe(tmp.extra.spec)
    expect(data.target).toBe(tmp.extra.spec)
    expect(data.retry).toBe(false)
    expect(data.error).toBeObject()

    const info = data.error as Record<string, unknown>
    expect(typeof info.message).toBe("string")
    expect((info.message as string).length).toBeGreaterThan(0)
    expect(typeof info.formatted).toBe("string")
    expect((info.formatted as string).length).toBeGreaterThan(0)
    expect(info.formatted).not.toBe("{}")
  } finally {
    await TuiPlugin.dispose()
    err.mockRestore()
    cwd.mockRestore()
    get.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})
