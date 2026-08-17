# Stranger Practice

Conversation practice for adults with ADHD, focused on the hardest thing to rehearse: talking to
a stranger.

**Live app:** <!-- LIVE_URL -->

Built for Build with Gemini XPRIZE. Category: **Education & Human Potential**.

This is a practice tool. It is not therapy, not diagnosis, not treatment, and it makes no clinical
claim of any kind.

## What it is

You pick one of three AI strangers, have a three-minute live spoken conversation with a talking
avatar, and then get a measured report on how the conversation actually went.

| id | name | difficulty | behaviour that is enforced in code |
|---|---|---|---|
| `warm` | Maya | 1 | patient, waits 2.2s before prompting, asks a follow-up |
| `brisk` | Dan | 3 | **cuts in if you talk past 7 seconds**, shifts topic every 3rd turn, ≤18 words |
| `reserved` | Priya | 4 | ≤8 words per turn, sits in 6-second silences, rarely asks anything |

The personas differ in code, not only in prompt wording (`lib/personas.js`). Each carries a
`policy` object the runtime acts on, and `enforceWordCap()` is applied server-side after
generation. A prompt saying "at most eight words" is a request; Priya's value to the user is that
she gives you almost nothing, so the cap is a constraint rather than a suggestion.

## Who it is for

Adults with ADHD who want reps at unstructured social interaction with strangers, and who cannot
get those reps on demand from another person. Practice with a stranger is the one social context
you cannot arrange in advance.

## Architecture

Next.js 15 (App Router, JavaScript), React 19. Deploy target: Vercel. Plain `fetch` to the Gemini
REST API — no SDK. Node.js runtime on every route.

**Gemini is the persona brain.** `app/api/turn/route.js` builds the conversation history, prepends
the persona system prompt, calls `gemini-2.5-flash`, and applies the word cap. When the persona's
turn index hits `policy.topicShiftEveryTurns`, the route injects a topic-shift instruction into the
prompt. That is what makes Dan's difficulty real rather than described.

**Gemini is the judge.** `app/api/report/route.js` runs in two stages, in this order:

1. Gemini labels every user turn `onTopic` true/false against the running topic, and writes 2–3
   sentences of plain-language coaching. The call is constrained by `JUDGE_SCHEMA` (structured
   JSON output). If the judge fails, the response comes back `judged: false` and the UI says "not
   scored" — it never shows a fabricated number.
2. `computeMetrics()` in `lib/metrics.js` counts. Deterministically, in code, never in the model.

**Six metrics** (`lib/metrics.js`). Deterministic: turn balance, interruptions per minute, question
ratio, median response latency. Judge-dependent: topic maintenance, tangent recovery. The report
surfaces one focus metric — the weakest — not six numbers.

Interruptions are recorded by the browser at the moment the user starts speaking while the persona
still holds the floor. They are never inferred after the fact by asking a model what it thinks
happened.

**Metric thresholds are product judgement, not research.** Every band in `lib/metrics.js` is
labelled `anchor: 'product'`. A planned research pass did not complete, so there is no literature
anchor and we do not claim one. What we did instead is a discrimination gate: two hand-written
three-minute transcripts, one deliberately good and one deliberately bad, and a script that fails
if any band cannot tell them apart.

```
npm run validate:metrics
```

Measured result: all six metrics separate. Composite 1.000 (good) against 0.316 (bad). This is a
reproducible check that the bands measure something. It is not a substitute for research anchoring
and is not presented as one.

**Voice and face.** The talking avatar is Anam (`@anam-ai/js-sdk`), driven by text streamed from
the Gemini persona turn. Speech input is the browser Web Speech API, which is why the app needs
Chrome. Gemini TTS (`gemini-2.5-flash-preview-tts`) is implemented in `app/api/speak/route.js` and
exercised by the health check, but it is not in the live conversation loop — Anam speaks the line.
We would rather say that plainly than imply more Gemini surface than we ship.

**Google Cloud.** The Gemini API calls run against Google Cloud project **240181611094**. That is
the Google Cloud product in the deployed path. `GET /api/health` is the eligibility proof: it makes
one real Gemini text call and one real Gemini TTS call, reports each independently with its own
error code, and returns 503 rather than a misleading 200 if either fails. Hit it on the live URL
above to confirm for yourself.

**Errors carry codes** — `CONFIG_MISSING`, `UPSTREAM_ERROR`, `UPSTREAM_EMPTY`, `UPSTREAM_MALFORMED`,
`BAD_REQUEST`. Missing configuration and a broken upstream must never look the same, and no route
returns an empty success for a failure.

## Run it locally

Run on Node 22.x (v22.23.1 is what this was developed and validated on) and Chrome.

```bash
npm install
# create .env.local by hand with the keys listed below (no example file is committed)
npm run dev                  # http://localhost:3000
npm run validate:metrics     # the metric discrimination gate
```

`.env.local` needs:

```
GEMINI_API_KEY=...              # required
ANAM_API_KEY=...                # required for the talking avatar
GOOGLE_CLOUD_PROJECT_NUMBER=240181611094
```

Honesty note on these instructions: in the session that wrote this README, `npm run
validate:metrics` was run and passed. A clean-state `npm install` and `npm run dev` were **not**
re-run from scratch here, so treat the cold-start path as unverified rather than tested.

## Status

Stated plainly, because a submission that overstates one thing should not be trusted on anything.

- **Revenue: $0.** For the hackathon period and in total.
- **Users: 0.** No pilot, no waitlist, no beta group. No testimonials, because there is nobody to
  quote.
- **Marketing and customer acquisition spend: $0.**
- **No employees, no contractors, no partners, no advisors.** One founder.
- Built in a single day, at the end of the submission window.

**Built and working:** the three personas with distinct enforced behaviour; live Gemini persona
turns; the Anam talking avatar; browser speech capture with live interruption and latency
recording; the Gemini schema-constrained judge; deterministic metrics with a passing discrimination
gate; `/api/health` as an end-to-end eligibility proof.

**Not built:** no payment path — Stripe is not integrated, and the £9/month or £4/session figure in
our notes is a placeholder with nothing behind it. No durable log store in production: structured
event logging writes JSONL locally (`lib/logstore.js`), which is not durable on Vercel, and
Firestore is not wired up. No accounts, no session history, no progress over time. No mobile
layout. No research anchoring for the metric bands.

## Repository access

This repository is shared with **testing@devpost.com** and **judging@hacker.fund** as required by
the submission rules.
