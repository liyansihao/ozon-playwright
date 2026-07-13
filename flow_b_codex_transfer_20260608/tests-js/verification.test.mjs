import test from "node:test";
import assert from "node:assert/strict";

import { runReadOnlyVerification } from "../scripts/flow_b_playwright/verification.mjs";

test("verification reads one favorite page and resolves targets without publish", async () => {
  const calls = [];
  const client = {
    getFavoritePage: async (options) => {
      calls.push(["favorites", options]);
      return { rows: [{ sku: 1 }], total: 321, page: 1, lastPage: 7 };
    },
    resolvePublishTarget: async (options) => {
      calls.push(["targets", options]);
      return { store: { id: 7, name: "丽丽1号店" }, watermark: { id: 8, name: "LYSH" } };
    },
    publish: async () => { throw new Error("verification must never publish"); },
  };
  const result = await runReadOnlyVerification({
    client,
    extensionVersion: "3.0.9",
    storeNeedle: "丽丽1号",
    watermarkNeedle: "lysh",
  });
  assert.deepEqual(result, {
    authenticated: true,
    extensionVersion: "3.0.9",
    favoriteCount: 321,
    favoritePageRows: 1,
    store: { id: 7, name: "丽丽1号店" },
    watermark: { id: 8, name: "LYSH" },
  });
  assert.deepEqual(calls, [
    ["favorites", { page: 1, pageSize: 1, isImported: 0 }],
    ["targets", { storeNeedle: "丽丽1号", watermarkNeedle: "lysh" }],
  ]);
});
