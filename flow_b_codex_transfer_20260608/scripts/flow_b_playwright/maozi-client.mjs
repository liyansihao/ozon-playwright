import { selectNamedResource } from "./publish-policy.mjs";

const ENDPOINTS = Object.freeze({
  favorites: "/api.product.favorite/lists",
  favoriteToggle: "/api.product.favorite/toggle",
  shops: "/api.shop/lists",
  watermarks: "/api.watermark/templates",
  category: "/api.tool/get_category_by_sku",
  profit: "/api.tool/calc_profit",
  publish: "/api.selection.follow/import",
  commissions: "/api.config/get_ozon_cate_commission",
});

function successResponse(response) {
  return Boolean(
    response
      && Number(response.status) >= 200
      && Number(response.status) < 300
      && response.json
      && typeof response.json === "object"
      && !Array.isArray(response.json)
      && Number(response.json.code) === 1,
  );
}

function requireSuccess(response, label) {
  if (!successResponse(response)) {
    const message = response?.json?.msg || response?.json?.message || `HTTP ${response?.status ?? "unknown"}`;
    throw new Error(`Maozi ${label} request failed: ${message}`);
  }
  return response.json.data;
}

function listRows(data, label) {
  const rows = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(rows)) throw new Error(`Maozi ${label} response does not contain a valid list`);
  return rows;
}

function stringQuery(input) {
  const query = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    if (key === "cate" && Array.isArray(value)) query["cate[]"] = value.map(String);
    else query[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return query;
}

export function createMaoziClient({ transport }) {
  if (typeof transport !== "function") throw new TypeError("Maozi transport must be a function");

  async function getFavoritePage({ page = 1, pageSize = 50, isImported = 0 } = {}) {
    const response = await transport(ENDPOINTS.favorites, {
      method: "GET",
      query: { page, page_size: pageSize, is_imported: isImported },
    });
    const data = requireSuccess(response, "favorites");
    const rows = listRows(data, "favorites");
    return {
      rows,
      total: Number(data?.total ?? rows.length),
      page: Number(page),
      lastPage: Number(data?.last_page ?? data?.last ?? data?.pages ?? 1),
    };
  }

  async function listFavorites({ pageSize = 50, query = {} } = {}) {
    const rows = [];
    const seenPages = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      if (seenPages.has(page)) throw new Error("Maozi favorites pagination repeated a page");
      seenPages.add(page);
      const response = await transport(ENDPOINTS.favorites, {
        method: "GET",
        query: { is_imported: 0, ...query, page, page_size: pageSize },
      });
      const data = requireSuccess(response, "favorites");
      const batch = listRows(data, "favorites");
      rows.push(...batch);

      const lastPage = Number(data?.last_page ?? data?.last ?? data?.pages);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) return rows;
      } else if (batch.length < pageSize) {
        return rows;
      }
    }
    throw new Error("Maozi favorites pagination exceeded 1000 pages");
  }

  async function listShops() {
    const data = requireSuccess(await transport(ENDPOINTS.shops, { method: "GET" }), "shops");
    return listRows(data, "shops");
  }

  async function listWatermarks() {
    const data = requireSuccess(await transport(ENDPOINTS.watermarks, { method: "GET" }), "watermarks");
    return listRows(data, "watermarks");
  }

  return {
    getFavoritePage,
    listFavorites,
    listShops,
    listWatermarks,

    async listCategoryCommissions() {
      const data = requireSuccess(await transport(ENDPOINTS.commissions, { method: "GET" }), "category commissions");
      if (!Array.isArray(data)) throw new Error("Maozi category commissions response does not contain a valid list");
      return data;
    },

    async resolvePublishTarget({ storeNeedle, watermarkNeedle }) {
      if (!String(storeNeedle || "").trim()) throw new Error("store needle is required");
      if (!String(watermarkNeedle || "").trim()) throw new Error("watermark needle is required");
      const [shops, watermarks] = await Promise.all([listShops(), listWatermarks()]);
      return {
        store: selectNamedResource(shops, storeNeedle, "store"),
        watermark: selectNamedResource(watermarks, watermarkNeedle, "watermark"),
      };
    },

    async getCategoryBySku(sku) {
      return requireSuccess(await transport(ENDPOINTS.category, {
        method: "GET",
        query: { keyword: String(sku) },
      }), "category");
    },

    async calculateProfit(input) {
      return requireSuccess(await transport(ENDPOINTS.profit, {
        method: "GET",
        query: stringQuery(input),
      }), "profit calculation");
    },

    async publish(payload) {
      const response = await transport(ENDPOINTS.publish, { method: "POST", body: payload });
      return {
        ok: successResponse(response),
        status: response?.status ?? 0,
        response: response?.json ?? null,
      };
    },

    async deleteFavorite(item) {
      const productInfo = {
        sku: String(item?.sku ?? item?.id ?? ""),
        coverImage: item?.cover_image ?? item?.coverImage ?? null,
        price_info: {
          sell_price: Number(item?.sell_price ?? item?.price ?? 0),
          currency: String(item?.currency ?? "CNY"),
        },
        title: String(item?.title ?? ""),
      };
      requireSuccess(await transport(ENDPOINTS.favoriteToggle, {
        method: "POST",
        body: { productInfo, status: false },
      }), "favorite deletion");
      return true;
    },

    async findPublishedSku(sku) {
      const response = await transport(ENDPOINTS.favorites, {
        method: "GET",
        query: { page: 1, page_size: 10, is_imported: 1, sku: String(sku) },
      });
      const data = requireSuccess(response, "favorites lookup");
      const rows = listRows(data, "favorites lookup");
      return rows.find((row) => String(row?.sku) === String(sku)) || null;
    },
  };
}

