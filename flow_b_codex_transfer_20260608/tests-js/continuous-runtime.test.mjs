import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveConcurrency,
  acceptanceSummary,
  operationalErrorSummary,
  mergeCandidateFacts,
  isFatalBrowserError,
  rankSourcesByYield,
  runProducerLoop,
} from "../scripts/flow_b_playwright/continuous-runtime.mjs";

test("collection facts retain publish-critical fields and override incomplete favorite rows", () => {
  const favorite = { sku: 42, title: "", sell_price: null, cover_image: null };
  const fact = {
    sku: "42",
    title: "儿童发饰",
    sale_price: 88,
    cover_image: "https://img.example/42.jpg",
    shipping_mode: "FBS",
    source_url: "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/",
    source_url_product: "https://www.ozon.ru/product/42/",
  };
  assert.deepEqual(mergeCandidateFacts(favorite, fact), {
    sku: "42",
    title: "儿童发饰",
    sell_price: 88,
    sale_price: 88,
    cover_image: "https://img.example/42.jpg",
    mode: "FBS",
    shipping_mode: "FBS",
    source_url: "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/",
    link: "https://www.ozon.ru/product/42/",
  });
});

test("operational error rate includes runtime crashes without hiding SKU failures", () => {
  assert.deepEqual(operationalErrorSummary({
    successCount: 9,
    skippedCount: 35,
    failedCount: 1,
    runtimeErrorCount: 2,
  }), {
    error_rate: 0.0638,
    sku_error_rate: 0.0222,
    runtime_error_count: 2,
  });
});

test("adaptive concurrency starts at 8, ramps to 12, and backs off on rate limits", () => {
  const adaptive = new AdaptiveConcurrency({ initial: 8, max: 12, min: 2, stableWindow: 3 });
  adaptive.recordSuccess();
  adaptive.recordSuccess();
  assert.equal(adaptive.current, 8);
  adaptive.recordSuccess();
  assert.equal(adaptive.current, 9);
  for (let index = 0; index < 9; index += 1) adaptive.recordSuccess();
  assert.equal(adaptive.current, 12);
  adaptive.recordFailure(new Error("HTTP 429 too many requests"));
  assert.equal(adaptive.current, 6);
  adaptive.recordFailure(new Error("TypeError: Failed to fetch"));
  assert.equal(adaptive.current, 3);
  adaptive.recordFailure(new Error("ordinary product mismatch"));
  assert.equal(adaptive.current, 3);
});

test("source yield ranks China/high-yield segments ahead of unproven sources", () => {
  const rows = [
    { source_url: "generic", attempted: 100, published: 3 },
    { source_url: "china-kids", attempted: 20, published: 5, segment: "Global 中国商品 儿童" },
    { source_url: "china-apparel", attempted: 30, published: 6, segment: "Global 中国商品 服饰 配饰" },
  ];
  assert.deepEqual(rankSourcesByYield(rows).map((row) => row.source_url), ["china-kids", "china-apparel", "generic"]);
});

test("acceptance only counts unique in-window profit>30 publications and excludes the bad SKU", () => {
  const startedAt = "2026-07-14T00:00:00.000Z";
  const endedAt = "2026-07-14T02:00:00.000Z";
  const rows = [
    { sku: "ok-1", profit_rate: 30.01, published_at: "2026-07-14T00:01:00.000Z" },
    { sku: "ok-1", profit_rate: 90, published_at: "2026-07-14T00:02:00.000Z" },
    { sku: "equal", profit_rate: 30, published_at: "2026-07-14T00:03:00.000Z" },
    { sku: "2815247918", profit_rate: 80, published_at: "2026-07-14T00:04:00.000Z" },
    { sku: "late", profit_rate: 80, published_at: "2026-07-14T02:00:00.001Z" },
  ];
  const summary = acceptanceSummary({ rows, startedAt, endedAt, target: 1 });
  assert.equal(summary.success_count, 1);
  assert.equal(summary.effective_per_hour, 0.5);
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.skus, ["ok-1"]);
});

test("producer loop keeps rescanning after success and survives one failed scan", async () => {
  let now = 0;
  let calls = 0;
  const errors = [];
  const result = await runProducerLoop({
    deadlineMs: 350,
    intervalMs: 100,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    scan: async () => {
      calls += 1;
      if (calls === 2) throw new Error("transient producer failure");
      return { round: calls };
    },
    onError: async (error) => { errors.push(error.message); },
  });
  assert.equal(calls, 4);
  assert.deepEqual(errors, ["transient producer failure"]);
  assert.deepEqual(result, { round: 4 });
});

test("closed Playwright contexts are fatal while individual page timeouts are recoverable", () => {
  assert.equal(isFatalBrowserError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isFatalBrowserError(new Error("browserContext.newPage: Target page has been closed")), true);
  assert.equal(isFatalBrowserError(new Error("page.goto: Timeout 12000ms exceeded")), false);
});
