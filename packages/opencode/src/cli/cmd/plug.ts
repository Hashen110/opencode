import { cmd } from "./cmd"
import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import path from "path"
import { mkdir } from "fs/promises"
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
import { ConfigPaths } from "../../config/paths"
import { Filesystem } from "../../util/filesystem"
import { Process } from "../../util/process"
import { errorMessage } from "../../util/error"
import { parsePluginSpecifier, resolvePluginTarget } from "../../plugin/shared"

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
        install.start("Installing plugin package...")
        const target = await resolvePluginTarget(mod).catch((err) => err)
        if (target instanceof Error) {
          install.stop("Install failed", 1)
          prompts.log.error(`Could not install "${mod}"`)
          if (target instanceof Process.RunFailedError) {
            const lines = target.stderr
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
              prompts.log.info("This package depends on a version that is not available in your npm registry.")
              prompts.log.info("Check npm registry/auth settings and try again.")
            }
          } else {
            prompts.log.error(errorMessage(target))
          }
          prompts.outro("Done")
          process.exitCode = 1
          return
        }
        install.stop("Plugin package ready")

        const inspect = prompts.spinner()
        inspect.start("Reading plugin manifest...")
        const stat = Filesystem.stat(target)
        const base = stat?.isDirectory() ? target : path.dirname(target)
        const file = path.join(base, "package.json")
        const json = await Filesystem.readJson<Record<string, unknown>>(file).catch((err) => err)
        if (json instanceof Error) {
          inspect.stop("Manifest read failed", 1)
          prompts.log.error(`Installed "${mod}" but failed to read ${file}`)
          prompts.log.error(errorMessage(json))
          prompts.outro("Done")
          process.exitCode = 1
          return
        }

        const raw = json["oc-plugin"]
        const kinds = Array.isArray(raw) ? raw.filter((x): x is "server" | "tui" => x === "server" || x === "tui") : []

        if (!kinds.length) {
          inspect.stop("No plugin targets found", 1)
          prompts.log.error(`"${mod}" does not declare supported targets in package.json`)
          prompts.log.info('Expected: "oc-plugin": ["server", "tui"] (or either one).')
          prompts.outro("Done")
          process.exitCode = 1
          return
        }
        inspect.stop(`Detected ${kinds.join(" + ")} target${kinds.length === 1 ? "" : "s"}`)

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
          await Filesystem.write(cfg, applyEdits(text, edits))
          spin.stop(`Added to ${cfg}`)
          return true
        }

        if (kinds.includes("server")) {
          const ok = await patch("opencode", "server")
          if (!ok) {
            prompts.outro("Done")
            process.exitCode = 1
            return
          }
        }

        if (kinds.includes("tui")) {
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
