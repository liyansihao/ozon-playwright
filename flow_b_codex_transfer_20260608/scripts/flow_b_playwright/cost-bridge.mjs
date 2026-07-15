import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const RELIABLE_SOURCES = new Set([
  "search_first_page_p70_similarity_filtered",
  "search_first_page_cluster_p70_similarity_filtered",
  "search_first_page_cluster_p80_similarity_filtered",
]);

function lineValue(text, label) {
  const match = String(text || "").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

function parsePrices(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    const match = String(value || "").match(/^\[([^\]]*)\]$/);
    if (!match) return [];
    const parts = match[1].split(",").map((part) => part.trim()).filter(Boolean);
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    if (!parts.length || parts.some((part) => !numeric.test(part))) return [];
    const prices = parts.map(Number);
    return prices.every(Number.isFinite) ? prices : [];
  }
}

export function parseCostOutput(text, sellPrice) {
  const cost = Number(lineValue(text, "P70_COST"));
  const source = lineValue(text, "COST_SOURCE");
  const prices = parsePrices(lineValue(text, "FILTERED_FIRST_PAGE_PRICES"));
  const sale = Number(sellPrice);
  const explicitReason = lineValue(text, "REASON");

  if (!Number.isFinite(cost) || cost <= 0) return { ok: false, reason: explicitReason || "missing or invalid P70 cost" };
  if (!RELIABLE_SOURCES.has(source)) return { ok: false, reason: `unreliable cost source: ${source || "missing"}` };
  if (prices.length < 3) return { ok: false, reason: `filtered first-page insufficient ${prices.length}` };
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) return { ok: false, reason: "invalid filtered first-page prices" };
  if (source === "search_first_page_p70_similarity_filtered" && Math.max(...prices) / Math.min(...prices) > 5) {
    return { ok: false, reason: "filtered first-page price spread greater than five" };
  }
  if (!Number.isFinite(sale) || sale <= 0) return { ok: false, reason: "invalid sale price" };
  if (cost >= sale * 0.85) return { ok: false, reason: "1688 cost is at least 85% of sale price" };
  return { ok: true, cost, source, prices };
}

function safeSku(value) {
  const sku = String(value ?? "").trim();
  if (!sku || sku.length > 128 || sku === "." || sku === ".." || !/^[A-Za-z0-9._-]+$/.test(sku)) {
    throw Object.assign(new Error("unsafe SKU; path traversal is not allowed"), { code: "invalid-sku" });
  }
  return sku;
}

