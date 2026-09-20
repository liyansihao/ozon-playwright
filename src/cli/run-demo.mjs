import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { TaskStore } from "../core/task-store.mjs";
import { createJsonlSeedAdapter } from "../adapters/jsonl-seed-adapter.mjs";
import { createFlowHubPolicyReviewAdapter } from "../adapters/flowhub-review-policy.mjs";
import { createSimulatedPublisher } from "../adapters/simulated-publisher.mjs";
import { ListingOrchestrator } from "../app/orchestrator.mjs";

const dataDir = path.resolve(process.argv[2] || "./data-demo");
await fs.mkdir(dataDir, { recursive: true });
const seedFile = path.join(dataDir, "candidates.jsonl");
try { await fs.access(seedFile); } catch {
  const now = new Date().toISOString();
  await fs.writeFile(seedFile, `${JSON.stringify({ schema_version:"1",candidate_id:"demo-1",source_id:"flowhub-seed",source_sku:"demo-sku",seller_id:"demo-seller",observed_at:now,source_cursor:"0",evidence_revision:"demo-rev-1",evidence_hash:"demo-hash",raw_evidence_ref:"demo/demo-1",trace_id:"demo-trace",facts:{identity:{dinoScore:0.9,qwenVerdict:"match",smallProduct:false}}})}\n`, "utf8");
}
const store = new TaskStore(path.join(dataDir, "tasks.json"));
const app = new ListingOrchestrator({ store, seed: createJsonlSeedAdapter(seedFile), review: createFlowHubPolicyReviewAdapter(), publisher: createSimulatedPublisher(), owner: `${os.hostname()}-${process.pid}` });
await app.ingest("0");
await app.reviewOne();
await app.publishOne();
console.log(JSON.stringify({ mode: "simulation", tasks: await store.list() }, null, 2));
