import { validateCandidateEnvelope } from "../contracts/candidate.mjs";

export class FlowHubSeedAdapter {
  constructor({ read, sourceId = "flowhub-seed" } = {}) {
    if (typeof read !== "function") throw new TypeError("FlowHubSeedAdapter requires a read function");
    this.read = read; this.sourceId = sourceId;
  }
  async pull(cursor = "start") {
    const result = await this.read(cursor);
    if (!result || !Array.isArray(result.items)) throw new TypeError("seed reader must return {items, nextCursor}");
    const items = result.items.map((item) => validateCandidateEnvelope({ ...item, source_id: item.source_id || this.sourceId }));
    return { items, nextCursor: result.nextCursor == null ? cursor : String(result.nextCursor) };
  }
}
