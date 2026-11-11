#!/usr/bin/env node
// Installation diagnostic: config, agents, MCP, tools, models, and what OpenCode actually loads.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseJsonc, frontmatter, mcpServers } from "./lib/jsonc.mjs"

// --offline / OC_DOCTOR_OFFLINE=1: strictly offline diagnostic. No network requests
// (model list, gh, MCP servers) and no probe that could trigger one
// (oc-semgrep-mcp --check, oc-android doctor). Local checks (files, binaries,
// "opencode debug config") are still performed.
const OFFLINE = process.argv.includes("--offline") || /^(1|true|yes)$/i.test(process.env.OC_DOCTOR_OFFLINE ?? "")
// --fix: after the diagnosis, apply only safe, reversible fixes (MCP re-enable + config
// permissions). --dry-run (with --fix) reports what would change without writing.
const FIX = process.argv.includes("--fix")
const DRY = process.argv.includes("--dry-run")
if (DRY && !FIX) { console.error("doctor: --dry-run requires --fix"); process.exit(1) }
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const MCP_STATE = path.join(SCRIPTS, "lib", "mcp-state.mjs")
const HOME = os.homedir()
const DEST = process.env.OPENCODE_CONFIG_DIR || path.join(HOME, ".config", "opencode")
const BIN = process.env.OBSCURA_BIN_DIR || path.join(HOME, ".local", "bin")
const env = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}` }
// Selected packs (installer marker): pack-specific checks run only when the pack is installed.
let packs = []
try {
  const m = fs.readFileSync(path.join(DEST, ".opencode-prerequisites.profile"), "utf8").match(/^packs=(.*)$/m)
  packs = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : []
} catch { /* no marker: no pack-specific check */ }
const hasPack = (p) => packs.includes(p)
let bad = 0, warned = 0
const ok = (m) => console.log(`✅ ${m}`)
const ko = (m) => { bad++; console.log(`❌ ${m}`) }
const wa = (m) => { warned++; console.log(`⚠️  ${m}`) }
const run = (cmd, args, t = 20000) => spawnSync(cmd, args, { encoding: "utf8", timeout: t, env })
// Find an executable in PATH WITHOUT calling "which" (missing from minimal Arch, Fedora and Rocky images)
const has = (c) => {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, c + ext), fs.constants.X_OK); return true } catch { /* try next */ }
    }
  }
  return false
}

// Readable output: merge consecutive identical lines (e.g. shim loops) and truncate.
const squash = (txt, max = 12) => {
  const out = []
  for (const l of (txt ?? "").split("\n").map((x) => x.trimEnd()).filter(Boolean)) {
    const last = out[out.length - 1]
    if (last && last.line === l) last.n++
    else out.push({ line: l, n: 1 })
  }
  const lines = out.map((o) => (o.n > 1 ? `${o.line}  (×${o.n})` : o.line))
  return lines.slice(0, max).join("\n") + (lines.length > max ? `\n… (${lines.length - max} more lines)` : "")
}

// opencode: call the real binary (mise/asdf shims can loop outside an interactive shell)
// and with the original environment (PATH unchanged).
const OC = (() => {
  if (has("mise")) {
    const r = spawnSync("mise", ["which", "opencode"], { encoding: "utf8", timeout: 10000 })
    const p = r.status === 0 ? r.stdout.trim().split("\n").pop() : ""
    if (p && fs.existsSync(p)) return p
  }
  return "opencode"
})()
const runOc = (args, t = 20000) => spawnSync(OC, args, { encoding: "utf8", timeout: t, env: process.env, maxBuffer: 1 << 22 })

let distro = os.platform()
try {
  const rel = fs.readFileSync("/etc/os-release", "utf8")
  distro = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? distro
} catch { /* macOS or other */ }
console.log(`System: ${distro} · Node ${process.versions.node}`)
if (OFFLINE) console.log("Offline mode: no network requests (models, gh and MCP servers not checked).")
console.log(`Config directory: ${DEST}\n`)
const pathDirs = (process.env.PATH ?? "").split(path.delimiter)
const binFirst = pathDirs[0] === BIN
const binInPath = pathDirs.includes(BIN)
if (binFirst) {
  console.log(`⚠️  ${BIN} is FIRST in your PATH: this can make mise/asdf shims loop (repeated "mise … tools: opencode@…" lines). Run  ./install.sh --no-tools --shell-env  again (it now appends it to PATH), then open a new terminal.`)
  warned++
}
if (!binInPath) {
  console.log(`⚠️  ${BIN} is not in your PATH: add  export PATH="${BIN}:$PATH"  to your ~/.bashrc / ~/.zshrc (obscura, trivy, agent-wt, oc-new-rust)`)
  warned++
}

// Node
const major = Number(process.versions.node.split(".")[0])
major >= 18 ? ok(`Node ${process.versions.node}`) : ko(`Node ${process.versions.node} too old (18+ required)`)

// OpenCode
let hasOc = has("opencode")
if (hasOc) {
  const v = runOc(["--version"], 15000)
  const ver = (v.stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0]
  ver ? ok(`opencode ${ver}${OC !== "opencode" ? ` (${OC})` : ""}`) : wa(`opencode responds but reports no version:\n${squash(v.stdout || v.stderr, 5)}`)
}
else ko("opencode not found (curl -fsSL https://opencode.ai/install | bash)")

// Config
let cfg
const cfgFile = ["opencode.jsonc", "opencode.json"].map((f) => path.join(DEST, f)).find(fs.existsSync)
if (!cfgFile) ko(`No config in ${DEST}: run ./install.sh`)
else {
  try { cfg = parseJsonc(fs.readFileSync(cfgFile, "utf8")); ok(`${path.basename(cfgFile)} readable`) }
  catch (e) { ko(`${path.basename(cfgFile)} unreadable: ${e.message}`) }
}

// Agents
const agents = {}
const adir = path.join(DEST, "agents")
if (fs.existsSync(adir)) for (const f of fs.readdirSync(adir).filter((x) => x.endsWith(".md"))) {
  agents[f.slice(0, -3)] = frontmatter(fs.readFileSync(path.join(adir, f), "utf8")) ?? {}
}
ok(`${Object.keys(agents).length} agents installed`)
if (cfg?.default_agent) {
  agents[cfg.default_agent]?.mode === "primary"
    ? ok(`default_agent "${cfg.default_agent}" present (primary)`)
    : ko(`default_agent "${cfg.default_agent}" missing or not primary`)
}
const skills = fs.existsSync(path.join(DEST, "skills")) ? fs.readdirSync(path.join(DEST, "skills")).length : 0
ok(`${skills} skills, ${fs.existsSync(path.join(DEST, "commands")) ? fs.readdirSync(path.join(DEST, "commands")).length : 0} commands`)

// Extra tools
for (const [c, why] of [["git", "worktrees (2.5+)"], ["gh", "/pr and GitHub search"], ["agent-wt", "per-agent worktrees"], ["oc-new-rust", "Rust template"]]) {
  has(c) ? ok(`${c} available`) : wa(`${c} not found (${why})`)
}
if (has("gh")) {
  const ghCfgDir = process.env.GH_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "gh")
  const ghUser = () => {
    try { return fs.readFileSync(path.join(ghCfgDir, "hosts.yml"), "utf8").match(/^\s+user:\s*(\S+)/m)?.[1] ?? "" } catch { return "" }
  }
  if (OFFLINE) {
    const user = ghUser()
    user
      ? ok(`gh configured for ${user} (not verified: offline mode)`)
      : wa(`gh present, not verified (offline mode): no account in ${ghCfgDir}/hosts.yml`)
  } else {
    // gh runs without stdin and without interaction (a subprocess cannot answer a keychain prompt or a login prompt).
    // If it still does not respond, read its config (hosts.yml): that proves an account is configured.
    const ghMs = Number(process.env.OC_DOCTOR_GH_TIMEOUT_MS || 10000)
    const ghRun = (args) => spawnSync("gh", args, {
      encoding: "utf8", timeout: ghMs, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    })
    const g = ghRun(["auth", "status"])
    if (g.status === 0) ok("gh logged in")
    else if (g.status === null) {
      const user = ghUser()
      user
        ? ok(`gh configured for ${user} (token not verified: gh does not respond when run from a script — keychain or interactive prompt; \`gh auth status\` in your terminal is authoritative)`)
        : wa(`gh does not respond (${g.error?.code ?? g.signal ?? "timeout"}) and no account found in ${ghCfgDir}/hosts.yml → gh auth login`)
    } else {
      const who = ghRun(["api", "user", "--jq", ".login"])
      const login = who.status === 0 ? (who.stdout ?? "").trim() : ""
      login
        ? ok(`gh logged in (${login}) — note: \`gh auth status\` returns code ${g.status} (see its output: gh auth status ; echo $?)`)
        : wa(`gh not logged in (code ${g.status}): ${squash(g.stderr || g.stdout, 4)}`)
    }
  }
}

