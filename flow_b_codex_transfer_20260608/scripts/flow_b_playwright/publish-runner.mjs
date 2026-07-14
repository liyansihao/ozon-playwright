import fs from "node:fs/promises";
import path from "node:path";

import * as defaultPolicy from "./publish-policy.mjs";
import { canonicalProductUrl } from "./publish-state.mjs";
import { mapOzonCategory } from "./category-commission.mjs";
import { productTitlePriority } from "./source-scanner.mjs";
import { AdaptiveConcurrency, hasReusableCandidateFacts, loadCandidateFacts, mergeCandidateFacts } from "./continuous-runtime.mjs";

const ECONOMY_SENTINEL = Object.freeze({
  title: "CEL Economy",
  price_list: { logistics_name: "CEL", logistics_speed: "economy" },
});

function asSku(item) {
  const sku = String(item?.sku ?? item?.id ?? "").trim();
  if (!sku) throw new Error("candidate SKU is required");
  return sku;
}

function economyResult(calc) {
  if (calc?.economy?.price_list) return calc.economy;
  const rows = calc?.calc_result ?? calc?.data?.calc_result;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry?.name === "CEL" && entry?.speed === "economy");
  return row ? { title: row.title, price_list: row.price_list } : null;
}

function offerDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function prioritizePublishCandidates(items, preflightPureSkus = new Set()) {
  return [...items]
    .map((item, index) => ({
      item,
      index,
      purePreflight: preflightPureSkus.has(String(item?.sku ?? item?.id ?? "")) ? 1 : 0,
      priority: productTitlePriority(item?.title),
      salePrice: Number(item?.sell_price ?? item?.price ?? item?.price_info?.sell_price) || 0,
    }))
    .sort((left, right) => right.purePreflight - left.purePreflight
      || right.priority - left.priority
      || right.salePrice - left.salePrice
      || left.index - right.index)
    .map(({ item }) => item);
}

