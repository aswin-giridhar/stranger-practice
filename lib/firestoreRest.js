// Firestore over the plain REST API — no SDK, no @google-cloud/firestore, no firebase-admin.
//
// Why REST: the app ships on Vercel with a deliberately tiny dependency tree, exactly like
// app/api/checkout/route.js talks to Stripe with fetch(). Everything here is built on node's
// own `crypto` plus global `fetch`.
//
// Auth flow (no SDK needed):
//   1. read a service-account JSON key from env (or a file path for local dev)
//   2. build a JWT, sign it RS256 with crypto.createSign('RSA-SHA256')
//   3. POST it to https://oauth2.googleapis.com/token with the jwt-bearer grant
//   4. cache the resulting access token in module scope until shortly before expiry
//
// Error discipline (project rule): "not configured" and "broken" must never produce the same
// value. Every function here either returns a well-formed result or throws an Error carrying a
// `.code` from the project's convention: CONFIG_MISSING / UPSTREAM_ERROR / UPSTREAM_EMPTY /
// UPSTREAM_MALFORMED / BAD_REQUEST. Nothing is swallowed.

import fs from 'fs';
import crypto from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const FIRESTORE_HOST = 'https://firestore.googleapis.com/v1';

// Requests sit on the live conversational turn path (app/api/turn/route.js awaits logEvent),
// and a fetch() in node has no default timeout. A stalled Firestore must not stall a turn.
const TOKEN_TIMEOUT_MS = Number(process.env.FIRESTORE_TOKEN_TIMEOUT_MS || 8000);
const WRITE_TIMEOUT_MS = Number(process.env.FIRESTORE_WRITE_TIMEOUT_MS || 8000);

// Refresh this many seconds before the token actually expires.
const TOKEN_SKEW_SECONDS = 60;

function codedError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/* ------------------------------------------------------------------ credentials */

let credentialsCache; // { ok: true, creds } | { ok: false, code, message }

/**
 * Parse a service-account JSON blob. Tolerates the two shapes people actually paste into
 * a Vercel env var: raw JSON, and base64-encoded JSON (which is what you end up doing when
 * the dashboard mangles multi-line values).
 */
function parseServiceAccount(raw, source) {
  const text = String(raw).trim();
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Second chance: base64-encoded JSON.
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      parsed = JSON.parse(decoded);
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw codedError(
      'CONFIG_MISSING',
      `${source} is set but is not valid service-account JSON (nor base64-encoded JSON).`,
    );
  }

  const clientEmail = parsed.client_email;
  const projectId = parsed.project_id;
  let privateKey = parsed.private_key;

  const missing = [];
  if (!clientEmail) missing.push('client_email');
  if (!projectId) missing.push('project_id');
  if (!privateKey) missing.push('private_key');
  if (missing.length) {
    throw codedError(
      'CONFIG_MISSING',
      `${source} is missing required service-account field(s): ${missing.join(', ')}.`,
    );
  }

  // When JSON is pasted through a dashboard the newlines often survive as the two
  // characters backslash-n. Harmless to run when they are already real newlines.
  privateKey = String(privateKey).replace(/\\n/g, '\n');

  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    throw codedError(
      'CONFIG_MISSING',
      `${source} private_key does not look like a PEM private key.`,
    );
  }

  return {
    clientEmail: String(clientEmail),
    projectId: String(projectId),
    privateKey,
    tokenUri: parsed.token_uri || TOKEN_URL,
  };
}

/**
 * Resolve credentials once, lazily (never at module load — the verify script and Next's
 * build both set env after import).
 *
 * Returns { ok: true, creds } when configured, or { ok: false, code: 'CONFIG_MISSING', message }
 * when no credentials are present at all. "Absent" is a normal, non-error state: the caller
 * falls back to JSONL. "Present but broken" is also reported here, with a message that says so.
 */
