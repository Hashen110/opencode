import { cmd } from "./cmd"
import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import path from "path"
import { mkdir } from "fs/promises"
import { pathToFileURL } from "url"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"
import { Instance } from "../../project/instance"
import { Global } from "../../global"
import { UI } from "../ui"
import { BunProc } from "../../bun"
import { ConfigPaths } from "../../config/paths"
import { Filesystem } from "../../util/filesystem"
import { Process } from "../../util/process"
import { errorMessage } from "../../util/error"
import { parsePluginSpecifier, uniqueModuleEntries } from "../../plugin/shared"

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

    UI.empty()
    prompts.intro(`Install plugin ${mod}`)

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const pkg = parsePluginSpecifier(mod).pkg
        const root = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const dir = args.global ? Global.Path.config : path.join(root, ".opencode")
        await mkdir(dir, { recursive: true })

        const install = prompts.spinner()
        install.start("Installing module...")
        const failed = await BunProc.run(["add", "--exact", mod], { cwd: dir })
          .then(() => undefined)
          .catch((err) => err)

        if (failed) {
          install.stop("Install failed", 1)
          prompts.log.error(`Could not install "${mod}"`)

          if (failed instanceof Process.RunFailedError) {
            const lines = failed.stderr
              .toString()
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
            const errors = lines
              .filter((line) => line.startsWith("error:"))
              .map((line) => line.replace(/^error:\s*/, ""))
            const detail = errors[0] ?? lines.at(-1)
            if (detail) prompts.log.error(detail)

            if (lines.some((line) => line.includes("No version matching"))) {
              prompts.log.info("This module depends on a package version that is not available in your npm registry.")
              prompts.log.info("Check your npm registry/auth settings and try again.")
            }
          }

          if (!(failed instanceof Process.RunFailedError)) {
            prompts.log.error(errorMessage(failed))
          }

          prompts.outro("Done")
          process.exitCode = 1
          return
        }
        install.stop("Module installed")

        const inspect = prompts.spinner()
        inspect.start("Inspecting plugin exports...")
        const loaded = await (async () => {
          const target = Bun.resolveSync(pkg, dir)
          return import(pathToFileURL(target).href)
        })()
          .then((x) => x)
          .catch((err) => err)

        if (loaded instanceof Error) {
          inspect.stop("Inspect failed", 1)
          prompts.log.error(`Installed "${mod}" but failed to import it`)
          prompts.log.error(errorMessage(loaded))
          prompts.outro("Done")
          process.exitCode = 1
          return
        }

        let server = false
        let tui = false
        if (loaded && typeof loaded === "object") {
          for (const [, entry] of uniqueModuleEntries(loaded as Record<string, unknown>)) {
            if (typeof entry === "function") server = true
            if (!entry || typeof entry !== "object") continue
            if ("server" in entry && typeof entry.server === "function") server = true
            if ("tui" in entry && typeof entry.tui === "function") tui = true
          }
        }

        if (!server && !tui) {
          inspect.stop("No plugin exports found", 1)
          prompts.log.error(`"${mod}" does not export a supported plugin shape`)
          prompts.log.info("Expected one of: default function (server), { server }, or { tui }.")
          prompts.outro("Done")
          process.exitCode = 1
          return
        }

        const kinds = [server ? "server" : undefined, tui ? "tui" : undefined].filter((x): x is string => !!x)
        inspect.stop(`Detected ${kinds.join(" + ")} plugin export${kinds.length === 1 ? "" : "s"}`)

        const patch = async (name: "opencode" | "tui", kind: "server" | "tui") => {
          const spin = prompts.spinner()
          spin.start(`Updating ${kind} config...`)

          const files = ConfigPaths.fileInDirectory(dir, name)
          let cfg = files[0]
          for (const file of files) {
            if (!(await Filesystem.exists(file))) continue
            cfg = file
            break
          }

          const src = await Filesystem.readText(cfg).catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return "{}"
            throw err
          })
          const text = src.trim() ? src : "{}"
          const errs: JsoncParseError[] = []
          const data = parseJsonc(text, errs, { allowTrailingComma: true })

          if (errs.length) {
            const err = errs[0]
            const lines = text.substring(0, err.offset).split("\n")
            const line = lines.length
            const col = lines[lines.length - 1].length + 1
            spin.stop(`Failed updating ${kind} config`, 1)
            prompts.log.error(
              `Invalid JSON in ${cfg} (${printParseErrorCode(err.error)} at line ${line}, column ${col})`,
            )
            prompts.log.info("Fix the config file and run the command again.")
            return false
          }

          const list: unknown[] =
            data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.plugin) ? data.plugin : []
          const exists = list.some((item) => {
            const spec =
              typeof item === "string" ? item : Array.isArray(item) && typeof item[0] === "string" ? item[0] : undefined
            if (!spec) return false
            if (spec === mod) return true
            if (spec.startsWith("file://")) return false
            return parsePluginSpecifier(spec).pkg === pkg
          })

          if (exists) {
            spin.stop(`Already configured in ${cfg}`)
            return true
          }

          const edits = modify(text, ["plugin"], [...list, mod], {
            formattingOptions: {
              tabSize: 2,
              insertSpaces: true,
            },
          })
          const next = applyEdits(text, edits)
          await Filesystem.write(cfg, next)
          spin.stop(`Added to ${cfg}`)
          return true
        }

        if (server) {
          const ok = await patch("opencode", "server")
          if (!ok) {
            prompts.outro("Done")
            process.exitCode = 1
            return
          }
        }

        if (tui) {
          const ok = await patch("tui", "tui")
          if (!ok) {
            prompts.outro("Done")
            process.exitCode = 1
            return
          }
        }

        prompts.log.success(`Installed ${mod}`)
        prompts.log.info(args.global ? `Scope: global (${dir})` : `Scope: local (${dir})`)
        prompts.outro("Done")
      },
    })
  },
})
