# Conversation practice for ADHD adults — build spec

Locked 2026-08-17 16:58 UTC. Code freeze 19:00 UTC. Submission deadline 20:00 UTC.
Category: **Education & Human Potential** (secondary fit: Professional Services Access).

## What it is
Adults with ADHD practise talking to *strangers* — the hardest, least practisable social
context — against varied AI personas. 3-minute live conversation, then measured feedback on
the specific pragmatic-language behaviours that make stranger interaction go badly.

Not therapy, not diagnosis, not treatment. A practice gym. All copy must say so.

## The 3 personas (varied behaviour is the point)
1. **Warm & patient** — forgiving, asks follow-ups. Confidence baseline.
2. **Brisk & transactional** — low patience, interrupts, changes subject. Trains recovery.
3. **Reserved & low-signal** — short answers, long pauses. Trains initiation + tolerating silence.

Personas must be behaviourally distinct in *code* (separate system prompts + turn policies),
not just named differently, or the metrics mean nothing across personas.

## Metrics from the 3-minute transcript (the actual product)
Derived, not vibes. Each needs a known-good and known-bad case before the threshold is fixed:
- **Turn balance** — user words / total words. Target band, not a maximum.
- **Interruption rate** — user starts while persona still speaking, per minute.
- **Question-asking ratio** — questions asked / turns taken. Low = interview-mode failure.
- **Topic maintenance** — on-topic turns / total, judged by Gemini against the topic stack.
- **Tangent recovery** — after an off-topic turn, did the next turn return? (ADHD-specific)
- **Response latency** — median ms to start speaking.

RULE: sweep every threshold against one good and one bad transcript before committing it.
A gate nothing can pass is a bug wearing a safety costume.

## Stack (chosen for the 121-minute window, all accounts already live)
- Next.js on **Vercel** (account ready).
- **Gemini API** — persona turns + post-session metric judging. Mandatory for eligibility.
- Browser **Web Speech API** for speech-in (free, zero setup, Chrome).
- **Stripe** payment link for the paid tier.

### Voice + avatar — available tools, ranked by risk inside the window
User has HeyGen, ElevenLabs and Runware in addition to Gemini + GCP. Ladder, not a bet:
- **Tier 1 (must work):** ElevenLabs REST TTS per persona voice + CSS/SVG mouth driven by
  audio amplitude. Known-good path; user's notes confirm direct REST POST works.
- **Tier 2 (upgrade if Tier 1 lands before 18:15 UTC):** HeyGen streaming interactive avatar
  for one persona — real talking face, much stronger demo. Unverified integration; strictly
  time-boxed and abandoned on the first wall.
- **Tier 3 (nice):** Runware / HeyGen pre-rendered persona portraits as idle-state visuals.
- Build Tier 1 behind an interface so Tier 2 swaps in without touching session logic.

### Google Cloud requirement — keep it explicit
ElevenLabs voice means TTS no longer carries the GCP requirement. A distinct Google Cloud
product must stay in the deployed path (Firestore for sessions/logs, or Cloud Run, or Gemini
via Vertex AI). Verify it is actually called in production — not merely a dependency in
package.json. Eligibility is pass/fail at Stage One; do not leave this to the last hour.

### API keys
No .env exists in this project yet. ElevenLabs key lives in *another* project's .env per the
user's notes — locate and copy, do not assume the shell environment has it.

## Non-negotiables for eligibility
- At least one Gemini call in the *deployed* app.
- At least one Google Cloud product.
- Repo shared with testing@devpost.com and judging@hacker.fund.
- Agent execution logs persisted and screenshot-able as evidence.
- P&L filed with marketing spend disclosed even if $0.

## Honesty constraints
- Revenue disclosed exactly as it is. No related-party revenue dressed as arms-length.
- No clinical claims. "Practice", never "treatment" or "improves ADHD".
- Cold-start setup instructions marked untested unless actually run from clean.