export function resolveCredentials() {
  if (credentialsCache) return credentialsCache;

  // Pick the first NON-BLANK source. A var that exists but is empty (easy to create by
  // accident in the Vercel dashboard) must not mask the alias behind it.
  const inlineSource = ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON'].find(
    (name) => process.env[name] && process.env[name].trim(),
  );
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  try {
    if (inlineSource) {
      credentialsCache = {
        ok: true,
        creds: parseServiceAccount(process.env[inlineSource], inlineSource),
      };
      return credentialsCache;
    }

    if (filePath && filePath.trim()) {
      let raw;
      try {
        raw = fs.readFileSync(filePath.trim(), 'utf8');
      } catch (err) {
        // The path was configured and could not be read. That is broken, not absent.
        credentialsCache = {
          ok: false,
          code: 'CONFIG_MISSING',
          message: `GOOGLE_APPLICATION_CREDENTIALS points at ${filePath.trim()} which could not be read: ${err?.message || err}`,
          malformed: true,
        };
        console.error(`[firestoreRest] ${credentialsCache.message}`);
        return credentialsCache;
      }
      credentialsCache = {
        ok: true,
        creds: parseServiceAccount(raw, 'GOOGLE_APPLICATION_CREDENTIALS'),
      };
      return credentialsCache;
    }

    credentialsCache = {
      ok: false,
      code: 'CONFIG_MISSING',
      message:
        'No Google service-account credentials configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_SERVICE_ACCOUNT_JSON) to the key JSON, or GOOGLE_APPLICATION_CREDENTIALS to a key file path.',
    };
    return credentialsCache;
  } catch (err) {
    credentialsCache = {
      ok: false,
      code: err?.code || 'CONFIG_MISSING',
      message: err?.message || String(err),
      // A credential source WAS present and could not be used. That is broken, not absent,
      // and it must not look like "nobody configured Firestore" in the logs.
      malformed: true,
    };
    console.error(
      `[firestoreRest] CREDENTIALS PRESENT BUT UNUSABLE — falling back to local JSONL: ${credentialsCache.message}`,
    );
    return credentialsCache;
  }
}

/** Test seam: forget cached credentials and tokens (used by the verification script). */
export function resetFirestoreCaches() {
  credentialsCache = undefined;
  tokenCache = null;
  tokenInFlight = null;
}

/* ------------------------------------------------------------------ access token */

let tokenCache = null; // { token, expiresAtMs }
let tokenInFlight = null; // Promise — so concurrent logEvent calls mint exactly one token.

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signedJwt(creds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.clientEmail,
    scope: SCOPE,
    aud: creds.tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  let signature;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    signature = signer.sign(creds.privateKey);
  } catch (err) {
    throw codedError(
      'CONFIG_MISSING',
      `Service-account private_key could not be used to sign a JWT: ${err?.message || err}`,
      err,
    );
  }

  return `${unsigned}.${base64url(signature)}`;
}

