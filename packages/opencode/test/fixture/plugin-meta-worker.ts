type Msg = {
  file: string
  spec: string
  target: string
}

const raw = process.argv[2]
if (!raw) throw new Error("Missing worker payload")

const msg = JSON.parse(raw) as Partial<Msg>
if (!msg.file || !msg.spec || !msg.target) {
  throw new Error("Invalid worker payload")
}

process.env.OPENCODE_PLUGIN_META_FILE = msg.file

const { PluginMeta } = await import("../../src/plugin/meta")

await PluginMeta.touch(msg.spec, msg.target)