async function defaultDownload(url, destinationPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`image download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("downloaded image is empty");
    await fs.writeFile(destinationPath, bytes);
  } finally {
    clearTimeout(timer);
  }
}

function defaultRunProcess({ command, args, cwd, timeout = 90000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`1688 process timed out after ${timeout}ms`), {
        code: "process-timeout",
        stdout,
        stderr,
      }));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function readableFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function createCostBridge({
  python = "python3",
  scriptPath = path.resolve(import.meta.dirname, "../1688_image_median.py"),
  runProcess = defaultRunProcess,
  download = defaultDownload,
} = {}) {
  const inFlight = new Map();
  const cacheByRun = new Map();
  let cacheWriteChain = Promise.resolve();

  function cacheKey(item) {
    const imageUrl = String(item?.cover_image || "").trim();
    return imageUrl ? crypto.createHash("sha256").update(imageUrl).digest("hex") : null;
  }

  async function loadCache(runDir) {
    const root = path.resolve(runDir);
    if (cacheByRun.has(root)) return cacheByRun.get(root);
    let cache = { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, "1688_cache.json"), "utf8"));
      if (parsed?.entries && typeof parsed.entries === "object") cache = parsed;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    cacheByRun.set(root, cache);
    return cache;
  }

  function saveCache(runDir, cache) {
    const operation = cacheWriteChain.then(async () => {
      const filename = path.join(path.resolve(runDir), "1688_cache.json");
      const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, "utf8");
      await fs.rename(temporary, filename);
    });
    cacheWriteChain = operation.catch(() => {});
    return operation;
  }

  async function estimateUncached(item, runDir) {
      let sku;
      try {
        sku = safeSku(item?.sku);
      } catch (error) {
        return { ok: false, error: { code: error.code || "invalid-sku", message: error.message } };
      }

      const root = path.resolve(runDir);
      const imageDir = path.join(root, "images");
      const outputDir = path.join(root, "1688");
      const imagePath = path.join(imageDir, `${sku}.jpg`);
      const outputPath = path.join(outputDir, `${sku}.out`);
      let processStarted = false;

      try {
        await fs.mkdir(imageDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        if (await readableFile(outputPath)) {
          const cachedText = await fs.readFile(outputPath, "utf8");
          if (/^P70_COST\s+/m.test(cachedText)) {
            const cached = parseCostOutput(cachedText, item?.sell_price);
            if (cached.ok) return { ...cached, cached: true, outputPath };
          }
        }

        if (!(await readableFile(imagePath))) {
          const imageUrl = String(item?.cover_image || "").trim();
          if (!/^https?:\/\//i.test(imageUrl)) throw Object.assign(new Error("valid cover image URL is required"), { code: "invalid-cover-image" });
          await download(imageUrl, imagePath);
          if (!(await readableFile(imagePath))) throw Object.assign(new Error("cover image download produced no file"), { code: "empty-image" });
        }

        processStarted = true;
        const result = await runProcess({
          command: python,
          args: [path.resolve(scriptPath), imagePath],
          cwd: path.resolve(process.cwd()),
          timeout: Number(process.env.FLOW_B_1688_ITEM_TIMEOUT || 90) * 1000,
        });
        const stdout = String(result?.stdout || "");
        const stderr = String(result?.stderr || "");
        const combined = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`;
        await fs.writeFile(outputPath, combined, "utf8");
        if (Number(result?.code) !== 0) {
          const parsed = parseCostOutput(combined, item?.sell_price);
          return {
            ok: false,
            reason: lineValue(combined, "REASON") || parsed.reason || `1688 process exited ${result?.code}`,
            process_code: Number(result?.code),
            outputPath,
          };
        }
        return { ...parseCostOutput(combined, item?.sell_price), process_code: 0, cached: false, outputPath };
      } catch (error) {
        if (processStarted) {
          const evidence = [
            String(error?.stdout || ""),
            "STDERR:",
            String(error?.stderr || ""),
            "ERROR:",
            String(error?.message || error),
          ].join("\n");
          await fs.writeFile(outputPath, evidence, "utf8").catch(() => {});
        }
        return {
          ok: false,
          error: { code: error?.code || "cost-estimate-failed", message: String(error?.message || error) },
          outputPath,
        };
      }
  }

  async function estimate(item, runDir) {
    const key = cacheKey(item);
    if (!key) return estimateUncached(item, runDir);
    const root = path.resolve(runDir);
    const compositeKey = `${root}:${key}`;
    const cache = await loadCache(root);
    const cached = cache.entries[key];
    if (cached?.output) {
      const parsed = parseCostOutput(cached.output, item?.sell_price);
      if (parsed.ok || cached.terminal) {
        return {
          ...parsed,
          process_code: Number.isFinite(Number(cached.process_code)) ? Number(cached.process_code) : undefined,
          cached: true,
          shared_cache: true,
          cache_key: key,
        };
      }
    }
    if (inFlight.has(compositeKey)) {
      const result = await inFlight.get(compositeKey);
      return { ...result, shared_cache: true, cache_key: key };
    }
    const operation = (async () => {
      const result = await estimateUncached(item, root);
      if (result?.outputPath && (result?.ok || result?.reason)) {
        const output = await fs.readFile(result.outputPath, "utf8");
        cache.entries[key] = {
          output,
          terminal: true,
          process_code: result.process_code,
          source_image: String(item.cover_image),
          updated_at: new Date().toISOString(),
        };
        await saveCache(root, cache);
      }
      return { ...result, shared_cache: false, cache_key: key };
    })();
    inFlight.set(compositeKey, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(compositeKey);
    }
  }

  return {
    estimate,
    async close() {},
  };
}
