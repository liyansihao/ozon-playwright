import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { TaskStore } from "../src/core/task-store.mjs";
import { FlowHubSeedAdapter } from "../src/adapters/flowhub-seed-adapter.mjs";
import { FlowHubReviewAdapter } from "../src/adapters/flowhub-review-adapter.mjs";
import { ListingOrchestrator } from "../src/app/orchestrator.mjs";

const candidate = {
  schema_version: "1", candidate_id: "c-1", source_id: "flowhub-seed", source_sku: "sku-1", seller_id: "seller-1",
  observed_at: "2026-09-20T00:00:00Z", source_cursor: "cursor-1", evidence_revision: "rev-1", evidence_hash: "hash-1",
  raw_evidence_ref: "evidence/c-1", trace_id: "trace-1", facts: { title: "demo" },
};

test("seed adapter validates and preserves cursor", async () => {
  const adapter = new FlowHubSeedAdapter({ read: async (cursor) => ({ items: [{ ...candidate, source_cursor: cursor }], nextCursor: "cursor-2" }) });
  const result = await adapter.pull("cursor-1");
  assert.equal(result.items[0].candidate_id, "c-1");
  assert.equal(result.nextCursor, "cursor-2");
});

test("review adapter rejects stale evidence", async () => {
  const adapter = new FlowHubReviewAdapter({ request: async () => ({ schema_version: "1", candidate_id: "c-1", evidence_revision: "old", outcome: "approved", review_revision: "r", reviewed_at: "2026-09-20T00:00:00Z" }) });
  await assert.rejects(() => adapter.review(candidate), /evidence_revision mismatch/);
});

test("orchestrator resumes durable review and publish stages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-stable-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const seed = new FlowHubSeedAdapter({ read: async () => ({ items: [candidate], nextCursor: "cursor-2" }) });
  const review = new FlowHubReviewAdapter({ request: async () => ({ schema_version: "1", candidate_id: "c-1", evidence_revision: "rev-1", outcome: "approved", review_revision: "review-1", reviewed_at: "2026-09-20T00:00:00Z" }) });
  const publisher = { publish: async (task) => ({ ok: task.review.outcome === "approved", operation_id: "op-1" }) };
  const app = new ListingOrchestrator({ store, seed, review, publisher, owner: "test" });
  await app.ingest();
  const reviewTask = await app.reviewOne();
  assert.equal(reviewTask.stage, "publish");
  const publishTask = await app.publishOne();
  assert.equal(publishTask.state, "succeeded");
  const reloaded = new TaskStore(path.join(dir, "tasks.json"));
  assert.equal((await reloaded.list())[0].state, "succeeded");
});

test("task store refuses illegal state changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-stable-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.upsert({ task_id: "t", stage: "review", state: "ready" });
  await assert.rejects(() => store.upsert({ task_id: "t", stage: "review", state: "succeeded" }), /invalid task transition/);
});

import { createFlowHubPolicyReviewAdapter, evaluateFlowHubIdentity } from "../src/adapters/flowhub-review-policy.mjs";

test("FlowHub review policy blocks hard brand and model conflicts", () => {
  assert.deepEqual(evaluateFlowHubIdentity({ dinoScore: 0.95, qwenVerdict: "match", brandOrModelConflict: true }), { outcome: "rejected", reason_codes: ["brand_or_model_conflict"] });
});

test("FlowHub review policy sends uncertain evidence to a human", async () => {
  assert.equal(evaluateFlowHubIdentity({ dinoScore: 0.75, qwenVerdict: "match" }).outcome, "manual_review");
  const adapter = createFlowHubPolicyReviewAdapter({ now: () => new Date("2026-09-20T00:00:00Z") });
  const decision = await adapter.review({ ...candidate, facts: { identity: { dinoScore: 0.75, qwenVerdict: "match" } } });
  assert.equal(decision.outcome, "manual_review");
  assert.equal(decision.policy_version, "flowhub-review-policy-v1");
});
