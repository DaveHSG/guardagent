// /api/review.js
// Runs on Vercel's Node serverless runtime. Never exposed to the browser.
//
// This is a multi-agent layer, not one generic prompt with an if/else
// jurisdiction string: each jurisdiction gets its own persona tuned to that
// regulator's actual concerns and tone, plus shared context on the client's
// financial sophistication and the use case (newsletter vs. one-to-one email
// vs. pitch deck), both of which change what "acceptable" looks like even
// under the same rule.
//
// IMPORTANT: this endpoint is a SEMANTIC AID, not a source of legal truth.
// Each agent reasons over the rule summary it's given; it does not know
// today's regulations from memory and must never be asked to invent them.
// The rule summaries are maintained by Legal & Compliance, not fetched live.

const AGENTS = {
  CH: {
    name: "FINMA specialist agent",
    rules: "Switzerland (FINMA / FinSA): structured products require a Key Information Document (KID) before retail offering. FinSA also requires clear client-segment-appropriate risk disclosure and a documented basis for any suitability claim.",
    tone: "FINMA's supervisory culture favours principles-based judgement over bright-line rules - flag substance over form, and note where a KID or segment classification is ambiguous rather than assuming a technical breach.",
  },
  DE: {
    name: "BaFin specialist agent",
    rules: "Germany (BaFin / MiFID II, PRIIPs): packaged/structured products marketed to retail clients require a PRIIPs Key Information Document. Direct solicitation of unregistered products to non-professional clients is prohibited. Outbound bank-initiated contact undermines any reverse-solicitation defence.",
    tone: "BaFin enforcement is comparatively strict and literal - flag anything that reads as solicitation even if hedged, and treat missing PRIIPs KID references as a hard blocker for retail, not a soft suggestion.",
  },
  FR: {
    name: "AMF specialist agent",
    rules: "France (AMF / MiFID II, PRIIPs): same PRIIPs KID requirement as Germany for retail. AMF additionally scrutinises promotional language implying guaranteed performance and requires balanced presentation of past-performance claims.",
    tone: "AMF pays particular attention to performance framing - flag any implication that past or projected returns are dependable, even without an explicit guarantee word.",
  },
  UK: {
    name: "FCA specialist agent",
    rules: "United Kingdom (FCA, Consumer Duty): financial promotions must be fair, clear, and not misleading; return figures need balanced, prominent risk disclosure. Unregistered scheme promotion to retail without an exemption is a criminal offence under s.21 FSMA.",
    tone: "The FCA's Consumer Duty lens asks whether the communication delivers good outcomes for the specific client segment - for a less sophisticated client, assess whether jargon or omitted context could cause misunderstanding, not just whether a disclaimer exists.",
  },
  SG: {
    name: "MAS specialist agent",
    rules: "Singapore (MAS, Securities & Futures Act): structured product marketing to retail requires a lodged prospectus or product highlights sheet. Retail advertisements must not be misleading as to returns.",
    tone: "MAS expects advertisements to be evaluated on overall impression, not just literal wording - flag headline figures that could create a misleading overall impression even if individually accurate.",
  },
};

const SOPHISTICATION_GUIDANCE = {
  novice: "This client has LOW financial literacy. Apply the strictest reading: jargon, implied urgency, or omitted context that a sophisticated investor would shrug off should still be flagged here, because this reader may not catch it.",
  experienced: "This client is an experienced retail investor. Standard retail rules apply at normal strictness - flag genuine issues, but don't over-flag routine market terminology this reader would recognise.",
  professional: "This client is classified as professional. Apply professional-investor norms: suitability and disclosure obligations are lighter, but record-keeping and any residual retail-like framing should still be noted.",
  institutional: "This client is institutional. Apply the lightest touch: focus only on genuine regulatory/legal exposure, not tone or accessibility, since institutional counterparties are assumed financially sophisticated.",
};

const USE_CASE_GUIDANCE = {
  newsletter: "This is a MASS-DISTRIBUTED newsletter, likely reaching many clients across possibly different sophistication levels. Weight findings toward the most conservative plausible reader in the intended segment.",
  one_to_one: "This is a ONE-TO-ONE email to a single named client. Check especially for personalised recommendation language ('for you', 'given your situation') that reads as bespoke advice rather than general commentary.",
  pitch: "This is a PITCH DECK / formal proposal. Check for completeness of required disclosures (KID references, risk sections, target market statements) more than tone, since pitch decks are expected to be more direct than passive commentary.",
  social: "This is a SOCIAL MEDIA post. These have the least room for nuance and the widest, least-controlled audience - apply strict scrutiny to any return figures or product mentions given the format's inherent lack of context.",
};

