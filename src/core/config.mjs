import fs from "node:fs/promises";

const DEFAULTS = { schema_version: 1, mode: "simulation", data_dir: "./data", seed_file: "./data/candidates.jsonl", review_command: null };

export async function loadConfig(file) {
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = { ...DEFAULTS, ...raw };
  if (config.schema_version !== 1) throw new Error("unsupported config schema_version");
  if (!["simulation", "production"].includes(config.mode)) throw new Error("mode must be simulation or production");
  if (config.mode === "production" && process.env.OZON_ALLOW_PRODUCTION_WRITES !== "1") throw new Error("production writes require OZON_ALLOW_PRODUCTION_WRITES=1");
  return config;
}

export async function writeExampleConfig(file) {
  await fs.writeFile(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, "utf8");
}
