// /api/register-check.js
// Live, factual lookup — NOT an LLM. Queries the FCA's Financial Services
// Register API to check whether a firm is currently authorised in the UK.
// This is the "genuinely live regulatory data" part of the platform: the
// register changes when firms gain/lose authorisation, and this endpoint
// reflects that in real time rather than relying on a static rule base.
//
// Sign up for free credentials at:
//   https://register.fca.org.uk/Developer/s/
// You'll receive an X-Auth-Email and X-Auth-Key. Free, no card, but the FCA
// gives no SLA/uptime guarantee on this service — treat it as best-effort,
// not a hard dependency in production.
//
// Scope note: this only covers UK/FCA. ESMA publishes equivalent EU register
// data (see https://www.esma.europa.eu/publications-and-data/databases-and-registers)
// but its access pattern differs per register and isn't wired up here yet —
// see README for the extension point.

const FCA_BASE = "https://register.fca.org.uk/services/V0.1";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { firmName } = req.body || {};
  if (!firmName || firmName.trim().length < 2) {
    res.status(400).json({ error: "Provide a firmName to search for." });
    return;
  }

  const email = process.env.FCA_AUTH_EMAIL;
  const key = process.env.FCA_AUTH_KEY;

  if (!email || !key) {
    res.status(500).json({
      error: "FCA_AUTH_EMAIL / FCA_AUTH_KEY not configured on the server. See README for setup.",
    });
    return;
  }

  try {
    const url = `${FCA_BASE}/CommonSearch?q=${encodeURIComponent(firmName)}&type=firm`;
    const fcaRes = await fetch(url, {
      headers: {
        "X-Auth-Email": email,
        "X-Auth-Key": key,
        Accept: "application/json",
      },
    });

    if (!fcaRes.ok) {
      const detail = await fcaRes.text();
      res.status(502).json({ error: "FCA Register API error", detail });
      return;
    }

    const data = await fcaRes.json();
    const results = (data?.Data || []).slice(0, 5).map((r) => ({
      name: r.Name,
      referenceNumber: r["Reference Number"] || r.FRN,
      status: r.Status,
      type: r.Type,
    }));

    res.status(200).json({ results, source: "FCA Financial Services Register (live)" });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
