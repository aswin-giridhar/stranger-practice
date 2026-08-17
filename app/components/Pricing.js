'use client';

import React, { useState } from 'react';
import { PLAN } from '@/lib/billing/plan';

/**
 * One plan, one button. Rendered in two registers:
 *
 *   variant="standing" — the quiet section that always sits at the foot of
 *                        the setup view. Nothing is being asked of anyone.
 *   variant="prompt"   — shown after the free session. Same block, a line of
 *                        context above it, and a way past it. It is a prompt,
 *                        not a wall: `onDismiss` starts the session anyway.
 *
 * If checkout is not configured the server says so (503 CONFIG_MISSING) and
 * that sentence goes on screen. The button is never a no-op, and a purchase
 * is never implied without one.
 */
export default function Pricing({ variant = 'standing', accent, onDismiss, dismissLabel }) {
  const [state, setState] = useState('idle'); // 'idle' | 'working' | 'unavailable' | 'error'
  const [message, setMessage] = useState('');

  const startCheckout = async () => {
    setState('working');
    setMessage('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.ok && typeof data?.url === 'string' && data.url) {
        window.location.href = data.url;
        return;
      }

      if (data?.error?.code === 'CONFIG_MISSING') {
        setState('unavailable');
        setMessage(
          'Payments are not live yet. Nothing has been charged and nothing has been set up — this is the checkout path, waiting on its keys.',
        );
        return;
      }

      setState('error');
      setMessage(
        data?.error?.message ||
          'Checkout could not be reached just now. Nothing has been charged. Try again in a moment.',
      );
    } catch (err) {
      setState('error');
      setMessage(
        `Checkout could not be reached just now. Nothing has been charged. (${err?.message || 'network error'})`,
      );
    }
  };

  const isPrompt = variant === 'prompt';

  return (
    <section
      className={`pricing ${isPrompt ? 'is-prompt' : ''}`}
      style={accent ? { '--accent': accent } : undefined}
      aria-labelledby="pricing-title"
    >
      <div className="pricing-head">
        <span className="eyebrow">{isPrompt ? 'Your free session is done' : 'Keeping this going'}</span>
        <h3 id="pricing-title" className="pricing-title">
          {isPrompt ? 'Carry on practising for £6 a month' : 'The first session is free'}
        </h3>
        <p className="pricing-lede">
          {isPrompt
            ? 'You have had the whole thing once — a stranger, three minutes, and the read-back afterwards. If it was worth repeating, this is what it costs to keep repeating it.'
            : 'Have a conversation and read the report without paying for anything. After that, one price keeps the strangers available.'}
        </p>
      </div>

      <div className="pricing-body">
        <p className="pricing-figure">
          <b>{PLAN.priceDisplay}</b>
          <span>{PLAN.cadence}</span>
        </p>

        <ul className="pricing-lines">
          {PLAN.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="pricing-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={startCheckout}
          disabled={state === 'working'}
        >
          {state === 'working' ? 'Opening checkout…' : `Practise for ${PLAN.priceDisplay} a month`}
        </button>

        {onDismiss && (
          <button type="button" className="btn-bare" onClick={onDismiss}>
            {dismissLabel || 'Not now — start the session anyway'}
          </button>
        )}
      </div>

      {message && (
        <p className={`pricing-status ${state === 'unavailable' ? 'is-pending' : 'is-off'}`} role="status">
          {message}
        </p>
      )}

      <p className="pricing-foot">
        Practice sessions and the report that follows are a rehearsal exercise. Paying changes how
        many conversations you can have, and nothing else.
      </p>
    </section>
  );
}
