import test from "node:test";
import assert from "node:assert/strict";

import { createMaoziClient, createMaoziPageTransport } from "../scripts/flow_b_playwright/maozi-client.mjs";

function makeTransport(fixtures) {
  const calls = [];
  const transport = async (path, request = {}) => {
    calls.push([path, request]);
    const key = `${path} ${request.method || "GET"} ${JSON.stringify(request.query || {})}`;
    const handler = fixtures[key] || fixtures[path] || fixtures.default;
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return typeof handler === "function" ? handler(path, request, calls) : handler;
  };
  transport.calls = calls;
  return transport;
}

test("client paginates favorites and resolves the first normalized publish target", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request, calls) => {
      const page = Number(request.query?.page || 1);
      if (page === 1) return { status: 200, json: { code: 1, data: { data: [{ sku: 1 }], last_page: 2 } } };
      if (page === 2) return { status: 200, json: { code: 1, data: { data: [{ sku: 2 }], last_page: 2 } } };
      throw new Error(`unexpected favorites page ${page}`);
    },
    "/api.shop/lists": { status: 200, json: { code: 1, data: [{ id: 7, name: "丽丽 1号 店铺" }, { id: 8, name: "丽丽1号备用店" }] } },
    "/api.watermark/templates": { status: 200, json: { code: 1, data: [{ id: 9, name: "LYSH 主水印" }, { id: 10, name: "lysh 备用" }] } },
  });

  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.listFavorites(), [{ sku: 1 }, { sku: 2 }]);
  assert.deepEqual(
    await client.resolvePublishTarget({ storeNeedle: "丽丽1号", watermarkNeedle: "lysh" }),
    {
      store: { id: 7, name: "丽丽 1号 店铺" },
      watermark: { id: 9, name: "LYSH 主水印" },
    },
  );

  assert.deepEqual(
    transport.calls.map(([path, request]) => [path, request.query?.page, request.query?.page_size, request.query?.is_imported]),
    [
      ["/api.product.favorite/lists", 1, 50, 0],
      ["/api.product.favorite/lists", 2, 50, 0],
      ["/api.shop/lists", undefined, undefined, undefined],
      ["/api.watermark/templates", undefined, undefined, undefined],
    ],
  );
});

test("publish target rejects empty store or watermark needles", async () => {
  const client = createMaoziClient({ transport: async () => { throw new Error("must not request resources"); } });
  await assert.rejects(
    () => client.resolvePublishTarget({ storeNeedle: "", watermarkNeedle: "lysh" }),
    /store.*required/i,
  );
  await assert.rejects(
    () => client.resolvePublishTarget({ storeNeedle: "丽丽1号", watermarkNeedle: "  " }),
    /watermark.*required/i,
  );
});

test("publish target pins the verified store and watermark IDs", async () => {
  const transport = makeTransport({
    "/api.shop/lists": { status: 200, json: { code: 1, data: [{ id: 1, name: "丽丽1号 old" }, { id: 104965, name: "丽丽1号" }] } },
    "/api.watermark/templates": { status: 200, json: { code: 1, data: [{ id: 2, name: "lysh old" }, { id: 60822, name: "lysh" }] } },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.resolvePublishTarget({
    storeNeedle: "丽丽1号",
    watermarkNeedle: "lysh",
    storeId: 104965,
    watermarkId: 60822,
  }), {
    store: { id: 104965, name: "丽丽1号" },
    watermark: { id: 60822, name: "lysh" },
  });
});

test("client validates endpoint request shapes for category and profit lookups", async () => {
  const transport = makeTransport({
    "/api.tool/get_category_by_sku": { status: 200, json: { code: 1, data: { cate: [1, 2, 3], product_info: { weight: 12 } } } },
    "/api.tool/calc_profit": { status: 200, json: { code: 1, data: { calc_result: [], cnyrub_rate: 10.5 } } },
  });

  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.getCategoryBySku("305"), { cate: [1, 2, 3], product_info: { weight: 12 } });
  assert.deepEqual(
    await client.calculateProfit({
      sell_price: 99,
      purchase_price: 20,
      package_weight: 1,
      package_length: 20,
      package_width: 10,
      package_height: 5,
      china_fee: 0,
      ad_rate: 0,
      other_rate: 1,
      logistics: "CEL",
      profit_value: 30,
      profit_type: "percentage",
      cate: [11, 22, 33],
    }),
    { calc_result: [], cnyrub_rate: 10.5 },
  );

  assert.deepEqual(
    transport.calls,
    [
      ["/api.tool/get_category_by_sku", { method: "GET", query: { keyword: "305" } }],
      ["/api.tool/calc_profit", {
        method: "GET",
        query: {
          sell_price: "99",
          purchase_price: "20",
          package_weight: "1",
          package_length: "20",
          package_width: "10",
          package_height: "5",
          china_fee: "0",
          ad_rate: "0",
          other_rate: "1",
          logistics: "CEL",
          profit_value: "30",
          profit_type: "percentage",
          "cate[]": ["11", "22", "33"],
        },
      }],
    ],
  );
});