// Enabled MCP servers: check their prerequisites
console.log("\nEnabled MCP servers:")
for (const [name, m] of Object.entries(mcpServers(cfg))) {
  if (m.enabled === false || m.disabled === true) {
    console.log(`   · ${name} (disabled)`)
    if (name === "rea") {
      if (OFFLINE) console.log("     (REA check skipped: offline mode)")
      else {
        const reaBin = path.join(HOME, ".local", "bin", "oc-rea-mcp")
        if (fs.existsSync(reaBin) && run(reaBin, ["--check"], 20000).status === 0) console.log("     Node is now suitable for REA: run ./install.sh --no-tools to enable it.")
        else console.log("     (REA requires Node >= 26.12.1, or 24.22.1 / 22.23.4: mise use -g node@26.12.1, then ./install.sh --no-tools)")
      }
    }
    if (name === "semgrep") console.log("     (check with oc-semgrep-mcp --check; if it responds, run ./install.sh to enable it)")
    continue
  }
  if (m.type === "remote") { ok(`${name} → ${m.url}`); continue }
  const expand = (x) => String(x).replace(/\{env:(\w+)\}/g, (_, k) => process.env[k] ?? "")
  const bin = expand(m.command?.[0] ?? "")
  if (!bin) { ko(`${name}: missing command`); continue }
  const exists = path.isAbsolute(bin) ? fs.existsSync(bin) : has(bin)
  if (!exists) { ko(`${name}: "${bin}" not found${path.isAbsolute(bin) ? " (run ./install.sh)" : ""}`); continue }

  if (bin.endsWith("oc-rea-mcp")) {
    // --check is local: it only validates the Node version REA requires, no npx, no download.
    const r = run(bin, ["--check"], 20000)
    const detail = squash(r.stderr || r.stdout, 6)
    r.status === 0
      ? ok(`${name}: Node ${process.versions.node} suitable (REA MCP ready)`)
      : ko(`${name}: ${detail || `--check failed (code ${r.status})`}`)
    continue
  }
  if (bin.endsWith("oc-terraform-mcp") || bin === "docker") {
    const installed = ["docker", "podman"].filter(has)
    if (!installed.length) { ko(`${name}: neither docker nor podman installed`); continue }
    if (OFFLINE) { wa(`${name}: ${installed.join("/")} installed (daemon not verified: offline mode)`); continue }
    const rt = installed.find((c) => run(c, ["info"], 10000).status === 0)
    rt ? ok(`${name}: ${rt} ready`)
       : wa(`${name}: ${installed.join("/")} installed but the daemon does not respond (Docker: sudo systemctl enable --now docker; your user must be in the docker group)`)
    continue
  }
  if (bin.endsWith("oc-playwright-mcp")) {
    const sys = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "brave"].find(has)
    const cache = path.join(HOME, ".cache", "ms-playwright")
    sys ? ok(`${name}: system browser (${sys})`)
        : fs.existsSync(cache) ? (() => {
            ok(`${name}: Playwright Chromium (${cache})`)
            const dirs = fs.readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-/.test(d))
            for (const d of dirs) {
              const base = path.join(cache, d)
              const exe = fs.readdirSync(base).map((x) => path.join(base, x, x.includes("headless") ? "headless_shell" : "chrome")).find(fs.existsSync)
              if (!exe || !has("ldd")) continue
              const missing = (run("ldd", [exe], 15000).stdout ?? "").split("\n").filter((l) => l.includes("not found")).map((l) => l.trim().split(" ")[0])
              if (missing.length) { wa(`${name}: missing libraries for ${d}: ${[...new Set(missing)].slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""} → simplest fix: a system Chromium (Arch/Omarchy: sudo pacman -S --needed chromium; Debian/Ubuntu: sudo npx playwright install-deps chromium)`); break }
            }
          })()
        : wa(`${name}: no browser (install chromium with your package manager, or run ./install.sh again)`)
    continue
  }
  if (bin.endsWith("oc-chrome-devtools-mcp")) {
    // The launcher owns the resolution order (OC_CHROME_PATH, PATH, Playwright cache):
    // --check resolves it locally and starts neither npx nor the MCP server.
    const r = run(bin, ["--check"], 15000)
    const detail = squash(r.stderr || r.stdout, 8)
    r.status === 0
      ? ok(`${name}: ${(r.stdout ?? "").trim()}`)
      : wa(`${name}: ${detail || `--check failed (code ${r.status})`}`)
    continue
  }
  if (bin.endsWith("oc-semgrep-mcp")) {
    if (OFFLINE) { wa(`MCP ${name}: --check not run (offline mode)`); continue }
    // The launcher actually starts the server and checks the MCP initialize handshake:
    // uvx being present proves nothing (semgrep-mcp 0.9.0 breaks with pydantic >= 2.12).
    // Extra margin beyond the launcher's internal 180 s: on first start uv may download
    // the packages (~50 MB) and a managed CPython (~30 MB); the launcher then reports a clear message.
    const ms = Number(process.env.OC_DOCTOR_SEMGREP_TIMEOUT_MS || 240000)
    const r = run(bin, ["--check"], ms)
    const detail = squash((r.stderr || r.stdout || "").trim(), 10)
    r.status === 0
      ? ok(`MCP ${name}: ${(r.stdout ?? "").trim() || "MCP server operational"}`)
      : ko(`MCP ${name}: the server does not start (--check ${r.status === null ? `interrupted after ${Math.round(ms / 1000)}s` : `code ${r.status}`})${detail ? `:\n${detail}` : ""}`)
    continue
  }
  ok(`${name}: ${bin} available`)
}

