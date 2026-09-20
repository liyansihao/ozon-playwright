import fs from "node:fs/promises";
import { FlowHubSeedAdapter } from "./flowhub-seed-adapter.mjs";

export function createJsonlSeedAdapter(file) {
  return new FlowHubSeedAdapter({ read: async (cursor) => {
    let text = "";
    try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const rows = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const start = Math.max(0, Number(cursor) || 0);
    return { items: rows.slice(start), nextCursor: String(rows.length) };
  } });
}
