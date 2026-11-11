#!/usr/bin/env node
// Tests for the scripts/doctor.mjs diagnostic in offline mode:
// - --offline / OC_DOCTOR_OFFLINE=1 makes NO network request (fetch neutralised by a Node
//   preload that throws, a fake gh that leaves a trace, "opencode mcp list" never launched);
// - healthy config → code 0; missing referenced agent, invalid JSON, missing MCP binary → code 1;
// - doctor.sh forwards --offline and propagates the exit code.
// Everything runs in a temporary HOME/OPENCODE_CONFIG_DIR, with fake binaries: never the real config.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseJsonc } from "./lib/jsonc.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DOCTOR = path.join(ROOT, "scripts/doctor.mjs")
const DOCTOR_SH = path.join(ROOT, "doctor.sh")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-doctortest-"))
let passed = 0, failed = 0
const check = (name, cond, detail = "") => {
  cond ? passed++ : failed++
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`)
}
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, { mode: 0o755 }) }
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")

// ---------- fake binaries and network spy ----------
const home = path.join(tmp, "home")
const cfg = path.join(home, "config", "opencode")
const fakeBin = path.join(tmp, "bin")
const calls = path.join(tmp, "opencode-calls.log")
const ghCalls = path.join(tmp, "gh-calls.log")
const ocConfigOut = path.join(tmp, "oc-debug-config.json")
const logDir = path.join(tmp, "logs")
fs.mkdirSync(logDir, { recursive: true })

// Preload: any fetch throws. If doctor attempts the network, the output contains "network forbidden".
const preload = path.join(tmp, "no-network.mjs")
fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("network forbidden by the test") }\n')

write(path.join(fakeBin, "opencode"), `#!/bin/sh
echo "$*" >> "$CALLS"
case "$*" in
  "--version") echo "2.2.5" ;;
  "debug config") cat "$FAKE_OC_CONFIG" ;;
  "debug agents") echo "ceo" ;;
  "debug paths") echo "$FAKE_OC_LOGS" ;;