// REA (reverse pack): CLI launcher, real --version (cache or download), optional native engines.
// The MCP launcher itself is checked by the enabled-MCP loop above; this section adds the CLI
// and never treats a missing Ghidra/IDA/Hopper as an error (REA uses the engines already installed).
if (hasPack("reverse")) {
  console.log("\nREA (reverse pack):")
  const reaCli = path.join(BIN, "oc-rea")
  const reaMcp = path.join(BIN, "oc-rea-mcp")
  const missing = [reaCli, reaMcp].filter((f) => !fs.existsSync(f))
  if (missing.length) ko(`${missing.join(", ")} not found: run ./install.sh --no-tools`)
  else {
    const gate = run(reaCli, ["--check"], 20000)
    if (gate.status !== 0) {
      wa(`oc-rea not ready: ${squash(gate.stderr || gate.stdout, 4) || `--check failed (code ${gate.status})`}`)
    } else {
      ok("oc-rea ready (Node is suitable)")
      if (OFFLINE) console.log("   (oc-rea --version not run: offline mode; the first run downloads rea-agents)")
      else {
        const ms = Number(process.env.OC_DOCTOR_REA_TIMEOUT_MS || 60000)
        const r = run(reaCli, ["--version"], ms)
        const out = ((r.stdout || "").trim().split("\n").pop() || "").trim()
        r.status === 0
          ? ok(`oc-rea --version: ${out || "OK"}`)
          : wa(`oc-rea --version did not answer (${r.status === null ? `timeout after ${Math.round(ms / 1000)}s` : `code ${r.status}`}): the first run downloads rea-agents, run oc-rea --version once`)
      }
    }
  }
  const engines = [["Ghidra", ["ghidra", "analyzeHeadless"]], ["IDA", ["ida", "ida64", "idat", "idat64"]], ["Hopper", ["hopper", "Hopper"]]]
    .map(([label, names]) => [label, names.find(has)]).filter(([, exe]) => exe)
  engines.length
    ? ok(`native engines: ${engines.map(([label, exe]) => `${label} (${exe})`).join(", ")}`)
    : wa("no Ghidra/IDA/Hopper found: static JavaScript/.NET/APK analysis works; native engines are optional (REA uses the ones installed)")
}

