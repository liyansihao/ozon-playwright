const OUTCOMES = new Set(["approved", "rejected", "manual_review", "blocked_dependency"]);

export function validateReviewDecision(input, candidate) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("review decision must be an object");
  if (String(input.schema_version) !== "1") throw new TypeError("unsupported review schema_version");
  if (String(input.candidate_id) !== String(candidate.candidate_id)) throw new TypeError("review candidate_id mismatch");
  if (String(input.evidence_revision) !== String(candidate.evidence_revision)) throw new TypeError("review evidence_revision mismatch");
  if (!OUTCOMES.has(input.outcome)) throw new TypeError(`unsupported review outcome: ${input.outcome}`);
  for (const key of ["review_revision", "policy_version", "reviewed_at"]) {
    if (typeof input[key] !== "string" || input[key].trim() === "") throw new TypeError(`review.${key} is required`);
  }
  if (!Number.isFinite(Date.parse(input.reviewed_at))) throw new TypeError("review.reviewed_at must be an ISO timestamp");
  return Object.freeze({
    schema_version: "1",
    candidate_id: String(input.candidate_id),
    evidence_revision: String(input.evidence_revision),
    outcome: input.outcome,
    reason_codes: Array.isArray(input.reason_codes) ? input.reason_codes.map(String) : [],
    policy_version: String(input.policy_version),
    model_versions: input.model_versions && typeof input.model_versions === "object" ? structuredClone(input.model_versions) : {},
    review_revision: String(input.review_revision),
    reviewed_at: new Date(Date.parse(input.reviewed_at)).toISOString(),
    human_decision_id: input.human_decision_id == null ? null : String(input.human_decision_id),
  });
}
