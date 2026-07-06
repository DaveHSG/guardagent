// /api/review.js
// Runs on Vercel's Node serverless runtime. Never exposed to the browser.
// Takes a draft + jurisdiction + client classification, asks an LLM (Groq,
// free tier, OpenAI-compatible) to find risks the deterministic regex layer
// on the frontend can't catch — implied recommendations, tone, missing
// nuance, context the pattern matcher has no way to see.
//
// IMPORTANT: this endpoint is a SEMANTIC AID, not a source of legal truth.
// It reasons over the rule summaries we give it in the prompt; it does not
// know today's regulations from memory and must never be asked to invent
// them. The rule summaries themselves are maintained by Legal & Compliance,
// not fetched live — see README for why no such live feed exists.

const JURISDICTION_RULES = {
  CH: "Switzerland (FINMA / FinSA): structured products require a Key Information Document (KID) before retail offering. Cross-border marketing from CH outward must respect the target country's own rules too.",
  DE: "Germany (BaFin / MiFID II, PRIIPs): packaged/structured products marketed to retail clients require a PRIIPs Key Information Document. Direct solicitation of unregistered products to non-professional clients is prohibited. Outbound bank-initiated contact undermines any reverse-solicitation defence.",
  FR: "France (AMF / MiFID II, PRIIPs): same PRIIPs KID requirement as Germany for retail. AMF additionally scrutinises promotional language implying guaranteed performance.",
  UK: "United Kingdom (FCA, Consumer Duty): financial promotions must be fair, clear, and not misleading; return figures need balanced, prominent risk disclosure. Unregistered scheme promotion to retail without an exemption is a criminal offence under s.21 FSMA.",
  SG: "Singapore (MAS, Securities & Futures Act): structured product marketing to retail requires a lodged prospectus or product highlights sheet. Retail advertisements must not be misleading as to returns."
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { text, jurisdiction, classification } = req.body || {};

  if (!text || !jurisdiction || !classification) {
    res.status(400).json({ error: "Missing text, jurisdiction, or classification." });
    return;
  }

  const ruleSummary = JURISDICTION_RULES[jurisdiction];
  if (!ruleSummary) {
    res.status(400).json({ error: `Unknown jurisdiction: ${jurisdiction}` });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "GROQ_API_KEY is not configured on the server. See README for setup.",
    });
    return;
  }

  const systemPrompt = `You are a compliance pre-clearance assistant at a private bank. You review draft client-facing marketing text for cross-border distribution risk.

Rules for the target jurisdiction (${jurisdiction}), client type "${classification}":
${ruleSummary}

You are a SECOND layer behind a deterministic keyword scanner. Do not repeat obvious keyword matches (e.g. don't just flag the word "yield" existing). Instead, look for things a keyword scanner would miss:
- implied recommendations or urgency conveyed through tone rather than an exact phrase
- claims that are technically hedged but still misleading in context
- missing context a reasonable retail client would need
- anything that reads as bespoke advice to a named individual rather than general commentary

Respond with ONLY valid JSON, no markdown fences, in this exact shape:
{"findings":[{"severity":"red|amber|green","observation":"short description of what you noticed","reason":"why it matters for this jurisdiction/client type"}]}

If you find nothing beyond what a keyword scanner would already catch, return {"findings":[]}.`;

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text.slice(0, 6000) }, // guard token budget
        ],
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      res.status(502).json({ error: "LLM provider error", detail: errBody });
      return;
    }

    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "{}";

    let parsed;
    try {
      // Strip stray ```json fences if the model adds them anyway
      const cleaned = raw.replace(/^```json\s*|```$/g, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: "Could not parse LLM response as JSON", raw });
      return;
    }

    res.status(200).json({ findings: parsed.findings || [] });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
