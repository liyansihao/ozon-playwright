#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { ensureMaoziLogin, launchFlowContext, openMaoziPage, resolveBrowserOptions } from "./flow_b_playwright/browser-context.mjs";
import { createCostBridge } from "./flow_b_playwright/cost-bridge.mjs";
import { createMaoziClient, createMaoziPageTransport } from "./flow_b_playwright/maozi-client.mjs";
import { createOzonDetailProvider } from "./flow_b_playwright/ozon-detail.mjs";
import { createPublishRunner } from "./flow_b_playwright/publish-runner.mjs";
import { createPublishState } from "./flow_b_playwright/publish-state.mjs";
import { scanSources } from "./flow_b_playwright/source-scanner.mjs";
import { runReadOnlyVerification } from "./flow_b_playwright/verification.mjs";
import { acceptanceSummary, operationalErrorSummary, rankSourcesByYield } from "./flow_b_playwright/continuous-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_RUN_DIR = path.join(ROOT, "runs/flow_b/playwright_target100");
const DEFAULT_PROFILE = path.join(ROOT, "runs/flow_b/playwright_setup/playwright_profile");

function required(value, label) {
  if (!value || String(value).startsWith("--")) throw new Error(`${label} is required`);
  return path.resolve(String(value));
}

function runtimeDefaults(env) {
  const threshold = Number(env.FLOW_B_PROFIT_THRESHOLD ?? 30);
  const target = Number(env.FLOW_B_TARGET_PUBLISH_COUNT ?? 100);
  if (!Number.isFinite(threshold)) throw new Error("FLOW_B_PROFIT_THRESHOLD must be numeric");
  if (!Number.isInteger(target) || target <= 0) throw new Error("FLOW_B_TARGET_PUBLISH_COUNT must be a positive integer");
  const storeNeedle = String(env.FLOW_B_STORE_NEEDLE ?? "丽丽1号").trim();
  const watermarkNeedle = String(env.FLOW_B_WATERMARK_NEEDLE ?? "lysh").trim();
  if (!storeNeedle) throw new Error("FLOW_B_STORE_NEEDLE is required");
  if (!watermarkNeedle) throw new Error("FLOW_B_WATERMARK_NEEDLE is required");
  return { threshold, target, storeNeedle, watermarkNeedle };
}

export function parseCli(argv, env = process.env) {
  const args = [...argv];
  if (!args.length || args.includes("--help") || args.includes("-h")) return { command: "help" };
  const [command, ...rest] = args;
  const defaults = runtimeDefaults(env);
  if (command === "setup") {
    return { command, runDir: path.resolve(rest[0] || path.join(ROOT, "runs/flow_b/playwright_setup")), ...defaults };
  }
  if (command === "verify") return { command, ...defaults };
  if (command === "scan") {
    return { command, urlsFile: required(rest[0], "URLS.txt"), outFile: required(rest[1], "OUT.json"), ...defaults };
  }
  if (command === "publish") {
    return { command, runDir: required(rest[0], "RUN_DIR"), ...defaults };
  }
  if (command === "run") {
    const runDir = required(rest[0], "RUN_DIR");
    return { command, runDir, urlsFile: required(rest[1], "URLS.txt"), outFile: path.join(runDir, "source_deep_scan.json"), ...defaults };
  }
  if (command === "accept") {
    const runDir = required(rest[0], "RUN_DIR");
    return { command, runDir, urlsFile: required(rest[1], "URLS.txt"), outFile: path.join(runDir, "source_deep_scan.json"), ...defaults };
  }
  throw new Error(`unknown command: ${command}`);
}

function browserOptions(env) {
  return resolveBrowserOptions({
    ...env,
    FLOW_B_PW_PROFILE: env.FLOW_B_PW_PROFILE || DEFAULT_PROFILE,
  });
}

async function createRunDir(runDir, sourceConfig) {
  await fs.mkdir(runDir, { recursive: true });
  const startFile = path.join(runDir, "start_time.txt");
  try { await fs.access(startFile); } catch { await fs.writeFile(startFile, `${new Date().toISOString()}\n`); }
  if (sourceConfig) await fs.writeFile(path.join(runDir, "source_config.json"), `${JSON.stringify(sourceConfig, null, 2)}\n`);
}