test("client only treats explicit Maozi publish success as success", async () => {
  const ok = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 1, msg: "success" } }) });
  const badCode = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 0, msg: "failed" } }) });
  const badShape = createMaoziClient({ transport: async () => ({ status: 200, json: "not-json" }) });

  assert.equal((await ok.publish({ rows: [] })).ok, true);
  assert.equal((await badCode.publish({ rows: [] })).ok, false);
  assert.equal((await badShape.publish({ rows: [] })).ok, false);
});

test("client deletes a favorite through the plugin toggle contract", async () => {
  const transport = makeTransport({
    "/api.product.favorite/toggle": (path, request) => {
      assert.deepEqual(request, {
        method: "POST",
        body: {
          productInfo: {
            sku: "123",
            coverImage: "cover.jpg",
            price_info: { sell_price: 19.9, currency: "CNY" },
            title: "sample",
          },
          status: false,
        },
      });
      return { status: 200, json: { code: 1, msg: "取消收藏成功", data: [] } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.equal(await client.deleteFavorite({ sku: 123, cover_image: "cover.jpg", sell_price: 19.9, title: "sample" }), true);
});

test("client finds published SKUs through the favorites endpoint", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request) => {
      assert.equal(request.query.page, 1);
      assert.equal(request.query.page_size, 10);
      assert.equal(request.query.is_imported, 1);
      assert.equal(request.query.sku, "123");
      return { status: 200, json: { code: 1, data: { data: [{ sku: 123, title: "done" }], last_page: 1 } } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.findPublishedSku("123"), { sku: 123, title: "done" });
});

test("client reads exactly one favorite page for verification", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request) => {
      assert.deepEqual(request.query, { page: 2, page_size: 3, is_imported: 0 });
      return { status: 200, json: { code: 1, data: { data: [{ sku: 9 }], total: 21, last_page: 7 } } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.getFavoritePage({ page: 2, pageSize: 3, isImported: 0 }), {
    rows: [{ sku: 9 }], total: 21, page: 2, lastPage: 7,
  });
});

test("client reads the Ozon category commission tree", async () => {
  const client = createMaoziClient({ transport: async (endpoint, request) => {
    assert.equal(endpoint, "/api.config/get_ozon_cate_commission");
    assert.deepEqual(request, { method: "GET" });
    return { status: 200, json: { code: 1, data: [{ cate_id: 10 }] } };
  } });
  assert.deepEqual(await client.listCategoryCommissions(), [{ cate_id: 10 }]);
});

test("client rejects malformed list responses before continuing", async () => {
  const client = createMaoziClient({
    transport: async () => ({ status: 200, json: { code: 1, data: { data: "oops" } } }),
  });
  await assert.rejects(() => client.listFavorites(), /favorites/i);
});

test("browser page transport includes Maozi headers and safely parses non-JSON errors", async () => {
  const requests = [];
  const page = {
    evaluate: async (fn, request) => {
      requests.push(request);
      const savedFetch = globalThis.fetch;
      const savedLocalStorage = globalThis.localStorage;
      globalThis.fetch = async () => ({
        status: 502,
        text: async () => "<html>Bad Gateway</html>",
      });
      globalThis.localStorage = {
        getItem: () => JSON.stringify({ accessToken: "abc123" }),
      };
      try {
        return await fn(request);
      } finally {
        globalThis.fetch = savedFetch;
        globalThis.localStorage = savedLocalStorage;
      }
    },
  };
  const transport = createMaoziPageTransport({ page });
  const response = await transport("/api.shop/lists", {
    method: "POST",
    query: { page: 1, page_size: 10 },
    body: { hello: "world" },
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.json, { raw: "<html>Bad Gateway</html>" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers["Accept-Language"], "zh-CN");
  assert.equal(requests[0].headers.Client, "pc");
  assert.equal(requests[0].headers.Authorization, "Bearer abc123");
});

test("browser transport retries on the replacement Maozi page after SSO closes", async () => {
  const first = { evaluate: async () => { throw new Error("Target page, context or browser has been closed"); }, isClosed: () => true, url: () => "about:blank" };
  const second = { evaluate: async () => ({ status: 200, json: { code: 1 } }), isClosed: () => false, url: () => "https://ozon.maozierp.com/#/dashboard" };
  const context = { pages: () => [first, second] };
  const transport = createMaoziPageTransport({ page: first, context });
  assert.deepEqual(await transport("/api.shop/lists"), { status: 200, json: { code: 1 } });
});

test("browser transport retries GET requests through a short HTTP 0 outage", async () => {
  let calls = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      calls += 1;
      return calls < 5
        ? { status: 0, json: { error: "Failed to fetch" } }
        : { status: 200, json: { code: 1, data: [] } };
    },
  };
  const transport = createMaoziPageTransport({
    page,
    maxGetAttempts: 6,
    retrySleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(await transport("/api.shop/lists"), { status: 200, json: { code: 1, data: [] } });
  assert.equal(calls, 5);
  assert.deepEqual(delays, [750, 1_500, 3_000, 5_000]);
});
