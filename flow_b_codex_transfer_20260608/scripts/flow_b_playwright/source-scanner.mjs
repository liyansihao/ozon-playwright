import fs from "node:fs/promises";
import path from "node:path";
import { ensureMaoziLogin, openMaoziPage } from "./browser-context.mjs";
import { AdaptiveConcurrency } from "./continuous-runtime.mjs";
import { isPureFbs } from "./publish-policy.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function waitForContent(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      bodyLength: document.body?.innerText?.length || 0,
      products: document.querySelectorAll('a[href*="/product/"]').length,
    })).catch(() => ({}));
    if (state.ready === "complete" && (state.bodyLength > 1000 || state.products > 0)) return state;
    await sleep(700);
  }
  return null;
}

export function isFavoriteSessionAuthenticated({ hasToken, httpOk, code, pageText }) {
  return Boolean(hasToken)
    && Boolean(httpOk)
    && Number(code) === 1
    && !/登录|手机号|验证码|密码|login/i.test(String(pageText || ""));
}

export function requiresFavoriteSession(env = process.env) {
  return env.FLOW_B_MAOZI_AUTOFAVORITE !== "0";
}

export function canClaimFavorite({ total, inFlight, target }) {
  return Number(total) + Number(inFlight) < Number(target);
}

export function favoriteRetryDelay(error, attempt) {
  const message = String(error?.message || error || "");
  if (/HTTP 429|too many requests|rate.?limit/i.test(message)) {
    return Math.min(60_000, 15_000 * (2 ** Math.max(0, attempt)));
  }
  if (/failed to fetch|network|ECONN|ETIMEDOUT|timeout/i.test(message)) {
    return Math.min(15_000, 2_000 * (2 ** Math.max(0, attempt)));
  }
  return null;
}

export function isFavoriteCapacityReached(error) {
  return /收藏数量已达上限|favorite.*(?:limit|capacity)/i.test(String(error?.message || error || ""));
}

export function effectiveFavoriteTotal({ claimedTotal, observedTotal, target }) {
  return Number(claimedTotal) >= Number(target) ? Number(target) : Number(observedTotal);
}

export function favoriteModeSkipReason(mode) {
  if (!String(mode || "").trim()) return "missing-shipping-mode";
  return isPureFbs(mode) ? null : "non-pure-fbs";
}

export function isOzonSoftBlock(value) {
  return /похоже, нет(?:\s|\u00a0)+соединения|выключите VPN|incident:\s*[a-z0-9_]+/i.test(String(value || ""));
}

export function ozonRetryDelay(attempt) {
  return Math.min(180_000, 60_000 * (2 ** Math.max(0, attempt)));
}

export function productTitlePriority(value) {
  const text = String(value || "");
  if (/трус|нижн(?:ее|его|ем)?\s+бель|бюст|лифчик|шляп|панам|кепк|козыр|докер|косынк|головн.*убор/i.test(text)) return 300;
  if (/носк|перчат|заколк|резинк|брелок|подвеск|наклейк|чехол|ремеш|браслет|кулон/i.test(text)) return 200;
  if (/кукл|игруш/i.test(text)) return 100;
  return 0;
}

function favoriteLinkPriority(link) {
  const provenSeller = isProvenSellerSource(link?.source_url);
  return (provenSeller ? 1000 : 0) + productTitlePriority(link?.text);
}

export function isProvenSellerSource(value) {
  return /\/seller\/(?:nuanniu|miaowu|yishao|alisa-3673390|vash-vybor-3332584|xiangyu01|kshunby|xzx-a02|fabrika-ulichnogo-stilya|linkworld-2709304|dretd)(?:[/?]|$)/i.test(String(value || ""));
}

function sourceUrlPriority(value) {
  const raw = String(value || "");
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const proven = isProvenSellerSource(raw) ? 1000 : 0;
  const global = /(?:ozon-global|tovary-iz-kitaya|tovary-so-vsego-mira|is_global=true)/i.test(decoded) ? 500 : 0;
  const targetFamily = /(?:детск|detsk|ребен|odezhd|aksess|accessor|одежд|обув|трус|кепк|панам|носк|заколк|брелок|ремешок|бижутер)/i.test(decoded) ? 250 : 0;
  return proven + global + targetFamily;
}

