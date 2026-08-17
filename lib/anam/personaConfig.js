// Anam persona configuration — the ONE place that maps our three strangers onto
// real Anam avatar/voice IDs.
//
// VERIFIED 2026-08-17 against the live API with the project's ANAM_API_KEY:
//   POST https://api.anam.ai/v1/auth/session-token  -> 200 {"sessionToken": "<jwt>"}
//   POST https://api.anam.ai/v1/engine/session      -> 200 {sessionId, engineHost, ...}
//
// CRITICAL, and the reason this file exists:
// the session-token endpoint does NOT validate personaConfig. It returns 200 for a
// completely made-up avatarId. The failure only surfaces later, in the browser, at
// engine/session:
//     avatarId "alyx" -> HTTP 404 {"error":"Not found","message":"Avatar with id alyx does not exist."}
// So a green token call proves nothing about the IDs. They must be real UUIDs.
//
// CONCURRENCY (observed 2026-08-17, not documented, NOT cleanly measured): the account
// has a low concurrent-session cap. What was actually seen is that a third live engine
// session was refused; whether the cap is 1 or 2 was not isolated. Refusal looks like
//   HTTP 429 {"error":"Concurrent session limit reached","reason":"concurrent_limit"}
// and a session is held for its full maxSessionLengthSeconds even if the browser goes
// away. Two things follow:
//   1. ALWAYS call client.stopStreaming() on unmount / page hide, or the next visitor
//      is locked out for up to maxSessionLengthSeconds.
//   2. Keep maxSessionLengthSeconds tight (300s here, matching the 3-minute exercise)
//      so an abandoned session self-heals quickly.
//   3. The UI must render the 429 as "the avatar is busy, try again in a moment",
//      never as a blank video pane.
//
// VALIDATION STATUS of the three mappings below:
//   warm     -> engine/session HTTP 200 (fully verified end to end)
//   brisk    -> avatar/voice IDs came from Anam's own GET /v1/avatars and /v1/voices,
//   reserved    and the config SHAPE is proven by `warm`; the engine call itself was
//               blocked by the concurrency limit above, so it is unverified. If either
//               fails at runtime, expect a 404 naming the offending id.
//
// DO NOT use `persona.anamAvatarId` from lib/personas.js. Those values
// ('alyx' / 'leo' / 'sam') are NOT valid Anam avatar IDs and were verified to 404 at
// session start. They are deliberately ignored here. If you "fix" this by reading them
// back, the token call will still return 200 and the avatar will still fail to start.

import { getPersona } from '@/lib/personas';

// Anam's stock avatar library (GET /v1/avatars, 10 entries, fetched 2026-08-17) and
// stock voices (GET /v1/voices, 10 entries). Re-fetch if a face/voice disappears.
//
// Known limitation to surface in the UI copy, not to paper over: the stock library has
// no South-Asian-presenting avatar and every voice is British-accented, so Priya's face
// will not match her name. Either rename the persona or upload a custom avatar.
export const ANAM_AVATARS = {
  ANNE_HOME: '27e12daa-50fc-4384-93c2-ebca73f1f78d', // Anne, home  — warm, relaxed
  KEVIN_TABLE: 'ccf00c0e-7302-455b-ace2-057e0cf58127', // Kevin, table — business, clipped
  JULIA_SOFA: 'edcb8f1a-334f-4cdb-871c-5c513db806a7', // Julia, sofa  — quiet, still
};

export const ANAM_VOICES = {
  AMANDA_WARM: '90313ddc-4fc0-11f1-84b0-52bacf74fa75', // "Amanda - Warm Guide", female
  ARCHIE_MATE: '91b4ce0f-4fc0-11f1-84b0-52bacf74fa75', // "Archie - Approachable Mate", male
  RACHEL_POLISHED: '90a1acd3-4fc0-11f1-84b0-52bacf74fa75', // "Rachel - Polished Presence", female
};

// Anam's sentinel LLM id meaning "the customer's client drives the conversation".
// It disables Anam's built-in brain, so the avatar speaks ONLY what we send via
// client.talk() / createTalkMessageStream(). This is what keeps Gemini as the brain.
export const CUSTOMER_CLIENT_LLM_ID = 'CUSTOMER_CLIENT_V1';

export const ANAM_AVATAR_MODEL = 'cara-4';

// personaId -> Anam presentation. Voice/face only; all behaviour still lives in
// lib/personas.js `policy` and is enforced by our own code.
const ANAM_PRESENTATION = {
  warm: { avatarId: ANAM_AVATARS.ANNE_HOME, voiceId: ANAM_VOICES.AMANDA_WARM },
  brisk: { avatarId: ANAM_AVATARS.KEVIN_TABLE, voiceId: ANAM_VOICES.ARCHIE_MATE },
  reserved: { avatarId: ANAM_AVATARS.JULIA_SOFA, voiceId: ANAM_VOICES.RACHEL_POLISHED },
};

export const ANAM_PERSONA_IDS = Object.keys(ANAM_PRESENTATION);

export function hasAnamPresentation(personaId) {
  return Object.prototype.hasOwnProperty.call(ANAM_PRESENTATION, personaId);
}

/**
 * Build the `personaConfig` for POST /v1/auth/session-token.
 *
 * Note there is no `systemPrompt`. Under CUSTOMER_CLIENT_V1 Anam runs no LLM, so a
 * system prompt would be inert — and leaving one in the config would mislead the next
 * reader into thinking Anam generates the dialogue. The real system prompt is
 * persona.system, used by /api/turn against Gemini.
 *
 * @param {string} personaId  'warm' | 'brisk' | 'reserved'
 * @param {{maxSessionLengthSeconds?: number}} [opts]
 */
export function buildAnamPersonaConfig(personaId, opts = {}) {
  const presentation = ANAM_PRESENTATION[personaId];
  if (!presentation) {
    throw new Error(`No Anam presentation mapped for personaId "${personaId}"`);
  }
  const persona = getPersona(personaId);

  return {
    name: persona.name, // single-sourced from lib/personas.js
    avatarId: presentation.avatarId,
    avatarModel: ANAM_AVATAR_MODEL,
    voiceId: presentation.voiceId,
    llmId: CUSTOMER_CLIENT_LLM_ID,
    maxSessionLengthSeconds: opts.maxSessionLengthSeconds ?? 300,
    // We drive every line ourselves, so Anam must not open with its own greeting.
    skipGreeting: true,
  };
}