async function publishWithContext(context, options, env, shared = {}) {
  await createRunDir(options.runDir);
  const maoziPage = await openMaoziPage(context, { forceNew: true });
  let costBridge;
  let detailProvider;
  try {
    await ensureMaoziLogin(maoziPage, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({ transport: createMaoziPageTransport({ page: maoziPage, context }) });
    const state = createPublishState({
      runDir: options.runDir,
      publishedCsv: path.join(ROOT, "data/flow_b/published_links.csv"),
    });
    costBridge = createCostBridge({
      python: env.FLOW_B_PYTHON || "python3",
      scriptPath: env.FLOW_B_1688_SCRIPT || path.join(ROOT, "scripts/1688_image_median.py"),
    });
    detailProvider = createOzonDetailProvider({
      context,
      timeout: Math.max(1000, Number(env.FLOW_B_OZON_DETAIL_TIMEOUT_MS) || 10000),
      initialConcurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8),
      maxConcurrency: Math.max(1, Number(env.FLOW_B_MAX_PUBLISH_WORKERS) || 12),
    });
    const runner = createPublishRunner({
      client,
      detailProvider,
      costBridge,
      state,
      runDir: options.runDir,
      target: options.target,
      threshold: options.threshold,
      storeNeedle: options.storeNeedle,
      watermarkNeedle: options.watermarkNeedle,
      storeId: Number(env.FLOW_B_STORE_ID || 104965),
      watermarkId: Number(env.FLOW_B_WATERMARK_ID || 60822),
      concurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8),
      maxConcurrency: Math.max(1, Number(env.FLOW_B_MAX_PUBLISH_WORKERS) || 12),
      dryCandidateLimit: Math.max(0, Number(env.FLOW_B_MAX_DRY_CANDIDATES) || 0),
      deadlineAt: env.FLOW_B_DEADLINE_AT || null,
      targetConfigCache: shared.targetConfigCache || null,
    });
    return await runner.run();
  } finally {
    await detailProvider?.close?.().catch(() => {});
    await costBridge?.close?.().catch(() => {});
    await maoziPage.close().catch(() => {});
  }
}

