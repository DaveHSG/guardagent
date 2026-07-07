# GuardAgent — Cross-Border Marketing Compliance Pre-Clearance

Prototype for a Trading & Sales internship project: screens client-facing FX/rates
marketing text against cross-border distribution rules before it's sent, classified
by client sophistication, use case, and risk, reviewed by jurisdiction-specialist
AI agents, and logged to a persistent audit trail.

## Architecture

| Layer | What it does | Data source | Live? |
|---|---|---|---|
| 1 — Rule Engine | Keyword matching + cross-border perimeter check (client jurisdiction vs. product domicile) + composite risk scoring | Hard-coded in `public/index.html` | Instant, fully offline |
| 2 — AI Semantic Review | Jurisdiction-specialist agent (distinct persona per regulator: FINMA/BaFin/AMF/FCA/MAS) reviews tone, implied advice, missing context — aware of client sophistication and use case | Groq LLM (`api/review.js`) | Live LLM call, reasons over rule *summaries* you give it — not a source of legal truth |
| 3 — Live Registration Check | Confirms a firm's actual UK authorisation status right now | FCA Financial Services Register API (`api/register-check.js`) | Genuinely live regulatory data |
| — Audit Trail | Logs every review (jurisdiction, sophistication, use case, domicile, verdict, risk score, short snippet) | Upstash Redis (`api/history.js`) | Persistent, survives across sessions and deployments |

**On "agents that learn over time":** this tool does not fine-tune or silently
retrain itself from the history log — an ungoverned self-updating compliance
tool is a risk, not a feature. What it does support: Compliance can review the
audit trail, mark past reviews as good/bad exemplars, and manually fold curated
examples into the Layer 2 prompts as few-shot context. Learning stays
human-supervised, which is also the honest answer if asked about this in a
pitch.

**Why the audit trail matters as much as the AI layers:** MiFID II and FinSA both
carry real record-keeping obligations for marketing communications review. A
pre-clearance tool that gives an opinion and then forgets it happened doesn't
actually satisfy that duty. The history layer stores metadata and a short
snippet only — never the full draft — as a deliberate data-minimisation choice;
see "Known limitations" below on why full client correspondence shouldn't
accumulate in a free-tier database with no data-processing agreement.

**Why three layers instead of one AI call:** an LLM asked "what are Germany's
marketing rules" from memory will confidently invent things. There is no free API
that returns marketing-rule *text* — regulators publish registers (who's
authorised, what's registered), not queryable rulebooks. So Layer 3 uses a real
register API for the one thing that's genuinely available live, Layer 2 uses an
LLM only as a reasoning aid over rules you supply, and Layer 1 stays fast and
deterministic for the common cases. Legal & Compliance should own and update the
rule summaries in `api/review.js` and the pattern list in `public/index.html` —
this tool is not a substitute for that ownership.

## What's new: classification, risk scoring, perimeter, multi-agent

- **Client sophistication** (novice retail / experienced retail / professional / institutional) changes both the Layer 2 agent's strictness and the risk-score weighting — a novice-retail flag is weighted 1.5× versus the same finding for an institutional client.
- **Use case** (newsletter / one-to-one email / pitch deck / social post) changes what the Layer 2 agent prioritises — e.g. one-to-one email review checks specifically for personalised-advice language that a mass newsletter review wouldn't need to.
- **Composite risk score** is a weighted, illustrative triage number (red findings ×3, amber ×1, adjusted for sophistication) banded into Minimal/Low/Moderate/High/Critical — useful for sorting a queue, not a calibrated statistical model.
- **Cross-border perimeter check** compares the client's jurisdiction against the product's stated domicile; if they differ and a structured product is referenced, it flags a passporting/registration risk independent of the other keyword rules.
- **Multi-agent Layer 2**: `api/review.js` now holds five distinct agent personas (one per jurisdiction) with regulator-specific tone guidance, rather than one generic prompt branching on a jurisdiction string.

## Deploy to Vercel (free)

1. **Push this folder to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "GuardAgent prototype"
   git branch -M main
   git remote add origin https://github.com/<you>/guardagent.git
   git push -u origin main
   ```

2. **Import into Vercel.**
   - Go to https://vercel.com/new
   - Select your GitHub repo → "Import"
   - Framework preset: **Other** (it's a static `public/` folder + `api/` functions, Vercel auto-detects this)
   - Click **Deploy**. You'll get a live URL like `guardagent-yourname.vercel.app` within about a minute.

3. **Add your API keys** (do this before or right after the first deploy):
   - In the Vercel dashboard: **Project → Settings → Environment Variables**
   - Add `GROQ_API_KEY` — get a free key at https://console.groq.com (no card needed)
   - Add `FCA_AUTH_EMAIL` and `FCA_AUTH_KEY` — register at https://register.fca.org.uk/Developer/s/ (free, no card, no SLA)
   - Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — sign up free at https://console.upstash.com, create a Redis database, copy both values from its dashboard
   - Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the functions pick up the new env vars.

4. **Test it.** Open your live URL, load one of the sample drafts, pick a jurisdiction, and click "Run compliance review." Layer 1 renders instantly. Layers 2 and 3 will show a loading line then populate — if a key is missing you'll see a clear red error box telling you which one, rather than a silent failure.

## Local development

```bash
npm install -g vercel   # one-time
cp .env.example .env.local
# fill in .env.local with your keys
vercel dev
```

## Known limitations (worth saying out loud in a pitch)

- **Layer 2 is not deterministic.** Same input can yield slightly different LLM output. Fine for a pre-clearance *aid*; not fine as the sole gate — every red/amber flag should still route to a human.
- **Layer 3 covers the UK only.** ESMA publishes equivalent EU register data, but each national competent authority's register has its own access pattern — extending this to DE/FR/etc. is real but non-trivial follow-on work.
- **The perimeter check is a single-hop comparison**, not a real passporting/equivalence database. It flags "domicile ≠ jurisdiction" as a risk to investigate; it does not know whether a valid passport actually exists.
- **The risk score is illustrative**, not calibrated against real enforcement outcomes — treat it as a triage sort order, not a probability.
- **Free tiers are rate-limited and not meant for production.** Groq's free tier is roughly 30 requests/min, 1,000/day. Fine for a demo or internal pilot; a real deployment handling actual client data would need a paid tier *and* a data-processing agreement, since free tiers often train on submitted content — client-identifying draft emails should never go through a free, no-DPA endpoint.
- **This is not legal advice**, and the rule summaries in `api/review.js` are illustrative, not exhaustive.
