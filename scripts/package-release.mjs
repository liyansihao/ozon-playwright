import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "dist");
await fs.mkdir(out, { recursive: true });
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = { name: packageJson.name, version: packageJson.version, git_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), mode: "simulation-default", generated_at: new Date().toISOString(), required_runtime: "Node.js 20+" };
await fs.writeFile(path.join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
execFileSync("npm", ["pack", "--pack-destination", out], { stdio: "inherit" });
console.log(JSON.stringify(manifest, null, 2));
