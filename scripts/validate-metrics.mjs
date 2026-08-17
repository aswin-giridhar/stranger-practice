// Metric validation script.
// Verifies that BANDS in lib/metrics.js successfully discriminate between
// a known-good conversation and a known-bad conversation.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeMetrics, BANDS } from '../lib/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const goodPath = path.join(__dirname, '../fixtures/good-transcript.json');
const badPath = path.join(__dirname, '../fixtures/bad-transcript.json');

const good = JSON.parse(fs.readFileSync(goodPath, 'utf8'));
const bad = JSON.parse(fs.readFileSync(badPath, 'utf8'));

const goodRes = computeMetrics(good.turns, { durationMs: good.durationMs });
const badRes = computeMetrics(bad.turns, { durationMs: bad.durationMs });

console.log('\n======================================================');
console.log('         CONVERSATION METRIC DISCRIMINATION GATE');
console.log('======================================================\n');

let failed = false;
const resultsTable = [];

for (const metricName of Object.keys(BANDS)) {
  const goodVal = goodRes.raw[metricName];
  const badVal = badRes.raw[metricName];
  const goodScore = goodRes.scores[metricName];
  const badScore = badRes.scores[metricName];

  const goodScoreNum = goodScore !== null ? Number(goodScore.toFixed(3)) : null;
  const badScoreNum = badScore !== null ? Number(badScore.toFixed(3)) : null;
  const delta = (goodScoreNum ?? 0) - (badScoreNum ?? 0);

  const passes = goodScoreNum !== null && badScoreNum !== null && goodScoreNum > badScoreNum;

  resultsTable.push({
    Metric: metricName,
    'Good Raw': goodVal !== null ? (typeof goodVal === 'number' ? goodVal.toFixed(3) : goodVal) : 'null',
    'Good Score': goodScoreNum ?? 'null',
    'Bad Raw': badVal !== null ? (typeof badVal === 'number' ? badVal.toFixed(3) : badVal) : 'null',
    'Bad Score': badScoreNum ?? 'null',
    Delta: delta.toFixed(3),
    Status: passes ? 'PASS' : 'FAIL',
  });

  if (!passes) {
    failed = true;
  }
}

console.table(resultsTable);

console.log(`Good Composite Score: ${goodRes.composite?.toFixed(3)}`);
console.log(`Bad Composite Score:  ${badRes.composite?.toFixed(3)}`);
console.log('------------------------------------------------------');

if (failed) {
  console.error('\n❌ VALIDATION FAILED: One or more metrics failed to discriminate between good and bad transcripts.\n');
  process.exit(1);
} else {
  console.log('\n✅ VALIDATION PASSED: All 6 metrics successfully separate good and bad conversation behaviors.\n');
  process.exit(0);
}