function sourceUrlKey(value) {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("sorting");
    return url.toString();
  } catch {
    return String(value || "").replace(/([?&])sorting=[^&]*&?/i, "$1").replace(/[?&]$/, "");
  }
}

export function expandHighYieldSourceUrls(urls, yieldRows = []) {
  const expanded = [...urls];
  const seen = new Set(expanded);
  const successful = [...new Set(yieldRows
    .filter((row) => row?.status === "published" && /^https?:\/\//i.test(String(row?.source_url || "")))
    .map((row) => String(row.source_url)))];
  for (const source of successful) {
    for (const sorting of ["rating", "price", "discount"]) {
      try {
        const url = new URL(source);
        url.searchParams.set("sorting", sorting);
        const value = url.toString();
        if (!seen.has(value)) {
          seen.add(value);
          expanded.push(value);
        }
      } catch {}
    }
  }
  return expanded;
}

export function prioritizeSourceUrls(urls, { highYieldSources = [] } = {}) {
  const successfulKeys = new Set(highYieldSources.map(sourceUrlKey));
  return [...urls]
    .map((url, index) => ({
      url,
      index,
      priority: sourceUrlPriority(url) + (successfulKeys.has(sourceUrlKey(url)) ? 2000 : 0),
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map(({ url }) => url);
}

export function prioritizeFavoriteLinks(links) {
  return [...links]
    .map((link, index) => ({ link, index, priority: favoriteLinkPriority(link) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map(({ link }) => link);
}

export function limitLinksPerSource(rows, limit = 24) {
  const maximum = Math.max(1, Number(limit) || 24);
  return rows.flatMap((row) => prioritizeFavoriteLinks((row?.links || []).map((link) => ({
    ...link,
    source_url: row.source_url,
  }))).slice(0, maximum));
}

export function terminalSkusFromJsonl(text) {
  const latest = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const sku = String(event?.sku ?? "").trim();
      if (sku) latest.set(sku, String(event?.status || ""));
    } catch {}
  }
  return new Set([...latest].filter(([, status]) => status === "skipped" || status === "published").map(([sku]) => sku));
}

async function loadExcludedSkus(outputPath, env) {
  const excluded = new Set();
  try {
    const stateText = await fs.readFile(path.join(path.dirname(outputPath), "sku_states.jsonl"), "utf8");
    for (const sku of terminalSkusFromJsonl(stateText)) excluded.add(sku);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const favoriteText = await fs.readFile(path.join(path.dirname(outputPath), "favorite_collection.jsonl"), "utf8");
    for (const line of favoriteText.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event?.status === "rejected" && event?.sku) excluded.add(String(event.sku));
      } catch {}
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const publishedCsv = path.resolve(env.FLOW_B_PUBLISHED_CSV || path.join(import.meta.dirname, "../../data/flow_b/published_links.csv"));
  try {
    const csvText = await fs.readFile(publishedCsv, "utf8");
    for (const line of csvText.split(/\r?\n/)) {
      const sku = skuFromProductUrl(line);
      if (sku) excluded.add(sku);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return excluded;
}

function skuFromProductUrl(value) {
  return String(value || "").match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/)?.[1] || "";
}

export function parseFavoriteProductSnapshot({ url, title, ogTitle, ogImage, priceText }) {
  const sku = skuFromProductUrl(url);
  if (!sku) throw new Error("Ozon product SKU is missing");
  const coverImage = String(ogImage || "").trim();
  if (!coverImage) throw new Error(`Ozon cover image is missing for SKU ${sku}`);
  const source = String(priceText || "");
  const rawPrice = source.match(/[0-9][0-9\s\u00a0\u2009\u202f]*(?:[,.][0-9]+)?/)?.[0] || "";
  const sellPrice = Number(rawPrice.replace(/[\s\u00a0\u2009\u202f]/g, "").replace(",", "."));
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) throw new Error(`Ozon sell price is missing for SKU ${sku}`);
  const currency = source.includes("¥") ? "CNY" : source.includes("₸") ? "KZT" : "RUB";
  const productTitle = String(ogTitle || title || "")
    .replace(/\s+купить на OZON.*$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
  if (!productTitle) throw new Error(`Ozon title is missing for SKU ${sku}`);
  return {
    sku,
    coverImage,
    price_info: { sell_price: sellPrice, currency },
    title: productTitle,
  };
}

async function favoriteCount(page) {
  const result = await page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=1&is_imported=0", { headers });
    const body = await response.json();
    return {
      total: Number(body?.data?.total || 0),
      hasToken: Boolean(token),
      httpOk: response.ok,
      code: body?.code,
      pageText: (document.body?.innerText || "").slice(0, 1000),
    };
  });
  return { total: result.total, authenticated: isFavoriteSessionAuthenticated(result) };
}

async function favoriteSkus(page) {
  return page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/skus", { headers });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1 || !Array.isArray(body?.data)) {
      throw new Error(body?.msg || "Unable to load Maozi favorite SKUs");
    }
    return body.data.map(String);
  });
}

async function favoriteProduct(page, productInfo) {
  return page.evaluate(async (payload) => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/toggle", {
      method: "POST",
      headers,
      body: JSON.stringify({ productInfo: payload, status: true }),
    });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1) throw new Error(body?.msg || `HTTP ${response.status}`);
    return body;
  }, productInfo);
}