// Android module (--android option): Podman toolchain
if (fs.existsSync(path.join(DEST, "android", "Containerfile"))) {
  console.log("\nAndroid module (Podman):")
  const oc = path.join(BIN, "oc-android")
  if (!fs.existsSync(oc)) ko(`${oc} not found: run ./install.sh --android`)
  else if (OFFLINE) wa("Android module: oc-android doctor not run (offline mode)")
  else {
    const r = run(oc, ["doctor"], 60000)
    const lines = ((r.stdout ?? "") + (r.stderr ?? "")).split("\n").map((l) => l.trim()).filter(Boolean)
    if (!lines.length) wa("oc-android doctor returned nothing")
    for (const l of lines) {
      if (l.startsWith("✅")) ok(l.slice(2).trim())
      else if (l.startsWith("❌")) wa(`${l.slice(1).trim()} (optional Android module)`)
      else if (l.startsWith("⚠️")) wa(l.replace(/^⚠️\s*/, ""))
      else console.log(`   · ${l.replace(/^ℹ️\s*/, "")}`)
    }
  }
}

// Plugins
const memPluginDir = path.join(DEST, "plugins", "mempalace")
const memEntry = path.join(HOME, ".mempalace", "plugin", "node_modules", "@rvboris", "opencode-mempalace", "dist", "plugin", "index.js")
if (fs.existsSync(memPluginDir) || [...(cfg?.plugins ?? []), ...(cfg?.plugin ?? [])].some((p) => String(Array.isArray(p) ? p[0] : p?.package ?? p).includes("mempalace"))) {
  const venvPy = path.join(HOME, ".mempalace", "venv", "bin", "python")
  const envPy = process.env.MEMPALACE_ADAPTER_PYTHON
  const py = envPy || (fs.existsSync(venvPy) ? venvPy : "python3")
  const t = run(py, ["-c", "import mempalace"], 15000)
  if (t.status !== 0) ko(`MemPalace not installed for ${py}: run ./install.sh --memory-only (or remove plugins/mempalace)`)
  else if (!envPy && fs.existsSync(venvPy) && /MEMPALACE_ADAPTER_PYTHON/.test(fs.existsSync(path.join(memPluginDir, "index.ts")) ? fs.readFileSync(path.join(memPluginDir, "index.ts"), "utf8") : "")) ok(`MemPalace importable (${py}); the plugin sets MEMPALACE_ADAPTER_PYTHON itself, independently of the shell`)
  else if (!envPy && fs.existsSync(venvPy)) wa(`MemPalace is in ${venvPy} but MEMPALACE_ADAPTER_PYTHON is not set: add  export MEMPALACE_ADAPTER_PYTHON="${venvPy}"  to your ~/.bashrc`)
  else ok(`MemPalace importable (${py})`)
  if (fs.existsSync(memPluginDir)) fs.existsSync(memEntry) ? ok("MemPalace plugin installed (npm, peer deps tolerated) and loaded as a local plugin") : ko(`plugins/mempalace points to ${memEntry}, which does not exist: run ./install.sh --memory-only`)
  else wa("MemPalace plugin declared through npm in the config: OpenCode fails on its peerDependencies (ERESOLVE): run ./install.sh to load it locally")
}
const pdir = path.join(DEST, "plugins")
if (fs.existsSync(pdir)) {
  const entries = fs.readdirSync(pdir)
  const dirs = entries.filter((x) => fs.statSync(path.join(pdir, x)).isDirectory())
  const loose = entries.filter((x) => !dirs.includes(x) && /\.(js|ts|mjs)$/.test(x))
  ok(`local plugins (v2 folders): ${dirs.join(", ") || "none"}`)
  if (loose.length) console.log(`   · loose files in plugins/: ${loose.join(", ")} (loaded if they default-export a v2 definition; OpenCode's Plugins panel is authoritative)`)
}

