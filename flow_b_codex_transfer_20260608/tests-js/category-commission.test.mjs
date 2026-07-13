import test from "node:test";
import assert from "node:assert/strict";

import { mapOzonCategory } from "../scripts/flow_b_playwright/category-commission.mjs";

const tree = [{
  cate_id: 10,
  label: "Top",
  children: [{
    cate_id: 20,
    label: "Second",
    children: [
      { label: "售价 ≤ 1500₽ (12.00%)", value: "1,12.00" },
      { label: "1500₽ < 售价 ≤ 3000₽ (14.00%)", value: "2,14.00" },
      { label: "售价 > 3000₽ (16.00%)", value: "3,16.00" },
    ],
  }],
}];

test("category commission mapping selects the sale-ruble tier", () => {
  assert.deepEqual(mapOzonCategory([10, 20, 999], tree, 100, 10.5), {
    mapped: [10, 20, "1,12.00"], labels: ["Top", "Second", "售价 ≤ 1500₽ (12.00%)"],
  });
  assert.deepEqual(mapOzonCategory([10, 20, 999], tree, 200, 10.5).mapped, [10, 20, "2,14.00"]);
  assert.deepEqual(mapOzonCategory([10, 20, 999], tree, 400, 10.5).mapped, [10, 20, "3,16.00"]);
});

test("category mapping safely falls back when the tree has no match", () => {
  assert.deepEqual(mapOzonCategory([10, 99, 777], tree, 100, 10.5).mapped, [10, 99, 777]);
});
