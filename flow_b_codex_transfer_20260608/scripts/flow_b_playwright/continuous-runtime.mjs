import fs from "node:fs/promises";
import path from "node:path";

const BAD_SKUS = new Set(["2815247918"]);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function mergeCandidateFacts(favorite = {}, fact = {}) {
  const sku = String(favorite?.sku ?? favorite?.id ?? fact?.sku ?? "").trim();
  const salePrice = positive(favorite?.sell_price ?? favorite?.sale_price ?? favorite?.price)
    ?? positive(fact?.sale_price ?? fact?.sell_price);
  const title = String(favorite?.title || fact?.title || "").trim();
  const coverImage = String(favorite?.cover_image || favorite?.coverImage || fact?.cover_image || "").trim() || null;
  const mode = String(favorite?.mode || favorite?.shipping_mode || fact?.shipping_mode || fact?.mode || "").trim() || null;
  const sourceUrl = String(favorite?.source_url || fact?.source_url || "").trim() || null;
  const productUrl = String(favorite?.link || favorite?.detail_url || fact?.source_url_product || fact?.link || "").trim() || null;
  return {
    ...favorite,
    sku,
    title,
    sell_price: salePrice,
    sale_price: salePrice,
    cover_image: coverImage,
    mode,
    shipping_mode: mode,
    source_url: sourceUrl,
    link: productUrl,
  };
}

export async function loadCandidateFacts(runDir) {
  const facts = new Map();
  let text = "";
  try {
    text = await fs.readFile(path.join(runDir, "favorite_collection.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line);
      if (row?.status !== "favorited" || !row?.sku) continue;
      facts.set(String(row.sku), mergeCandidateFacts({}, row));
    } catch {}
  }
  return facts;
}

export function hasReusableCandidateFacts(item) {
  return Boolean(
    String(item?.title || "").trim()
      && /^https?:\/\//i.test(String(item?.cover_image || ""))
      && positive(item?.sale_price ?? item?.sell_price)
      && String(item?.shipping_mode ?? item?.mode ?? "").trim().toUpperCase() === "FBS",
  );
}

export class AdaptiveConcurrency {
  constructor({ initial = 8, max = 12, min = 2, stableWindow = 12 } = {}) {
    this.min = Math.max(1, Number(min));
    this.max = Math.max(this.min, Number(max));
    this.current = Math.max(this.min, Math.min(this.max, Number(initial)));
    this.stableWindow = Math.max(1, Number(stableWindow));
    this.stable = 0;
  }

  recordSuccess() {
    this.stable += 1;
    if (this.stable >= this.stableWindow && this.current < this.max) {
      this.current += 1;
      this.stable = 0;
    }
    return this.current;
  }

  recordFailure(error) {
    if (/429|too many requests|rate.?limit|soft block|access denied|captcha|timeout/i.test(String(error?.message || error || ""))) {
      this.current = Math.max(this.min, Math.floor(this.current / 2));
      this.stable = 0;
    }
    return this.current;
  }
}

export function rankSourcesByYield(rows) {
  return [...rows].map((row) => {
    const attempted = Math.max(0, Number(row?.attempted) || 0);
    const published = Math.max(0, Number(row?.published) || 0);
    const segment = String(row?.segment || row?.source_url || "");
    const priorityBoost = /global|中国|china/i.test(segment) ? 0.04 : 0;
    const familyBoost = /儿童|kids|配饰|accessor|服饰|apparel/i.test(segment) ? 0.02 : 0;
    return { ...row, success_rate: attempted ? published / attempted : 0, yield_score: (attempted ? published / attempted : 0) + priorityBoost + familyBoost };
  }).sort((left, right) => right.yield_score - left.yield_score || Number(right.published || 0) - Number(left.published || 0));
}

export function acceptanceSummary({ rows, startedAt, endedAt, target = 50 }) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const durationHours = Math.max(0, end - start) / 3_600_000;
  const unique = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    const at = Date.parse(row?.published_at || row?.timestamp || "");
    if (!sku || BAD_SKUS.has(sku) || !(Number(row?.profit_rate) > 30) || !(at >= start && at <= end)) continue;
    unique.set(sku, row);
  }
  const successCount = unique.size;
  return {
    window_started_at: new Date(start).toISOString(),
    window_ended_at: new Date(end).toISOString(),
    duration_hours: Math.round(durationHours * 1000) / 1000,
    success_count: successCount,
    effective_per_hour: durationHours ? Math.round((successCount / durationHours) * 100) / 100 : 0,
    target: Number(target),
    passed: successCount >= Number(target),
    excluded_skus: [...BAD_SKUS],
    skus: [...unique.keys()],
  };
}

export function operationalErrorSummary({ successCount = 0, skippedCount = 0, failedCount = 0, runtimeErrorCount = 0 } = {}) {
  const skuAttempts = Math.max(0, Number(successCount)) + Math.max(0, Number(skippedCount)) + Math.max(0, Number(failedCount));
  const runtimeErrors = Math.max(0, Number(runtimeErrorCount));
  const operationalAttempts = skuAttempts + runtimeErrors;
  const roundRate = (numerator, denominator) => denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
  return {
    error_rate: roundRate(Math.max(0, Number(failedCount)) + runtimeErrors, operationalAttempts),
    sku_error_rate: roundRate(Math.max(0, Number(failedCount)), skuAttempts),
    runtime_error_count: runtimeErrors,
  };
}
