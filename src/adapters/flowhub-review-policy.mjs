import crypto from "node:crypto";
import { validateReviewDecision } from "../contracts/review.mjs";

const POLICY_VERSION = "flowhub-review-policy-v1";

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Portable version of the reviewed FlowHub identity rules.
 * It accepts already collected evidence; it never calls a publisher.
 */
export function evaluateFlowHubIdentity({ dinoScore, qwenVerdict, brandOrModelConflict = false, smallProduct = false } = {}) {
  if (brandOrModelConflict) return { outcome: "rejected", reason_codes: ["brand_or_model_conflict"] };
  if (!Number.isFinite(Number(dinoScore)) || Number(dinoScore) < -1 || Number(dinoScore) > 1) {
    return { outcome: "manual_review", reason_codes: ["invalid_image_score"] };
  }
  const score = Number(dinoScore);
  if (score < 0.63) return { outcome: "rejected", reason_codes: ["image_similarity_below_floor"] };
  if (smallProduct && score >= 0.86) return { outcome: "approved", reason_codes: ["small_product_high_similarity"] };
  if (qwenVerdict === "match" && score >= 0.82) return { outcome: "approved", reason_codes: ["qwen_match_and_image_threshold"] };
  if (qwenVerdict === "mismatch" && score <= 0.64) return { outcome: "rejected", reason_codes: ["qwen_mismatch_and_image_threshold"] };
  return { outcome: "manual_review", reason_codes: ["model_disagreement"] };
}

export function createFlowHubPolicyReviewAdapter({ now = () => new Date(), policyVersion = POLICY_VERSION } = {}) {
  return {
    async review(candidate) {
      const facts = candidate.facts?.identity || {};
      const result = evaluateFlowHubIdentity(facts);
      const reviewedAt = now().toISOString();
      return validateReviewDecision({
        schema_version: "1",
        candidate_id: candidate.candidate_id,
        evidence_revision: candidate.evidence_revision,
        outcome: result.outcome,
        reason_codes: result.reason_codes,
        policy_version: policyVersion,
        model_versions: facts.model_versions || { image: "pinned", text: "pinned" },
        review_revision: `review-${digest({ candidate_id: candidate.candidate_id, evidence_revision: candidate.evidence_revision, result })}`,
        reviewed_at: reviewedAt,
      }, candidate);
    },
  };
}

export { POLICY_VERSION };
