#!/bin/zsh
set -u

ROOT="${0:A:h:h}"
RUN_DIR="${1:?RUN_DIR is required}"
URLS_FILE="${2:?URLS_FILE is required}"
RESTART_DELAY_SECONDS="${FLOW_B_RESTART_DELAY_SECONDS:-5}"

export FLOW_B_RESUME_WINDOW=1

while true; do
  node "$ROOT/scripts/flow_b_playwright.mjs" accept "$RUN_DIR" "$URLS_FILE"
  exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    exit 0
  fi

  ended_at=$(node --input-type=module -e '
    import fs from "node:fs";
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(Date.parse(value.ended_at) || 0));
    } catch {
      process.stdout.write("0");
    }
  ' "$RUN_DIR/acceptance_window.json")
  now_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  if [[ "$ended_at" -gt 0 && "$now_ms" -ge "$ended_at" ]]; then
    exit $exit_code
  fi

  sleep "$RESTART_DELAY_SECONDS"
done