// --- Human-curated few-shot: pull up to 3 gold examples for this jurisdiction ---
// These are past reviews a human explicitly marked as good exemplars. We read
// them straight from Redis (same store as /api/history) and fold them into the
// agent prompt. If Redis isn't configured, this silently returns none and the
// review proceeds without examples.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const GOLD_KEY = "guardagent:gold";
const RECORD_PREFIX = "guardagent:record:";
const POSTURE_KEY = "guardagent:postures";

const POSTURE_GUIDANCE = {
  strict: "Compliance has explicitly set a STRICT posture for this jurisdiction. Apply the most conservative reading of ambiguous cases — flag borderline items that a standard reading might let pass.",
  lenient: "Compliance has explicitly set a LENIENT posture for this jurisdiction, reflecting this institution's considered risk appetite. Continue to flag clear breaches, but give reasonable benefit of the doubt on genuinely ambiguous borderline phrasing rather than flagging every possible reading.",
  standard: "",
};

async function getPosture(jurisdiction) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return "standard";
  try {
    const val = await redisCommand(["HGET", POSTURE_KEY, jurisdiction]);
    return val && POSTURE_GUIDANCE[val] !== undefined ? val : "standard";
  } catch (e) {
    return "standard"; // never let posture-fetching break the actual review
  }
}

async function redisCommand(command) {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).result;
}

async function getGoldExamples(jurisdiction) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  try {
    const goldIds = (await redisCommand(["SMEMBERS", GOLD_KEY])) || [];
    const examples = [];
    for (const id of goldIds) {
      const raw = await redisCommand(["GET", RECORD_PREFIX + id]);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      if (rec.jurisdiction === jurisdiction) examples.push(rec);
      if (examples.length >= 3) break;
    }
    return examples;
  } catch (e) {
    return []; // never let example-fetching break the actual review
  }
}

function formatExamples(examples) {
  if (!examples.length) return "";
  const lines = examples.map((e) => {
    const outcome = e.outcome ? `outcome: ${e.outcome}` : "outcome: n/a";
    const fb = e.feedback === "up" ? "human approved this review" : e.feedback === "down" ? "human rejected this review" : "human reviewed";
    return `- Draft snippet: "${(e.snippet || "").slice(0, 120)}" | verdict: ${e.verdict} | ${outcome} | ${fb}`;
  });
  return `\n\nHuman-curated examples from past reviews in this jurisdiction (use these to calibrate your judgement to how human compliance reviewers here actually decided):\n${lines.join("\n")}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { text, jurisdiction, classification, sophistication, useCase } = req.body || {};

  if (!text || !jurisdiction || !classification) {
    res.status(400).json({ error: "Missing text, jurisdiction, or classification." });
    return;
  }

  const agent = AGENTS[jurisdiction];
  if (!agent) {
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

  const sophGuidance = SOPHISTICATION_GUIDANCE[sophistication] || SOPHISTICATION_GUIDANCE.experienced;
  const useCaseGuidance = USE_CASE_GUIDANCE[useCase] || USE_CASE_GUIDANCE.newsletter;

  const goldExamples = await getGoldExamples(jurisdiction);
  const examplesBlock = formatExamples(goldExamples);
  const posture = await getPosture(jurisdiction);
  const postureBlock = POSTURE_GUIDANCE[posture] ? `\n\n${POSTURE_GUIDANCE[posture]}` : "";

  const systemPrompt = `You are the ${agent.name}, a compliance pre-clearance specialist at a private bank reviewing draft client-facing marketing text for cross-border distribution risk in your jurisdiction only.

Regulatory context: ${agent.rules}

Supervisory tone for this jurisdiction: ${agent.tone}

Client sophistication: ${sophGuidance}

Use case: ${useCaseGuidance}

Client classification for this review: "${classification}".${postureBlock}${examplesBlock}

You are a SECOND layer behind a deterministic keyword scanner. Do not repeat obvious keyword matches (e.g. don't just flag the word "yield" existing). Instead, look for things a keyword scanner would miss:
- implied recommendations or urgency conveyed through tone rather than an exact phrase
- claims that are technically hedged but still misleading in context
- missing context this specific client (given their sophistication) would need
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
        model: "openai/gpt-oss-120b",
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text.slice(0, 6000) },
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
      const cleaned = raw.replace(/^```json\s*|```$/g, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: "Could not parse LLM response as JSON", raw });
      return;
    }

    res.status(200).json({ findings: parsed.findings || [], agent: agent.name, examplesUsed: goldExamples.length, posture });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
