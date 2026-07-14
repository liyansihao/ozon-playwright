import test from "node:test";
import assert from "node:assert/strict";

import {
  canClaimFavorite,
  favoriteRetryDelay,
  favoriteModeSkipReason,
  effectiveFavoriteTotal,
  excludedSkusFromHistories,
  expandHighYieldSourceUrls,
  isFavoriteSessionAuthenticated,
  isFavoriteCapacityReached,
  isOzonSoftBlock,
  isProvenSellerSource,
  ozonRetryDelay,
  ozonDetailFailurePolicy,
  prioritizeFavoriteLinks,
  prioritizeSourceUrls,
  parseFavoriteProductSnapshot,
  requiresFavoriteSession,
  retryMaoziPageFetch,
  retainedRowsForCollection,
  orderRowsBySourceYield,
  waitForMovingDeadline,
  shouldYieldAfterRetained,
  terminalSkusFromJsonl,
  limitLinksPerSource,
} from "../scripts/flow_b_playwright/source-scanner.mjs";

test("source scan prioritizes proven sellers, Global China, and target families stably", () => {
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  const apparel = "https://www.ozon.ru/highlight/odezhda-obuv-i-aksessuary-iz-za-rubezha-1698511/";
  const global = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/";
  const proven = "https://www.ozon.ru/seller/nuanniu/";
  assert.deepEqual(prioritizeSourceUrls([ordinary, apparel, global, proven]), [proven, global, apparel, ordinary]);
});

test("published sources expand into prioritized sorting variants without duplicates", () => {
  const successful = "https://www.ozon.ru/seller/example/?currency_price=50.000%3B";
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  const rows = [{ source_url: successful, status: "published" }];
  const expanded = expandHighYieldSourceUrls([ordinary, successful], rows);
  const prioritized = prioritizeSourceUrls(expanded, { highYieldSources: [successful] });
  assert.equal(prioritized[0], successful);
  assert.deepEqual(prioritized.slice(1, 4).map((value) => new URL(value).searchParams.get("sorting")), ["rating", "price", "discount"]);
  assert.ok(prioritized.some((value) => new URL(value).searchParams.get("currency_price") === "500.000;"
    && new URL(value).searchParams.get("sorting") === "discount"));
  assert.equal(new Set(prioritized).size, prioritized.length);
  assert.equal(prioritized.at(-1), ordinary);
});

test("source fairness caps each large source before combining batches", () => {
  const rows = [
    { source_url: "a", links: Array.from({ length: 5 }, (_, index) => ({ href: `a-${index}`, text: "" })) },
    { source_url: "b", links: Array.from({ length: 5 }, (_, index) => ({ href: `b-${index}`, text: "" })) },
  ];
  assert.deepEqual(limitLinksPerSource(rows, 2).map((row) => row.href), ["a-0", "a-1", "b-0", "b-1"]);
});

test("skip-retained still resumes persisted high-yield sources", () => {
  const successful = "https://www.ozon.ru/seller/winner/?currency_price=50.000%3B";
  const records = [
    { source_url: `${successful}&sorting=rating`, links: [{ href: "winner" }] },
    { source_url: "https://www.ozon.ru/seller/ordinary/", links: [{ href: "ordinary" }] },
  ];
  assert.deepEqual(retainedRowsForCollection(records, {
    skipRetained: true,
    highYieldSources: [successful],
  }).map((row) => row.links[0].href), ["winner"]);
});

test("retained source rows prefer observed publications over file order", () => {
  const rows = [
    { source_url: "https://www.ozon.ru/seller/dry/?sorting=rating" },
    { source_url: "https://www.ozon.ru/seller/winner/?currency_price=500.000%3B" },
  ];
  const yieldRows = [
    { source_url: "https://www.ozon.ru/seller/dry/", status: "skipped" },
    { source_url: "https://www.ozon.ru/seller/winner/?sorting=price", status: "published" },
    { source_url: "https://www.ozon.ru/seller/winner/?sorting=discount", status: "published" },
  ];
  assert.deepEqual(orderRowsBySourceYield(rows, yieldRows).map((row) => row.source_url), [
    rows[1].source_url,
    rows[0].source_url,
  ]);
});

test("retained collection yields to the producer loop for fresh source feedback", () => {
  assert.equal(shouldYieldAfterRetained({ retainedLinks: 60, pendingSources: 400 }), true);
  assert.equal(shouldYieldAfterRetained({ retainedLinks: 0, pendingSources: 400 }), false);
});

test("proven seller source recognition is explicit", () => {
  assert.equal(isProvenSellerSource("https://www.ozon.ru/seller/xiangyu01/?currency_price=150"), true);
  assert.equal(isProvenSellerSource("https://www.ozon.ru/seller/dm/?currency_price=150"), false);
});

test("favorite session rejects stale tokens and login-page state", () => {
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: true, code: 1, pageText: "收藏商品" }), true);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: false, code: 0, pageText: "收藏商品" }), false);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: true, code: 1, pageText: "手机号 登录 验证码" }), false);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: false, httpOk: true, code: 1, pageText: "收藏商品" }), false);
});

test("explicitly disabling Maozi autofavorite preserves unauthenticated scan mode", () => {
  assert.equal(requiresFavoriteSession({ FLOW_B_MAOZI_AUTOFAVORITE: "0" }), false);
  assert.equal(requiresFavoriteSession({}), true);
});

