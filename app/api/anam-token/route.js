import { NextResponse } from 'next/server';
import { buildAnamPersonaConfig, hasAnamPresentation } from '@/lib/anam/personaConfig';

export const runtime = 'nodejs';

const ANAM_SESSION_TOKEN_URL = 'https://api.anam.ai/v1/auth/session-token';

function fail(status, code, message) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * POST /api/anam-token
 *
 * request:  { personaId: 'warm'|'brisk'|'reserved', maxSessionLengthSeconds?: Number }
 * response: { sessionToken: String, personaId, personaConfig, expiresInSeconds }
 *
 * The token is bound to the exact personaConfig sent here and is valid for one hour
 * (verified: JWT exp - iat = 3600). The client passes it to
 * `createClient(sessionToken)` from @anam-ai/js-sdk and passes NO config of its own.
 */
export async function POST(req) {
  if (!process.env.ANAM_API_KEY) {
    return fail(500, 'CONFIG_MISSING', 'ANAM_API_KEY is not set on the server.');
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Request body must be JSON.');
  }

  const personaId = body?.personaId;
  if (!personaId || !hasAnamPresentation(personaId)) {
    return fail(
      400,
      'BAD_REQUEST',
      `Unknown personaId "${personaId}". Expected one of: warm, brisk, reserved.`,
    );
  }

  const personaConfig = buildAnamPersonaConfig(personaId, {
    maxSessionLengthSeconds: body?.maxSessionLengthSeconds,
  });

  let response;
  try {
    response = await fetch(ANAM_SESSION_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({ clientLabel: 'stranger-practice', personaConfig }),
    });
  } catch (err) {
    // Network/DNS/TLS — Anam was never reached. Distinct from a rejection by Anam.
    return fail(502, 'UPSTREAM_ERROR', `Could not reach Anam: ${err?.message || String(err)}`);
  }

  const raw = await response.text();

  if (!response.ok) {
    // Anam's own error shape is { error, message }. Surface its message; never echo
    // request headers or the API key.
    let upstreamMessage = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw);
      upstreamMessage = parsed?.message || parsed?.error || upstreamMessage;
    } catch {
      /* non-JSON body (e.g. an HTML error page) — keep the truncated text */
    }
    console.error('[anam-token] upstream %s: %s', response.status, upstreamMessage);
    return fail(
      502,
      'UPSTREAM_ERROR',
      `Anam returned ${response.status}: ${upstreamMessage}`,
    );
  }

  // A 200 is not enough. Validate the CONTENT: a 200 carrying an HTML error page or an
  // empty body must not be handed to the client as a token.
  if (!raw.trim()) {
    return fail(502, 'UPSTREAM_EMPTY', 'Anam returned 200 with an empty body.');
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail(
      502,
      'UPSTREAM_MALFORMED',
      `Anam returned 200 but the body was not JSON (starts with: ${raw.slice(0, 60)}).`,
    );
  }

  if (typeof data?.sessionToken !== 'string' || !data.sessionToken) {
    return fail(
      502,
      'UPSTREAM_EMPTY',
      `Anam returned 200 JSON with no sessionToken (keys: ${Object.keys(data || {}).join(', ') || 'none'}).`,
    );
  }

  return NextResponse.json({
    sessionToken: data.sessionToken,
    personaId,
    // Echoed back for the client's benefit and for the agent-execution log. Contains no
    // secret: these are public avatar/voice IDs.
    personaConfig,
    expiresInSeconds: 3600,
  });
}
