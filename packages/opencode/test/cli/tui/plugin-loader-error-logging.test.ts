import { expect, spyOn, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { TuiConfig } from "../../../src/config/tui"

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

  try {
    await TuiPlugin.init(createTuiPluginApi())

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
