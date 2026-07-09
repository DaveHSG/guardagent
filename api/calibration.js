// /api/calibration.js
// Aggregates the historical review log into per-jurisdiction calibration
// insights, and stores an explicit, human-set "posture" per jurisdiction
// (Strict / Standard / Lenient) that Compliance can adjust after reviewing
// those insights.
//
// DELIBERATE DESIGN CHOICE: nothing here adjusts the AI agent's behaviour
// automatically. Aggregate stats are read-only insight. A posture change
// only takes effect once a human explicitly sets it via POST. This avoids
// "controls drift" — a system that quietly loosens itself because people
// keep overriding its flags would be learning to rubber-stamp behaviour,
// not learning the bank's genuine risk interpretation. The human stays the
// one deciding what the institution's posture actually is; this tool just
// gives them the data to decide with.
//
// Routes:
//   GET  /api/calibration                  -> { stats: {JUR: {...}}, postures: {JUR: "strict"|"standard"|"lenient"} }
//   POST /api/calibration {jurisdiction, posture} -> sets the posture for one jurisdiction

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_KEY = "guardagent:history";
const RECORD_PREFIX = "guardagent:record:";
const POSTURE_KEY = "guardagent:postures"; // Redis hash: jurisdiction -> posture
const VALID_POSTURES = ["strict", "standard", "lenient"];
const JURISDICTIONS = ["CH", "DE", "FR", "UK", "SG"];

async function redisCommand(command) {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).result;
}

function emptyStat() {
  return {
    total: 0,
    verdictCounts: { red: 0, amber: 0, green: 0 },
    sentDespiteFlag: 0,     // red/amber verdict, but outcome was "sent" anyway
    flaggedCount: 0,        // red or amber verdicts (the denominator for override rate)
    overrideRate: null,     // % of flagged reviews sent unchanged despite the flag
    feedbackUp: 0,
    feedbackDown: 0,
    thumbsUpRate: null,
    goldCount: 0,
  };
}

function computeStats(records) {
  const byJur = {};
  JURISDICTIONS.forEach((j) => { byJur[j] = emptyStat(); });

  for (const r of records) {
    const s = byJur[r.jurisdiction];
    if (!s) continue; // unknown jurisdiction, skip defensively

    s.total++;
    if (r.verdict === "red" || r.verdict === "amber" || r.verdict === "green") {
      s.verdictCounts[r.verdict]++;
    }
    if (r.verdict === "red" || r.verdict === "amber") {
      s.flaggedCount++;
      if (r.outcome === "sent") s.sentDespiteFlag++;
    }
    if (r.feedback === "up") s.feedbackUp++;
    if (r.feedback === "down") s.feedbackDown++;
    if (r.gold) s.goldCount++;
  }

  for (const j of JURISDICTIONS) {
    const s = byJur[j];
    s.overrideRate = s.flaggedCount > 0 ? Math.round((s.sentDespiteFlag / s.flaggedCount) * 100) : null;
    const fbTotal = s.feedbackUp + s.feedbackDown;
    s.thumbsUpRate = fbTotal > 0 ? Math.round((s.feedbackUp / fbTotal) * 100) : null;
  }

  return byJur;
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
      const ids = (await redisCommand(["LRANGE", HISTORY_KEY, "0", "199"])) || [];
      const records = [];
      for (const id of ids) {
        try {
          const raw = await redisCommand(["GET", RECORD_PREFIX + id]);
          if (raw) records.push(JSON.parse(raw));
        } catch (e) {
          // skip unreadable record
        }
      }

      const stats = computeStats(records);

      const postureFlat = (await redisCommand(["HGETALL", POSTURE_KEY])) || [];
      const postures = {};
      for (let i = 0; i < postureFlat.length; i += 2) postures[postureFlat[i]] = postureFlat[i + 1];
      JURISDICTIONS.forEach((j) => { if (!postures[j]) postures[j] = "standard"; });

      res.status(200).json({ stats, postures, sampleSize: records.length });
      return;
    }

    if (req.method === "POST") {
      const { jurisdiction, posture } = req.body || {};
      if (!JURISDICTIONS.includes(jurisdiction)) {
        res.status(400).json({ error: `Unknown jurisdiction: ${jurisdiction}` });
        return;
      }
      if (!VALID_POSTURES.includes(posture)) {
        res.status(400).json({ error: `Posture must be one of: ${VALID_POSTURES.join(", ")}` });
        return;
      }
      await redisCommand(["HSET", POSTURE_KEY, jurisdiction, posture]);
      res.status(200).json({ saved: true, jurisdiction, posture });
      return;
    }

    res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
