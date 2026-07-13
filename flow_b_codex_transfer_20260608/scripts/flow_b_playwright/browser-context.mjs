import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requiredPath(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return path.resolve(normalized);
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  let source;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`Maozi extension manifest.json was not found: ${manifestPath}`);
  }
  try {
    const manifest = JSON.parse(source);
    if (!manifest || !manifest.manifest_version) throw new Error("missing manifest_version");
    return manifest;
  } catch (error) {
    throw new Error(`Maozi extension manifest.json must contain valid JSON: ${error.message}`);
  }
}

export function resolveBrowserOptions(env = process.env, defaultExecutable = chromium.executablePath()) {
  const profileDir = requiredPath(env.FLOW_B_PW_PROFILE, "FLOW_B_PW_PROFILE");
  const extensionDir = requiredPath(env.FLOW_B_EXTENSION_DIR, "FLOW_B_EXTENSION_DIR");
  readManifest(extensionDir);

  const executablePath = String(env.FLOW_B_CHROMIUM_EXECUTABLE || defaultExecutable || "").trim();
  if (!executablePath) throw new Error("Chrome for Testing executable path is required");

  return {
    profileDir,
    extensionDir,
    executablePath,
    headless: false,
    viewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
    pluginTimeout: Number(env.FLOW_B_PLUGIN_TIMEOUT_MS) || 15000,
  };
}

function targetUrl(target) {
  if (!target) return "";
  try {
    return String(typeof target.url === "function" ? target.url() : target.url || "");
  } catch {
    return "";
  }
}

export async function assertPluginLoaded(context, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, timeout);
  do {
    const targets = [
      ...(typeof context.serviceWorkers === "function" ? context.serviceWorkers() : []),
      ...(typeof context.backgroundPages === "function" ? context.backgroundPages() : []),
      ...(typeof context.pages === "function" ? context.pages() : []),
    ];
    const extensionTarget = targets.find((target) => targetUrl(target).startsWith("chrome-extension://"));
    if (extensionTarget) return extensionTarget;
    if (Date.now() >= deadline) break;
    await delay(Math.max(1, interval));
  } while (true);
  throw new Error("Maozi extension did not load in Chrome for Testing");
}

export async function launchFlowContext(options) {
  const {
    profileDir,
    extensionDir: _extensionDir,
    pluginTimeout = 15000,
    ...launchOptions
  } = options;
  await fsp.mkdir(profileDir, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    await assertPluginLoaded(context, { timeout: pluginTimeout });
    return context;
  } catch (error) {
    await context?.close().catch(() => {});
    throw error;
  }
}

export async function openMaoziPage(context, { settleMs = 1000 } = {}) {
  const available = () => context.pages().filter((page) => typeof page.isClosed !== "function" || !page.isClosed());
  let page = available().find((candidate) => targetUrl(candidate).startsWith("https://ozon.maozierp.com/"));
  if (!page) {
    page = available()[0] || await context.newPage();
    await page.goto("https://ozon.maozierp.com/#/product/favorite", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  if (settleMs > 0) await delay(settleMs);
  if (typeof page.isClosed === "function" && page.isClosed()) {
    page = available().find((candidate) => targetUrl(candidate).startsWith("https://ozon.maozierp.com/"));
  }
  if (!page) throw new Error("Maozi SSO page closed without leaving an authenticated ERP page");
  return page;
}

export async function assertMaoziLogin(page) {
  const token = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "";
    } catch {
      return "";
    }
  });
  const normalized = String(token || "").trim();
  if (!normalized) throw new Error("Maozi profile is not logged in: maozierp-core-access.accessToken is empty");
  return normalized;
}

export async function ensureMaoziLogin(page, { continueDeviceLogin = false, timeout = 30000 } = {}) {
  try {
    return await assertMaoziLogin(page);
  } catch (error) {
    if (!continueDeviceLogin) throw error;
    const button = page.getByRole("button", { name: "继续登录", exact: true });
    if (await button.count() !== 1) throw error;
    await button.click();
    await page.waitForFunction(() => {
      try {
        return Boolean(JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken);
      } catch {
        return false;
      }
    }, null, { timeout });
    return assertMaoziLogin(page);
  }
}
