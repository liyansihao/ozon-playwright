import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalProductUrl,
  createPublishState,
} from "../scripts/flow_b_playwright/publish-state.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-state-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("state restores the latest event and never republishes success", async () => {
  await withTempDir(async (dir) => {
    const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
    await state.transition("123", "processing", { attempt: 1 });
    await state.transition("123", "published", { link: "https://www.ozon.ru/product/123" });

    const restored = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
    await restored.load();

    assert.equal(restored.hasPublished("123"), true);
    assert.deepEqual(restored.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });
    assert.equal(await restored.recordPublished({ sku: "123", link: "https://www.ozon.ru/product/other" }), false);

    const publishedLines = (await fs.readFile(path.join(dir, "published.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(publishedLines.length, 1);
    assert.equal(JSON.parse(publishedLines[0]).link, canonicalProductUrl("123"));
  });
});

test("failed state remains retryable", async () => {
  await withTempDir(async (dir) => {
    const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
    await state.transition("9", "failed", { error: "timeout" });
    assert.equal(state.hasPublished("9"), false);

    await state.transition("9", "processing", { attempt: 2 });
    await state.transition("9", "published", { title: "retry succeeded" });
    assert.equal(state.hasPublished("9"), true);

    const failedLines = (await fs.readFile(path.join(dir, "failed.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(failedLines.length, 1);
  });
});

test("restored state exposes the latest SKU status for reconciliation", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.transition("retry-me", "failed", { error: "timeout" });
    const restored = createPublishState({ runDir: dir, publishedCsv: csv });
    await restored.load();
    assert.equal(restored.statusOf("retry-me"), "failed");
    assert.equal(restored.statusOf("unknown"), null);
  });
});

test("CSV history seeds published SKUs from valid links and ignores malformed rows", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    await fs.writeFile(csv, [
      "product_link,created_at",
      "https://www.ozon.ru/product/321,2026-07-12",
      "not-a-product-row",
      "https://ozon.ru/product/654?source=history,ignored",
      '"https://www.ozon.ru/product/321",duplicate',
      "",
    ].join("\n"));

    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.load();

    assert.equal(state.hasPublished("321"), true);
    assert.equal(state.hasPublished("654"), true);
    assert.equal(state.hasPublished("999"), false);
    assert.deepEqual(state.summary(5), { published: 0, failed: 0, skipped: 0, remaining: 5 });
    assert.equal(state.runPublishedCount(), 0);
  });
});

test("empty or malformed JSONL history is safe to load", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "sku_states.jsonl"), [
      "",
      "not json",
      JSON.stringify({ sku: "7", status: "failed", data: { error: "temporary" } }),
      "{\"sku\": \"missing status\"}",
    ].join("\n"));

    const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "missing.csv") });
    await state.load();

    assert.equal(state.hasPublished("7"), false);
    assert.deepEqual(state.summary(1), { published: 0, failed: 1, skipped: 0, remaining: 1 });
  });
});

test("terminal records are append-only and summary writes atomically", async () => {
  await withTempDir(async (dir) => {
    const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
    await state.transition("1", "failed", { error: "first" });
    await state.transition("2", "skipped", { reason: "policy" });
    await state.transition("3", "published", { title: "ok" });

    const summary = state.summary(5);
    assert.deepEqual(summary, { published: 1, failed: 1, skipped: 1, remaining: 4 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")), summary);
    await assert.rejects(fs.access(path.join(dir, "summary.json.tmp")));

    for (const filename of ["sku_states.jsonl", "failed.jsonl", "skipped.jsonl", "published.jsonl"]) {
      const lines = (await fs.readFile(path.join(dir, filename), "utf8")).trim().split("\n");
      assert.ok(lines.length > 0, `${filename} should contain events`);
      assert.doesNotThrow(() => lines.forEach((line) => JSON.parse(line)));
    }
  });
});

test("recordPublished writes one canonical URL per SKU", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });

    assert.equal(await state.recordPublished({ sku: 88, link: "https://example.invalid/wrong" }), true);
    assert.equal(await state.recordPublished({ sku: 88, link: "https://example.invalid/another" }), false);

    const csvText = await fs.readFile(csv, "utf8");
    assert.equal((csvText.match(/https:\/\/www\.ozon\.ru\/product\/88/g) ?? []).length, 1);
    assert.equal(csvText.includes("example.invalid"), false);
  });
});

