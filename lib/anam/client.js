'use client';

// Browser-side helper for the Anam talking avatar.
//
// ARCHITECTURE, verified against @anam-ai/js-sdk@3.4.1 and the live API on 2026-08-17:
//
//   Gemini owns  : the dialogue text (/api/turn), the judge and the metrics (/api/report).
//   Anam owns    : the avatar video, the TTS voice, the user's mic + speech detection.
//
// We keep the brain because `llmId: 'CUSTOMER_CLIENT_V1'` disables Anam's built-in LLM;
// the avatar then speaks ONLY what we push with talk() / createTalkMessageStream().
//
// We do NOT keep the voice. Every ingress into Anam is a text string --
// `talk(content: string)` and `TalkMessageStreamPayload { content: string, ... }`. There
// is no persona-audio input anywhere in the SDK surface. So on the Anam path:
//   * /api/speak (Gemini TTS -> wavBase64) is BYPASSED,
//   * the Gemini voice names in lib/personas.js (Kore/Fenrir/Zephyr) are unused,
//   * the AnalyserNode amplitude lipsync in ARCHITECTURE.md is unused (Anam lipsyncs).
// Keep /api/speak working as the no-avatar fallback path; it is not dead code.

import { createClient, AnamEvent } from '@anam-ai/js-sdk';

/**
 * Fetch a session token from our server route.
 * Throws with the server's { code, message } so callers can distinguish CONFIG_MISSING
 * from UPSTREAM_ERROR rather than seeing a generic failure.
 */
export async function fetchAnamSessionToken(personaId, { maxSessionLengthSeconds } = {}) {
  const res = await fetch('/api/anam-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId, maxSessionLengthSeconds }),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('anam-token returned non-JSON'), {
      code: 'UPSTREAM_MALFORMED',
    });
  }

  if (!res.ok || !data?.sessionToken) {
    const err = new Error(data?.error?.message || `anam-token failed (${res.status})`);
    err.code = data?.error?.code || 'UPSTREAM_ERROR';
    throw err;
  }
  return data;
}

/**
 * Start an Anam session and stream the avatar into an existing <video> element.
 *
 * IMPORTANT: pass only the token to createClient(). In SDK v3 the persona config lives
 * inside the token; passing a second config client-side is not supported by
 * `createClient(sessionToken, options)`.
 *
 * @param {object} args
 * @param {string} args.personaId
 * @param {string} args.videoElementId   id of the <video> tag to stream into
 * @param {boolean} [args.disableInputAudio]  set true if the app captures the mic itself
 *                                            for turn timing — otherwise two consumers
 *                                            fight over the same device.
 * @param {(messages: Array) => void} [args.onMessageHistory]
 * @param {(evt: object) => void} [args.onMessageStreamEvent]
 * @param {(sessionId: string) => void} [args.onSessionReady]
 * @param {(reason: any, details?: string) => void} [args.onConnectionClosed]
 */
export async function startAnamAvatar({
  personaId,
  videoElementId,
  disableInputAudio = false,
  onMessageHistory,
  onMessageStreamEvent,
  onSessionReady,
  onConnectionClosed,
}) {
  const { sessionToken } = await fetchAnamSessionToken(personaId);

  const client = createClient(sessionToken, { disableInputAudio });

  // MESSAGE_HISTORY_UPDATED fires when the user finishes speaking, with the full history.
  // MESSAGE_STREAM_EVENT_RECEIVED carries { id, content, role, endOfSpeech, interrupted }
  // per chunk — `role` is 'user' | 'persona' and `interrupted` is how you learn that the
  // user cut the persona off. That flag, observed live, is the honest source for the
  // Turn.overlappedPersona field; do not infer it after the fact.
  if (onMessageHistory) client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, onMessageHistory);
  if (onMessageStreamEvent) {
    client.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, onMessageStreamEvent);
  }
  if (onSessionReady) client.addListener(AnamEvent.SESSION_READY, onSessionReady);
  if (onConnectionClosed) client.addListener(AnamEvent.CONNECTION_CLOSED, onConnectionClosed);

  await client.streamToVideoElement(videoElementId);
  return client;
}

/** Speak one complete Gemini line. Simplest path; use when you already have full text. */
export async function speakLine(client, text) {
  if (!client?.isStreaming?.()) {
    throw new Error('Anam session is not streaming yet; wait for SESSION_READY.');
  }
  return client.talk(text);
}

/**
 * Speak a Gemini line as it streams, so the avatar starts talking before generation
 * finishes. `chunks` is any async iterable of strings.
 */
export async function speakStream(client, chunks) {
  const stream = client.createTalkMessageStream();
  try {
    for await (const chunk of chunks) {
      if (!stream.isActive()) break;
      await stream.streamMessageChunk(chunk, false);
    }
  } finally {
    if (stream.isActive()) await stream.endMessage();
  }
  return stream.getCorrelationId();
}

/**
 * USER BARGE-IN. Stops the avatar mid-sentence because the user started talking over it.
 * Call this at the moment overlap is detected and record Turn.overlappedPersona = true
 * right there — ARCHITECTURE.md requires that flag be observed live, never inferred later.
 *
 * This is NOT how Dan's `interruptAfterMs: 7000` works. That policy is the opposite
 * direction — Dan cuts in on the *user* — and is implemented by calling speakLine()
 * with Dan's next line while the user is still speaking. interruptPersona() would
 * silence Dan, which is precisely the wrong thing.
 */
export function interruptPersonaOnBargeIn(client) {
  client?.interruptPersona?.();
}

export async function stopAnamAvatar(client) {
  try {
    await client?.stopStreaming?.();
  } catch {
    /* already closed */
  }
}
