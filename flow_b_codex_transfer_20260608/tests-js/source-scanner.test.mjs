import test from "node:test";
import assert from "node:assert/strict";

import {
  canClaimFavorite,
  favoriteRetryDelay,
  favoriteModeSkipReason,
  effectiveFavoriteTotal,
  expandHighYieldSourceUrls,
  isFavoriteSessionAuthenticated,
  isFavoriteCapacityReached,
  isOzonSoftBlock,
  isProvenSellerSource,
  ozonRetryDelay,
  prioritizeFavoriteLinks,
  prioritizeSourceUrls,
  parseFavoriteProductSnapshot,
  requiresFavoriteSession,
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

test("Ozon no-connection incident pages are retried with a longer cooldown", () => {
  assert.equal(isOzonSoftBlock("Похоже, нет соединения Выключите VPN"), true);
  assert.equal(isOzonSoftBlock("ordinary product page"), false);
  assert.equal(ozonRetryDelay(0), 60_000);
  assert.equal(ozonRetryDelay(2), 180_000);
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
