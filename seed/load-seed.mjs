// seed/load-seed.mjs
// Loads the synthetic seed dataset into Upstash Redis so the tracker and the
// few-shot pool have content for a demo. Mirrors the key structure api/history.js uses.
//
// USAGE (PowerShell, from project root):
//   $env:UPSTASH_REDIS_REST_URL="https://xxx.upstash.io"
//   $env:UPSTASH_REDIS_REST_TOKEN="xxxxx"
//   node seed/load-seed.mjs
//
// Pass --wipe to clear existing history first (careful — removes real data too).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_KEY = "guardagent:history";
const GOLD_KEY = "guardagent:gold";
const RECORD_PREFIX = "guardagent:record:";

if (!URL_ || !TOKEN) {
  console.error("ERROR: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first.");
  process.exit(1);
}

async function redis(command) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis command failed (${r.status}): ${await r.text()}`);
  return (await r.json()).result;
}

async function main() {
  const wipe = process.argv.includes("--wipe");
  const raw = fs.readFileSync(path.join(__dirname, "seed-data.json"), "utf8");
  const { records } = JSON.parse(raw);

  if (wipe) {
    console.log("Wiping existing history and gold set…");
    await redis(["DEL", HISTORY_KEY]);
    await redis(["DEL", GOLD_KEY]);
  }

  const ordered = [...records].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));

  let loaded = 0, gold = 0;
  for (const rec of ordered) {
    await redis(["SET", RECORD_PREFIX + rec.id, JSON.stringify(rec)]);
    await redis(["LPUSH", HISTORY_KEY, rec.id]);
    if (rec.gold) { await redis(["SADD", GOLD_KEY, rec.id]); gold++; }
    loaded++;
  }
  await redis(["LTRIM", HISTORY_KEY, "0", "199"]);

  console.log(`Done. Loaded ${loaded} synthetic records (${gold} gold).`);
  console.log("Open your live site and click 'Refresh' in the tracker to see them.");
}

main().catch((e) => { console.error("Seeding failed:", e.message); process.exit(1); });