async function extractFavoriteProduct(page, url, timeout) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(10_000, Math.min(30_000, timeout * 2)) });
  const deadline = Date.now() + timeout;
  let snapshot;
  do {
    snapshot = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || "",
      ogImage: document.querySelector('meta[property="og:image"]')?.content || "",
      priceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
      mode: (document.body?.innerText || "").match(/发货模式：\s*([^\n]+)/)?.[1]?.trim() || "",
      pageText: (document.body?.innerText || "").slice(0, 1000),
    })).catch(() => null);
    if (isOzonSoftBlock(`${snapshot?.title || ""} ${snapshot?.pageText || ""}`)) {
      throw new Error(`Ozon detail soft blocked: ${url}`);
    }
    if (/доступ ограничен|access denied|captcha/i.test(`${snapshot?.title || ""} ${snapshot?.pageText || ""}`)) {
      throw new Error(`Ozon detail is blocked: ${url}`);
    }
    if (snapshot?.ogImage && snapshot?.priceText && snapshot?.mode) break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  const modeReason = favoriteModeSkipReason(snapshot?.mode);
  if (modeReason) throw new Error(`${modeReason}: SKU ${skuFromProductUrl(snapshot?.url || url)}`);
  return parseFavoriteProductSnapshot(snapshot || { url });
}

