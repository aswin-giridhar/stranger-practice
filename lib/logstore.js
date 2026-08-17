// Structured event and session logging.
// Supports local append-only JSONL storage in .data/events.jsonl with Firestore fallback/extensibility.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), '.data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('Failed to create data directory for logstore:', err);
  }
}

/**
 * Log a structured runtime event (e.g. Gemini text turn, TTS synthesis, metric evaluation)
 */
export async function logEvent({ sessionId, kind, payload = {} }) {
  const logId = crypto.randomUUID();
  const entry = {
    logId,
    sessionId: sessionId || null,
    kind,
    payload,
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
  };

  try {
    ensureDataDir();
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write event log:', err);
  }

  return entry;
}

/**
 * Log a complete session object
 */
export async function logSession(session) {
  const entry = {
    ...session,
    loggedAt: new Date().toISOString(),
  };

  try {
    ensureDataDir();
    fs.appendFileSync(SESSIONS_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write session log:', err);
  }

  return entry;
}