test("Ozon detail metadata becomes a complete Maozi favorite payload", () => {
  assert.deepEqual(parseFavoriteProductSnapshot({
    url: "https://www.ozon.ru/product/light-pan-1467551655/?from=seller",
    title: "Light pan купить на OZON (1467551655)",
    ogTitle: "Light pan ",
    ogImage: "https://ir.ozone.ru/image.jpg",
    priceText: "151,10\u2009¥\nС банками\n158,97\u2009¥",
  }), {
    sku: "1467551655",
    coverImage: "https://ir.ozone.ru/image.jpg",
    price_info: { sell_price: 151.1, currency: "CNY" },
    title: "Light pan",
  });
});

test("favorite preflight accepts only an explicit pure FBS mode", () => {
  assert.equal(favoriteModeSkipReason("FBS"), null);
  assert.equal(favoriteModeSkipReason("FBS, RFBS"), "non-pure-fbs");
  assert.equal(favoriteModeSkipReason(null), "missing-shipping-mode");
});

test("favorite payload parser rejects incomplete Ozon details", () => {
  assert.throws(() => parseFavoriteProductSnapshot({
    url: "https://www.ozon.ru/product/1467551655/",
    title: "Missing image",
    priceText: "100 ₽",
  }), /cover image/i);
});

test("favorite workers reserve capacity without exceeding the target", () => {
  assert.equal(canClaimFavorite({ total: 4, inFlight: 0, target: 5 }), true);
  assert.equal(canClaimFavorite({ total: 4, inFlight: 1, target: 5 }), false);
  assert.equal(canClaimFavorite({ total: 5, inFlight: 0, target: 5 }), false);
});

test("Maozi rate limits and transient network failures use bounded backoff", () => {
  assert.equal(favoriteRetryDelay(new Error("HTTP 429"), 0), 15_000);
  assert.equal(favoriteRetryDelay(new Error("HTTP 429"), 3), 60_000);
  assert.equal(favoriteRetryDelay(new Error("Failed to fetch"), 0), 2_000);
  assert.equal(favoriteRetryDelay(new Error("validation failed"), 0), null);
});

test("Maozi page fetch telemetry survives a short browser network outage", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryMaoziPageFetch(async () => {
    calls += 1;
    if (calls < 3) throw new Error("Failed to fetch");
    return { total: 17 };
  }, {
    attempts: 4,
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(result, { total: 17 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2_000, 4_000]);
});

test("detail gate rechecks a cooldown deadline extended while waiting", async () => {
  let now = 0;
  let deadline = 10;
  const waits = [];
  await waitForMovingDeadline({
    getDeadline: () => deadline,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
      if (waits.length === 1) deadline = 25;
    },
  });
  assert.deepEqual(waits, [10, 15]);
});

test("Ozon no-connection incident pages are retried with a longer cooldown", () => {
  assert.equal(isOzonSoftBlock("Похоже, нет соединения Выключите VPN"), true);
  assert.equal(isOzonSoftBlock("ordinary product page"), false);
  assert.equal(ozonRetryDelay(0), 60_000);
  assert.equal(ozonRetryDelay(2), 180_000);
  assert.deepEqual(ozonDetailFailurePolicy(new Error("Ozon detail soft blocked"), 0, 0), {
    softBlocked: true,
    retry: false,
    delay: 60_000,
  });
});

test("favorite collection prioritizes proven lightweight product families stably", () => {
  const links = [
    { href: "ordinary", text: "Большая картина" },
    { href: "proven-seller", text: "Обычный товар", source_url: "https://www.ozon.ru/seller/xiangyu01/" },
    { href: "toy", text: "Детская игрушка" },
    { href: "underwear", text: "Комплект трусов" },
    { href: "hat", text: "Панама шляпа для девочек" },
    { href: "strap", text: "Ремешок для часов" },
    { href: "ordinary-2", text: "Кухонная посуда" },
  ];
  assert.deepEqual(prioritizeFavoriteLinks(links).map((link) => link.href), [
    "proven-seller",
    "underwear",
    "hat",
    "strap",
    "toy",
    "ordinary",
    "ordinary-2",
  ]);
});

test("Maozi favorite capacity is a batch terminal condition", () => {
  assert.equal(isFavoriteCapacityReached(new Error("收藏数量已达上限（1000个），请先删除部分收藏")), true);
  assert.equal(isFavoriteCapacityReached(new Error("商品信息不完整")), false);
  assert.equal(effectiveFavoriteTotal({ claimedTotal: 1000, observedTotal: 962, target: 1000 }), 1000);
  assert.equal(effectiveFavoriteTotal({ claimedTotal: 900, observedTotal: 905, target: 1000 }), 905);
});

test("rolling collection excludes only latest terminal skipped or published SKUs", () => {
  const text = [
    JSON.stringify({ sku: "1", status: "skipped" }),
    JSON.stringify({ sku: "2", status: "failed" }),
    JSON.stringify({ sku: "2", status: "published" }),
    JSON.stringify({ sku: "3", status: "skipped" }),
    JSON.stringify({ sku: "3", status: "processing" }),
    "malformed",
  ].join("\n");
  assert.deepEqual([...terminalSkusFromJsonl(text)].sort(), ["1", "2"]);
});

test("cross-run seeds skip deterministic outcomes but retry transient favorite failures", () => {
  const excluded = excludedSkusFromHistories({
    stateTexts: [[
      JSON.stringify({ sku: "published", status: "published" }),
      JSON.stringify({ sku: "unprofitable", status: "skipped" }),
      JSON.stringify({ sku: "retry-state", status: "failed" }),
    ].join("\n")],
    favoriteTexts: [[
      JSON.stringify({ sku: "non-fbs", status: "rejected", reason: "non-pure-fbs" }),
      JSON.stringify({ sku: "soft-block", status: "failed", error: "Ozon detail soft blocked" }),
    ].join("\n")],
  });
  assert.deepEqual([...excluded].sort(), ["non-fbs", "published", "unprofitable"]);
});
