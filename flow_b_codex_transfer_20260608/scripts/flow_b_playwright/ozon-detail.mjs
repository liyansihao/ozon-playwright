import { canonicalProductUrl } from "./publish-state.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function money(value) {
  const normalized = String(value || "")
    .replace(/[\u00a0\u2009\u202f\s]/g, "")
    .replace(",", ".");
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
  const number = Number(match?.[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rounded(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function parseOzonDetailText(text, fallbackPrice, webPriceText = "") {
  const source = String(text || "");
  const mode = source.match(/发货模式：\s*([^\n]+)/)?.[1]?.trim() || null;

  let followMin = money(source.match(/跟卖最低价：\s*¥\s*([0-9.,\s\u00a0\u2009\u202f]+)/)?.[1]);
  if (followMin === null) {
    followMin = money(source.match(/Есть дешевле или быстрее\s*\nот\s*([0-9.,\s\u00a0\u2009\u202f]+)\s*¥/i)?.[1]);
  }

  const head = source.split("选品标签：", 1)[0];
  const visiblePrice = String(webPriceText || "").includes("¥") ? money(webPriceText) : null;
  const currentPrice = visiblePrice
    ?? head.split(/\r?\n/).filter((line) => line.includes("¥") && !line.includes("₽")).map(money).find((value) => value !== null)
    ?? null;
  const fallback = money(fallbackPrice);
  const rubSuspect = currentPrice !== null && fallback !== null
    && (currentPrice > fallback * 3 || fallback > currentPrice * 3);
  const selectedBasis = [fallback, currentPrice, followMin];
  const selectedValues = selectedBasis.filter((value) => value !== null);

  return {
    mode,
    current_price: rounded(currentPrice),
    follow_min: rounded(followMin),
    selected_price: selectedValues.length ? rounded(Math.min(...selectedValues)) : null,
    fallback_price: rounded(fallback),
    current_price_rub_suspect: rubSuspect,
  };
}

export function createOzonDetailProvider({ context, timeout = 20000, pollInterval = 750 } = {}) {
  if (!context || typeof context.newPage !== "function") throw new TypeError("Playwright context is required for Ozon detail extraction");
  return {
    async getProductDetail(skuValue, item = {}) {
      const sku = String(skuValue || "").trim();
      if (!sku) throw new Error("Ozon detail SKU is required");
      const page = await context.newPage();
      try {
        const url = item.link || item.detail_url || canonicalProductUrl(sku);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        const deadline = Date.now() + Math.max(0, timeout);
        let payload = null;
        do {
          payload = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            text: document.body?.innerText || "",
            webPriceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
          })).catch(() => null);
          const diagnostic = `${payload?.title || ""} ${payload?.text?.slice(0, 1000) || ""}`;
          if (/доступ ограничен|access denied|captcha/i.test(diagnostic)) throw new Error(`Ozon detail is blocked for SKU ${sku}`);
          if (payload?.text && /发货模式：/.test(payload.text)) break;
          if (Date.now() >= deadline) break;
          await delay(Math.max(1, pollInterval));
        } while (true);
        if (!payload?.text) throw new Error(`Ozon detail text unavailable for SKU ${sku}`);
        const fallback = item.sell_price ?? item.current_price ?? item.price;
        return {
          ...parseOzonDetailText(payload.text, fallback, payload.webPriceText),
          detail_url: payload.url,
          detail_title: payload.title,
        };
      } finally {
        await page.close().catch(() => {});
      }
    },
  };
}
