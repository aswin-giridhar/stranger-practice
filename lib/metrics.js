// Conversation metrics.
//
// Two-layer design on purpose:
//   1. DETERMINISTIC layer -- counted from the transcript and timings. No model involved,
//      so it is reproducible and unit-testable against fixtures.
//   2. JUDGED layer -- topic maintenance and tangent recovery need semantics, so Gemini
//      labels each user turn as on-topic / off-topic. Those labels are then counted
//      deterministically here.
//
// Every band below is validated by scripts/validate-metrics.mjs against one deliberately
// good and one deliberately bad transcript. A band that does not separate the two is a bug,
// not a safety feature.

export const TURN_ROLES = { USER: 'user', PERSONA: 'persona' };

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const median = (xs) => {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Bands are [min, max] of the GOOD range. Scores fall off linearly outside.
 * `anchor` records provenance honestly: 'literature' where research gives a figure,
 * 'product' where it is our own judgement. The narrative and UI must not blur these.
 */
export const BANDS = {
  turnBalance: { good: [0.35, 0.62], hardMin: 0.05, hardMax: 0.95, anchor: 'product',
    label: 'Share of the talking you did' },
  interruptionsPerMin: { good: [0, 0.7], hardMax: 4, lowerIsBetter: true, anchor: 'product',
    label: 'Times you cut in' },
  questionRatio: { good: [0.2, 0.6], hardMin: 0, hardMax: 1, anchor: 'product',
    label: 'How often you asked something back' },
  topicMaintenance: { good: [0.7, 1.0], hardMin: 0, hardMax: 1, anchor: 'product',
    label: 'Staying on the thread' },
  tangentRecovery: { good: [0.6, 1.0], hardMin: 0, hardMax: 1, anchor: 'product',
    label: 'Finding your way back after a detour' },
  medianLatencyMs: { good: [200, 1800], hardMin: 0, hardMax: 6000, anchor: 'product',
    label: 'Time to start replying' },
};

/** Score a value against its band: 1.0 inside, tapering to 0 at the hard edges. */
export function scoreMetric(name, value) {
  const b = BANDS[name];
  if (!b || value === null || value === undefined || !Number.isFinite(value)) return null;
  const [lo, hi] = b.good;
  if (value >= lo && value <= hi) return 1;
  if (value < lo) {
    const floor = b.hardMin ?? 0;
    if (value <= floor) return 0;
    return Math.max(0, (value - floor) / (lo - floor));
  }
  const ceil = b.hardMax ?? hi * 2;
  if (value >= ceil) return 0;
  return Math.max(0, (ceil - value) / (ceil - hi));
}

/**
 * @param {Array} turns  [{role, text, startedAt, endedAt, overlappedPersona?, latencyMs?, onTopic?}]
 * @param {object} opts  { durationMs }
 */
export function computeMetrics(turns, opts = {}) {
  const userTurns = turns.filter((t) => t.role === TURN_ROLES.USER);
  const personaTurns = turns.filter((t) => t.role === TURN_ROLES.PERSONA);

  const userWords = userTurns.reduce((n, t) => n + words(t.text), 0);
  const personaWords = personaTurns.reduce((n, t) => n + words(t.text), 0);
  const totalWords = userWords + personaWords;

  const durationMs = opts.durationMs
    || (turns.length ? (turns[turns.length - 1].endedAt - turns[0].startedAt) : 0);
  const minutes = Math.max(durationMs / 60000, 1 / 60);

  // An interruption is recorded by the client at the moment it happens -- the user began
  // speaking while the persona still had the floor. We do not infer it after the fact.
  const interruptions = userTurns.filter((t) => t.overlappedPersona).length;

  const questions = userTurns.filter((t) => /\?/.test(t.text || '')
    || /^(what|how|why|where|when|who|do you|did you|have you|are you|is it|does)\b/i.test((t.text || '').trim())).length;

  // Judged labels: onTopic true/false per user turn. Absent labels -> null, not a guess.
  const labelled = userTurns.filter((t) => typeof t.onTopic === 'boolean');
  const topicMaintenance = labelled.length ? labelled.filter((t) => t.onTopic).length / labelled.length : null;

  // Tangent recovery: after an off-topic user turn, did the NEXT user turn come back?
  let tangents = 0; let recovered = 0;
  for (let i = 0; i < labelled.length - 1; i++) {
    if (labelled[i].onTopic === false) {
      tangents++;
      if (labelled[i + 1].onTopic === true) recovered++;
    }
  }
  const tangentRecovery = tangents ? recovered / tangents : (labelled.length ? 1 : null);

  const raw = {
    turnBalance: totalWords ? userWords / totalWords : null,
    interruptionsPerMin: interruptions / minutes,
    questionRatio: userTurns.length ? questions / userTurns.length : null,
    topicMaintenance,
    tangentRecovery,
    medianLatencyMs: median(userTurns.map((t) => t.latencyMs)),
  };

  const scores = {};
  for (const k of Object.keys(BANDS)) scores[k] = scoreMetric(k, raw[k]);

  const scored = Object.values(scores).filter((s) => s !== null);
  const composite = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;

  return {
    raw,
    scores,
    composite,
    counts: { userTurns: userTurns.length, personaTurns: personaTurns.length, userWords, personaWords, interruptions, questions, tangents, recovered },
    durationMs,
    coverage: scored.length / Object.keys(BANDS).length,
  };
}

/** The single weakest metric -- the UI shows one focus, not six numbers. */
export function weakestMetric(result) {
  const entries = Object.entries(result.scores).filter(([, v]) => v !== null);
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  const [name, score] = entries[0];
  return { name, score, label: BANDS[name].label, value: result.raw[name], band: BANDS[name].good };
}
