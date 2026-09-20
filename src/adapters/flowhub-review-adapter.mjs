import { validateReviewDecision } from "../contracts/review.mjs";

export class FlowHubReviewAdapter {
  constructor({ request, policyVersion = "flowhub-review-policy-v1" } = {}) {
    if (typeof request !== "function") throw new TypeError("FlowHubReviewAdapter requires a request function");
    this.request = request; this.policyVersion = policyVersion;
  }
  async review(candidate) {
    const response = await this.request({ candidate, policy_version: this.policyVersion });
    return validateReviewDecision({ ...response, policy_version: response?.policy_version || this.policyVersion }, candidate);
  }
}
