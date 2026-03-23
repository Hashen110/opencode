import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "../../src/util/process"
import { Filesystem } from "../../src/util/filesystem"
import { createPlugTask, type PlugCtx, type PlugDeps } from "../../src/cli/cmd/plug"
import { tmpdir } from "../fixture/fixture"

type Log = {
  info: string[]
  error: string[]
  success: string[]
}

function capture() {
  const log: Log = {
    info: [],
    error: [],
    success: [],
  }
  const spin: string[] = []
  return {
    log,
    spin,
  }
}

function deps(global: string, target: string | Error, out: ReturnType<typeof capture>): PlugDeps {
  return {
    spinner: () => ({
      start() {},
      stop(msg) {
        out.spin.push(msg)
      },
    }),
    log: {
      error(msg) {
        out.log.error.push(msg)
      },
      info(msg) {
        out.log.info.push(msg)
      },
      success(msg) {
        out.log.success.push(msg)
      },
    },
    mkdir: async (dir, opts) => {
      await fs.mkdir(dir, opts)
    },
    resolve: async () => {
      if (target instanceof Error) throw target
      return target
    },
    stat: Filesystem.stat,
    readJson: (file) => Filesystem.readJson(file),
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => {
      await Filesystem.write(file, text)
    },
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global,
  }
}

function ctx(dir: string): PlugCtx {
  return {
    vcs: "git",
    worktree: dir,
    directory: dir,
  }
}

async function plugin(dir: string, kinds?: unknown) {
  const p = path.join(dir, "plugin")
  await fs.mkdir(p, { recursive: true })
  await Bun.write(
    path.join(p, "package.json"),
    JSON.stringify(
      {
        name: "acme",
        version: "1.0.0",
        ...(kinds === undefined ? {} : { "oc-plugin": kinds }),
      },
      null,
      2,
    ),
  )
  return p
}

async function read(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as {
    plugin?: unknown[]
  }
}

describe("cli.plug.task", () => {
  test("installs server+tui plugin and writes both configs", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server", "tui"])
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    const tui = await read(path.join(tmp.path, ".opencode", "tui.jsonc"))
    expect(server.plugin).toEqual(["acme@1.2.3"])
    expect(tui.plugin).toEqual(["acme@1.2.3"])
    expect(cap.log.success).toEqual(["Installed acme@1.2.3"])
  })

  test("supports resolver targets that point to a file", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const file = path.join(target, "index.js")
    await Bun.write(file, "export {}")
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), file, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(server.plugin).toEqual(["acme@1.2.3"])
  })

  test("keeps existing version when package already configured without force", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(cfg, JSON.stringify({ plugin: ["acme@1.0.0"] }, null, 2))

    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual(["acme@1.0.0"])
    expect(cap.spin.some((x) => x.includes("Already configured"))).toBe(true)
  })

  test("force replaces version and keeps tuple options", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(
      cfg,
      JSON.stringify(
        {
          plugin: [["acme@1.0.0", { mode: "safe" }], "acme@1.1.0", "other@1.0.0"],
        },
        null,
        2,
      ),
    )

    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
        force: true,
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual([["acme@2.0.0", { mode: "safe" }], "other@1.0.0"])
    expect(cap.spin.some((x) => x.includes("Replaced"))).toBe(true)
  })

  test("writes into global config when global flag is set", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const global = path.join(tmp.path, "global")
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
        global: true,
      },
      deps(global, target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    expect(await Filesystem.exists(path.join(global, "opencode.jsonc"))).toBe(true)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("fails when config file has invalid JSONC", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    const bad = '{"plugin": ["acme@1.0.0",}'
    await Bun.write(cfg, bad)

    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(cap.log.error.some((x) => x.includes("Invalid JSON"))).toBe(true)
    expect(await fs.readFile(cfg, "utf8")).toBe(bad)
  })

  test("fails when plugin manifest has no supported targets", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path)
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(cap.log.error.some((x) => x.includes("does not declare supported targets"))).toBe(true)
  })

  test("fails when plugin manifest cannot be read", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "plugin")
    await fs.mkdir(target, { recursive: true })
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(cap.log.error.some((x) => x.includes("failed to read"))).toBe(true)
  })

  test("fails cleanly when install throws regular error", async () => {
    await using tmp = await tmpdir()
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@9.9.9",
      },
      deps(path.join(tmp.path, "global"), new Error("boom"), cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(cap.log.error.some((x) => x.includes('Could not install "acme@9.9.9"'))).toBe(true)
    expect(cap.log.error.some((x) => x.includes("boom"))).toBe(true)
  })

  test("shows registry hints for run failure with missing version", async () => {
    await using tmp = await tmpdir()
    const err = new Process.RunFailedError(
      ["bun", "add", "acme@9.9.9"],
      1,
      Buffer.from(""),
      Buffer.from('error: No version matching "9.9.9" found for specifier "acme"\n'),
    )
    const cap = capture()
    const run = createPlugTask(
      {
        mod: "acme@9.9.9",
      },
      deps(path.join(tmp.path, "global"), err, cap),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(cap.log.info).toContain("This package depends on a version that is not available in your npm registry.")
    expect(cap.log.info).toContain("Check npm registry/auth settings and try again.")
  })
})