async function requestAccessToken(creds) {
  const assertion = signedJwt(creds);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  let res;
  let text;
  try {
    res = await fetch(creds.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw codedError(
      'UPSTREAM_ERROR',
      `Could not reach Google's OAuth token endpoint: ${err?.message || err}`,
      err,
    );
  }

  // Validate the CONTENT, not just the status. A 200 carrying an HTML captive-portal page
  // is still a failure and must not flow downstream as a token.
  if (!text || !text.trim()) {
    throw codedError('UPSTREAM_EMPTY', `Token endpoint returned an empty body (HTTP ${res.status}).`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw codedError(
      'UPSTREAM_MALFORMED',
      `Token endpoint returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 160)}`,
    );
  }

  if (!res.ok) {
    const detail = data?.error_description || data?.error || text.slice(0, 200);
    throw codedError(
      'UPSTREAM_ERROR',
      `Google rejected the service-account assertion (HTTP ${res.status}): ${detail}`,
    );
  }

  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw codedError(
      'UPSTREAM_MALFORMED',
      'Token endpoint returned 200 with no access_token field.',
    );
  }

  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  return {
    token: data.access_token,
    expiresAtMs: Date.now() + Math.max(0, expiresInSec - TOKEN_SKEW_SECONDS) * 1000,
  };
}

/**
 * Get a cached access token, minting one if needed. Throws a coded Error on failure —
 * never returns null, because a null token and a working token must not be confusable.
 */
export async function getAccessToken() {
  const resolved = resolveCredentials();
  if (!resolved.ok) throw codedError(resolved.code || 'CONFIG_MISSING', resolved.message);

  if (tokenCache && tokenCache.expiresAtMs > Date.now()) return tokenCache.token;

  if (!tokenInFlight) {
    tokenInFlight = requestAccessToken(resolved.creds)
      .then((entry) => {
        tokenCache = entry;
        return entry.token;
      })
      .finally(() => {
        tokenInFlight = null;
      });
  }

  return tokenInFlight;
}

/* ------------------------------------------------------------------ value encoding */

const MAX_DEPTH = 18; // Firestore's own limit is 20 levels; stay inside it.

/**
 * Encode an arbitrary JS value as a Firestore REST `Value`.
 *
 * This must be TOTAL: logSession() writes whatever the report route assembled (turns,
 * metrics, coaching, judged). An un-encodable field must degrade to a string, never reject
 * the whole document — losing one field is recoverable, losing the session record is not.
 */
export function encodeValue(value, depth = 0) {
  if (value === null || value === undefined) return { nullValue: null };

  const t = typeof value;

  if (t === 'string') return { stringValue: value };
  if (t === 'boolean') return { booleanValue: value };
  if (t === 'bigint') return { integerValue: value.toString() };

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      // NaN / Infinity are hard-rejected by Firestore. Keep the information as a string.
      return { stringValue: String(value) };
    }
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(value) }; // integerValue must be a STRING in REST.
    }
    return { doubleValue: value };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { stringValue: 'Invalid Date' }
      : { timestampValue: value.toISOString() };
  }

  if (depth >= MAX_DEPTH) {
    return { stringValue: safeStringify(value) };
  }

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((v) => encodeValue(v, depth + 1)) } };
  }

  if (t === 'object') {
    return { mapValue: { fields: encodeFields(value, depth + 1) } };
  }

  // functions, symbols, anything exotic
  return { stringValue: safeStringify(value) };
}

function safeStringify(value) {
  try {
    const out = JSON.stringify(value);
    return typeof out === 'string' ? out : String(value);
  } catch {
    return String(value);
  }
}

/** Encode a plain object into Firestore `fields`. `undefined` keys are dropped entirely. */
export function encodeFields(obj, depth = 0) {
  const fields = {};
  if (!obj || typeof obj !== 'object') return fields;
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue; // Firestore rejects an empty Value object.
    if (!key) continue;
    fields[key] = encodeValue(val, depth);
  }
  return fields;
}

/** Decode a Firestore REST document back into plain JS (used by the read-back verification). */
export function decodeFields(fields) {
  const out = {};
  for (const [key, val] of Object.entries(fields || {})) {
    out[key] = decodeValue(val);
  }
  return out;
}

export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}

/* ------------------------------------------------------------------ documents */

export function databaseId() {
  return process.env.FIRESTORE_DATABASE_ID || '(default)';
}

/** Base path for a collection. Matches the URL shape that was verified working by hand. */
function documentsUrl(projectId, collection, documentId) {
  const base = `${FIRESTORE_HOST}/projects/${projectId}/databases/${databaseId()}/documents/${collection}`;
  return documentId
    ? `${base}?documentId=${encodeURIComponent(documentId)}`
    : base;
}

/**
 * Create a document in `collection` with `documentId`, from a plain JS object.
 *
 * Resolves to the parsed Firestore document ({ name, fields, createTime, updateTime }).
 * Throws a coded Error otherwise. Never resolves to null/undefined on failure.
 */
