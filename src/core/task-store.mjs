import fs from "node:fs/promises";
import path from "node:path";

const STATES = new Set(["ready", "leased", "running", "waiting_user", "blocked_dependency", "succeeded", "failed_terminal", "cancelled"]);
const TRANSITIONS = new Map([
  ["ready", new Set(["leased", "cancelled"])],
  ["leased", new Set(["running", "ready", "failed_terminal"])],
  ["running", new Set(["succeeded", "ready", "waiting_user", "blocked_dependency", "failed_terminal"])],
  ["waiting_user", new Set(["ready", "cancelled"])],
  ["blocked_dependency", new Set(["ready", "cancelled"])],
  ["succeeded", new Set()], ["failed_terminal", new Set()], ["cancelled", new Set()],
]);

export class TaskStore {
  constructor(file) { this.file = path.resolve(file); this.state = { version: 1, tasks: {}, events: [] }; this.loaded = false; this.writeChain = Promise.resolve(); }
  async load() {
    if (this.loaded) return this;
    try { this.state = JSON.parse(await fs.readFile(this.file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!this.state || this.state.version !== 1 || typeof this.state.tasks !== "object") throw new Error("unsupported task store");
    this.loaded = true; return this;
  }
  async flush() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.file);
  }
  async mutate(fn) { await this.load(); const result = await fn(this.state); this.writeChain = this.writeChain.then(() => this.flush()); await this.writeChain; return result; }
  async upsert(task) {
    if (!task?.task_id || !task.stage) throw new TypeError("task_id and stage are required");
    return this.mutate((state) => {
      const old = state.tasks[task.task_id];
      if (old && old.state !== task.state && !TRANSITIONS.get(old.state)?.has(task.state)) throw new Error(`invalid task transition ${old.state} -> ${task.state}`);
      if (!STATES.has(task.state)) throw new TypeError(`invalid task state ${task.state}`);
      const next = { ...(old || {}), ...structuredClone(task), updated_at: new Date().toISOString() };
      state.tasks[task.task_id] = next; state.events.push({ at: next.updated_at, type: "task_upserted", task_id: task.task_id, state: next.state }); return next;
    });
  }
  async lease(stage, owner, ttlMs = 60000) {
    return this.mutate((state) => {
      const now = Date.now();
      const task = Object.values(state.tasks).find((item) => item.stage === stage && (item.state === "ready" || (item.state === "leased" && Date.parse(item.lease_expires_at || 0) <= now)));
      if (!task) return null;
      task.state = "leased"; task.lease_owner = owner; task.lease_expires_at = new Date(now + ttlMs).toISOString(); task.updated_at = new Date(now).toISOString();
      state.events.push({ at: task.updated_at, type: "task_leased", task_id: task.task_id, owner }); return structuredClone(task);
    });
  }
  async get(taskId) { await this.load(); return this.state.tasks[taskId] ? structuredClone(this.state.tasks[taskId]) : null; }
  async list() { await this.load(); return structuredClone(Object.values(this.state.tasks)); }
}
