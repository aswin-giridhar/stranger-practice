/* =========================================================================
   Billing — the plan, and the free-session gate.

   ONE plan, deliberately. A three-column pricing table asks the user to make
   a comparison before they have made a decision, and decision load is a real
   cost for this audience. There is one price and one button.

   Why a subscription and not a session pack: the product only works if the
   same person comes back and rehearses again next week. A consumable pack
   makes someone meter the exact behaviour we want them to repeat — every
   session spends a countable unit, so practising costs something to think
   about. A flat monthly price is decided once and then stops being a
   decision.

   Nothing here claims "unlimited". The marginal cost of an avatar minute is
   real and has not been measured, so the copy prices a cadence rather than
   an infinity we cannot stand behind.
   ========================================================================= */

export const PLAN = {
  id: 'practice-monthly',
  name: 'Practice',
  priceDisplay: '£6',
  cadence: 'a month',
  currency: 'gbp',
  unitAmount: 600, // pence
  interval: 'month',
  productName: 'Stranger Practice — monthly',
  // Kept non-clinical on purpose: a rehearsal exercise, never a treatment.
  productDescription:
    'Monthly access to three-minute spoken conversation rehearsals with measured feedback.',
  lines: [
    'Three minutes a day if you want it, with any of the three strangers.',
    'A measured read-back after every session, and one thing to work on.',
    'Cancel whenever. No notice period, no exit questionnaire.',
  ],
};

/* ---- Free-session gate -------------------------------------------------
   Honest and light. The first session is free; after that the pricing
   prompt appears once, and it can be waved away. This is a prompt, not a
   wall — nothing here can stop someone using the product.

   localStorage only. Every read is guarded because this module is imported
   into a page that is prerendered at build time, where `window` is absent.
   ----------------------------------------------------------------------- */

const KEY_COUNT = 'sp.sessionsCompleted';
const KEY_WAIVED = 'sp.gateWaived';

export const FREE_SESSIONS = 1;

function safeStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Private mode / blocked storage. Absent is not broken: the gate simply
    // never fires, which fails open rather than locking someone out.
    return null;
  }
}

// The dismissal is deliberately scoped to the visit, not to the browser.
// A permanent waive would mean the prompt appears exactly once ever, which
// is not a monetisation surface. Session-scoped keeps "not now" honest —
// it stops the nagging for as long as you are here, and asks again next time.
function safeSessionStorage() {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSessionsCompleted() {
  const store = safeStorage();
  if (!store) return 0;
  const raw = store.getItem(KEY_COUNT);
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function recordSessionCompleted() {
  const store = safeStorage();
  if (!store) return 0;
  const next = readSessionsCompleted() + 1;
  try {
    store.setItem(KEY_COUNT, String(next));
  } catch {
    /* storage full or blocked — the counter just does not persist */
  }
  return next;
}

export function readGateWaived() {
  const store = safeSessionStorage();
  if (!store) return false;
  return store.getItem(KEY_WAIVED) === '1';
}

export function waiveGate() {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.setItem(KEY_WAIVED, '1');
  } catch {
    /* ignore */
  }
}

/** True when the pricing prompt should be shown before another session. */
export function shouldPrompt({ sessionsCompleted, waived }) {
  if (waived) return false;
  return sessionsCompleted >= FREE_SESSIONS;
}
