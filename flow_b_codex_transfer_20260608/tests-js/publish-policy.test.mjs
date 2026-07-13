import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  selectNamedResource,
  selectSalePrice,
  isPureFbs,
  preflightSkipReason,
  profitSkipReason,
} from "../scripts/flow_b_playwright/publish-policy.mjs";

test("normalized substring matching selects the first resource", () => {
  const rows = [{ id: 1, name: "其他" }, { id: 2, name: "丽丽 1号 店铺" }, { id: 3, name: "丽丽1号备用" }];
  assert.equal(normalizeName("丽丽 1号-店铺"), "丽丽1号店铺");
  assert.deepEqual(selectNamedResource(rows, "丽丽1号", "store"), rows[1]);
});

test("resource matching includes watermark content aliases", () => {
  const rows = [{ id: 8, name: "1号", content: "lysh" }];
  assert.deepEqual(selectNamedResource(rows, "LYSH", "watermark"), rows[0]);
});

test("missing resource throws a global configuration error", () => {
  assert.throws(() => selectNamedResource([{ id: 1, name: "其他" }], "lysh", "watermark"), /watermark not found/);
});

test("sale price is the lower positive Ozon and follow price", () => {
  assert.equal(selectSalePrice({ current_price: 120, follow_min: 99 }), 99);
  assert.equal(selectSalePrice({ current_price: 120, follow_min: 0 }), 120);
});

test("only pure FBS mode is accepted", () => {
  assert.equal(isPureFbs("FBS"), true);
  assert.equal(isPureFbs("FBO,FBS"), false);
  assert.equal(isPureFbs(undefined), false);
});

test("preflight rejects prohibited categories", () => {
  assert.equal(preflightSkipReason({ mode: "FBS", title: "food storage", category: "" }), "prohibited-category");
});

test("preflight rejects a calculation without a CEL Economy result", () => {
  const item = { mode: "FBS", title: "wooden toy", category: "toys" };
  assert.equal(preflightSkipReason(item), "missing-cel-economy");
});

test("preflight accepts the explicit CEL Economy result contract", () => {
  assert.equal(preflightSkipReason({
    mode: "FBS",
    title: "wooden toy",
    category: "toys",
    economy: {
      title: "CEL Economy Small",
      price_list: { logistics_name: "CEL", logistics_speed: "economy" },
    },
  }), null);
});

test("profit gate is strict and requires category commission", () => {
  assert.match(profitSkipReason({ profit_rate: 30, cate_rate: 12, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), /profit_rate/);
  assert.match(profitSkipReason({ profit_rate: 30.01, cate_rate: 0, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), /cate_rate/);
  assert.equal(profitSkipReason({ profit_rate: 30.01, cate_rate: 12, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), null);
});
