const PROHIBITED = [/еда|пищ|корм|food/i, /одеж|плать|fashion|服装/i, /телефон|смартфон|ноутбук|3c/i, /жидк|спрей|порош|клей|масло|лекар|витамин/i, /манекен|anatomical|人体模型/i];

export function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function selectNamedResource(rows, needle, label) {
  const normalized = normalizeName(needle);
  const found = normalized && rows.find((row) => [row.name, row.title, row.content, row.label]
    .some((value) => normalizeName(value).includes(normalized)));
  if (!found) throw new Error(`${label} not found: ${needle}`);
  return found;
}

export function selectSalePrice({ current_price, follow_min, selected_price, sale_price, sell_price }) {
  const primary = [current_price, follow_min].map(Number).filter((value) => value > 0);
  if (primary.length) return Math.min(...primary);
  const values = [selected_price, sale_price, sell_price].map(Number).filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

export function isPureFbs(mode) {
  const parts = String(mode ?? "").split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
  return parts.length === 1 && parts[0] === "FBS";
}

function isCelEconomyResult(result) {
  return result !== null
    && typeof result === "object"
    && typeof result.title === "string"
    && result.title.toLowerCase().includes("cel economy")
    && result.price_list !== null
    && typeof result.price_list === "object"
    && result.price_list.logistics_name === "CEL"
    && result.price_list.logistics_speed === "economy";
}

export function preflightSkipReason(item) {
  const text = `${item.title ?? ""} ${item.category ?? ""}`;
  if (!isPureFbs(item.mode)) return "non-pure-fbs";
  if (PROHIBITED.find((pattern) => pattern.test(text))) return "prohibited-category";
  return isCelEconomyResult(item.economy) ? null : "missing-cel-economy";
}

export function profitSkipReason(calc, threshold = 30) {
  if (!(Number(calc.purchase_price) > 0)) return "purchase_price<=0";
  if (!(Number(calc.sell_price) > 0)) return "sell_price<=0";
  if (!(Number(calc.cate_rate) > 0)) return "cate_rate<=0";
  if (!(Number(calc.cate_fee) > 0)) return "cate_fee<=0";
  if (!(Number(calc.profit_rate) > threshold)) return `profit_rate<=${threshold}`;
  return null;
}
