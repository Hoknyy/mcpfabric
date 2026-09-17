#!/usr/bin/env node
/**
 * Scenario runner for the mcpfabric bridge (AA-Lato harness).
 *
 * Drives the Minecraft client through the in-game bridge (HTTP JSON-RPC), can send Pterodactyl
 * console commands as fixtures (through AA-Main's verified transport), and asserts on the results.
 * Agents can therefore prepare state, run gameplay funnels and verify outcomes without touching
 * the keyboard/mouse.
 *
 * Usage:
 *   node runner.mjs scenarios/shop-buy-wheat.yaml [--url ...] [--token ...] [--var player=Name]
 *   node runner.mjs --doctor
 *
 * Config resolution: CLI flags > environment > harness/config.json > defaults.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const file = resolve(HERE, "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    url: process.env.MCPFABRIC_URL || cfg.url || "http://127.0.0.1:25599",
    token: process.env.MCPFABRIC_TOKEN || cfg.token || "",
    minecraftConfig: process.env.MCPFABRIC_MINECRAFT_CONFIG || cfg.minecraftConfig || "",
    player: cfg.player || "",
    python: cfg.python || "",
    aaMainInfra: cfg.aaMainInfra || "",
    servers: cfg.servers || {},
  };
}

function resolveToken(cfg, explicit) {
  if (explicit) return explicit;
  if (cfg.token) return cfg.token;
  if (cfg.minecraftConfig && existsSync(cfg.minecraftConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(cfg.minecraftConfig, "utf8"));
      if (parsed.token) return parsed.token;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function parseArgs(argv) {
  const out = { file: null, url: null, token: null, artifacts: null, doctor: false, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--artifacts") out.artifacts = argv[++i];
    else if (a === "--var") {
      const [k, ...rest] = String(argv[++i]).split("=");
      out.vars[k] = rest.join("=");
    } else if (a === "--doctor") out.doctor = true;
    else if (!out.file) out.file = a;
  }
  return out;
}

function getPath(obj, path) {
  if (path === "" || path == null) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function fmt(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s != null && s.length > 140 ? s.slice(0, 137) + "..." : s;
}

function substitute(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

class Bridge {
  constructor(url, token, timeoutMs = 20000) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async call(method, params = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(
        `bridge injoignable (${this.url}): ${e.message}. Ouvre Minecraft (profil Modrinth "Fabric 26.2", mod mcpfabric) puis relance.`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new Error("bridge rejected the token (check MCPFABRIC_TOKEN / config.json)");
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`bridge returned non-JSON (HTTP ${res.status})`);
    }
    if (!body.ok) throw new Error(`[${body.error?.code ?? "error"}] ${body.error?.message ?? "unknown bridge error"}`);
    return body.result;
  }
}

function checkExpectations(result, expect) {
  const failures = [];
  for (const [key, want] of Object.entries(expect ?? {})) {
    if (key === "chatContains") continue; // handled separately (polls chat)
    if (key === "itemAt") {
      const items = result?.items ?? [];
      for (const [slot, spec] of Object.entries(want)) {
        const item = items.find((i) => String(i.slot) === String(slot));
        if (!item) {
          failures.push(`itemAt slot ${slot}: absent`);
          continue;
        }
        for (const [k, v] of Object.entries(spec)) {
          if (item[k] !== v) failures.push(`itemAt slot ${slot}.${k}: got ${fmt(item[k])}, want ${fmt(v)}`);
        }
      }
      continue;
    }
    if (key === "contains") {
      for (const [path, sub] of Object.entries(want)) {
        const got = getPath(result, path);
        if (typeof got !== "string" || !got.includes(sub)) failures.push(`${path}: "${fmt(got)}" ne contient pas "${sub}"`);
      }
      continue;
    }
    if (key === "loreContains") {
      const items = result?.items ?? [];
      for (const [slot, sub] of Object.entries(want)) {
        const item = items.find((i) => String(i.slot) === String(slot));
        const lore = item?.lore ?? [];
        if (!lore.some((l) => String(l).includes(sub))) {
          failures.push(`lore slot ${slot}: ${fmt(lore)} ne contient pas "${sub}"`);
        }
      }
      continue;
    }
    if (key === "gte" || key === "lte") {
      for (const [path, n] of Object.entries(want)) {
        const got = getPath(result, path);
        if (typeof got !== "number" || (key === "gte" ? got < n : got > n)) {
          failures.push(`${path}: ${fmt(got)} ${key === "gte" ? "<" : ">"} ${n}`);
        }
      }
      continue;
    }
    const got = getPath(result, key);
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) failures.push(`${key}: got ${fmt(got)}, want ${fmt(want)}`);
  }
  return failures;
}

async function chatContains(bridge, needle, timeoutS, intervalS) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const chat = await bridge.call("chat.getRecent", { limit: 40 });
    const texts = (chat.messages ?? []).map((m) => m.data?.text ?? "");
    if (texts.some((t) => t.includes(needle))) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

async function saveScreenshot(bridge, dir, name) {
  try {
    const shot = await bridge.call("vision.screenshot", {});
    if (!shot?.base64) return null;
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.base64, "base64"));
    return file;
  } catch {
    return null;
  }
}

function consoleCommand(cfg, server, command) {
  const uuid = cfg.servers[server];
  if (!uuid) throw new Error(`serveur inconnu "${server}" (connus: ${Object.keys(cfg.servers).join(", ")})`);
  if (!cfg.python) throw new Error("config.python manquant (chemin de python-runtime.cmd d'AA-Main)");
  const script = resolve(HERE, "panel_cmd.py");
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const line = [q(cfg.python), q(script), "--infra", q(cfg.aaMainInfra), q(uuid), q(command)].join(" ");
  const out = execSync(line, { encoding: "utf8", timeout: 60000 });
  if (!/HTTP 20\d/.test(out)) throw new Error(`console refusée: ${out.trim()}`);
  return out.trim();
}

async function doctor(cfg, bridge) {
  console.log(`\n=== doctor (${bridge.url})`);
  let bad = 0;
  const check = (label, ok, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) bad++;
  };

  try {
    const status = await bridge.call("info.status", {});
    check("bridge", true, `mcpfabric ${status.modVersion} / mc ${status.minecraftVersion} / ${status.side}`);
  } catch (e) {
    check("bridge", false, e.message);
  }
  try {
    const self = await bridge.call("player.getState", {});
    check("joueur dans un monde", true, `${cfg.player || "?"} @ ${self.x.toFixed(1)} ${self.y} ${self.z.toFixed(1)} (${self.dimension})`);
  } catch (e) {
    check("joueur dans un monde", false, e.message);
  }
  check("token", Boolean(bridge.token), bridge.token ? "résolu" : "introuvable");
  if (cfg.python && existsSync(cfg.python)) {
    try {
      const out = consoleCommand(cfg, "survival", "list");
      check("console Pterodactyl", /HTTP 20\d/.test(out), out.trim());
    } catch (e) {
      check("console Pterodactyl", false, e.message.split("\n")[0]);
    }
  } else {
    check("console Pterodactyl", false, "config.python absent");
  }
  console.log(`\n${bad === 0 ? "PASS" : "FAIL"} — doctor`);
  process.exitCode = bad === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const url = args.url || cfg.url;
  const token = resolveToken(cfg, args.token);
  const bridge = new Bridge(url, token);

  if (args.doctor) return doctor(cfg, bridge);
  if (!args.file) {
    console.error("usage: node runner.mjs <scenario.yaml> [--url ...] [--token ...] [--var k=v] [--artifacts dir]");
    console.error("       node runner.mjs --doctor");
    process.exitCode = 2;
    return;
  }

  const scenarioPath = resolve(process.cwd(), args.file);
  const scenario = parseYaml(readFileSync(scenarioPath, "utf8"));
  const name = scenario.name || basename(scenarioPath, ".yaml");
  const artifacts = resolve(args.artifacts || resolve(HERE, "artifacts"), name);
  const vars = { player: cfg.player, ...(scenario.vars ?? {}), ...args.vars };

  console.log(`\n=== ${name} (${scenarioPath})`);
  console.log(`bridge: ${bridge.url} | joueur: ${vars.player || "?"}\n`);

  const results = [];
  let failed = 0;

  for (const [i, rawStep] of (scenario.steps ?? []).entries()) {
    const step = substitute(rawStep, vars);
    const label =
      step.log ||
      step.call ||
      (step.console ? `console ${step.console.server}: ${step.console.command}` : null) ||
      (step.expect_chat ? `expect_chat ${JSON.stringify(step.expect_chat)}` : null) ||
      `step ${i + 1}`;
    const t0 = Date.now();
    try {
      if (step.wait) {
        await new Promise((r) => setTimeout(r, Number(step.wait) * 1000));
        results.push({ label, ok: true, ms: Date.now() - t0 });
        console.log(`  ok   wait ${step.wait}s`);
        continue;
      }

      if (step.expect_chat) {
        const needles = Array.isArray(step.expect_chat) ? step.expect_chat : [step.expect_chat];
        for (const needle of needles) {
          const ok = await chatContains(bridge, needle, step.timeout ?? 6, step.interval ?? 0.4);
          if (!ok) throw new Error(`chat ne contient pas "${needle}"`);
        }
        results.push({ label, ok: true, ms: Date.now() - t0 });
        console.log(`  ok   ${label}`);
        continue;
      }

      if (step.console) {
        const out = consoleCommand(cfg, step.console.server, step.console.command);
        results.push({ label, ok: true, ms: Date.now() - t0 });
        console.log(`  ok   ${label} (${out})`);
        continue;
      }

      if (step.log && !step.call) {
        results.push({ label, ok: true, ms: 0 });
        console.log(`  --   ${label}`);
        continue;
      }

      const timeoutS = typeof step.retry === "number" ? step.retry : step.retry?.timeout ?? 0;
      const intervalS = (typeof step.retry === "object" ? step.retry?.interval : undefined) ?? 0.4;
      const deadline = Date.now() + timeoutS * 1000;

      let result;
      let failures = [];
      for (;;) {
        try {
          result = await bridge.call(step.call, step.args ?? {});
          failures = checkExpectations(result, step.expect);
        } catch (err) {
          failures = [err.message];
        }
        if (failures.length === 0 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, intervalS * 1000));
      }
      if (failures.length) throw new Error(failures.join(" | "));

      if (step.save) vars[step.save] = result;
      if (step.screenshot) {
        const shot = await saveScreenshot(bridge, artifacts, `${String(i + 1).padStart(2, "0")}-${(step.call || "step").replace(/\W+/g, "_")}`);
        if (shot) console.log(`       screenshot: ${shot}`);
      }

      results.push({ label, ok: true, ms: Date.now() - t0 });
      console.log(`  ok   ${label} (${Date.now() - t0}ms)`);
    } catch (err) {
      if (step.optional) {
        results.push({ label, ok: true, ms: Date.now() - t0, skipped: true });
        console.log(`  skip ${label} (${err.message})`);
        continue;
      }
      failed++;
      results.push({ label, ok: false, ms: Date.now() - t0, error: err.message });
      console.log(`  FAIL ${label} (${Date.now() - t0}ms)\n       ${err.message}`);
      const shot = await saveScreenshot(bridge, artifacts, `FAIL-${String(i + 1).padStart(2, "0")}-${(step.call || "step").replace(/\W+/g, "_")}`);
      if (shot) console.log(`       screenshot: ${shot}`);
      if (!scenario.continueOnError) break;
    }
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${results.filter((r) => r.ok).length}/${results.length} steps`);
  if (failed) console.log(`artifacts: ${artifacts}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`runner error: ${e.message}`);
  process.exitCode = 2;
});
