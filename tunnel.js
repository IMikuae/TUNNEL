#!/usr/bin/env node
/*
 * TUNNEL - Cloudflare Tunnel helper
 *
 * Satu file, tanpa dependency. Menjalankan web lokal ke internet lewat
 * Cloudflare Tunnel dengan 3 mode:
 *   1. token   - named tunnel pakai token (paling aman, recommended)
 *   2. config  - pakai .cloudflared/config.yml (ingress rules)
 *   3. quick   - URL acak *.trycloudflare.com (dev / tanpa akun)
 *
 * Binary cloudflared diunduh otomatis (versi terbaru) ke ./bin sesuai OS/arch.
 *
 * Pemakaian:
 *   node tunnel.js                     menu interaktif
 *   node tunnel.js --mode quick        langsung quick tunnel
 *   node tunnel.js --mode token --token <token>
 *   node tunnel.js --mode config --config .cloudflared/config.yml
 *   node tunnel.js --check             cek/unduh binary saja
 *
 * Butuh Node.js 18+.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");

const VERSION = "1.0.0";
const CWD = process.cwd();
const IS_WIN = process.platform === "win32";
const BIN_DIR = path.join(CWD, "bin");
const BIN_NAME = IS_WIN ? "cloudflared.exe" : "cloudflared";
const DEFAULT_BIN = path.join(BIN_DIR, BIN_NAME);
const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

// ---------------------------------------------------------------- utils

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const cyan = (s) => paint("36", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n  ${red("[!]")} ${msg}\n`);
  process.exit(1);
}

function rel(p) {
  const r = path.relative(CWD, p);
  return r && !r.startsWith("..") ? r : p;
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    mode: null,
    token: null,
    config: null,
    port: null,
    tunnelName: null,
    spawn: null,
    yes: false,
    check: false,
    forceDownload: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) fail(`Nilai untuk ${a} kosong.`);
      return v;
    };

    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      case "--mode":
        opts.mode = next().toLowerCase();
        break;
      case "--token":
        opts.token = next();
        opts.mode = opts.mode || "token";
        break;
      case "--config":
        opts.config = next();
        opts.mode = opts.mode || "config";
        break;
      case "--tunnel":
        opts.tunnelName = next();
        break;
      case "-p":
      case "--port":
        opts.port = Number(next());
        break;
      case "--quick":
      case "--dev":
      case "--url":
        opts.mode = "quick";
        break;
      case "--spawn":
        opts.spawn = true;
        break;
      case "--no-spawn":
        opts.spawn = false;
        break;
      case "--start":
        opts.yes = true;
        opts.spawn = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--check":
      case "--doctor":
        opts.check = true;
        break;
      case "--force-download":
        opts.forceDownload = true;
        break;
      default:
        if (a.startsWith("-")) fail(`Opsi tidak dikenal: ${a} (lihat --help)`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
  ${bold("TUNNEL")} v${VERSION} - Cloudflare Tunnel helper

  ${bold("Pemakaian")}
    node tunnel.js                          menu interaktif
    node tunnel.js --mode quick             quick tunnel (URL acak)
    node tunnel.js --mode token --token X   named tunnel (recommended)
    node tunnel.js --mode config            pakai .cloudflared/config.yml
    node tunnel.js --check                  unduh / cek binary saja

  ${bold("Opsi")}
    --mode <token|config|quick>   pilih mode tanpa menu
    --token <token>               token tunnel (atau env TUNNEL_TOKEN)
    --config <path>               path config.yml
    --tunnel <name>               nama tunnel untuk mode config
    --port, -p <n>                port web lokal (auto-deteksi kalau kosong)
    --spawn                       jalankan index.js/server.js otomatis
    --no-spawn                    jangan jalankan server lokal
    --start, -y                   non-interaktif: auto mode + spawn
    --force-download              unduh ulang cloudflared
    --check                       cek binary lalu keluar
    --help, -h                    bantuan
    --version, -v                 versi

  ${bold("Env")}
    TUNNEL_TOKEN                  token tunnel
    CLOUDFLARED_PATH              pakai binary cloudflared tertentu
    NO_COLOR=1                    matikan warna

  Binary disimpan di ${cyan("bin/cloudflared" + (IS_WIN ? ".exe" : ""))} (sesuai OS/arch).
`);
}

// ---------------------------------------------------------------- prompt

let rl = null;
let stdinClosed = false;

function ask(prompt) {
  return new Promise((resolve) => {
    if (!rl || stdinClosed) return resolve("");
    rl.question(prompt, (ans) => resolve(ans.trim()));
  });
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!rl || stdinClosed) return resolve("");
    let muted = false;
    const original = rl._writeToOutput;
    rl._writeToOutput = function (s) {
      if (muted) return;
      original.call(rl, s);
    };
    rl.question(prompt, (ans) => {
      rl._writeToOutput = original;
      process.stdout.write("\n");
      resolve(ans.trim());
    });
    muted = true;
  });
}

function closePrompt() {
  if (rl && !stdinClosed) {
    stdinClosed = true;
    rl.close();
    rl = null;
  }
}

// ---------------------------------------------------------------- env file

function readEnvValue(file, key) {
  try {
    const txt = fs.readFileSync(path.resolve(CWD, file), "utf8");
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
    if (!m) return null;
    return m[1].trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

function writeEnvValue(file, key, value) {
  const p = path.resolve(CWD, file);
  let txt = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(txt)) txt = txt.replace(re, `${key}=${value}`);
  else txt = txt.replace(/\s*$/, "") + `\n${key}=${value}\n`;
  fs.writeFileSync(p, txt);
}

// ---------------------------------------------------------------- platform

function detectAsset() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    "win32-x64": { file: "cloudflared-windows-amd64.exe", kind: "exe" },
    "win32-arm64": { file: "cloudflared-windows-arm64.exe", kind: "exe" },
    "linux-x64": { file: "cloudflared-linux-amd64", kind: "bin" },
    "linux-arm64": { file: "cloudflared-linux-arm64", kind: "bin" },
    "linux-arm": { file: "cloudflared-linux-arm", kind: "bin" },
    "linux-ia32": { file: "cloudflared-linux-386", kind: "bin" },
    "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", kind: "tgz" },
    "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", kind: "tgz" },
  };
  return map[key] || null;
}

function findOnPath(cmd) {
  const probe = spawnSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  return (
    (probe.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || null
  );
}

function binVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split(/\r?\n/)[0];
  return out || "versi tidak diketahui";
}

// ---------------------------------------------------------------- download

async function downloadFile(url, dest) {
  if (typeof fetch !== "function") {
    fail("Butuh Node.js 18+ (fetch tidak tersedia).");
  }

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": `tunnel-helper/${VERSION}` },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") || 0);
  const tty = Boolean(process.stdout.isTTY);
  let got = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const body = Readable.fromWeb(res.body);

    body.on("data", (chunk) => {
      got += chunk.length;
      if (tty && total) {
        const pct = Math.min(100, Math.round((got / total) * 100));
        process.stdout.write(`\r  mengunduh ${mb(got)} / ${mb(total)} (${pct}%)   `);
      }
    });
    body.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    body.pipe(out);
  });

  if (tty && total) process.stdout.write("\n");
}

async function downloadCloudflared() {
  const asset = detectAsset();
  if (!asset) {
    fail(
      `Platform belum didukung: ${process.platform}-${process.arch}. ` +
        `Unduh manual dari https://github.com/cloudflare/cloudflared/releases lalu taruh di ${rel(DEFAULT_BIN)}`
    );
  }

  console.log(
    `  ${cyan("->")} binary belum ada, mengunduh cloudflared terbaru (${process.platform}-${process.arch}) ...`
  );
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = `${RELEASE_BASE}/${asset.file}`;

  if (asset.kind === "tgz") {
    const tmp = path.join(BIN_DIR, `.cloudflared-${Date.now()}.tgz`);
    await downloadFile(url, tmp);
    const r = spawnSync("tar", ["-xzf", tmp, "-C", BIN_DIR], { stdio: "ignore" });
    fs.rmSync(tmp, { force: true });
    if (r.status !== 0) fail("Gagal mengekstrak .tgz (butuh perintah tar).");
    const extracted = path.join(BIN_DIR, "cloudflared");
    if (extracted !== DEFAULT_BIN && fs.existsSync(extracted)) {
      fs.renameSync(extracted, DEFAULT_BIN);
    }
  } else {
    const tmp = `${DEFAULT_BIN}.part`;
    await downloadFile(url, tmp);
    fs.renameSync(tmp, DEFAULT_BIN);
  }

  if (!IS_WIN) fs.chmodSync(DEFAULT_BIN, 0o755);

  const check = spawnSync(DEFAULT_BIN, ["--version"], { encoding: "utf8" });
  if (check.status !== 0) {
    fs.rmSync(DEFAULT_BIN, { force: true });
    fail("Binary hasil unduhan tidak bisa dijalankan. Coba --force-download atau unduh manual.");
  }

  console.log(`  ${green("[ok]")} tersimpan: ${rel(DEFAULT_BIN)}`);
}

async function ensureCloudflared(opts) {
  if (process.env.CLOUDFLARED_PATH) {
    const p = process.env.CLOUDFLARED_PATH;
    if (!fs.existsSync(p)) fail(`CLOUDFLARED_PATH tidak ditemukan: ${p}`);
    console.log(`  ${green("[ok]")} cloudflared dari CLOUDFLARED_PATH`);
    return p;
  }

  if (!opts.forceDownload && fs.existsSync(DEFAULT_BIN)) {
    console.log(`  ${green("[ok]")} binary ditemukan: ${rel(DEFAULT_BIN)}`);
    return DEFAULT_BIN;
  }

  if (!opts.forceDownload) {
    const sys = findOnPath("cloudflared");
    if (sys) {
      console.log(`  ${green("[ok]")} cloudflared dari PATH`);
      return sys;
    }
  }

  await downloadCloudflared();
  return DEFAULT_BIN;
}

// ---------------------------------------------------------------- ports

function detectListeningPorts() {
  const ports = new Set();

  try {
    if (IS_WIN) {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout || "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING/i);
        if (m) ports.add(Number(m[1]));
      }
      return [...ports];
    }

    if (process.platform === "darwin") {
      const out = spawnSync("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }).stdout || "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) ports.add(Number(m[1]));
      }
      return [...ports];
    }

    let out = spawnSync("ss", ["-ltn"], { encoding: "utf8" }).stdout || "";
    if (!out.trim()) out = spawnSync("netstat", ["-ltn"], { encoding: "utf8" }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      if (!/^LISTEN/i.test(line.trim())) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[3];
      const m = local && local.match(/:(\d+)$/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

function probePort(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await probePort(port, 500)) return true;
    await sleep(500);
  }
  return false;
}

function validPort(n) {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

// ---------------------------------------------------------------- entry

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(CWD, file), "utf8"));
  } catch {
    return null;
  }
}

function findEntry() {
  const candidates = [
    "index.js",
    "server.js",
    "app.js",
    "main.js",
    "src/index.js",
    "src/server.js",
    "server/index.js",
    "dist/index.js",
  ];

  for (const file of candidates) {
    if (fs.existsSync(path.join(CWD, file))) {
      return { cmd: process.execPath, args: [file], label: file, shell: false };
    }
  }

  const pkg = readJson("package.json");
  if (pkg) {
    if (pkg.main && fs.existsSync(path.join(CWD, pkg.main))) {
      return { cmd: process.execPath, args: [pkg.main], label: pkg.main, shell: false };
    }
    if (pkg.scripts && pkg.scripts.start) {
      return { cmd: "npm", args: ["start"], label: "npm start", shell: true };
    }
    if (pkg.scripts && pkg.scripts.dev) {
      return { cmd: "npm", args: ["run", "dev"], label: "npm run dev", shell: true };
    }
  }

  return null;
}

// ---------------------------------------------------------------- process helper

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (!child || !child.pid || child.killed) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  closePrompt();
  console.log(`\n  ${dim("menghentikan tunnel ...")}`);
  for (const child of [...children].reverse()) killTree(child);
  setTimeout(() => process.exit(code), 350);
}

function attachPrefix(stream, prefix, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (data) => {
    buf += data;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      process.stdout.write(prefix + line + "\n");
      if (onLine) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buf) process.stdout.write(prefix + buf + "\n");
  });
}

function startEntry(entry) {
  console.log(`  ${cyan("->")} menjalankan ${bold(entry.label)} ...`);
  const child = spawn(entry.cmd, entry.args, {
    cwd: CWD,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: entry.shell,
  });
  children.push(child);
  attachPrefix(child.stdout, dim("  [app] "));
  attachPrefix(child.stderr, dim("  [app] "));
  child.on("exit", (code) => {
    if (!shuttingDown) console.log(`  ${yellow("[!]")} ${entry.label} berhenti (code ${code})`);
  });
  return child;
}

// ---------------------------------------------------------------- modes

function detectConfig() {
  const list = [
    path.join(CWD, ".cloudflared", "config.yml"),
    path.join(CWD, ".cloudflared", "config.yaml"),
    path.join(os.homedir(), ".cloudflared", "config.yml"),
    path.join(os.homedir(), ".cloudflared", "config.yaml"),
  ];
  for (const file of list) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function tunnelNameFromConfig(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const m = txt.match(/^\s*tunnel:\s*["']?([^"'\s#]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function chooseMode() {
  console.log("");
  console.log(`  ${bold("Pilih mode:")}`);
  console.log(`    ${cyan("1")}) Token          ${dim("- paling aman, pakai token dashboard (recommended)")}`);
  console.log(`    ${cyan("2")}) Config/ingress ${dim("- pakai .cloudflared/config.yml")}`);
  console.log(`    ${cyan("3")}) Quick/dev      ${dim("- URL acak *.trycloudflare.com, tanpa akun")}`);
  console.log("");

  const ans = (await ask("  Mode [1]: ")) || "1";
  if (ans === "1" || /^tok/i.test(ans)) return "token";
  if (ans === "2" || /^con|^ing/i.test(ans)) return "config";
  if (ans === "3" || /^qui|^dev|^url/i.test(ans)) return "quick";
  fail("Pilihan mode tidak valid.");
}

async function choosePort(opts, interactive) {
  if (opts.port != null) {
    if (!validPort(opts.port)) fail(`Port tidak valid: ${opts.port}`);
    return opts.port;
  }

  const detected = detectListeningPorts().filter((p) => p >= 1024 && p <= 65535);
  const preferred = [3000, 3001, 5173, 8080, 8000, 5000, 4000, 4200, 4321, 20128, 8081];
  const guess = preferred.find((p) => detected.includes(p)) || detected[0] || 3000;

  if (!interactive) return guess;

  if (detected.length) console.log(dim(`  Port terdeteksi: ${detected.join(", ")}`));
  const ans = await ask(`  Port web lokal [${guess}]: `);
  const port = ans ? Number(ans) : guess;
  if (!validPort(port)) fail(`Port tidak valid: ${ans}`);
  return port;
}

async function chooseConfig(opts, interactive) {
  let cfg = opts.config ? path.resolve(CWD, opts.config) : detectConfig();

  if (cfg && !fs.existsSync(cfg)) fail(`Config tidak ditemukan: ${cfg}`);

  if (!cfg) {
    if (!interactive) fail("Config tidak ditemukan. Pakai --config <path>.");
    console.log(`  ${yellow("[!]")} config.yml tidak ditemukan.`);
    console.log(dim("      Contoh: .cloudflared/config.yml atau ~/.cloudflared/config.yml"));
    const ans = await ask("  Path config (kosong = batal): ");
    if (!ans) fail("Dibatalkan.");
    cfg = path.resolve(CWD, ans);
    if (!fs.existsSync(cfg)) fail(`Config tidak ditemukan: ${cfg}`);
  }

  console.log(`  ${green("[ok]")} config: ${rel(cfg)}`);
  return cfg;
}

async function chooseToken(opts, interactive) {
  let token = opts.token || process.env.TUNNEL_TOKEN || readEnvValue(".env", "TUNNEL_TOKEN");
  let manual = false;

  if (!token) {
    if (!interactive) {
      fail("Token tidak ada. Pakai --token <token> atau set env TUNNEL_TOKEN.");
    }
    console.log(dim("  Buat token: dash.cloudflare.com -> Zero Trust -> Networks -> Tunnels -> Create"));
    token = await askHidden("  Tempel token tunnel: ");
    manual = true;
  }

  if (!token) fail("Token kosong.");
  console.log(`  ${green("[ok]")} token: ${dim("****" + token.slice(-4))}`);

  if (manual && interactive) {
    const save = await ask("  Simpan token ke .env? [y/N]: ");
    if (/^y/i.test(save)) {
      writeEnvValue(".env", "TUNNEL_TOKEN", token);
      console.log(`  ${green("[ok]")} disimpan di .env ${dim("(pastikan .env masuk .gitignore)")}`);
    }
  }

  return token;
}

async function decideSpawn(opts, port, interactive) {
  if (await probePort(port)) {
    console.log(`  ${green("[ok]")} sudah ada server di http://localhost:${port}`);
    return null;
  }

  if (opts.spawn === false) {
    console.log(`  ${yellow("[!]")} tidak ada server di port ${port} (--no-spawn).`);
    return null;
  }

  const entry = findEntry();
  if (!entry) {
    console.log(`  ${yellow("[!]")} tidak ada index.js / server.js / npm start. Jalankan server manual.`);
    return null;
  }

  if (opts.spawn === true || opts.yes || !interactive) return entry;

  const ans = await ask(`  Belum ada server di port ${port}. Jalankan ${bold(entry.label)}? [Y/n]: `);
  if (/^n/i.test(ans)) return null;
  return entry;
}

function buildTunnelArgs(mode, opts, port, configPath) {
  const base = ["tunnel", "--no-autoupdate"];

  if (mode === "token") {
    return [...base, "run", "--token", opts.token];
  }

  if (mode === "config") {
    const args = [...base, "--config", configPath, "run"];
    if (opts.tunnelName) args.push(opts.tunnelName);
    return args;
  }

  return [...base, "--url", `http://localhost:${port}`];
}

function startTunnel(bin, args, isQuick, token) {
  const preview = args.map((a) => (token && a === token ? "****" : a)).join(" ");
  console.log(`  ${cyan("->")} ${path.basename(bin)} ${preview}`);
  console.log("");

  const child = spawn(bin, args, {
    cwd: CWD,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let foundUrl = false;
  const onLine = (line) => {
    if (!isQuick || foundUrl) return;
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!m) return;
    foundUrl = true;
    console.log("");
    console.log(`  ${green("==================================================")}`);
    console.log(`  ${bold("URL publik:")} ${cyan(m[0])}`);
    console.log(`  ${green("==================================================")}`);
    console.log("");
  };

  attachPrefix(child.stdout, dim("  [tunnel] "), onLine);
  attachPrefix(child.stderr, dim("  [tunnel] "), onLine);

  child.on("error", (err) => {
    console.error(`  ${red("[!]")} gagal menjalankan cloudflared: ${err.message}`);
    shutdown(1);
  });

  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`  ${yellow("[!]")} cloudflared berhenti (code ${code})`);
      shutdown(code || 1);
    }
  });

  return child;
}

// ---------------------------------------------------------------- banner

function banner() {
  console.log("");
  console.log(`  ${bold("TUNNEL")} v${VERSION} ${dim("- Cloudflare Tunnel helper")}`);
  console.log(dim("  ----------------------------------------"));
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) return printHelp();
  if (opts.version) return console.log(VERSION);

  banner();

  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;

  if (opts.check) {
    const bin = await ensureCloudflared(opts);
    console.log(`  ${green("[ok]")} ${binVersion(bin)}`);
    console.log(`  path: ${bin}`);
    return;
  }

  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => shutdown(0));
  }

  if (!opts.mode) {
    if (interactive) {
      opts.mode = await chooseMode();
    } else {
      const hasToken = opts.token || process.env.TUNNEL_TOKEN || readEnvValue(".env", "TUNNEL_TOKEN");
      if (hasToken) opts.mode = "token";
      else if (opts.config || detectConfig()) opts.mode = "config";
      else opts.mode = "quick";
      console.log(`  ${dim("mode otomatis:")} ${bold(opts.mode)}`);
    }
  }

  if (!["token", "config", "quick"].includes(opts.mode)) {
    fail(`Mode tidak dikenal: ${opts.mode} (pakai token|config|quick)`);
  }

  const port = await choosePort(opts, interactive);
  const configPath = opts.mode === "config" ? await chooseConfig(opts, interactive) : null;
  if (opts.mode === "token") opts.token = await chooseToken(opts, interactive);

  const entry = await decideSpawn(opts, port, interactive);

  closePrompt();

  const bin = await ensureCloudflared(opts);

  console.log("");
  console.log(`  mode   : ${bold(opts.mode)}${opts.mode === "token" ? dim(" (recommended)") : ""}`);
  console.log(`  port   : ${port}`);
  if (configPath) {
    const name = opts.tunnelName || tunnelNameFromConfig(configPath);
    console.log(`  config : ${rel(configPath)}${name ? dim(` (tunnel: ${name})`) : ""}`);
  }
  console.log(`  binary : ${rel(bin)} ${dim(`(${binVersion(bin)})`)}`);
  console.log("");

  if (entry) {
    startEntry(entry);
    const ready = await waitForPort(port, 25000);
    if (ready) console.log(`  ${green("[ok]")} server siap di http://localhost:${port}`);
    else console.log(`  ${yellow("[!]")} server belum merespons di port ${port}, lanjut saja ...`);
  }

  if (opts.mode === "quick") {
    console.log(dim("  quick tunnel: URL acak, sementara, jangan untuk produksi."));
  }

  startTunnel(bin, buildTunnelArgs(opts.mode, opts, port, configPath), opts.mode === "quick", opts.token);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((err) => {
  closePrompt();
  console.error(`\n  ${red("[!]")} ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
