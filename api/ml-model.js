// /api/ml-model.js
// A genuinely trained machine learning model: logistic regression, fit via
// batch gradient descent on your accumulated review history. This is
// different from the few-shot examples elsewhere in the app — those retrieve
// past cases into a prompt; this actually learns numeric weights from data
// and updates them when retrained.
//
// WHAT IT PREDICTS: given a draft's jurisdiction, client sophistication, use
// case, and Layer 1 risk score, the model predicts the probability that a
// red/amber-flagged review at this institution ends up being sent unchanged
// anyway (i.e., overridden) — a direct, learned signal for "how much does
// this specific kind of flag actually matter here," distinct from the static
// rule engine and from the LLM's semantic judgement.
//
// TRAINING: batch, on-demand (POST with action:'train'), not continuous —
// serverless functions are stateless between requests, so there is no
// always-on training loop. This mirrors how real production ML systems are
// usually run anyway (scheduled/triggered batch retraining), and keeping it
// on-demand means a human can see exactly when the model changed and on how
// much data, rather than it silently drifting between requests.
//
// Routes:
//   GET  /api/ml-model                 -> current model + metadata (or "not yet trained")
//   POST /api/ml-model {action:'train'} -> retrain on all available history, store, return summary
//   POST /api/ml-model {action:'predict', jurisdiction, sophistication, useCase, riskScore}
//                                       -> probability using the currently stored model

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_KEY = "guardagent:history";
const RECORD_PREFIX = "guardagent:record:";
const MODEL_KEY = "guardagent:ml-model";

const JURISDICTIONS = ["CH", "DE", "FR", "UK", "SG"];
const SOPHISTICATIONS = ["novice", "experienced", "professional", "institutional"];
const USE_CASES = ["newsletter", "one_to_one", "pitch", "social"];
const RISK_CAP = 15; // normalisation ceiling for riskScore -> [0,1]
const MIN_TRAINING_SAMPLES = 8; // below this, predictions are too unstable to trust

// Feature order is fixed and shared between training and prediction.
const FEATURE_NAMES = [
  ...JURISDICTIONS.map((j) => `jur_${j}`),
  ...SOPHISTICATIONS.map((s) => `soph_${s}`),
  ...USE_CASES.map((u) => `use_${u}`),
  "riskScoreNorm",
];

async function redisCommand(command) {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).result;
}

function buildFeatureVector({ jurisdiction, sophistication, useCase, riskScore }) {
  const vec = new Array(FEATURE_NAMES.length).fill(0);
  const jurIdx = JURISDICTIONS.indexOf(jurisdiction);
  if (jurIdx >= 0) vec[jurIdx] = 1;
  const sophIdx = SOPHISTICATIONS.indexOf(sophistication);
  if (sophIdx >= 0) vec[JURISDICTIONS.length + sophIdx] = 1;
  const useIdx = USE_CASES.indexOf(useCase);
  if (useIdx >= 0) vec[JURISDICTIONS.length + SOPHISTICATIONS.length + useIdx] = 1;
  const norm = Math.max(0, Math.min(1, (riskScore || 0) / RISK_CAP));
  vec[vec.length - 1] = norm;
  return vec;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Batch gradient descent logistic regression with small L2 regularisation.
function trainLogisticRegression(X, y, { lr = 0.2, epochs = 500, l2 = 0.02 } = {}) {
  const n = X.length;
  const d = X[0].length;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = bias + X[i].reduce((sum, xij, j) => sum + xij * weights[j], 0);
      const pred = sigmoid(z);
      const err = pred - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias };
}

function predictProbability(model, features) {
  const z = model.bias + features.reduce((sum, xj, j) => sum + xj * model.weights[j], 0);
  return sigmoid(z);
}

function trainingAccuracy(model, X, y) {
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predictProbability(model, X[i]);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  }
  return X.length ? Math.round((correct / X.length) * 100) : null;
}

async function fetchLabeledDataset() {
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

  // Only flagged (red/amber) reviews with a KNOWN outcome carry a usable label:
  // label = 1 if it was overridden (sent unchanged despite the flag), 0 if the
  // flag was respected (amended or rejected). Unflagged or outcome-less
  // records don't tell us anything about override behaviour, so they're excluded.
  const labeled = records.filter(
    (r) => (r.verdict === "red" || r.verdict === "amber") && (r.outcome === "sent" || r.outcome === "amended" || r.outcome === "rejected")
  );

  const X = labeled.map((r) => buildFeatureVector(r));
  const y = labeled.map((r) => (r.outcome === "sent" ? 1 : 0));

  return { X, y, totalRecordsSeen: records.length, labeledCount: labeled.length };
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
      const raw = await redisCommand(["GET", MODEL_KEY]);
      if (!raw) {
        res.status(200).json({ trained: false, message: "No model trained yet. POST {action:'train'} to train one." });
        return;
      }
      res.status(200).json({ trained: true, model: JSON.parse(raw) });
      return;
    }

    if (req.method === "POST") {
      const { action } = req.body || {};

      if (action === "train") {
        const { X, y, totalRecordsSeen, labeledCount } = await fetchLabeledDataset();

        if (labeledCount < MIN_TRAINING_SAMPLES) {
          res.status(200).json({
            trained: false,
            message: `Not enough labeled data yet: ${labeledCount} labeled flagged reviews (need at least ${MIN_TRAINING_SAMPLES}). Rate more reviews with an outcome (sent/amended/rejected) to enable training.`,
            labeledCount,
            totalRecordsSeen,
          });
          return;
        }

        const { weights, bias } = trainLogisticRegression(X, y);
        const model = {
          weights,
          bias,
          featureNames: FEATURE_NAMES,
          trainedAt: new Date().toISOString(),
          nSamples: labeledCount,
          totalRecordsSeen,
          trainingAccuracy: trainingAccuracy({ weights, bias }, X, y),
        };

        await redisCommand(["SET", MODEL_KEY, JSON.stringify(model)]);
        res.status(200).json({ trained: true, model });
        return;
      }

      if (action === "predict") {
        const { jurisdiction, sophistication, useCase, riskScore } = req.body || {};
        const raw = await redisCommand(["GET", MODEL_KEY]);
        if (!raw) {
          res.status(200).json({ available: false, message: "No trained model yet." });
          return;
        }
        const model = JSON.parse(raw);
        const features = buildFeatureVector({ jurisdiction, sophistication, useCase, riskScore });
        const probability = predictProbability(model, features);
        res.status(200).json({
          available: true,
          overrideProbability: Math.round(probability * 100),
          nSamples: model.nSamples,
          trainedAt: model.trainedAt,
          trainingAccuracy: model.trainingAccuracy,
        });
        return;
      }

      res.status(400).json({ error: "action must be 'train' or 'predict'." });
      return;
    }

    res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
