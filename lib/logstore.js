// Structured event and session logging.
//
// Two backends behind one interface, selected by environment:
//   - Firestore (REST, no SDK — see lib/firestoreRest.js) when a Google service account is
//     configured. This is the "one Google Cloud product" requirement and the source of the
//     agent-execution-log evidence in the submission.
//   - Local append-only JSONL at .data/events.jsonl / .data/sessions.jsonl for local dev.
//
// The logs ARE product evidence, not debug noise, so this file's error handling is the point:
//
//   * "no credentials configured" is NOT an error — it selects the JSONL backend and reports
//     ok:true with backend:'jsonl'.
//   * "credentials configured but the write failed" IS an error. It is surfaced on
//     console.error with a distinct, greppable prefix AND on the returned entry as
//     entry.storage = { ok:false, code, message } so the caller can read it.
//   * Logging never throws at the caller. Every route awaits logEvent() on the live turn path;
//     a logging failure must not fail the user's request. But it must never *silently* succeed
//     either — a failed Firestore write never reports ok:true, not even when the JSONL mirror
//     succeeded.
//
// The returned entry keeps every field it had before (logId, sessionId, kind, payload,
// timestamp, epochMs) and only adds `storage`, so existing callers are unaffected.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { createDocument, resolveCredentials, firestoreProjectId } from './firestoreRest.js';

const DATA_DIR = path.join(process.cwd(), '.data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');

const EVENTS_COLLECTION = process.env.FIRESTORE_EVENTS_COLLECTION || 'events';
const SESSIONS_COLLECTION = process.env.FIRESTORE_SESSIONS_COLLECTION || 'sessions';

// Set FIRESTORE_MIRROR_JSONL=1 to also append locally when Firestore is the primary backend.
// The mirror never rescues a failed Firestore write's status — see writeThrough().
const MIRROR_JSONL = process.env.FIRESTORE_MIRROR_JSONL === '1';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Is a Firestore backend configured at all? Absence is a normal state, not a failure.
 * Returns { configured, code, message, projectId }.
 */
export function getStoreStatus() {
  const resolved = resolveCredentials();
  if (resolved.ok) {
    return {
      backend: 'firestore',
      configured: true,
      projectId: resolved.creds.projectId,
      database: process.env.FIRESTORE_DATABASE_ID || '(default)',
      collections: { events: EVENTS_COLLECTION, sessions: SESSIONS_COLLECTION },
      jsonlFallbackPath: EVENTS_FILE,
    };
  }
  return {
    backend: 'jsonl',
    configured: false,
    // `malformed` distinguishes "nobody set credentials" (normal) from "credentials were set
    // and are unusable" (broken). Both fall back to JSONL, but only one is a problem.
    malformed: Boolean(resolved.malformed),
    code: resolved.code || 'CONFIG_MISSING',
    message: resolved.message,
    projectId: null,
    jsonlFallbackPath: EVENTS_FILE,
  };
}

/** Append one JSON line. Returns a storage status object; never throws. */
function appendJsonl(file, entry) {
  try {
    ensureDataDir();
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return { backend: 'jsonl', ok: true, path: file };
  } catch (err) {
    // Local disk failed. This is broken, not absent — say so loudly.
    console.error(`[logstore] JSONL write FAILED for ${file}:`, err?.message || err);
    return {
      backend: 'jsonl',
      ok: false,
      code: 'UPSTREAM_ERROR',
      message: `Could not append to ${file}: ${err?.message || err}`,
      path: file,
    };
  }
}

/**
 * Write one record through the selected backend.
 *
 * Returns a `storage` descriptor — always populated, never null, and its `ok` reflects the
 * PRIMARY backend only. A Firestore failure that was mirrored to JSONL still reports ok:false
 * with the Firestore error code, because "we kept a local copy" is not "the write landed".
 */
