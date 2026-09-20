const REQUIRED = [
  "schema_version", "candidate_id", "source_id", "source_sku", "seller_id",
  "observed_at", "source_cursor", "evidence_revision", "evidence_hash", "raw_evidence_ref", "trace_id",
];

function requiredString(object, key) {
  const value = object?.[key];
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`candidate.${key} is required`);
  return value.trim();
}

export function validateCandidateEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("candidate envelope must be an object");
  for (const key of REQUIRED) requiredString(input, key);
  if (String(input.schema_version) !== "1") throw new TypeError("unsupported candidate schema_version");
  const observed = Date.parse(input.observed_at);
  if (!Number.isFinite(observed)) throw new TypeError("candidate.observed_at must be an ISO timestamp");
  return Object.freeze({
    schema_version: "1",
    candidate_id: requiredString(input, "candidate_id"),
    source_id: requiredString(input, "source_id"),
    source_sku: requiredString(input, "source_sku"),
    seller_id: requiredString(input, "seller_id"),
    observed_at: new Date(observed).toISOString(),
    source_cursor: requiredString(input, "source_cursor"),
    evidence_revision: requiredString(input, "evidence_revision"),
    evidence_hash: requiredString(input, "evidence_hash"),
    raw_evidence_ref: requiredString(input, "raw_evidence_ref"),
    trace_id: requiredString(input, "trace_id"),
    facts: input.facts && typeof input.facts === "object" ? structuredClone(input.facts) : {},
  });
}
