import "@opentui/solid/runtime-plugin-support"
import {
  type TuiDispose,
  type TuiPlugin as TuiPluginFn,
  type TuiPluginInit,
  type TuiPluginInput,
  type TuiTheme,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { CliRenderer } from "@opentui/core"
import path from "path"
import { fileURLToPath } from "url"

import { Config } from "@/config/config"
import { TuiConfig } from "@/config/tui"
import { Log } from "@/util/log"
import { isRecord } from "@/util/record"
import { Instance } from "@/project/instance"
import { isDeprecatedPlugin, resolvePluginTarget, uniqueModuleEntries } from "@/plugin/shared"
import { PluginMeta } from "@/plugin/meta"
import { addTheme, hasTheme } from "../context/theme"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { INTERNAL_TUI_PLUGINS, type InternalTuiPlugin } from "./internal"
import { getTuiSlotPlugin, setupSlots, Slot as View, type InitInput } from "./slots"

type Loaded = {
  item?: Config.PluginSpec
  spec: string
  target: string
  retry: boolean
  mod: Record<string, unknown>
  install: TuiTheme["install"]
}
type Deps = {
  wait?: Promise<void>
}

type HostInput = InitInput & {
  slots: TuiPluginInput<CliRenderer, JSX.Element>["slots"]
}

type Scope = ReturnType<typeof scope>

const log = Log.create({ service: "tui.plugin" })

function fail(message: string, data: Record<string, unknown>) {
  log.error(message, data)
  console.error(`[tui.plugin] ${message}`, data)
}

function isTuiPlugin(value: unknown): value is TuiPluginFn<CliRenderer, JSX.Element> {
  return typeof value === "function"
}

function getTuiPlugin(value: unknown) {
  if (!isRecord(value) || !("tui" in value)) return
  if (!isTuiPlugin(value.tui)) return
  return value.tui
}

function isTheme(value: unknown) {
  if (!isRecord(value)) return false
  if (!isRecord(value.theme)) return false
  return true
}

function localDir(file: string) {
  const dir = path.dirname(file)
  if (path.basename(dir) === ".opencode") return path.join(dir, "themes")
  return path.join(dir, ".opencode", "themes")
}

function scopeDir(pluginMeta: TuiConfig.PluginMeta) {
  if (pluginMeta.scope === "local") return localDir(pluginMeta.source)
  return path.join(Global.Path.config, "themes")
}

function pluginRoot(spec: string, target: string) {
  if (spec.startsWith("file://")) return path.dirname(fileURLToPath(spec))
  if (target.startsWith("file://")) return path.dirname(fileURLToPath(target))
  return target
}

function rootDir(root?: string) {
  if (!root) return process.cwd()
  if (root.startsWith("file://")) {
    const file = fileURLToPath(root)
    if (root.endsWith("/")) return file
    return path.dirname(file)
  }
  if (path.isAbsolute(root)) return root
  return path.resolve(process.cwd(), root)
}

function resolveThemePath(root: string, file: string) {
  if (file.startsWith("file://")) return fileURLToPath(file)
  if (path.isAbsolute(file)) return file
  return path.resolve(root, file)
}

function themeName(file: string) {
  return path.basename(file, path.extname(file))
}

function getPluginMeta(config: TuiConfig.Info, item: Config.PluginSpec) {
  const key = Config.getPluginName(item)
  return config.plugin_meta?.[key]
}

function makeInstallFn(meta: TuiConfig.PluginMeta, root: string, spec: string): TuiTheme["install"] {
  return async (file) => {
    const src = resolveThemePath(root, file)
    const theme = themeName(src)
    if (hasTheme(theme)) return

    const text = await Filesystem.readText(src).catch((error) => {
      log.warn("failed to read tui plugin theme", { path: spec, theme: src, error })
      return
    })
    if (text === undefined) return

    const fail = Symbol()
    const data = await Promise.resolve(text)
      .then((x) => JSON.parse(x) as unknown)
      .catch((error) => {
        log.warn("failed to parse tui plugin theme", { path: spec, theme: src, error })
        return fail
      })
    if (data === fail) return

    if (!isTheme(data)) {
      log.warn("invalid tui plugin theme", { path: spec, theme: src })
      return
    }

    const dest = path.join(scopeDir(meta), `${theme}.json`)
    if (!(await Filesystem.exists(dest))) {
      await Filesystem.write(dest, text).catch((error) => {
        log.warn("failed to persist tui plugin theme", { path: spec, theme: src, dest, error })
      })
    }

    addTheme(theme, data)
  }
}

function waitDeps(state: Deps) {
  state.wait ??= TuiConfig.waitForDependencies().catch((error) => {
    log.warn("failed waiting for tui plugin dependencies", { error })
  })
  return state.wait
}

async function prepPlugin(config: TuiConfig.Info, item: Config.PluginSpec, retry = false): Promise<Loaded | undefined> {
  const spec = Config.pluginSpecifier(item)
  if (isDeprecatedPlugin(spec)) return
  log.info("loading tui plugin", { path: spec, retry })
  const target = await resolvePluginTarget(spec).catch((error) => {
    fail("failed to resolve tui plugin", { path: spec, retry, error })
    return
  })
  if (!target) return

  const root = pluginRoot(spec, target)
  const pluginMeta = getPluginMeta(config, item)
  if (!pluginMeta) {
    log.warn("missing tui plugin metadata", {
      path: spec,
      retry,
      name: Config.getPluginName(item),
    })
    return
  }

  const install = makeInstallFn(pluginMeta, root, spec)
  const mod = await import(target).catch((error) => {
    fail("failed to load tui plugin", { path: spec, retry, error })
    return
  })
  if (!mod) return

  return {
    item,
    spec,
    target,
    retry,
    mod,
    install,
  }
}

function createInit(
  spec: string,
  target: string,
  meta: Awaited<ReturnType<typeof PluginMeta.touch>> | undefined,
  name?: string,
): TuiPluginInit {
  if (meta) {
    return {
      state: meta.state,
      entry: meta.entry,
    }
  }

  const source = spec.startsWith("internal:") ? "internal" : spec.startsWith("file://") ? "file" : "npm"
  const now = Date.now()
  return {
    state: source === "internal" ? "same" : "first",
    entry: {
      name: name ?? spec,
      source,
      spec,
      target,
      first_time: now,
      last_time: now,
      time_changed: now,
      load_count: 1,
      fingerprint: target,
    },
  }
}

function prepInternalPlugin(item: InternalTuiPlugin): Loaded {
  const spec = `internal:${item.name}`
  const target = item.root ?? spec
  const root = rootDir(item.root)

  return {
    spec,
    target,
    retry: false,
    mod: item.module,
    install: makeInstallFn(
      {
        scope: "global",
        source: target,
      },
      root,
      spec,
    ),
  }
}

function scope(load: Loaded, name: string) {
  const ctrl = new AbortController()
  let list: { key: symbol; fn: TuiDispose }[] = []
  let done = false

  const onDispose = (fn: TuiDispose) => {
    if (done) return () => {}
    const key = Symbol()
    list.push({ key, fn })
    let drop = false
    return () => {
      if (drop) return
      drop = true
      list = list.filter((x) => x.key !== key)
    }
  }

  const wrap = (fn: (() => void) | undefined) => {
    if (!fn) return () => {}
    const off = onDispose(fn)
    let drop = false
    return () => {
      if (drop) return
      drop = true
      off()
      fn()
    }
  }

  const lifecycle = {
    signal: ctrl.signal,
    onDispose,
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>["lifecycle"]

  const dispose = async () => {
    if (done) return
    done = true
    ctrl.abort()
    const queue = [...list].reverse()
    list = []
    for (const item of queue) {
      await Promise.resolve(item.fn()).catch((error) => {
        fail("failed to clean up tui plugin", {
          path: load.spec,
          name,
          error,
        })
      })
    }
  }

  return {
    lifecycle,
    wrap,
    dispose,
  }
}

function pluginInput(input: HostInput, load: Loaded, state: Scope) {
  const api = {
    command: {
      register(cb) {
        return state.wrap(input.api.command.register(cb))
      },
      trigger(value) {
        input.api.command.trigger(value)
      },
    },
    route: {
      register(list) {
        return state.wrap(input.api.route.register(list))
      },
      navigate(name, params) {
        input.api.route.navigate(name, params)
      },
      get current() {
        return input.api.route.current
      },
    },
    ui: input.api.ui,
    keybind: input.api.keybind,
    theme: Object.create(input.api.theme, {
      install: {
        value: load.install,
        configurable: true,
        enumerable: true,
      },
    }),
    kv: input.api.kv,
    state: input.api.state,
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>["api"]

  const event = {
    on(type, handler) {
      return state.wrap(input.event.on(type, handler))
    },
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>["event"]

  const slots = {
    register(plugin) {
      return state.wrap(input.slots.register(plugin))
    },
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>["slots"]

  return {
    ...input,
    event,
    slots,
    api,
    lifecycle: state.lifecycle,
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>
}

async function applyPlugin(input: HostInput, load: Loaded, init: TuiPluginInit, all: Scope[]) {
  const opts = load.item ? Config.pluginOptions(load.item) : undefined

  for (const [name, value] of uniqueModuleEntries(load.mod)) {
    if (!value || typeof value !== "object") {
      log.warn("ignoring non-object tui plugin export", {
        path: load.spec,
        name,
        type: value === null ? "null" : typeof value,
      })
      continue
    }

    const slotPlugin = getTuiSlotPlugin(value)
    const tuiPlugin = getTuiPlugin(value)
    if (!slotPlugin && !tuiPlugin) continue

    const state = scope(load, name)
    const ready = await Promise.resolve()
      .then(async () => {
        if (slotPlugin) state.wrap(input.slots.register(slotPlugin))
        if (!tuiPlugin) return true
        await tuiPlugin(pluginInput(input, load, state), opts, init)
        return true
      })
      .catch((error) => {
        fail("failed to initialize tui plugin export", {
          path: load.spec,
          name,
          error,
        })
        return false
      })

    if (!ready) {
      await state.dispose()
      continue
    }

    all.push(state)
  }
}

export namespace TuiPlugin {
  let dir = ""
  let loaded: Promise<void> | undefined
  let list: Scope[] = []
  export const Slot = View

  export async function init(input: InitInput) {
    const cwd = process.cwd()
    if (loaded && dir === cwd) return loaded
    if (loaded) await dispose()
    dir = cwd
    loaded = load({
      ...input,
      slots: setupSlots(input),
    })
    return loaded
  }

  export async function dispose() {
    const task = loaded
    if (task) await task
    const queue = [...list].reverse()
    list = []
    loaded = undefined
    for (const state of queue) {
      await state.dispose()
    }
  }

  async function load(input: HostInput) {
    const cwd = process.cwd()
    const next: Scope[] = []

    await Instance.provide({
      directory: cwd,
      fn: async () => {
        const config = await TuiConfig.get()
        const plugins = config.plugin ?? []
        const deps: Deps = {}

        for (const item of INTERNAL_TUI_PLUGINS) {
          log.info("loading internal tui plugin", { name: item.name })
          const entry = prepInternalPlugin(item)
          await applyPlugin(input, entry, createInit(entry.spec, entry.target, undefined, item.name), next)
        }

        const loaded = await Promise.all(plugins.map((item) => prepPlugin(config, item)))
        const ready: Loaded[] = []

        for (let i = 0; i < plugins.length; i++) {
          let entry = loaded[i]
          if (!entry) {
            const item = plugins[i]
            if (!item) continue
            const spec = Config.pluginSpecifier(item)
            if (!spec.startsWith("file://")) continue
            await waitDeps(deps)
            entry = await prepPlugin(config, item, true)
          }
          if (!entry) continue
          ready.push(entry)
        }

        const meta = await PluginMeta.touchMany(ready.map((item) => ({ spec: item.spec, target: item.target }))).catch(
          (error) => {
            log.warn("failed to track tui plugins", { error })
            return undefined
          },
        )

        for (let i = 0; i < ready.length; i++) {
          const entry = ready[i]
          if (!entry) continue
          const hit = meta?.[i]
          if (hit && hit.state !== "same") {
            log.info("tui plugin metadata updated", {
              path: entry.spec,
              retry: entry.retry,
              state: hit.state,
              source: hit.entry.source,
              version: hit.entry.version,
              modified: hit.entry.modified,
            })
          }

          // Keep plugin execution sequential for deterministic side effects:
          // command registration order affects keybind/command precedence,
          // route registration is last-wins when ids collide,
          // and hook chains rely on stable plugin ordering.
          await applyPlugin(input, entry, createInit(entry.spec, entry.target, hit), next)
        }

        list = next
      },
    }).catch((error) => {
      fail("failed to load tui plugins", { directory: cwd, error })
    })
  }
}