// Models
const wanted = new Set()
const add = (v) => v && /^opencode-go\//.test(v) && wanted.add(v)
add(cfg?.model); add(cfg?.small_model)
Object.values(cfg?.agent ?? {}).forEach((a) => add(a?.model))
Object.values(agents).forEach((a) => add(a.model))
if (OFFLINE) {
  wa(`model list not checked (offline mode). Models in use: ${[...wanted].join(", ") || "none"}. Check with /models.`)
} else {
  try {
    const res = await fetch("https://opencode.ai/inference/go/v1/models", { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    const ids = new Set((data.data ?? data).map?.((x) => `opencode-go/${x.id ?? x}`) ?? [])
    if (!ids.size) throw new Error("empty list")
    for (const m of wanted) ids.has(m) ? ok(`model ${m} exists`) : ko(`model ${m} NOT FOUND: fix it (/models)`)
  } catch (e) {
    wa(`model list could not be checked (${e.message}). Models in use: ${[...wanted].join(", ")}. Check with /models.`)
  }
}

// What OpenCode actually loads
if (hasOc) {
  console.log("\nOpenCode loading:")
  const r = runOc(["debug", "config"], 30000)
  if (r.status !== 0) ko(`opencode debug config failed (code ${r.status ?? "timeout"}):\n${squash(r.stderr || r.stdout)}`)
  else {
    ok("opencode debug config: configuration loaded without errors")
    // Values retained by OpenCode: look for the keys wherever they are (debug config format is not guaranteed)
    let rc = null
    for (const parse of [JSON.parse, parseJsonc]) { try { rc = parse(r.stdout); break } catch { /* try next */ } }
    const deepFind = (o, key, depth = 0) => {
      if (!o || typeof o !== "object" || depth > 6) return undefined
      if (key in o) return o[key]
      for (const v of Object.values(o)) { const f = deepFind(v, key, depth + 1); if (f !== undefined) return f }
      return undefined
    }
    if (!rc || typeof rc !== "object") wa(`debug config output unreadable (cannot compare):\n${squash(r.stdout, 4)}`)
    else {
      const da = deepFind(rc, "default_agent") ?? deepFind(rc, "defaultAgent")
      const md = deepFind(rc, "model")
      if (cfg?.default_agent && da !== undefined) da === cfg.default_agent ? ok(`default_agent retained: ${da}`) : ko(`default_agent expected "${cfg.default_agent}", OpenCode has "${da}"`)
      if (cfg?.model && md !== undefined && typeof md === "string") md === cfg.model ? ok(`model retained: ${md}`) : wa(`model expected ${cfg.model}, OpenCode has "${md}" (a project config can override it)`)
      if (da === undefined && md === undefined) console.log(`   (debug config: root keys seen → ${Object.keys(rc).slice(0, 15).join(", ")})`)
    }
  }

  // MCP servers: real state as seen by OpenCode (one line per server).
  // In offline mode, "mcp list" would start the servers (network): skip it explicitly.
  if (OFFLINE) {
    console.log("   (MCP: online check skipped in offline mode)")
  } else {
    const m = runOc(["mcp", "list"], 60000)
    const clean = (t) => (t ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    const rows = clean(m.stdout || m.stderr).split("\n").map((l) => l.match(/^\s*([✓✗])\s+([\w.-]+)\s+(.*)$/)).filter(Boolean)
    if (!rows.length) console.log(squash(clean(m.stdout || m.stderr)).split("\n").map((l) => "   " + l).join("\n"))
    else {
      const kc = (process.env.KUBECONFIG ?? path.join(HOME, ".kube", "config")).split(path.delimiter)[0]
      const hasKube = fs.existsSync(kc) && /^current-context:\s*\S+/m.test(fs.readFileSync(kc, "utf8"))
      for (const [, mark, name, rest] of rows) {
        const why = rest.replace(/\s+/g, " ").slice(0, 130)
        if (mark === "✓") ok(`MCP ${name}: ${why}`)
        else if (name === "kubernetes" && !hasKube) wa(`MCP kubernetes: no kubectl context (${kc}): the server exits on startup. Disable it ("disabled": true) or configure a cluster.`)
        else ko(`MCP ${name}: ${why}`)
      }
      const seen = new Set(rows.map((x) => x[2]))
      const missing = Object.entries(mcpServers(cfg)).filter(([k, v]) => !v.disabled && v.enabled !== false && !seen.has(k)).map(([k]) => k)
      if (missing.length) ko(`OpenCode does not list these MCP servers: ${missing.join(", ")}`)
    }
  }
  if (cfg?.default_agent) {
    const a = runOc(["debug", "agents"], 20000)
    const txt = `${a.stdout ?? ""}${a.stderr ?? ""}`
    a.status !== 0 ? wa(`opencode debug agents unavailable (code ${a.status ?? "timeout"}):\n${squash(txt, 4)}`)
      : txt.includes(cfg.default_agent) ? ok(`agent ${cfg.default_agent} known to OpenCode`)
      : ko(`agent ${cfg.default_agent} missing from OpenCode's list (debug agents). Check ${path.join(DEST, "agents")}`)
  }
}

// OpenCode processes started BEFORE the last installation: an already running server keeps its old environment and
// old plugins (it does not reload them), even when the files are up to date. This is the most common cause of "still not working".
let staleProcs = []
if (hasOc && process.platform !== "win32") {
  const stampFiles = [".opencode-prerequisites.installed", ".opencode-prerequisites.manifest"].map((f) => path.join(DEST, f)).filter(fs.existsSync)
  const since = stampFiles.length ? Math.max(...stampFiles.map((f) => fs.statSync(f).mtimeMs)) : 0
  if (since) {
    const stale = []
    for (const l of (run("ps", ["-eo", "pid=,lstart=,args="], 10000).stdout ?? "").split("\n")) {
      const m = l.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/)
      if (!m) continue
      const [, pid, lstart, args] = m
      if (Number(pid) === process.pid || /doctor\.mjs|ps -eo/.test(args)) continue
      const isOpencode = path.basename(args.split(/\s+/)[0]) === "opencode" || /node_modules\/\.bin\/opencode(\s|$)/.test(args)
      const started = Date.parse(lstart)
      if (isOpencode && started && started < since) stale.push(`PID ${pid} (started ${lstart.replace(/\s+/g, " ")})`)
    }
    staleProcs = stale
    if (stale.length) {
      wa(`OpenCode has been running since before the kit's last installation: ${stale.join(", ")}. It reloads NEITHER plugins NOR the environment: restart it (per your feedback: opencode service restart; otherwise close every OpenCode window and start it again).`)
    }
  }
}

// OpenCode log: plugin failure reasons (the Plugins panel only shows "failed")
if (hasOc) {
  const dp = runOc(["debug", "paths"], 15000)
  // Read the "log" line only: a greedy "/.../log..." regex matched $HOME (/home/logan) when the
  // user name starts with "log", and readFileSync() then got a directory (EISDIR).
  const logDir = ((dp.stdout ?? "") + (dp.stderr ?? "")).split("\n").map((l) => l.match(/^\s*log\s+(\/\S+)\s*$/)?.[1]).find((p) => p && fs.existsSync(p) && fs.statSync(p).isDirectory())
  if (logDir) {
    const files = fs.readdirSync(logDir).map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    if (files[0]) {
      const buf = fs.readFileSync(path.join(logDir, files[0].f), "utf8").slice(-300000)
      // Marker = end of the last installation (the .installed file is written last; otherwise the file list)
      const stamps = [".opencode-prerequisites.installed", ".opencode-prerequisites.manifest"].map((f) => path.join(DEST, f)).filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs)
      const since = stamps.length ? Math.max(...stamps) : 0
      const lines = buf.split("\n").filter((l) => /plugin|mempalace|guard|notify/i.test(l) && /fail|error|cannot|unable|not found|denied/i.test(l))
      const stamp = (l) => Date.parse(l.match(/timestamp=(\S+)/)?.[1] ?? "") || 0
      const recent = lines.filter((l) => stamp(l) > since).slice(-6)
      const old = lines.length - lines.filter((l) => stamp(l) > since).length
      console.log(`\nOpenCode log (${path.join(logDir, files[0].f)}):`)
      if (recent.length) recent.forEach((l) => wa(`plugin: ${l.trim().replace(/^timestamp=\S+\s+/, "").slice(0, 420)}`))
      else ok(`no plugin error since the kit's last installation${old ? ` (${old} older line(s) ignored, before ${new Date(since).toLocaleString()})` : ""}`)
      const lastWrite = files[0].t
      if (lastWrite < since) console.log(`   (OpenCode has not written to its log since the installation: restart it to check the plugins)`)
    }
  } else console.log("\n(OpenCode log not found: `opencode debug paths` to see where it is)")
}

// Safe fixes (--fix): only reversible changes to the kit's own configuration. Never edit shell
// files, never install a tool, never touch a running process: those are printed as commands.
// --dry-run reports the same actions without writing anything (no backup either).
if (FIX) {
  console.log("\nSafe fixes (--fix):")
  let fixed = 0, skipped = 0
  const applied = (m) => { fixed++; console.log(`${DRY ? "🔎 would fix" : "✅ fixed"}: ${m}`) }
  const skip = (m) => { skipped++; console.log(`   · skipped: ${m}`) }

  // --- MCP servers disabled by install.sh whose prerequisite is now present ---
  const kubeconfig = (process.env.KUBECONFIG || path.join(HOME, ".kube", "config")).split(path.delimiter)[0]
  const reaBin = path.join(BIN, "oc-rea-mcp")
  const prerequisite = {
    kubernetes: () => {
      try { return /^current-context:\s*\S+/m.test(fs.readFileSync(kubeconfig, "utf8")) } catch { return false }
    },
    rea: () => fs.existsSync(reaBin) && run(reaBin, ["--check"], 20000).status === 0,
    mobile: () => fs.existsSync(path.join(DEST, "android", "Containerfile")) && has("podman"),
    semgrep: () => has("uvx") || has("pipx"),
  }
  const hint = {
    kubernetes: `configure a context (kubectl config use-context …) then run ./doctor.sh --fix`,
    rea: `update Node (mise use -g node@26.12.1), then run ./doctor.sh --fix`,
    mobile: `install the Android module and Podman (./install.sh --android), then run ./doctor.sh --fix`,
    semgrep: `install uv (curl -LsSf https://astral.sh/uv/install.sh | sh), then run ./doctor.sh --fix`,
  }
  const disabledMcps = Object.entries(mcpServers(cfg ?? {})).filter(([, m]) => m && (m.disabled === true || m.enabled === false))
  if (disabledMcps.length && !cfgFile) {
    skip(`no config file in ${DEST}: run ./install.sh`)
  } else if (disabledMcps.length) {
    let backup = ""
    const backupOnce = () => {
      if (backup) return backup
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")
      let p = `${cfgFile}.bak-doctor-${stamp}`, n = 2
      while (fs.existsSync(p)) p = `${cfgFile}.bak-doctor-${stamp}-${n++}`
      fs.copyFileSync(cfgFile, p)
      try { fs.chmodSync(p, 0o600) } catch { /* best effort */ }
      backup = p
      console.log(`💾 backup: ${p}`)
      return p
    }
    for (const [name, m] of disabledMcps) {
      if (m.disabled !== true) {
        skip(`${name} uses "enabled": false (mcp-state edits "disabled" only): remove that line by hand`)
        continue
      }
      if (!(name in prerequisite)) {
        console.log(`   · ${name}: disabled, not a kit-managed prerequisite (left as is)`)
        continue
      }
      if (!prerequisite[name]()) {
        skip(`${name}: prerequisite still missing — ${hint[name]}`)
        continue
      }
      if (DRY) {
        applied(`re-enable MCP ${name} (prerequisite detected)`)
        continue
      }
      backupOnce()
      const r = spawnSync(process.execPath, [MCP_STATE, "enable", cfgFile, name], { encoding: "utf8", timeout: 15000 })
      if (r.status === 0) applied(`MCP ${name} re-enabled`)
      else skip(`MCP ${name}: mcp-state failed (code ${r.status})${(r.stderr || r.stdout || "").trim() ? `: ${(r.stderr || r.stdout).trim()}` : ""}`)
    }
  }

  // --- Config tree permissions: directories 700, files 600 when group/other bits are set ---
  if (fs.existsSync(DEST)) {
    const loose = []
    let dirs = 0, files = 0
    const walk = (p) => {
      let st
      try { st = fs.lstatSync(p) } catch { return }
      if (st.isSymbolicLink()) return
      if (st.isDirectory()) {
        if ((st.mode & 0o077) !== 0) { loose.push([p, 0o700]); dirs++ }
        let entries = []
        try { entries = fs.readdirSync(p) } catch { return }
        for (const e of entries) walk(path.join(p, e))
      } else if (st.isFile() && (st.mode & 0o077) !== 0) {
        loose.push([p, 0o600]); files++
      }
    }
    walk(DEST)
    if (loose.length) {
      let done = 0
      if (!DRY) for (const [p, mode] of loose) {
        try { fs.chmodSync(p, mode); done++ }
        catch (e) { console.log(`   · ${path.relative(DEST, p) || "."}: chmod failed (${e.message})`) }
      }
      if (DRY || done) applied(`permissions tightened: ${dirs} dir(s) → 700, ${files} file(s) → 600${DRY ? " (would apply)" : ""}`)
      if (!DRY && done < loose.length) skip(`${loose.length - done} path(s) could not be tightened`)
    }
  }

  // --- Never automatic: shell files, tools, running processes ---
  if (binFirst) skip(`PATH order: ${BIN} is first — run ./install.sh --no-tools --shell-env, then open a new terminal`)
  else if (!binInPath) skip(`PATH: ${BIN} is missing — run ./install.sh --no-tools --shell-env, then open a new terminal`)
  if (!hasOc) skip(`opencode is missing — curl -fsSL https://opencode.ai/install | bash`)
  if (major < 18) skip(`Node ${process.versions.node} is too old — install Node 18+ (mise use -g node@26.12.1), then open a new terminal`)
  if (staleProcs.length) skip(`OpenCode running since before the installation (${staleProcs.join(", ")}) — systemctl --user restart opencode, or close every OpenCode window and start it again`)

  console.log(`\n${DRY ? "Dry run: nothing was written. " : ""}fixed: ${fixed}, skipped: ${skipped}`)
}

console.log(`\n${bad ? "❌" : "✅"} ${bad} error(s), ${warned} warning(s)`)
process.exit(bad ? 1 : 0)
