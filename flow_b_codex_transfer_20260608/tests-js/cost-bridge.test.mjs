import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCostBridge, parseCostOutput } from "../scripts/flow_b_playwright/cost-bridge.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-cost-bridge-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("accepts a reliable filtered first-page P70 cost", () => {
  const text = [
    "VALID_COUNT 5",
    "P70_COST 21.3",
    "COST_SOURCE search_first_page_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [17, 19.8, 21.3, 23.8]",
  ].join("\n");

  assert.deepEqual(parseCostOutput(text, 100), {
    ok: true,
    cost: 21.3,
    source: "search_first_page_p70_similarity_filtered",
    prices: [17, 19.8, 21.3, 23.8],
  });
});

test("rejects insufficient evidence and cost near sale price", () => {
  const result = parseCostOutput(
    [
      "P70_COST 90",
      "COST_SOURCE search_first_page_p70_similarity_filtered",
      "FILTERED_FIRST_PAGE_PRICES [80, 90]",
    ].join("\n"),
    100,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient|spread|sale price|85%/i);
});

test("cluster-filtered sources retain the existing spread behavior", () => {
  const result = parseCostOutput([
    "P70_COST 12",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [1, 6, 12]",
  ].join("\n"), 100);
  assert.equal(result.ok, true);
});

test("malformed bare price tokens invalidate the evidence", () => {
  const result = parseCostOutput([
    "P70_COST 12",
    "COST_SOURCE search_first_page_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, foo, 12, 14]",
  ].join("\n"), 100);
  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient|invalid/i);
});

test("nonzero review decisions preserve the 1688 reliability reason", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 2,
          stdout: [
            "DECISION REVIEW",
            "REASON extreme price spread without strong main cluster",
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "P70_COST None",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    const result = await bridge.estimate({
      sku: "review-1",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "extreme price spread without strong main cluster");
    assert.equal(result.process_code, 2);

    const cached = await bridge.estimate({
      sku: "review-2",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(cached.ok, false);
    assert.equal(cached.reason, result.reason);
    assert.equal(cached.shared_cache, true);
    assert.equal(runs, 1);
  });
});

test("estimate reuses parseable cached output without redownloading or rerunning", async () => {
  await withTempDir(async (runDir) => {
    const imagesDir = path.join(runDir, "images");
    const costsDir = path.join(runDir, "1688");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.mkdir(costsDir, { recursive: true });
    await fs.writeFile(
      path.join(costsDir, "sku-123.out"),
      [
        "VALID_COUNT 10",
        "DECISION LIGHT_ACCEPT",
        "COST_SOURCE search_first_page_p70_similarity_filtered",
        "FILTERED_FIRST_PAGE_PRICES [10, 12, 14, 16]",
        "P70_COST 14",
      ].join("\n"),
      "utf8",
    );

    const downloadCalls = [];
    const runCalls = [];
    const bridge = createCostBridge({
      download: async (...args) => {
        downloadCalls.push(args);
        throw new Error("download should not be called for parseable cache");
      },
      runProcess: async (...args) => {
        runCalls.push(args);
        throw new Error("runProcess should not be called for parseable cache");
      },
    });

    const result = await bridge.estimate(
      {
        sku: "sku-123",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    assert.equal(result.ok, true);
    assert.equal(result.cost, 14);
    assert.equal(result.source, "search_first_page_p70_similarity_filtered");
    assert.equal(downloadCalls.length, 0);
    assert.equal(runCalls.length, 0);
  });
});

test("estimate downloads safely, runs python, and saves combined stdout and stderr", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async (url, destinationPath) => {
        assert.equal(url, "https://example.invalid/cover.jpg");
        await fs.writeFile(destinationPath, Buffer.from("jpeg-data"));
      },
      runProcess: async ({ command, args, cwd }) => {
        assert.equal(command, "python3");
        assert.match(args[0], /flow_b_codex_transfer_20260608\/scripts\/1688_image_median\.py$/);
        assert.match(args[1], /images\/sku-456\.jpg$/);
        assert.equal(cwd, path.resolve(process.cwd()));
        return {
          code: 0,
          stdout: [
            "VALID_COUNT 6",
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [11, 12, 13]",
            "P70_COST 12",
          ].join("\n"),
          stderr: "warning: recovered from cache miss",
        };
      },
    });

    const result = await bridge.estimate(
      {
        sku: "sku-456",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    const outPath = path.join(runDir, "1688", "sku-456.out");
    const outText = await fs.readFile(outPath, "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.cost, 12);
    assert.match(outText, /VALID_COUNT 6/);
    assert.match(outText, /STDERR:/);
    assert.match(outText, /warning: recovered from cache miss/);
  });
});

test("estimate rejects path traversal attempts structurally", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async () => {
        throw new Error("download should not be called");
      },
      runProcess: async () => {
        throw new Error("runProcess should not be called");
      },
    });

    const result = await bridge.estimate(
      {
        sku: "../escape",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid-sku");
    assert.match(result.error?.message || "", /path traversal|unsafe/i);
  });
});

test("estimate persists partial process evidence on timeout", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async (url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        throw Object.assign(new Error("timed out"), {
          code: "process-timeout",
          stdout: "PARTIAL STDOUT",
          stderr: "PARTIAL STDERR",
        });
      },
    });
    const result = await bridge.estimate({
      sku: "timeout-1",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);
    const evidence = await fs.readFile(path.join(runDir, "1688", "timeout-1.out"), "utf8");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "process-timeout");
    assert.match(evidence, /PARTIAL STDOUT/);
    assert.match(evidence, /PARTIAL STDERR/);
    assert.match(evidence, /timed out/);
  });
});

test("same cover image shares one in-flight 1688 query and persists reusable cache", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    const first = { sku: "same-1", cover_image: "https://img.example/same.jpg", sell_price: 100 };
    const second = { sku: "same-2", cover_image: "https://img.example/same.jpg", sell_price: 100 };
    const results = await Promise.all([bridge.estimate(first, runDir), bridge.estimate(second, runDir)]);
    assert.equal(runs, 1);
    assert.ok(results.every((row) => row.ok));
    assert.ok(results.some((row) => row.shared_cache === true));
    const cache = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.entries).length, 1);
  });
});