esac
exit 0
`)
write(path.join(fakeBin, "gh"), `#!/bin/sh
echo "$*" >> "$GH_CALLS"
exit 0
`)
write(path.join(cfg, "..", "gh", "hosts.yml"), "github.com:\n    user: testuser\n")

const baseEnv = {
  HOME: home,
  OPENCODE_CONFIG_DIR: cfg,
  OBSCURA_BIN_DIR: fakeBin, // already in PATH: no PATH warning
  PATH: [path.dirname(process.execPath), fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GH_CONFIG_DIR: path.join(home, "config", "gh"),
  FAKE_OC_CONFIG: ocConfigOut,
  FAKE_OC_LOGS: logDir,
  CALLS: calls,
  GH_CALLS: ghCalls,
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  OC_DOCTOR_OFFLINE: "1",
}
const resetSpies = () => { fs.writeFileSync(calls, ""); fs.rmSync(ghCalls, { force: true }) }
const runDoctor = ({ args = [], env = {}, shell = false } = {}) => {
  resetSpies()
  const cmd = shell ? "bash" : process.execPath
  const argv = shell ? [DOCTOR_SH, ...args] : [DOCTOR, ...args]
  return spawnSync(cmd, argv, { encoding: "utf8", cwd: ROOT, env: { ...baseEnv, ...env } })
}
const setConfig = ({ jsonc, agents = { ceo: "---\ndescription: Director\nmode: primary\n---\nPrompt.\n" }, ocJson = '{"default_agent":"ceo"}' }) => {
  fs.rmSync(cfg, { recursive: true, force: true })
  for (const [name, body] of Object.entries(agents)) write(path.join(cfg, "agents", `${name}.md`), body)
  fs.writeFileSync(path.join(cfg, "opencode.jsonc"), jsonc)
  fs.writeFileSync(ocConfigOut, ocJson)
}

const HEALTHY = `{
  // Test config: nothing that requires the network.
  "default_agent": "ceo",
  "model": "opencode-go/deepseek-v4.1-flash",
  "mcp": {
    "servers": {
      "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
      "kubernetes": { "type": "local", "command": ["/nonexistent/voluntarily/absent"], "disabled": true }
    }
  }
}
`

// ---------- 1. healthy config in offline mode (environment variable) ----------
setConfig({ jsonc: HEALTHY })
let r = runDoctor()
const out = r.stdout + r.stderr
check("offline: healthy config → exit code 0", r.status === 0, `code ${r.status} | ${out.slice(-600)}`)
check("offline: explicit banner displayed", /Offline mode: no network requests/.test(out))
check("offline: no fetch attempt (the network stub was not triggered)",
  !/network forbidden by the test/.test(out) && /model list not checked \(offline mode\)/.test(out), out)
check("offline: gh is not run (no trace of the fake gh)", !fs.existsSync(ghCalls), read(ghCalls))
check("offline: \"opencode mcp list\" never launched (avoids starting MCP servers)",
  !read(calls).includes("mcp list") && /online check skipped/.test(out), read(calls))
check("offline: local checks are still performed (version, debug config/agents/paths)",
  ["--version", "debug config", "debug agents", "debug paths"].every((c) => read(calls).includes(c)), read(calls))
check("offline: healthy config → 0 error", /0 error\(s\)/.test(out))
check("offline: disabled server not tested (missing binary tolerated)",
  /kubernetes \(disabled\)/.test(out) && !/kubernetes: .*not found/.test(out))

// ---------- 2. control: without --offline, the same test does detect the network ----------
r = runDoctor({ env: { OC_DOCTOR_OFFLINE: "" } })
const controlOut = r.stdout + r.stderr
check("control: outside offline mode, fetch is attempted (network stub triggered)",
  /network forbidden by the test/.test(controlOut), controlOut.slice(-500))
check("control: outside offline mode, gh and mcp list are called",
  fs.existsSync(ghCalls) && read(calls).includes("mcp list"), `gh=${read(ghCalls)} | ${read(calls)}`)

// ---------- 3. missing referenced agent → code 1 ----------
setConfig({ jsonc: '{\n  "default_agent": "ghost",\n  "mcp": { "servers": {} }\n}\n', ocJson: '{"default_agent":"ghost"}' })
r = runDoctor()
check("broken config (missing default_agent): code 1 and precise message",
  r.status === 1 && /default_agent "ghost" missing or not primary/.test(r.stdout), `code ${r.status} | ${r.stdout + r.stderr}`)

// ---------- 4. invalid JSON → code 1 ----------
setConfig({ jsonc: '{\n  "default_agent": "ceo",\n', ocJson: "{}" })
r = runDoctor()
check("broken config (invalid JSONC): code 1 and file reported unreadable",
  r.status === 1 && /opencode\.jsonc unreadable/.test(r.stdout), `code ${r.status} | ${r.stdout + r.stderr}`)

// ---------- 5. active MCP whose binary is missing → code 1 ----------
setConfig({
  jsonc: `{
  "default_agent": "ceo",
  "mcp": { "servers": {
    "ghost": { "type": "local", "command": ["/nonexistent/oc-ghost-mcp"] }
  } }
}
`,
})
r = runDoctor()
check("broken config (missing MCP binary): code 1 and server named",
  r.status === 1 && /ghost: "\/nonexistent\/oc-ghost-mcp" not found/.test(r.stdout), `code ${r.status} | ${r.stdout + r.stderr}`)

// ---------- 6. doctor.sh: forwards --offline and propagates the exit code ----------
setConfig({ jsonc: HEALTHY })
r = runDoctor({ args: ["--offline"], shell: true, env: { OC_DOCTOR_OFFLINE: "" } })
check("doctor.sh --offline: code 0 on a healthy config, offline banner",
  r.status === 0 && /Offline mode: no network requests/.test(r.stdout + r.stderr) && !fs.existsSync(ghCalls),
  `code ${r.status} | ${r.stdout + r.stderr}`)
setConfig({ jsonc: '{\n  "default_agent": "ceo",\n', ocJson: "{}" })
r = runDoctor({ args: ["--offline"], shell: true, env: { OC_DOCTOR_OFFLINE: "" } })
check("doctor.sh --offline: propagates code 1 from a broken config", r.status === 1, `code ${r.status}`)

// ---------- 7. --fix: re-enable a kit-disabled MCP when its prerequisite is back ----------
const cfgFile = path.join(cfg, "opencode.jsonc")
const fakeUvxDir = path.join(tmp, "uvxbin")
write(path.join(fakeUvxDir, "uvx"), "#!/bin/sh\nexit 0\n")
// PATH without uv/uvx/pipx: deterministic "prerequisite missing" even on a CI image that ships uv.
const noUvx = path.join(tmp, "no-uvx")
fs.mkdirSync(noUvx)
for (const dir of baseEnv.PATH.split(path.delimiter)) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { continue }
  for (const n of names) if (!["uv", "uvx", "pipx"].includes(n) && !fs.existsSync(path.join(noUvx, n))) {
    try { fs.symlinkSync(path.join(dir, n), path.join(noUvx, n)) } catch { /* ignored */ }
  }
}
const withUvx = [fakeUvxDir, noUvx, fakeBin].join(path.delimiter)
const withoutUvx = [noUvx, fakeBin].join(path.delimiter)
const tightTree = (dir) => {
  fs.chmodSync(dir, 0o700)
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    const st = fs.lstatSync(p)
    if (st.isDirectory()) tightTree(p)
    else if (st.isFile()) fs.chmodSync(p, 0o600)
  }
}
const backups = () => fs.readdirSync(cfg).filter((n) => n.includes(".bak-doctor-"))
const disabledLines = (text) => (text.match(/^\s*"disabled"\s*:\s*true\b.*$/gm) ?? []).length
const SEMGREP_OFF = `{
  "default_agent": "ceo",
  "mcp": { "servers": {
    "semgrep": {
      "type": "local",
      "command": ["${fakeBin}/oc-semgrep-mcp", "--stdio"],
      "disabled": true // install.sh: uv (uvx) and pipx missing
    }
  } }
}
`

setConfig({ jsonc: SEMGREP_OFF })
tightTree(cfg)
const semgrepBefore = read(cfgFile)
r = runDoctor({ args: ["--fix"], env: { PATH: withUvx } })
const semgrepAfter = read(cfgFile)
const semgrepBackups = backups()
check("--fix: semgrep re-enabled when its prerequisite (uvx) is present",
  r.status === 0 && parseJsonc(semgrepAfter).mcp.servers.semgrep.disabled === undefined && disabledLines(semgrepAfter) === 0,
  `code ${r.status} | ${r.stdout + r.stderr}`)
check("--fix: exactly one disabled line removed, rest of the file byte-identical",
  semgrepAfter === semgrepBefore.split("\n").filter((l) => !/^\s*"disabled"\s*:\s*true\b/.test(l)).join("\n"),
  `${semgrepBefore.split("\n").length} → ${semgrepAfter.split("\n").length} lines`)
check("--fix: opencode.jsonc backed up before the edit (same bytes, mode 600)",
  semgrepBackups.length === 1 && read(path.join(cfg, semgrepBackups[0])) === semgrepBefore
  && (fs.statSync(path.join(cfg, semgrepBackups[0])).mode & 0o777) === 0o600,
  semgrepBackups.join(", "))
check("--fix: summary fixed: 1, skipped: 0", /fixed: 1, skipped: 0/.test(r.stdout), r.stdout.slice(-300))

// ---------- 8. --fix: no prerequisite → config unchanged ----------
setConfig({ jsonc: SEMGREP_OFF })
tightTree(cfg)
const noPrereqBefore = read(cfgFile)
r = runDoctor({ args: ["--fix"], env: { PATH: withoutUvx } })
check("--fix without prerequisite: config byte-identical, no backup, semgrep still disabled",
  r.status === 0 && read(cfgFile) === noPrereqBefore && backups().length === 0 && disabledLines(read(cfgFile)) === 1,
  `code ${r.status} | ${r.stdout + r.stderr}`)
check("--fix without prerequisite: counted as skipped with the exact install command",
  /fixed: 0, skipped: 1/.test(r.stdout) && /semgrep: prerequisite still missing/.test(r.stdout) && /astral\.sh\/uv\/install\.sh/.test(r.stdout),
  r.stdout.slice(-400))

// ---------- 9. --fix --dry-run: reports, writes nothing ----------
setConfig({ jsonc: SEMGREP_OFF })
fs.chmodSync(cfg, 0o755); fs.chmodSync(cfgFile, 0o644)
const dryBefore = read(cfgFile)
r = runDoctor({ args: ["--fix", "--dry-run"], env: { PATH: withUvx } })
check("--dry-run: config and permissions untouched, no backup",
  r.status === 0 && read(cfgFile) === dryBefore && backups().length === 0
  && (fs.statSync(cfg).mode & 0o777) === 0o755 && (fs.statSync(cfgFile).mode & 0o777) === 0o644,
  `dir ${(fs.statSync(cfg).mode & 0o777).toString(8)} | file ${(fs.statSync(cfgFile).mode & 0o777).toString(8)}`)
check("--dry-run: announces the MCP fix, the permission fix and that nothing was written",
  /would fix: re-enable MCP semgrep/.test(r.stdout) && /would fix: permissions tightened/.test(r.stdout)
  && /Dry run: nothing was written/.test(r.stdout) && /fixed: 2, skipped: 0/.test(r.stdout),
  r.stdout.slice(-500))

// ---------- 10. default mode: still strictly read-only ----------
setConfig({ jsonc: SEMGREP_OFF })
fs.chmodSync(cfg, 0o755); fs.chmodSync(cfgFile, 0o644)
const roBefore = read(cfgFile)
r = runDoctor({ env: { PATH: withUvx } })
check("default mode: no write, no backup, permissions untouched, no fix summary",
  r.status === 0 && read(cfgFile) === roBefore && backups().length === 0
  && (fs.statSync(cfg).mode & 0o777) === 0o755 && (fs.statSync(cfgFile).mode & 0o777) === 0o644
  && !/fixed: \d+, skipped: \d+/.test(r.stdout),
  r.stdout.slice(-300))

// ---------- 11. --fix: config tree permissions tightened to 700/600 ----------
setConfig({ jsonc: '{\n  "default_agent": "ceo",\n  "mcp": { "servers": {} }\n}\n' })
fs.chmodSync(cfg, 0o755); fs.chmodSync(cfgFile, 0o644)
r = runDoctor({ args: ["--fix"], env: { PATH: withoutUvx } })
check("--fix: config directory 700 and opencode.jsonc 600",
  r.status === 0 && (fs.statSync(cfg).mode & 0o777) === 0o700 && (fs.statSync(cfgFile).mode & 0o777) === 0o600,
  `dir ${(fs.statSync(cfg).mode & 0o777).toString(8)} | file ${(fs.statSync(cfgFile).mode & 0o777).toString(8)}`)
check("--fix: permissions counted as one fix", /fixed: 1, skipped: 0/.test(r.stdout), r.stdout.slice(-300))

// ---------- 12. regression: HOME containing "/log" must not break the log read ----------
// A greedy /.../log... regex matched the "home /home/logan" line, then readFileSync() got a
// directory (EISDIR). The log path must come from the "log" line only.
setConfig({ jsonc: HEALTHY })
const logHome = path.join(tmp, "home-logan")
fs.mkdirSync(path.join(logHome, ".cache"), { recursive: true })
const realLogDir = path.join(tmp, "logs-real")
fs.mkdirSync(realLogDir, { recursive: true })
fs.writeFileSync(path.join(realLogDir, "opencode.log"), "timestamp=2026-01-01T00:00:00.000Z level=INFO msg=ok\n")
const pathsOut = `home ${logHome}\ndata ${path.join(logHome, ".local", "share", "opencode")}\nlog ${realLogDir}\n`
r = runDoctor({ env: { FAKE_OC_LOGS: pathsOut } })
const logOut = r.stdout + r.stderr
check("regression: home path containing /log does not break the log read",
  r.status === 0 && logOut.includes(`OpenCode log (${path.join(realLogDir, "opencode.log")})`), logOut.slice(-500))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ offline doctor OK (${passed} checks)`)
process.exit(failed ? 1 : 0)