async function loadPreflightPureSkus(runDir) {
  const result = new Set();
  try {
    const text = await fs.readFile(path.join(runDir, "favorite_collection.jsonl"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event?.status === "favorited" && event?.preflight_mode === "FBS" && event?.sku) {
          result.add(String(event.sku));
        }
      } catch {}
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return result;
}

function buildPayload(item, detail, economy, targetConfig, now) {
  const sku = asSku(item);
  const price = rounded(economy.price_list.sell_price);
  return {
    scene: "erp",
    shop_ids: [targetConfig.store.id],
    brand: "none",
    image_order: "none",
    watermark_id: targetConfig.watermark.id,
    floating_price: null,
    rows: [{
      id: item.id ?? item.favorite_id ?? detail.id ?? detail.favorite_id,
      sku,
      title: detail.title ?? item.title ?? "",
      cover_image: detail.cover_image ?? item.cover_image ?? null,
      link: detail.link ?? detail.detail_url ?? item.link ?? item.detail_url ?? canonicalProductUrl(sku),
      sell_price: price,
      price,
      old_price: rounded(price * 2),
      offer_id: `mz-${offerDate(now())}-${sku.slice(-6)}`,
      brand: "",
      source: "favorite",
      source_currency: "CNY",
    }],
  };
}

export function createPublishRunner({
  client,
  detailProvider = client,
  costBridge,
  state,
  policy = defaultPolicy,
  target = 100,
  threshold = 30,
  now = () => new Date(),
  runDir = process.cwd(),
  storeNeedle = "丽丽1号",
  watermarkNeedle = "lysh",
  storeId = 104965,
  watermarkId = 60822,
  concurrency = 1,
  maxConcurrency = 12,
  dryCandidateLimit = 0,
  deadlineAt = null,
  targetConfigCache = null,
  sourceYieldHistoryPath = null,
} = {}) {
  if (!client || !costBridge || !state) throw new TypeError("client, costBridge, and state are required");
  if (!detailProvider || typeof detailProvider.getProductDetail !== "function") {
    throw new TypeError("Playwright Ozon detailProvider.getProductDetail is required");
  }
  const targetCount = Number(target);
  const profitThreshold = Number(threshold);
  if (!Number.isInteger(targetCount) || targetCount < 0) throw new TypeError("target must be a non-negative integer");
  if (!Number.isFinite(profitThreshold)) throw new TypeError("threshold must be numeric");
  const workerCount = Number(concurrency);
  if (!Number.isInteger(workerCount) || workerCount <= 0) throw new TypeError("concurrency must be a positive integer");
  const dryLimit = Number(dryCandidateLimit);
  if (!Number.isInteger(dryLimit) || dryLimit < 0) throw new TypeError("dryCandidateLimit must be a non-negative integer");
  let cnyRubRate = 10.4672;
  let publishChain = Promise.resolve();
  let metricsChain = Promise.resolve();
  const adaptive = new AdaptiveConcurrency({ initial: workerCount, max: Math.max(workerCount, Number(maxConcurrency) || workerCount) });

  function recordMetric(filename, row) {
    metricsChain = metricsChain.then(async () => {
      const event = { at: now().toISOString(), ...row };
      await fs.mkdir(runDir, { recursive: true });
      await fs.appendFile(path.join(runDir, filename), `${JSON.stringify(event)}\n`);
      if (filename === "source_yield.jsonl" && sourceYieldHistoryPath && event.source_url && event.status !== "ignored") {
        await fs.mkdir(path.dirname(sourceYieldHistoryPath), { recursive: true });
        await fs.appendFile(sourceYieldHistoryPath, `${JSON.stringify(event)}\n`);
      }
    });
  }

  async function timed(sku, stage, operation) {
    const started = Date.now();
    try {
      const value = await operation();
      recordMetric("stage_timings.jsonl", { sku, stage, duration_ms: Date.now() - started, ok: true });
      return value;
    } catch (error) {
      recordMetric("stage_timings.jsonl", { sku, stage, duration_ms: Date.now() - started, ok: false, error: String(error?.message || error) });
      throw error;
    }
  }

  function publishSerial(payload) {
    const operation = publishChain.then(() => client.publish(payload));
    publishChain = operation.catch(() => {});
    return operation;
  }

  async function skip(item, reason, data = {}) {
    const sku = asSku(item);
    try {
      await client.deleteFavorite(item);
    } catch (error) {
      await state.transition(sku, "failed", {
        reason: "favorite-delete-failed",
        skip_reason: reason,
        error: String(error?.message || error),
      });
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "favorite-delete-failed" };
    }
    await state.transition(sku, "skipped", { reason, favorite_deleted: true, ...data });
    return { status: "skipped", sku, source_url: item.source_url ?? null, reason };
  }

  async function processItem(item, targetConfig) {
    const sku = asSku(item);
    try {
      await state.transition(sku, "processing", { started_at: now().toISOString() });
      const reusable = hasReusableCandidateFacts(item);
      const [detailResult, categoryData] = await timed(sku, "ozon_detail_and_category", () => Promise.all([
        reusable ? Promise.resolve({
          mode: item.shipping_mode ?? item.mode,
          title: item.title,
          cover_image: item.cover_image,
          current_price: item.sale_price ?? item.sell_price,
          detail_url: item.link,
          reused_collection_facts: true,
        }) : detailProvider.getProductDetail(sku, item),
        client.getCategoryBySku(sku),
      ]));
      const detail = { ...item, ...(detailResult || {}) };

      // Reuse the central policy for mode/category checks before paying the 1688 cost.
      const earlyReason = policy.preflightSkipReason({ ...detail, economy: ECONOMY_SENTINEL });
      if (earlyReason) return skip(item, earlyReason);

      const salePrice = policy.selectSalePrice(detail);
      if (!(Number(salePrice) > 0)) return skip(item, "missing-sale-price");

      const cost = await timed(sku, "1688_cost", () => costBridge.estimate({ ...detail, sell_price: salePrice }, runDir));
      if (!cost?.ok) return skip(item, cost?.reason || cost?.error?.code || "unreliable-1688-cost", { cost });

      const productInfo = categoryData?.product_info || {};
      const category = mapOzonCategory(
        categoryData?.cate,
        targetConfig.commissionTree,
        salePrice,
        cnyRubRate,
      );
      const calc = await timed(sku, "profit_calculation", () => client.calculateProfit({
        sku,
        sell_price: salePrice,
        purchase_price: cost.cost,
        package_weight: productInfo.weight ?? detail.weight ?? 1,
        package_length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length ?? 20,
        package_width: productInfo.width ?? detail.width ?? 20,
        package_height: productInfo.height ?? detail.height ?? 20,
        china_fee: 0,
        ad_rate: 0,
        other_rate: 1,
        logistics: "CEL",
        profit_value: profitThreshold,
        profit_type: "percentage",
        cate: category.mapped,
      }));
      if (Number(calc?.cnyrub_rate) > 0) cnyRubRate = Number(calc.cnyrub_rate);
      const economy = economyResult(calc);
      const preflightReason = policy.preflightSkipReason({ ...detail, economy });
      if (preflightReason) return skip(item, preflightReason);

      const profit = {
        ...economy.price_list,
        purchase_price: economy.price_list.purchase_price ?? cost.cost,
        sell_price: economy.price_list.sell_price ?? salePrice,
      };
      const profitReason = policy.profitSkipReason(profit, profitThreshold);
      if (profitReason) return skip(item, profitReason, { profit });

      const payload = buildPayload(item, detail, economy, targetConfig, now);
      const publishResult = await timed(sku, "maozi_publish", () => publishSerial(payload));
      if (!publishResult?.ok) {
        await state.transition(sku, "failed", { reason: "publish-not-confirmed", publish_result: publishResult ?? null });
        return { status: "failed", sku, source_url: item.source_url ?? null, reason: "publish-not-confirmed" };
      }

      await state.recordPublished({
        ...item,
        sku,
        link: payload.rows[0].link,
        sell_price: payload.rows[0].sell_price,
        purchase_price: profit.purchase_price,
        profit_rate: profit.profit_rate,
        cate_rate: profit.cate_rate,
        cate_fee: profit.cate_fee,
        store_id: targetConfig.store.id,
        watermark_id: targetConfig.watermark.id,
        published_at: now().toISOString(),
      });
      return { status: "published", sku, source_url: item.source_url ?? null, payload, publishResult };
    } catch (error) {
      await state.transition(sku, "failed", { reason: "exception", error: String(error?.message || error) }).catch(() => {});
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "exception", error };
    }
  }

  async function run() {
    await state.load?.();
    state.summary?.(targetCount);
    let targetConfig = targetConfigCache?.value;
    if (!targetConfig) {
      targetConfig = {
        ...await client.resolvePublishTarget({ storeNeedle, watermarkNeedle, storeId, watermarkId }),
        commissionTree: typeof client.listCategoryCommissions === "function" ? await client.listCategoryCommissions() : [],
      };
      if (targetConfigCache) targetConfigCache.value = targetConfig;
    }
    const facts = await loadCandidateFacts(runDir);
    const candidates = prioritizePublishCandidates(
      (await client.listFavorites()).map((item) => mergeCandidateFacts(item, facts.get(String(item?.sku ?? item?.id ?? "")) || {})),
      await loadPreflightPureSkus(runDir),
    );
    let published = Number(state.runPublishedCount?.() ?? 0);
    let failed = 0;
    let skipped = 0;
    let attempted = 0;
    let dryCandidates = 0;

    async function handleCandidate(item) {
      const sku = asSku(item);
      if (state.hasPublished(sku)) return { status: "ignored", sku };

      const restoredStatus = state.statusOf?.(sku);
      if (restoredStatus === "skipped") {
        try {
          await client.deleteFavorite(item);
        } catch (error) {
          await state.transition(sku, "failed", { reason: "favorite-delete-failed", error: String(error?.message || error) }).catch(() => {});
          return { status: "failed", sku, reason: "favorite-delete-failed" };
        }
        return { status: "ignored", sku };
      }
      if (restoredStatus === "processing" || restoredStatus === "failed") {
        try {
          const existing = await client.findPublishedSku(sku);
          if (existing) {
            await state.recordPublished({ ...item, ...existing, sku, reconciled: true, reconciled_at: now().toISOString() });
            return { status: "published", sku, source_url: item.source_url ?? null, reconciled: true };
          }
        } catch (error) {
          await state.transition(sku, "failed", { reason: "reconciliation-check-failed", error: String(error?.message || error) }).catch(() => {});
          return { status: "failed", sku, reason: "reconciliation-check-failed" };
        }
      }

      return { ...await processItem(item, targetConfig), attempted: true };
    }

    let cursor = 0;
    while (cursor < candidates.length
      && published < targetCount
      && (!deadlineAt || Date.now() < Date.parse(deadlineAt))
      && (dryLimit === 0 || dryCandidates < dryLimit)) {
      const nearTarget = published >= targetCount - (adaptive.current - 1);
      const width = nearTarget ? 1 : adaptive.current;
      const batch = candidates.slice(cursor, cursor + width);
      cursor += batch.length;
      const results = await Promise.all(batch.map(handleCandidate));
      for (const result of results) {
        recordMetric("source_yield.jsonl", { sku: result.sku, source_url: result.source_url ?? null, status: result.status, reason: result.reason ?? null });
        if (result.status === "failed" && result.error) adaptive.recordFailure(result.error);
        else adaptive.recordSuccess();
        if (result.attempted) attempted += 1;
        if (result.status === "published") {
          published += 1;
          dryCandidates = 0;
        } else {
          if (result.attempted) dryCandidates += 1;
          if (result.status === "failed") failed += 1;
          else if (result.status === "skipped") skipped += 1;
        }
      }
    }

    await metricsChain;

    return {
      published,
      failed,
      skipped,
      attempted,
      dry_candidates: dryCandidates,
      final_concurrency: adaptive.current,
      deadline_reached: Boolean(deadlineAt && Date.now() >= Date.parse(deadlineAt)),
      target: targetCount,
      state_summary: state.summary?.(targetCount),
    };
  }

  return { run, processItem };
}