export async function createDocument(collection, documentId, data) {
  if (!collection || typeof collection !== 'string') {
    throw codedError('BAD_REQUEST', 'createDocument requires a collection name.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw codedError('BAD_REQUEST', 'createDocument requires a plain object as the document body.');
  }

  const resolved = resolveCredentials();
  if (!resolved.ok) throw codedError(resolved.code || 'CONFIG_MISSING', resolved.message);

  const token = await getAccessToken();
  const url = documentsUrl(resolved.creds.projectId, collection, documentId);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeFields(data) }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw codedError(
      'UPSTREAM_ERROR',
      `Could not reach Firestore: ${err?.name === 'TimeoutError' ? `timed out after ${WRITE_TIMEOUT_MS}ms` : err?.message || err}`,
      err,
    );
  }

  if (!text || !text.trim()) {
    throw codedError('UPSTREAM_EMPTY', `Firestore returned an empty body (HTTP ${res.status}).`);
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // A 200 with an HTML error page lands here. Status alone would have said "success".
    throw codedError(
      'UPSTREAM_MALFORMED',
      `Firestore returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 160)}`,
    );
  }

  if (!res.ok) {
    // A stale/revoked token would otherwise poison the module-scope cache for up to an hour
    // on a warm serverless instance, failing every subsequent write identically.
    if (res.status === 401 || res.status === 403) {
      tokenCache = null;
    }
    const detail = doc?.error?.message || doc?.error?.status || text.slice(0, 200);
    throw codedError(
      'UPSTREAM_ERROR',
      `Firestore rejected the write (HTTP ${res.status}): ${detail}`,
    );
  }

  // `name` is the discriminator between a real written document and any other 200.
  if (typeof doc?.name !== 'string' || !doc.name) {
    throw codedError(
      'UPSTREAM_MALFORMED',
      'Firestore returned 200 without a document name — the write cannot be confirmed.',
    );
  }

  return doc;
}

/**
 * Read a document back by its full resource name (the `name` returned from a write) or by
 * collection/id. Used by the verification script; also useful for a health probe.
 */
export async function getDocument(nameOrCollection, documentId) {
  const resolved = resolveCredentials();
  if (!resolved.ok) throw codedError(resolved.code || 'CONFIG_MISSING', resolved.message);

  const token = await getAccessToken();

  const url = documentId
    ? `${FIRESTORE_HOST}/projects/${resolved.creds.projectId}/databases/${databaseId()}/documents/${nameOrCollection}/${encodeURIComponent(documentId)}`
    : `${FIRESTORE_HOST}/${nameOrCollection}`;

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw codedError('UPSTREAM_ERROR', `Could not reach Firestore: ${err?.message || err}`, err);
  }

  if (!text || !text.trim()) {
    throw codedError('UPSTREAM_EMPTY', `Firestore returned an empty body (HTTP ${res.status}).`);
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw codedError(
      'UPSTREAM_MALFORMED',
      `Firestore returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 160)}`,
    );
  }

  if (res.status === 404) {
    // Absent is distinct from broken: say so explicitly rather than returning null.
    const err = codedError('NOT_FOUND', `Firestore has no document at ${url}.`);
    err.notFound = true;
    throw err;
  }

  if (!res.ok) {
    const detail = doc?.error?.message || text.slice(0, 200);
    throw codedError('UPSTREAM_ERROR', `Firestore read failed (HTTP ${res.status}): ${detail}`);
  }

  if (typeof doc?.name !== 'string') {
    throw codedError('UPSTREAM_MALFORMED', 'Firestore returned 200 without a document name.');
  }

  return doc;
}

/** Project id from the key JSON itself (not from GOOGLE_CLOUD_PROJECT). Null when unconfigured. */
export function firestoreProjectId() {
  const resolved = resolveCredentials();
  return resolved.ok ? resolved.creds.projectId : null;
}
