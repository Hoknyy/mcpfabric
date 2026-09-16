#!/usr/bin/env node
/**
 * Scenario runner for the mcpfabric bridge.
 *
 * Drives the Minecraft client through the in-game bridge (HTTP JSON-RPC) and asserts on the
 * results, so agents can run reproducible gameplay tests without touching the keyboard/mouse.
 *
 * Usage:
 *   node runner.mjs scenarios/shop-buy-wheat.yaml [--url http://127.0.0.1:25599]
 *                                                 [--token <token>] [--artifacts ./artifacts]
 *
 * The token can also come from the MCPFABRIC_TOKEN environment variable.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { file: null, url: process.env.MCPFABRIC_URL || "http://127.0.0.1:25599", token: process.env.MCPFABRIC_TOKEN || "", artifacts: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--artifacts") out.artifacts = argv[++i];
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
  return s != null && s.length > 120 ? s.slice(0, 117) + "..." : s;
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
      throw new Error(`bridge unreachable (${this.url}): ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new Error("bridge rejected the token (check MCPFABRIC_TOKEN)");
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
  let last = [];
  for (;;) {
    const chat = await bridge.call("chat.getRecent", { limit: 40 });
    last = (chat.messages ?? []).map((m) => m.data?.text ?? "");
    if (last.some((t) => t.includes(needle))) return true;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("usage: node runner.mjs <scenario.yaml> [--url ...] [--token ...] [--artifacts dir]");
    process.exit(2);
  }
  const scenarioPath = resolve(process.cwd(), args.file);
  const scenario = parseYaml(readFileSync(scenarioPath, "utf8"));
  const name = scenario.name || basename(scenarioPath, ".yaml");
  const artifacts = resolve(args.artifacts || resolve(HERE, "artifacts"), name);
  const bridge = new Bridge(args.url, args.token);
  const vars = scenario.vars ?? {};

  console.log(`\n=== ${name} (${scenarioPath})`);
  console.log(`bridge: ${bridge.url}\n`);

  const results = [];
  let failed = 0;

  for (const [i, step] of (scenario.steps ?? []).entries()) {
    const label = step.log || step.call || (step.expect_chat ? `expect_chat ${JSON.stringify(step.expect_chat)}` : `step ${i + 1}`);
    const t0 = Date.now();
    try {
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

      if (step.log && !step.call) {
        results.push({ label, ok: true, ms: 0 });
        console.log(`  --   ${label}`);
        continue;
      }

      const params = { ...(step.args ?? {}) };
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string" && vars[v] !== undefined) params[k] = vars[v];
      }

      const timeoutS = typeof step.retry === "number" ? step.retry : step.retry?.timeout ?? 0;
      const intervalS = (typeof step.retry === "object" ? step.retry?.interval : undefined) ?? 0.4;
      const deadline = Date.now() + timeoutS * 1000;

      let result;
      let failures = [];
      for (;;) {
        try {
          result = await bridge.call(step.call, params);
          failures = checkExpectations(result, step.expect);
        } catch (err) {
          failures = [err.message];
        }
        if (failures.length === 0 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, intervalS * 1000));
      }
      if (failures.length) throw new Error(failures.join(" | "));

      if (step.save) vars[step.save] = result;

      if (failures.length) throw new Error(`assertions: ${failures.join(" | ")}`);
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