async function collectFavorites({ context, maozi, links, target, currentTotal, env, attempted, logFile, log }) {
  if (currentTotal >= target || !links.length) return currentTotal;
  const existing = new Set(await favoriteSkus(maozi));
  const queue = [];
  for (const link of prioritizeFavoriteLinks(links)) {
    const href = typeof link === "string" ? link : link?.href;
    const sku = skuFromProductUrl(href);
    if (!sku || existing.has(sku) || attempted.has(sku)) continue;
    attempted.add(sku);
    queue.push({ sku, href, source_url: typeof link === "object" ? link?.source_url : null });
  }
  const workerCount = Math.max(1, envNumber(env, "FLOW_B_FAVORITE_WORKERS", envNumber(env, "FLOW_B_TAB_WORKERS", 4)));
  const timeout = envNumber(env, "FLOW_B_FAVORITE_DETAIL_TIMEOUT", 15000);
  let cursor = 0;
  let total = currentTotal;
  let inFlight = 0;
  let nextApiAt = 0;
  let apiChain = Promise.resolve();
  let nextDetailAt = 0;
  let detailBlockedUntil = 0;
  let detailGate = Promise.resolve();
  const apiInterval = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_INTERVAL_MS", 750));
  const maxRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_RETRIES", 5));
  const detailInterval = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_INTERVAL_MS", 1500));
  const detailRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_RETRIES", 3));
  const reserveDetailSlot = () => {
    const operation = detailGate.then(async () => {
      const wait = Math.max(0, Math.max(nextDetailAt, detailBlockedUntil) - Date.now());
      if (wait) await sleep(wait);
      nextDetailAt = Date.now() + detailInterval;
    });
    detailGate = operation.catch(() => {});
    return operation;
  };
  const loadProduct = async (page, item) => {
    for (let attempt = 0; ; attempt += 1) {
      await reserveDetailSlot();
      try {
        return await extractFavoriteProduct(page, item.href, timeout);
      } catch (error) {
        if (!/Ozon detail soft blocked/i.test(String(error?.message || error)) || attempt >= detailRetries) throw error;
        const retryDelay = ozonRetryDelay(attempt);
        detailBlockedUntil = Math.max(detailBlockedUntil, Date.now() + retryDelay);
        log(`Ozon detail retry SKU ${item.sku} attempt=${attempt + 1} wait=${retryDelay}ms`);
      }
    }
  };
  const callFavorite = (productInfo) => {
    const operation = apiChain.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const gateWait = Math.max(0, nextApiAt - Date.now());
        if (gateWait) await sleep(gateWait);
        try {
          const result = await favoriteProduct(maozi, productInfo);
          nextApiAt = Date.now() + apiInterval;
          return result;
        } catch (error) {
          nextApiAt = Date.now() + apiInterval;
          const retryDelay = favoriteRetryDelay(error, attempt);
          if (retryDelay === null || attempt >= maxRetries) throw error;
          log(`favorite API retry SKU ${productInfo.sku} attempt=${attempt + 1} wait=${retryDelay}ms: ${error?.message || error}`);
          await sleep(retryDelay);
        }
      }
    });
    apiChain = operation.catch(() => {});
    return operation;
  };
  let writeChain = Promise.resolve();
  const record = (row) => {
    writeChain = writeChain.then(() => fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`));
    return writeChain;
  };
  const workers = Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    const page = await context.newPage();
    try {
      while (canClaimFavorite({ total, inFlight, target })) {
        const item = queue[cursor++];
        if (!item) break;
        inFlight += 1;
        try {
          const productInfo = await loadProduct(page, item);
          await callFavorite(productInfo);
          existing.add(productInfo.sku);
          total += 1;
          const observedTotal = total;
          await record({
            status: "favorited",
            preflight_mode: "FBS",
            shipping_mode: "FBS",
            sku: productInfo.sku,
            url: item.href,
            source_url_product: item.href,
            source_url: item.source_url || null,
            sale_price: productInfo.price_info?.sell_price ?? null,
            title: productInfo.title,
            cover_image: productInfo.coverImage,
            total: observedTotal,
          });
          log(`favorite SKU ${productInfo.sku} total=${observedTotal}/${target}`);
        } catch (error) {
          if (isFavoriteCapacityReached(error)) {
            total = target;
            await record({ status: "capacity_reached", sku: item.sku, url: item.href, message: String(error?.message || error) });
            log(`favorite capacity reached; ending collection at configured target ${target}`);
          } else if (/^non-pure-fbs:/i.test(String(error?.message || error))) {
            await record({ status: "rejected", reason: "non-pure-fbs", sku: item.sku, url: item.href });
            log(`favorite rejected SKU ${item.sku}: non-pure-fbs`);
          } else {
            await record({ status: "failed", sku: item.sku, url: item.href, error: String(error?.message || error) });
            log(`favorite failed SKU ${item.sku}: ${error?.message || error}`);
          }
        } finally {
          inFlight -= 1;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  });
  await Promise.all(workers);
  await writeChain;
  return total;
}

async function scanOne(page, url, { steps, ratio, delay, initialWait, maxNoNewSteps }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForContent(page, 20000);
  await sleep(initialWait);
  await page.evaluate(() => window.scrollTo(0, 0));
  const links = new Map();
  let stable = 0;
  let noNew = 0;
  let lastHeight = 0;
  let lastY = -1;
  let lastLinkCount = 0;
  let title = "";
  let finalUrl = url;
  let blocked = false;
  let stopReason = "max_steps";
  const started = Date.now();

  for (let step = 0; step < steps; step += 1) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        y: Math.round(scrollY),
        height: document.body?.scrollHeight || 0,
        viewport: innerHeight,
        text: text.slice(0, 900),
        links: [...document.querySelectorAll('a[href*="/product/"]')].map((anchor) => ({
          href: String(anchor.href || "").split("?")[0],
          text: String(anchor.innerText || anchor.title || "").trim().slice(0, 120),
        })),
      };
    });
    title = state.title;
    finalUrl = state.url;
    blocked = /доступ ограничен|access denied|captcha|похоже, нет/i.test(`${title} ${state.text}`);
    for (const link of state.links) if (link.href.includes("/product/")) links.set(link.href, link.text || links.get(link.href) || "");
    if (blocked) { stopReason = "blocked_or_empty"; break; }
    const nearBottom = state.y + state.viewport >= state.height - 100;
    stable = links.size === lastLinkCount && nearBottom && Math.abs(state.y - lastY) < 20 && Math.abs(state.height - lastHeight) < 20 ? stable + 1 : 0;
    noNew = links.size === lastLinkCount ? noNew + 1 : 0;
    lastLinkCount = links.size;
    lastY = state.y;
    lastHeight = state.height;
    if (stable >= 8) { stopReason = "stable_bottom"; break; }
    if (noNew >= maxNoNewSteps && nearBottom) { stopReason = "no_new_links_near_bottom"; break; }
    await page.evaluate((scrollRatio) => window.scrollBy(0, Math.max(350, Math.floor(innerHeight * scrollRatio))), ratio);
    await sleep(delay);
  }
  return {
    final_url: finalUrl,
    title,
    blocked,
    stop_reason: stopReason,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cumulative_product_link_count: links.size,
    links: [...links].sort().map(([href, text]) => ({ href, text })),
  };
}

export async function scanSources({ context, urlsFile, outFile, env = process.env, log = console.log }) {
  const inputPath = path.resolve(urlsFile);
  const outputPath = path.resolve(outFile);
  const inputUrls = [...new Set((await fs.readFile(inputPath, "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  let yieldRows = [];
  try {
    const text = await fs.readFile(path.join(path.dirname(outputPath), "source_yield.jsonl"), "utf8");
    yieldRows = text.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const urls = [...new Set(expandHighYieldSourceUrls(inputUrls, yieldRows))];
  let records = [];
  try {
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (Array.isArray(parsed)) records = parsed;
  } catch {}
  const done = new Set(records.map((row) => row.source_url).filter(Boolean));
  const highYieldSources = yieldRows.filter((row) => row?.status === "published").map((row) => row.source_url);
  const pending = prioritizeSourceUrls(urls.filter((url) => !done.has(url)), { highYieldSources });
  const workers = Math.max(1, envNumber(env, "FLOW_B_TAB_WORKERS", 4));
  const adaptiveWorkers = new AdaptiveConcurrency({
    initial: workers,
    max: Math.max(workers, envNumber(env, "FLOW_B_MAX_TAB_WORKERS", 12)),
  });
  const options = {
    steps: envNumber(env, "FLOW_B_MAX_SCROLL_STEPS", 24),
    ratio: envNumber(env, "FLOW_B_SCROLL_RATIO", 0.82),
    delay: envNumber(env, "FLOW_B_SCROLL_DELAY", 0.65) * 1000,
    initialWait: envNumber(env, "FLOW_B_MAOZI_INITIAL_WAIT", 8) * 1000,
    maxNoNewSteps: envNumber(env, "FLOW_B_MAX_NO_NEW_LINK_STEPS", 45),
  };
  const lowDeltaThreshold = envNumber(env, "FLOW_B_LOW_DELTA_THRESHOLD", 1);
  const lowDeltaBatchLimit = envNumber(env, "FLOW_B_LOW_DELTA_BATCH_LIMIT", 2);
  let lowDeltaBatches = 0;
  const targetFavorites = envNumber(env, "FLOW_B_TARGET_FAVORITES", 1000);
  const attempted = await loadExcludedSkus(outputPath, env);
  log(`favorite exclusions loaded: ${attempted.size}`);
  const favoriteLog = path.join(path.dirname(outputPath), "favorite_collection.jsonl");
  const maozi = await openMaoziPage(context, { forceNew: true });
  try {
    await waitForContent(maozi, 15000);
    if (requiresFavoriteSession(env)) {
      await ensureMaoziLogin(maozi, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    }
    let favoriteState = await favoriteCount(maozi);
    if (requiresFavoriteSession(env) && !favoriteState.authenticated) throw new Error("Maozi profile token is stale or the session is not logged in");
    let favoriteBefore = favoriteState.authenticated ? favoriteState.total : null;

    if (favoriteBefore !== null && favoriteBefore < targetFavorites && records.length) {
      const retainedRows = env.FLOW_B_SKIP_RETAINED === "1"
        ? []
        : env.FLOW_B_RETAINED_PROVEN_ONLY === "1"
          ? records.filter((row) => isProvenSellerSource(row.source_url))
          : records;
      const retainedLinks = limitLinksPerSource(retainedRows, envNumber(env, "FLOW_B_MAX_LINKS_PER_SOURCE", 24));
      log(`collecting favorites from ${retainedLinks.length} retained product links`);
      favoriteBefore = await collectFavorites({
        context,
        maozi,
        links: retainedLinks,
        target: targetFavorites,
        currentTotal: favoriteBefore,
        env,
        attempted,
        logFile: favoriteLog,
        log,
      });
    }

    for (let start = 0; start < pending.length;) {
      if (favoriteBefore !== null && favoriteBefore >= targetFavorites) break;
      const batch = pending.slice(start, start + adaptiveWorkers.current);
      start += batch.length;
      const batchFavoriteBefore = favoriteBefore;
      log(`batch ${start - batch.length + 1}-${start} / ${pending.length} concurrency=${adaptiveWorkers.current}`);
      const pages = await Promise.all(batch.map(() => context.newPage()));
      const batchRows = await Promise.all(pages.map((page, index) => scanOne(page, batch[index], options)
        .catch((error) => ({ source_url: batch[index], blocked: false, stop_reason: `error: ${error.message}`, links: [], cumulative_product_link_count: 0 }))));
      await Promise.all(pages.map((page) => page.close().catch(() => {})));
      for (const row of batchRows) {
        if (row.blocked || /soft block|access denied|captcha|timeout|error:/i.test(String(row.stop_reason || ""))) {
          adaptiveWorkers.recordFailure(new Error(row.stop_reason || "soft block"));
        } else {
          adaptiveWorkers.recordSuccess();
        }
      }
      if (favoriteBefore !== null) {
        favoriteBefore = await collectFavorites({
          context,
          maozi,
          links: limitLinksPerSource(batchRows.map((row, index) => ({ ...row, source_url: batch[index] })), envNumber(env, "FLOW_B_MAX_LINKS_PER_SOURCE", 24)),
          target: targetFavorites,
          currentTotal: favoriteBefore,
          env,
          attempted,
          logFile: favoriteLog,
          log,
        });
      }
      const afterWait = envNumber(env, "FLOW_B_MAOZI_AFTER_SCAN_WAIT", 10) * 1000;
      if (afterWait) await sleep(afterWait);
      favoriteState = await favoriteCount(maozi);
      const observedFavoriteAfter = favoriteState.authenticated ? favoriteState.total : null;
      const favoriteAfter = observedFavoriteAfter === null ? null : effectiveFavoriteTotal({
        claimedTotal: favoriteBefore,
        observedTotal: observedFavoriteAfter,
        target: targetFavorites,
      });
      const delta = batchFavoriteBefore !== null && favoriteAfter !== null ? favoriteAfter - batchFavoriteBefore : null;
      records.push(...batchRows.map((row, index) => ({
        source_url: batch[index],
        ...row,
        favorite_count_before: batchFavoriteBefore,
        favorite_count_after: favoriteAfter,
        favorite_count_delta: delta,
      })));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(records, null, 2));
      log(`favorite ${batchFavoriteBefore} -> ${favoriteAfter} delta=${delta}`);
      favoriteBefore = favoriteAfter;
      if (favoriteAfter !== null && favoriteAfter >= targetFavorites) break;
      if (lowDeltaBatchLimit > 0) {
        lowDeltaBatches = delta === null || delta < lowDeltaThreshold ? lowDeltaBatches + 1 : 0;
        if (lowDeltaBatches >= lowDeltaBatchLimit) break;
      }
    }
    return { outFile: outputPath, records: records.length, pending: pending.length };
  } finally {
    await maozi.close().catch(() => {});
  }
}
