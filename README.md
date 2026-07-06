# GuardAgent — Cross-Border Marketing Compliance Pre-Clearance

Prototype for a Trading & Sales internship project: screens client-facing FX/rates
marketing text against cross-border distribution rules before it's sent, with three
layers of increasing sophistication.

## Architecture

| Layer | What it does | Data source | Live? |
|---|---|---|---|
| 1 — Rule Engine | Keyword/pattern matching against a small illustrative rule set | Hard-coded in `public/index.html` | Instant, fully offline |
| 2 — AI Semantic Review | Catches tone, implied advice, missing context that keywords miss | Groq LLM (`api/review.js`) | Live LLM call, reasons over rule *summaries* you give it — not a source of legal truth |
| 3 — Live Registration Check | Confirms a firm's actual UK authorisation status right now | FCA Financial Services Register API (`api/register-check.js`) | Genuinely live regulatory data |

**Why three layers instead of one AI call:** an LLM asked "what are Germany's
marketing rules" from memory will confidently invent things. There is no free API
that returns marketing-rule *text* — regulators publish registers (who's
authorised, what's registered), not queryable rulebooks. So Layer 3 uses a real
register API for the one thing that's genuinely available live, Layer 2 uses an
LLM only as a reasoning aid over rules you supply, and Layer 1 stays fast and
deterministic for the common cases. Legal & Compliance should own and update the
rule summaries in `api/review.js` and the pattern list in `public/index.html` —
this tool is not a substitute for that ownership.

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
- **Free tiers are rate-limited and not meant for production.** Groq's free tier is roughly 30 requests/min, 1,000/day. Fine for a demo or internal pilot; a real deployment handling actual client data would need a paid tier *and* a data-processing agreement, since free tiers often train on submitted content — client-identifying draft emails should never go through a free, no-DPA endpoint.
- **This is not legal advice**, and the rule summaries in `api/review.js` are illustrative, not exhaustive.
