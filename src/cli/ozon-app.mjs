#!/usr/bin/env node
import path from "node:path";
import { TaskStore } from "../core/task-store.mjs";

const [command, dataDir = "./data"] = process.argv.slice(2);
const store = new TaskStore(path.join(dataDir, "tasks.json"));
if (command === "init") { await store.load(); await store.flush(); console.log(JSON.stringify({ ok: true, data_dir: path.resolve(dataDir) })); }
else if (command === "status") { console.log(JSON.stringify({ tasks: await store.list() }, null, 2)); }
else { console.error("usage: ozon-app <init|status> [data-dir]"); process.exitCode = 2; }
