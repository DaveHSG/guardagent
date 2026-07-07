// /api/history.js
// Persistent audit trail — the single most "we understand compliance" feature
// in this whole project. A pre-clearance tool that gives an opinion and then
// forgets it happened is missing the point: MiFID II and FinSA both carry real
// record-keeping obligations for marketing communications review.
//
// GET  -> returns the most recent review records (newest first)
// POST -> appends a new review record
//
// Data-minimisation note: we deliberately store only a short snippet of the
// draft (not the full text), plus metadata and the verdict. Full client
// correspondence should not accumulate indefinitely in a free-tier database
// with no data-processing agreement — see README.
//
// Uses Upstash Redis's plain REST API (no SDK needed): POST a JSON array
// command to the database URL. Free tier: console.upstash.com

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_KEY = "guardagent:history";
const MAX_RECORDS = 200; // trim so the list doesn't grow unbounded on a free tier

async function redisCommand(command) {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Redis command failed: ${detail}`);
  }
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({
      error: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured. See README for setup.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const raw = await redisCommand(["LRANGE", HISTORY_KEY, "0", "49"]); // most recent 50
      const records = (raw || []).map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
      res.status(200).json({ records });
      return;
    }

    if (req.method === "POST") {
      const { jurisdiction, classification, verdict, counts, draft, sophistication, useCase, productDomicile, riskScore } = req.body || {};
      if (!jurisdiction || !classification || !verdict) {
        res.status(400).json({ error: "Missing jurisdiction, classification, or verdict." });
        return;
      }

      const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        jurisdiction,
        classification,
        sophistication: sophistication || null,
        useCase: useCase || null,
        productDomicile: productDomicile || null,
        riskScore: typeof riskScore === "number" ? riskScore : null,
        verdict, // "red" | "amber" | "green"
        counts: counts || { red: 0, amber: 0, green: 0 },
        // Data minimisation: store a short snippet only, never the full draft.
        snippet: (draft || "").trim().slice(0, 120),
      };

      await redisCommand(["LPUSH", HISTORY_KEY, JSON.stringify(record)]);
      await redisCommand(["LTRIM", HISTORY_KEY, "0", String(MAX_RECORDS - 1)]);

      res.status(201).json({ saved: true, record });
      return;
    }

    res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