export function createMaoziPageTransport({ page, context, baseUrl = "https://api.maozierp.com" }) {
  if (!page || typeof page.evaluate !== "function") throw new TypeError("A Playwright Maozi page is required");
  const evaluate = (activePage, request) => activePage.evaluate(async (input) => {
    let token = "";
    try {
      token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "";
    } catch {}
    input.headers["Accept-Language"] = "zh-CN";
    input.headers.Client = "pc";
    if (token) input.headers.Authorization = `Bearer ${token}`;

    const url = new URL(input.endpoint, input.baseUrl);
    for (const [key, value] of Object.entries(input.query || {})) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry !== undefined && entry !== null) url.searchParams.append(key, String(entry));
      }
    }
    const init = { method: input.method, headers: input.headers };
    if (input.body !== undefined && input.body !== null && input.method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }

    try {
      const response = await fetch(url.toString(), init);
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, json };
    } catch (error) {
      return { status: 0, json: { error: String(error?.message || error) } };
    }
  }, request);
  return async (endpoint, { method = "GET", query, body } = {}) => {
    const request = {
      baseUrl,
      endpoint,
      method: String(method || "GET").toUpperCase(),
      query: query || {},
      body,
      headers: {},
    };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await evaluate(page, { ...request, headers: {} });
      } catch (error) {
        lastError = error;
        if (!context || !/target page|context or browser has been closed/i.test(String(error?.message || error))) throw error;
        const previous = page;
        let replacement = null;
        for (let poll = 0; poll < 20 && !replacement; poll += 1) {
          replacement = context.pages().find((candidate) => {
            try {
              return candidate !== previous
                && (!candidate.isClosed || !candidate.isClosed())
                && String(candidate.url()).startsWith("https://ozon.maozierp.com/");
            } catch {
              return false;
            }
          });
          if (!replacement) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!replacement) {
          replacement = await context.newPage();
          await replacement.goto("https://ozon.maozierp.com/#/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        page = replacement;
      }
    }
    throw lastError;
  };
}
