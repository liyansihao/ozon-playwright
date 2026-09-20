import { spawn } from "node:child_process";
import { FlowHubReviewAdapter } from "./flowhub-review-adapter.mjs";

function invoke(command, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); const error = new Error("review_command_timeout"); error.code = "review_command_timeout"; finish(reject, error); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code !== 0) { const error = new Error(`review_command_exit_${code}: ${stderr.trim()}`); error.code = "review_command_failed"; return finish(reject, error); }
      try { finish(resolve, JSON.parse(stdout)); } catch { const error = new Error("review_command_invalid_json"); error.code = "review_command_invalid_json"; finish(reject, error); }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export function createJsonCommandReviewAdapter({ command, timeoutMs = 120000, policyVersion } = {}) {
  if (!Array.isArray(command) || command.length === 0) throw new TypeError("review command is required");
  return new FlowHubReviewAdapter({ policyVersion, request: ({ candidate, policy_version }) => invoke(command, { candidate, policy_version }, timeoutMs) });
}