async function withContext(env, operation) {
  const context = await launchFlowContext(browserOptions(env));
  try {
    return await operation(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function verifyWithContext(context, options, env) {
  const page = await openMaoziPage(context);
  try {
    await ensureMaoziLogin(page, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({ transport: createMaoziPageTransport({ page, context }) });
    const manifest = JSON.parse(await fs.readFile(path.join(browserOptions(env).extensionDir, "manifest.json"), "utf8"));
    return runReadOnlyVerification({
      client,
      extensionVersion: manifest.version,
      storeNeedle: options.storeNeedle,
      watermarkNeedle: options.watermarkNeedle,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function setup(options, env) {
  await createRunDir(options.runDir);
  const context = await launchFlowContext(browserOptions(env));
  try {
    await openMaoziPage(context);
    const ozon = await context.newPage();
    await ozon.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(JSON.stringify({ ok: true, profile: browserOptions(env).profileDir, message: "请完成 Ozon/Maozi 登录，完成后按 Ctrl+C。" }, null, 2));
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

async function readJsonLines(filename) {
  let text = "";
  try { text = await fs.readFile(filename, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function countsBy(rows, field) {
  const result = {};
  for (const row of rows) {
    const key = String(row?.data?.[field] ?? row?.[field] ?? "unknown");
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function collectionEliminationReason(row) {
  if (row?.reason) return String(row.reason);
  const error = String(row?.error || "");
  if (/missing-shipping-mode/i.test(error)) return "missing-shipping-mode";
  if (/soft blocked/i.test(error)) return "ozon-soft-block";
  if (/target page, context or browser has been closed/i.test(error)) return "browser-context-closed";
  if (/timeout/i.test(error)) return "page-timeout";
  return "collection-failed";
}

export async function writeAcceptanceReport(runDir, startedAt, endedAt, target) {
  const publishedEvents = await readJsonLines(path.join(runDir, "published.jsonl"));
  const skipped = await readJsonLines(path.join(runDir, "skipped.jsonl"));
  const failed = await readJsonLines(path.join(runDir, "failed.jsonl"));
  const runtimeErrors = await readJsonLines(path.join(runDir, "runtime_errors.jsonl"));
  const favoriteCollection = await readJsonLines(path.join(runDir, "favorite_collection.jsonl"));
  const timings = await readJsonLines(path.join(runDir, "stage_timings.jsonl"));
  const yieldEvents = await readJsonLines(path.join(runDir, "source_yield.jsonl"));
  const published = publishedEvents.map((row) => ({ ...row, ...(row.data || {}) }));
  const acceptance = acceptanceSummary({ rows: published, startedAt, endedAt, target });
  const stageMap = new Map();
  for (const row of timings) {
    const values = stageMap.get(row.stage) || [];
    values.push(Number(row.duration_ms) || 0);
    stageMap.set(row.stage, values);
  }
  const stageSummary = Object.fromEntries([...stageMap].map(([stage, values]) => [stage, {
    count: values.length,
    total_ms: values.reduce((sum, value) => sum + value, 0),
    average_ms: Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  }]));
  const sourceMap = new Map();
  for (const row of yieldEvents) {
    const key = String(row.source_url || "unknown");
    const value = sourceMap.get(key) || { source_url: key, attempted: 0, published: 0, failed: 0, skipped: 0 };
    if (row.status !== "ignored") value.attempted += 1;
    if (row.status in value) value[row.status] += 1;
    sourceMap.set(key, value);
  }
  const sourceYield = rankSourcesByYield([...sourceMap.values()]);
  const report = {
    ...acceptance,
    stage_timings: stageSummary,
    collection_elimination_reasons: countsBy(
      favoriteCollection
        .filter((row) => row.status === "rejected" || row.status === "failed")
        .map((row) => ({ ...row, reason: collectionEliminationReason(row) })),
      "reason",
    ),
    elimination_reasons: countsBy(skipped, "reason"),
    failure_reasons: countsBy(failed, "reason"),
    ...operationalErrorSummary({
      successCount: acceptance.success_count,
      skippedCount: skipped.length,
      failedCount: failed.length,
      runtimeErrorCount: runtimeErrors.length,
    }),
    invalid_sku_2815247918_counted: false,
  };
  await Promise.all([
    fs.writeFile(path.join(runDir, "acceptance_summary.json"), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(runDir, "stage_summary.json"), `${JSON.stringify(stageSummary, null, 2)}\n`),
    fs.writeFile(path.join(runDir, "source_yield_summary.json"), `${JSON.stringify(sourceYield, null, 2)}\n`),
  ]);
  return report;
}

async function runAcceptance(context, options, env) {
  const durationMs = Math.max(1_000, Number(env.FLOW_B_ACCEPTANCE_SECONDS || 7200) * 1000);
  const acceptanceTarget = Math.max(1, Number(env.FLOW_B_ACCEPTANCE_TARGET || 50));
  const authPage = await openMaoziPage(context, { forceNew: true, settleMs: 1500 });
  try {
    await ensureMaoziLogin(authPage, { continueDeviceLogin: true, timeout: 60000 });
  } finally {
    await authPage.close().catch(() => {});
  }
  let startedAt = new Date();
  let endedAt = new Date(startedAt.getTime() + durationMs);
  const windowPath = path.join(options.runDir, "acceptance_window.json");
  if (env.FLOW_B_RESUME_WINDOW === "1") {
    try {
      const existingWindow = JSON.parse(await fs.readFile(windowPath, "utf8"));
      const existingStart = new Date(existingWindow.started_at);
      const existingEnd = new Date(existingWindow.ended_at);
      if (Number.isFinite(existingStart.getTime()) && Number.isFinite(existingEnd.getTime())) {
        startedAt = existingStart;
        endedAt = existingEnd;
      }
    } catch {}
  }
  const runtimeEnv = {
    ...env,
    FLOW_B_DEADLINE_AT: endedAt.toISOString(),
    FLOW_B_MAOZI_CONTINUE_LOGIN: "1",
  };
  await createRunDir(options.runDir, {
    mode: "continuous-acceptance",
    urls_file: options.urlsFile,
    scan_output: options.outFile,
    window_started_at: startedAt.toISOString(),
    window_ended_at: endedAt.toISOString(),
    publish_target: options.target,
    acceptance_target: acceptanceTarget,
    store_id: Number(env.FLOW_B_STORE_ID || 104965),
    watermark_id: Number(env.FLOW_B_WATERMARK_ID || 60822),
    initial_concurrency: Number(env.FLOW_B_PUBLISH_WORKERS || 8),
    max_concurrency: Number(env.FLOW_B_MAX_PUBLISH_WORKERS || 12),
  });
  await fs.writeFile(windowPath, `${JSON.stringify({ started_at: startedAt.toISOString(), ended_at: endedAt.toISOString() }, null, 2)}\n`);
  const shared = { targetConfigCache: {} };
  const scanTask = (async () => {
    let lastResult = null;
    while (Date.now() < endedAt.getTime()) {
      try {
        lastResult = await scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env: runtimeEnv });
        return lastResult;
      } catch (error) {
        await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: "producer", error: String(error?.message || error) })}\n`);
        const wait = Math.min(15_000, endedAt.getTime() - Date.now());
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    return lastResult || { deadline_reached: true };
  })();
  const rounds = [];
  while (Date.now() < endedAt.getTime()) {
    try {
      rounds.push(await publishWithContext(context, options, runtimeEnv, shared));
    } catch (error) {
      await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: "consumer", error: String(error?.message || error) })}\n`);
    }
    const wait = Math.min(Math.max(1_000, Number(env.FLOW_B_POLL_INTERVAL_MS || 10_000)), endedAt.getTime() - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const scan = await scanTask;
  const report = await writeAcceptanceReport(options.runDir, startedAt.toISOString(), endedAt.toISOString(), acceptanceTarget);
  return { report, scan, rounds };
}

function printHelp() {
  console.log(`Usage:
  flow_b_playwright.mjs setup [RUN_DIR]
  flow_b_playwright.mjs verify
  flow_b_playwright.mjs scan URLS.txt OUT.json
  flow_b_playwright.mjs publish RUN_DIR
  flow_b_playwright.mjs run RUN_DIR URLS.txt
  flow_b_playwright.mjs accept RUN_DIR URLS.txt

Required for browser commands: FLOW_B_EXTENSION_DIR=/path/to/unpacked/maozi-plugin
Defaults: profit_rate > 30, target 100, store contains 丽丽1号, watermark contains lysh`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv, env);
  if (options.command === "help") { printHelp(); return { ok: true, command: "help" }; }
  if (options.command === "setup") return setup(options, env);
  if (options.command === "verify") {
    return withContext(env, (context) => verifyWithContext(context, options, env));
  }
  if (options.command === "scan") {
    return withContext(env, (context) => scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env }));
  }
  if (options.command === "publish") {
    return withContext(env, (context) => publishWithContext(context, options, env));
  }
  if (options.command === "run") {
    return withContext(env, async (context) => {
      await createRunDir(options.runDir, {
        mode: "playwright-run",
        browser: "playwright-chrome-for-testing",
        urls_file: options.urlsFile,
        scan_output: options.outFile,
        profit_threshold: options.threshold,
        publish_target: options.target,
      });
      const scan = await scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env });
      const publish = await publishWithContext(context, options, env);
      return { scan, publish };
    });
  }
  if (options.command === "accept") {
    return withContext(env, (context) => runAcceptance(context, options, env));
  }
  throw new Error(`unsupported command: ${options.command}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await main();
    if (result && result.command !== "help") console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error), stack: error?.stack }, null, 2));
    process.exitCode = 1;
  }
}
