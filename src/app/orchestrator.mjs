import crypto from "node:crypto";

export class ListingOrchestrator {
  constructor({ store, seed, review, publisher, owner = `node-${process.pid}` } = {}) {
    if (!store || !seed || !review || !publisher) throw new TypeError("store, seed, review and publisher are required");
    this.store = store; this.seed = seed; this.review = review; this.publisher = publisher; this.owner = owner;
  }
  taskId(candidate) { return crypto.createHash("sha256").update(`${candidate.candidate_id}:${candidate.evidence_revision}`).digest("hex").slice(0, 32); }
  async ingest(cursor = "start") {
    const result = await this.seed.pull(cursor);
    for (const candidate of result.items) {
      const taskId = this.taskId(candidate); const existing = await this.store.get(taskId);
      if (!existing) await this.store.upsert({ task_id: taskId, stage: "review", state: "ready", candidate, source_cursor: result.nextCursor });
    }
    return result.nextCursor;
  }
  async reviewOne() {
    const task = await this.store.lease("review", this.owner);
    if (!task) return null;
    await this.store.upsert({ ...task, state: "running" });
    try {
      const decision = await this.review.review(task.candidate);
      if (decision.outcome === "manual_review") return this.store.upsert({ ...task, state: "waiting_user", review: decision });
      if (decision.outcome === "blocked_dependency") return this.store.upsert({ ...task, state: "blocked_dependency", review: decision });
      if (decision.outcome === "rejected") return this.store.upsert({ ...task, state: "failed_terminal", review: decision });
      return this.store.upsert({ ...task, state: "ready", stage: "publish", review: decision });
    } catch (error) {
      return this.store.upsert({ ...task, state: "blocked_dependency", error: { code: error.code || "review_failed", message: String(error.message || error) } });
    }
  }
  async publishOne() {
    const task = await this.store.lease("publish", this.owner);
    if (!task) return null;
    await this.store.upsert({ ...task, state: "running" });
    try { const result = await this.publisher.publish(task); return this.store.upsert({ ...task, state: result?.ok ? "succeeded" : "blocked_dependency", publication: result }); }
    catch (error) { return this.store.upsert({ ...task, state: "blocked_dependency", error: { code: error.code || "publish_failed", message: String(error.message || error) } }); }
  }
}