async function writeThrough({ collection, documentId, record, jsonlFile }) {
  const status = getStoreStatus();

  if (!status.configured) {
    // Not configured -> JSONL is the intended backend, and success here is real success.
    const local = appendJsonl(jsonlFile, record);
    return {
      ...local,
      configured: false,
      malformed: Boolean(status.malformed),
      reason: status.code, // CONFIG_MISSING — informational, not an error for the caller
      // ok reflects the JSONL write. `malformed:true` means credentials were supplied and
      // rejected, so a deployment expecting Firestore can detect it without a crash.
    };
  }

  try {
    const doc = await createDocument(collection, documentId, record);
    const result = {
      backend: 'firestore',
      ok: true,
      configured: true,
      projectId: status.projectId,
      docPath: doc.name,
      docId: documentId,
      createTime: doc.createTime || null,
    };
    if (MIRROR_JSONL) {
      result.mirror = appendJsonl(jsonlFile, record);
    }
    return result;
  } catch (err) {
    const code = err?.code || 'UPSTREAM_ERROR';
    // Distinct, greppable prefix. This is the only place a logging failure becomes visible,
    // so it must never be quiet.
    console.error(
      `[logstore] FIRESTORE WRITE FAILED (${code}) collection=${collection} docId=${documentId}: ${err?.message || err}`,
    );

    const failure = {
      backend: 'firestore',
      ok: false,
      configured: true,
      projectId: status.projectId,
      code,
      message: err?.message || String(err),
      docId: documentId,
    };

    // Best-effort local salvage so the evidence is not lost. It does NOT flip ok to true.
    failure.fallback = appendJsonl(jsonlFile, { ...record, _firestoreError: { code, message: failure.message } });
    return failure;
  }
}

/**
 * Log a structured runtime event (e.g. Gemini text turn, TTS synthesis, metric evaluation).
 *
 * Returns the entry, with `entry.storage` describing where it went and whether it landed.
 * Never throws — callers await this on the request path.
 */
export async function logEvent({ sessionId, kind, payload = {} } = {}) {
  const logId = crypto.randomUUID();
  const entry = {
    logId,
    sessionId: sessionId || null,
    kind,
    payload,
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
  };

  let storage;
  try {
    storage = await writeThrough({
      collection: EVENTS_COLLECTION,
      documentId: logId,
      record: entry,
      jsonlFile: EVENTS_FILE,
    });
  } catch (err) {
    // writeThrough is not supposed to throw; if it does, that is a bug and must be visible.
    console.error('[logstore] UNEXPECTED logEvent failure:', err?.message || err);
    storage = {
      backend: 'unknown',
      ok: false,
      code: err?.code || 'UPSTREAM_ERROR',
      message: err?.message || String(err),
    };
  }

  return { ...entry, storage };
}

/**
 * Log a complete session object.
 *
 * Adds `logId` (also used as the Firestore document id) — app/api/report/route.js already
 * reads `logged?.logId`, which was always null before.
 */
export async function logSession(session) {
  if (!session || typeof session !== 'object') {
    console.error('[logstore] logSession called with a non-object session; refusing to log.');
    return {
      logId: null,
      loggedAt: new Date().toISOString(),
      storage: {
        backend: 'none',
        ok: false,
        code: 'BAD_REQUEST',
        message: 'logSession requires a session object.',
      },
    };
  }

  const logId = session.logId || crypto.randomUUID();
  const entry = {
    ...session,
    logId,
    loggedAt: new Date().toISOString(),
  };

  let storage;
  try {
    storage = await writeThrough({
      collection: SESSIONS_COLLECTION,
      documentId: logId,
      record: entry,
      jsonlFile: SESSIONS_FILE,
    });
  } catch (err) {
    console.error('[logstore] UNEXPECTED logSession failure:', err?.message || err);
    storage = {
      backend: 'unknown',
      ok: false,
      code: err?.code || 'UPSTREAM_ERROR',
      message: err?.message || String(err),
    };
  }

  return { ...entry, storage };
}

export { firestoreProjectId };