test("concurrent recordPublished calls commit exactly one canonical success", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });

    const results = await Promise.all([
      state.recordPublished({ sku: "race", link: "https://example.invalid/one" }),
      state.recordPublished({ sku: "race", link: "https://example.invalid/two" }),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
    assert.equal((await fs.readFile(path.join(dir, "sku_states.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await fs.readFile(path.join(dir, "published.jsonl"), "utf8")).trim().split("\n").length, 1);
    const publishedEvent = JSON.parse(await fs.readFile(path.join(dir, "published.jsonl"), "utf8"));
    assert.equal(publishedEvent.link, canonicalProductUrl("race"));
    const csvText = await fs.readFile(csv, "utf8");
    assert.equal((csvText.match(/https:\/\/www\.ozon\.ru\/product\/race/g) ?? []).length, 1);
  });
});

test("reload preserves the persisted summary target", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.recordPublished({ sku: "summary-target" });
    assert.deepEqual(state.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });

    const restored = createPublishState({ runDir: dir, publishedCsv: csv });
    await restored.load();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")), {
      published: 1,
      failed: 0,
      skipped: 0,
      remaining: 99,
    });
    assert.deepEqual(restored.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });
  });
});

test("CSV seeding only reads the product_link field, not quoted note fields", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const quote = String.fromCharCode(34);
    await fs.writeFile(csv, [
      "product_link,note",
      `https://www.ozon.ru/product/real,${quote}note https://www.ozon.ru/product/note${quote}`,
    ].join("\n"));

    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.load();

    assert.equal(state.hasPublished("real"), true);
    assert.equal(state.hasPublished("note"), false);
  });
});

test("concurrent published transitions reserve one success across public transition calls", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });

    const results = await Promise.all([
      state.transition("transition-race", "published", { source: "one" }),
      state.transition("transition-race", "published", { source: "two" }),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
    assert.equal((await fs.readFile(path.join(dir, "sku_states.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await fs.readFile(path.join(dir, "published.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal(((await fs.readFile(csv, "utf8")).match(/https:\/\/www\.ozon\.ru\/product\/transition-race/g) ?? []).length, 1);
  });
});

test("mixed recordPublished and published transition calls share one reservation", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });

    const results = await Promise.all([
      state.recordPublished({ sku: "mixed-race", source: "record" }),
      state.transition("mixed-race", "published", { source: "transition" }),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
    assert.equal((await fs.readFile(path.join(dir, "sku_states.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await fs.readFile(path.join(dir, "published.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal(((await fs.readFile(csv, "utf8")).match(/https:\/\/www\.ozon\.ru\/product\/mixed-race/g) ?? []).length, 1);
  });
});

test("CSV seeding discards an unterminated quoted record", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    await fs.writeFile(csv, [
      "product_link,note",
      '"https://www.ozon.ru/product/incomplete,unterminated',
    ].join("\n"));

    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.load();

    assert.equal(state.hasPublished("incomplete"), false);
  });
});

test("load reconciles newer published history into the persisted summary", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.recordPublished({ sku: "first" });
    assert.deepEqual(state.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });

    const secondEvent = {
      sku: "second",
      status: "published",
      data: { link: canonicalProductUrl("second") },
      timestamp: new Date().toISOString(),
    };
    await fs.appendFile(path.join(dir, "sku_states.jsonl"), `${JSON.stringify(secondEvent)}\n`);
    await fs.appendFile(path.join(dir, "published.jsonl"), `${JSON.stringify({
      ...secondEvent,
      link: canonicalProductUrl("second"),
    })}\n`);
    await fs.appendFile(csv, `${canonicalProductUrl("second")}\n`);

    const restored = createPublishState({ runDir: dir, publishedCsv: csv });
    await restored.load();

    const expected = { published: 2, failed: 0, skipped: 0, remaining: 98 };
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")), expected);
    assert.deepEqual(restored.summary(100), expected);
  });
});

test("historical CSV prevents duplicates without consuming this run target", async () => {
  await withTempDir(async (dir) => {
    const csv = path.join(dir, "published.csv");
    await fs.writeFile(csv, `product_link\n${canonicalProductUrl("historic")}\n`);
    const state = createPublishState({ runDir: dir, publishedCsv: csv });
    await state.load();

    assert.equal(state.hasPublished("historic"), true);
    assert.equal(state.runPublishedCount(), 0);
    await state.recordPublished({ sku: "new-in-this-run" });
    assert.equal(state.runPublishedCount(), 1);
    assert.deepEqual(state.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });
  });
});
