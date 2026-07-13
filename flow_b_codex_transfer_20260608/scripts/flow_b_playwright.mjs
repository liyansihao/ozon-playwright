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

async function publishWithContext(context, options, env) {
  await createRunDir(options.runDir);
  const maoziPage = await openMaoziPage(context);
  try {
    await ensureMaoziLogin(maoziPage, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({ transport: createMaoziPageTransport({ page: maoziPage, context }) });
    const state = createPublishState({
      runDir: options.runDir,
      publishedCsv: path.join(ROOT, "data/flow_b/published_links.csv"),
    });
    const costBridge = createCostBridge({
      python: env.FLOW_B_PYTHON || "python3",
      scriptPath: env.FLOW_B_1688_SCRIPT || path.join(ROOT, "scripts/1688_image_median.py"),
    });
    const detailProvider = createOzonDetailProvider({
      context,
      timeout: Math.max(1000, Number(env.FLOW_B_OZON_DETAIL_TIMEOUT_MS) || 10000),
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
      concurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 4),
      dryCandidateLimit: Math.max(0, Number(env.FLOW_B_MAX_DRY_CANDIDATES) || 0),
    });
    return runner.run();
  } finally {
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

function printHelp() {
  console.log(`Usage:
  flow_b_playwright.mjs setup [RUN_DIR]
  flow_b_playwright.mjs verify
  flow_b_playwright.mjs scan URLS.txt OUT.json
  flow_b_playwright.mjs publish RUN_DIR
  flow_b_playwright.mjs run RUN_DIR URLS.txt

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
