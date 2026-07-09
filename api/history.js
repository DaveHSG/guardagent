// /api/history.js
// Persistent audit trail + human feedback loop.
//
// A pre-clearance tool that gives an opinion and then forgets it happened
// misses the point: MiFID II and FinSA both carry record-keeping obligations
// for marketing communications review. Beyond audit, this endpoint captures
// the reviewer's human judgement (thumbs up/down, and whether the draft was
// sent as-is / amended / rejected) so that curated "gold" cases can later be
// fed back into the AI agent as few-shot examples. This is human-supervised
// curation, NOT model retraining — every example that influences a future
// review is one a human explicitly marked, and is fully auditable.
//
// Storage model (Upstash Redis REST API):
//   guardagent:history            -> list of record IDs, newest first (ordering)
//   guardagent:record:<id>        -> the full JSON record (updatable in place)
//   guardagent:gold               -> set of record IDs marked as gold examples
//
// Routes:
//   GET  /api/history                      -> recent records (newest first)
//   GET  /api/history?gold=1               -> only gold-flagged records
//   GET  /api/history?examples=CH          -> up to 3 gold records for a jurisdiction (for few-shot)
//   POST /api/history   {review fields}    -> append a new review record
//   PATCH /api/history  {id, feedback,...} -> attach feedback / outcome / gold flag to a record

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_KEY = "guardagent:history";
const GOLD_KEY = "guardagent:gold";
const RECORD_PREFIX = "guardagent:record:";
const MAX_RECORDS = 200;

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

async function getRecordsByIds(ids) {
  const records = [];
  for (const id of ids) {
    try {
      const raw = await redisCommand(["GET", RECORD_PREFIX + id]);
      if (raw) {
        const rec = JSON.parse(raw);
        records.push(rec);
      }
    } catch (e) {
      // skip unparseable / missing records
    }
  }
  return records;
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
      // Few-shot example retrieval: up to 3 gold records for a jurisdiction.
      if (req.query && req.query.examples) {
        const jur = String(req.query.examples);
        const goldIds = (await redisCommand(["SMEMBERS", GOLD_KEY])) || [];
        const goldRecords = await getRecordsByIds(goldIds);
        const matching = goldRecords
          .filter((r) => r.jurisdiction === jur)
          .slice(0, 3);
        res.status(200).json({ examples: matching });
        return;
      }

      // Gold-only listing (for the curation view).
      if (req.query && req.query.gold) {
        const goldIds = (await redisCommand(["SMEMBERS", GOLD_KEY])) || [];
        const goldRecords = await getRecordsByIds(goldIds);
        goldRecords.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
        res.status(200).json({ records: goldRecords });
        return;
      }

      // Default: most recent 50 records, newest first.
      const ids = (await redisCommand(["LRANGE", HISTORY_KEY, "0", "49"])) || [];
      const records = await getRecordsByIds(ids);
      res.status(200).json({ records });
      return;
    }

    if (req.method === "POST") {
      const {
        jurisdiction, classification, verdict, counts, draft,
        sophistication, useCase, productDomicile, riskScore,
      } = req.body || {};
      if (!jurisdiction || !classification || !verdict) {
        res.status(400).json({ error: "Missing jurisdiction, classification, or verdict." });
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record = {
        id,
        ts: new Date().toISOString(),
        jurisdiction,
        classification,
        sophistication: sophistication || null,
        useCase: useCase || null,
        productDomicile: productDomicile || null,
        riskScore: typeof riskScore === "number" ? riskScore : null,
        verdict,
        counts: counts || { red: 0, amber: 0, green: 0 },
        // Data minimisation: store a short snippet only, never the full draft.
        snippet: (draft || "").trim().slice(0, 120),
        // Feedback fields, populated later via PATCH:
        feedback: null,     // "up" | "down" | null
        outcome: null,      // "sent" | "amended" | "rejected" | null
        gold: false,
      };

      await redisCommand(["SET", RECORD_PREFIX + id, JSON.stringify(record)]);
      await redisCommand(["LPUSH", HISTORY_KEY, id]);
      await redisCommand(["LTRIM", HISTORY_KEY, "0", String(MAX_RECORDS - 1)]);

      res.status(201).json({ saved: true, record });
      return;
    }

    if (req.method === "PATCH") {
      const { id, feedback, outcome, gold } = req.body || {};
      if (!id) {
        res.status(400).json({ error: "Missing record id." });
        return;
      }

      const raw = await redisCommand(["GET", RECORD_PREFIX + id]);
      if (!raw) {
        res.status(404).json({ error: "Record not found (it may have aged out of the store)." });
        return;
      }

      const record = JSON.parse(raw);
      if (feedback === "up" || feedback === "down" || feedback === null) record.feedback = feedback;
      if (["sent", "amended", "rejected"].includes(outcome) || outcome === null) record.outcome = outcome;
      if (typeof gold === "boolean") {
        record.gold = gold;
        if (gold) await redisCommand(["SADD", GOLD_KEY, id]);
        else await redisCommand(["SREM", GOLD_KEY, id]);
      }

      await redisCommand(["SET", RECORD_PREFIX + id, JSON.stringify(record)]);
      res.status(200).json({ updated: true, record });
      return;
    }

    res.status(405).json({ error: "Use GET, POST, or PATCH." });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
