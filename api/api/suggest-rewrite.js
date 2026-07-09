// /api/suggest-rewrite.js
// Given a flagged phrase (and its jurisdiction/context), suggest a more
// compliant way to express the same commercial intent.
//
// DESIGN STANCE: this does NOT rewrite text so it "passes the check" — that
// would be compliance theatre. It suggests SOFTENING / REFRAMING toward
// genuinely more compliant language, and every suggestion is explicitly a
// draft for a human to approve, never an auto-applied edit.
//
// Two tiers: (1) a curated map of safe reviewed rewrites (deterministic,
// preferred), (2) an LLM fallback for phrases not in the map (marked unreviewed).

const CURATED = {
  "we highly recommend": "clients may wish to consider",
  "we recommend buying": "one option some clients consider is",
  "you should buy": "an approach some investors take is",
  "strongly advise you to buy": "for information, some clients have looked at",
  "we advise buying": "clients considering this theme sometimes look at",
  "act now": "there is no time pressure to act",
  "buy our new": "our new product is available; details on request",
  "invest now": "further information is available on request",
  "don't miss": "further details are available should you wish",
  "limited-time offer": "available subject to terms",
  "guaranteed return": "targeted return (not guaranteed; capital at risk)",
  "guaranteed yield": "indicative yield (not guaranteed; capital at risk)",
  "risk-free": "lower-risk (all investments carry some risk)",
  "attractive returns": "the following return profile (capital at risk)",
  "enhanced yield": "the following yield profile (capital at risk)",
  "high yield": "the following yield level (higher yield reflects higher risk)",
};

const DISCLAIMER_APPENDIX =
  "This is a marketing communication and not investment advice. Capital at risk. Past performance is not a reliable indicator of future results.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { phrase, jurisdiction, context } = req.body || {};
  if (!phrase || typeof phrase !== "string") {
    res.status(400).json({ error: "Provide a 'phrase' to rewrite." });
    return;
  }

  const key = phrase.trim().toLowerCase();

  let curatedHit = CURATED[key];
  if (!curatedHit) {
    for (const k of Object.keys(CURATED)) {
      if (key.includes(k)) { curatedHit = CURATED[k]; break; }
    }
  }
  if (curatedHit) {
    res.status(200).json({
      source: "curated",
      original: phrase,
      suggestion: curatedHit,
      note: "Curated compliant reframing. Review before use.",
      appendix: DISCLAIMER_APPENDIX,
    });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(200).json({
      source: "none",
      original: phrase,
      suggestion: null,
      note: "No curated rewrite for this phrase, and the AI fallback is unavailable (GROQ_API_KEY not set).",
    });
    return;
  }

  const sys = `You are a compliance-minded editor at a private bank. Given a flagged phrase from client marketing text${jurisdiction ? ` for the ${jurisdiction} market` : ""}, rewrite it to express the same legitimate commercial meaning in a more compliant, non-promotional way.

Rules:
- Do NOT simply help the text evade a filter. Genuinely soften solicitation into neutral commentary, and add balance where a claim was one-sided.
- Prefer factual, non-advisory framing ("clients may wish to consider" rather than "we recommend").
- Never imply guaranteed or risk-free outcomes.
- Keep it short — a phrase-level replacement, not a paragraph.

Respond with ONLY valid JSON: {"suggestion":"...","rationale":"one short sentence"}`;

  try {
    const g = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `Flagged phrase: "${phrase}"${context ? `\nContext: ${context}` : ""}` },
        ],
      }),
    });

    if (!g.ok) {
      res.status(502).json({ error: "LLM provider error", detail: await g.text() });
      return;
    }

    const data = await g.json();
    const rawTxt = (data.choices?.[0]?.message?.content || "{}").replace(/^```json\s*|```$/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(rawTxt); }
    catch { res.status(502).json({ error: "Could not parse AI response", raw: rawTxt }); return; }

    res.status(200).json({
      source: "ai",
      original: phrase,
      suggestion: parsed.suggestion || null,
      rationale: parsed.rationale || "",
      note: "AI-proposed reframing — NOT reviewed. A human must approve before use.",
      appendix: DISCLAIMER_APPENDIX,
    });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
