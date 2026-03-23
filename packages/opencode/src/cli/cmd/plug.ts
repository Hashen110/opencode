import { cmd } from "./cmd"
import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Global } from "../../global"
import { UI } from "../ui"
import path from "path"
import { mkdir } from "fs/promises"
import { BunProc } from "../../bun"
import { Filesystem } from "../../util/filesystem"
import { ConfigPaths } from "../../config/paths"
import { parsePluginSpecifier, uniqueModuleEntries } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"
import { pathToFileURL } from "url"

type Shape = {
  server: boolean
  tui: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function server(value: unknown) {
  if (typeof value === "function") return true
  if (!record(value)) return false
  return typeof value.server === "function"
}

function tui(value: unknown) {
  if (!record(value)) return false
  return typeof value.tui === "function"
}

function shape(mod: Record<string, unknown>): Shape {
  let out: Shape = {
    server: false,
    tui: false,
  }

  for (const [, entry] of uniqueModuleEntries(mod)) {
    if (server(entry)) {
      out = {
        ...out,
        server: true,
      }
    }
    if (tui(entry)) {
      out = {
        ...out,
        tui: true,
      }
    }
  }

  return out
}

function spec(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return
  if (typeof value[0] !== "string") return
  return value[0]
}

function key(value: string) {
  if (value.startsWith("file://")) return value
  return parsePluginSpecifier(value).pkg
}

function has(list: unknown[], value: string) {
  const want = key(value)
  for (const item of list) {
    const next = spec(item)
    if (!next) continue
    if (next === value) return true
    if (key(next) === want) return true
  }
  return false
}

function parse(text: string, file: string) {
  const errs: JsoncParseError[] = []
  const data = parseJsonc(text, errs, { allowTrailingComma: true })
  if (errs.length) {
    const detail = errs.map((err) => printParseErrorCode(err.error)).join(", ")
    throw new Error(`Failed parsing ${file}: ${detail}`)
  }
  if (!data) return {}
  if (record(data)) return data
  throw new Error(`Expected object in ${file}`)
}

async function file(dir: string, name: string) {
  const list = ConfigPaths.fileInDirectory(dir, name)
  for (const item of list) {
    if (await Filesystem.exists(item)) return item
  }
  return list[0]
}

async function patch(file: string, value: string) {
  const found = await Filesystem.exists(file)
  const src = found ? await Filesystem.readText(file) : "{}"
  const text = src.trim() ? src : "{}"
  const data = parse(text, file)
  const list = Array.isArray(data.plugin) ? data.plugin : []
  if (has(list, value)) return false

  const edits = modify(text, ["plugin"], [...list, value], {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
    },
  })
  const next = applyEdits(text, edits)
  await Filesystem.write(file, next)
  return true
}

async function load(dir: string, value: string) {
  const pkg = parsePluginSpecifier(value).pkg
  const target = Bun.resolveSync(pkg, dir)
  const mod = await import(pathToFileURL(target).href)
  if (!record(mod)) return {}
  return mod
}

export const PlugCommand = cmd({
  command: "plug <module>",
  aliases: ["plugin"],
  describe: "install plugin and update config",
  builder: (yargs: Argv) => {
    return yargs
      .positional("module", {
        type: "string",
        describe: "npm module name",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "install in global config",
      })
  },
  handler: async (args) => {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const root = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const dir = args.global ? Global.Path.config : path.join(root, ".opencode")
        await mkdir(dir, { recursive: true })

        const added = await BunProc.run(["add", "--exact", mod], {
          cwd: dir,
        })
          .then(() => true)
          .catch((err) => {
            UI.error(`Failed installing ${mod}: ${errorMessage(err)}`)
            return false
          })
        if (!added) {
          process.exitCode = 1
          return
        }

        const mods = await load(dir, mod).catch((err) => {
          UI.error(`Failed importing ${mod}: ${errorMessage(err)}`)
          return
        })
        if (!mods) {
          process.exitCode = 1
          return
        }

        const out = shape(mods)
        if (!out.server && !out.tui) {
          UI.error(`${mod} exports neither server nor tui plugin hooks`)
          process.exitCode = 1
          return
        }

        const lines: string[] = []
        if (out.server) {
          const cfg = await file(dir, "opencode")
          const wrote = await patch(cfg, mod)
          lines.push(`${wrote ? "added" : "exists"} server plugin in ${cfg}`)
        }
        if (out.tui) {
          const cfg = await file(dir, "tui")
          const wrote = await patch(cfg, mod)
          lines.push(`${wrote ? "added" : "exists"} tui plugin in ${cfg}`)
        }

        UI.println(`installed ${mod} in ${dir}`)
        for (const line of lines) {
          UI.println(line)
        }
      },
    })
  },
})
