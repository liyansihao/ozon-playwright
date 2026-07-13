import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { parseCli } from "../scripts/flow_b_playwright.mjs";

test("publish CLI uses strict production defaults", () => {
  const parsed = parseCli(["publish", "/tmp/flow-run"], {});
  assert.equal(parsed.command, "publish");
  assert.equal(parsed.runDir, path.resolve("/tmp/flow-run"));
  assert.equal(parsed.threshold, 30);
  assert.equal(parsed.target, 100);
  assert.equal(parsed.storeNeedle, "丽丽1号");
  assert.equal(parsed.watermarkNeedle, "lysh");
});

test("CLI accepts setup, scan, and run shapes", () => {
  assert.equal(parseCli(["setup"], {}).command, "setup");
  assert.equal(parseCli(["verify"], {}).command, "verify");
  assert.deepEqual(
    Object.keys(parseCli(["scan", "urls.txt", "out.json"], {})).filter((key) => ["command", "urlsFile", "outFile"].includes(key)),
    ["command", "urlsFile", "outFile"],
  );
  const run = parseCli(["run", "/tmp/run", "urls.txt"], {});
  assert.equal(run.command, "run");
  assert.equal(run.runDir, "/tmp/run");
  assert.equal(run.urlsFile, path.resolve("urls.txt"));
  assert.equal(run.outFile, "/tmp/run/source_deep_scan.json");
});

test("CLI validates numbers, commands, and required paths without launching", () => {
  assert.throws(() => parseCli(["scan", "urls.txt"], {}), /OUT\.json/);
  assert.throws(() => parseCli(["publish"], {}), /RUN_DIR/);
  assert.throws(() => parseCli(["unknown"], {}), /unknown command/i);
  assert.throws(() => parseCli(["publish", "/tmp/run"], { FLOW_B_TARGET_PUBLISH_COUNT: "zero" }), /TARGET.*integer/i);
  assert.equal(parseCli(["--help"], {}).command, "help");
});

test("environment overrides production defaults explicitly", () => {
  const parsed = parseCli(["publish", "/tmp/run"], {
    FLOW_B_PROFIT_THRESHOLD: "35.5",
    FLOW_B_TARGET_PUBLISH_COUNT: "12",
    FLOW_B_STORE_NEEDLE: "店铺A",
    FLOW_B_WATERMARK_NEEDLE: "wm",
  });
  assert.equal(parsed.threshold, 35.5);
  assert.equal(parsed.target, 12);
  assert.equal(parsed.storeNeedle, "店铺A");
  assert.equal(parsed.watermarkNeedle, "wm");
});
