'use client';

import React, { useState, useEffect, useRef } from 'react';
import { PERSONAS, PERSONA_LIST } from '@/lib/personas';
import { BANDS } from '@/lib/metrics';
import { createClient } from '@anam-ai/js-sdk';

export default function StrangerPracticePage() {
  const [view, setView] = useState('setup'); // 'setup' | 'active' | 'generating_report' | 'report'
  const [selectedPersonaId, setSelectedPersonaId] = useState('warm');
  const [sessionId, setSessionId] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState(180);
  const [sessionStartTime, setSessionStartTime] = useState(0);

  // Turn management
  const [turns, setTurns] = useState([]);
  const [floorState, setFloorState] = useState('silence'); // 'silence' | 'user' | 'persona'
  const [interruptionAlert, setInterruptionAlert] = useState(false);
  const [interruptionTimeout, setInterruptionTimeout] = useState(null);

  // Anam SDK client
  const anamClientRef = useRef(null);

  // Speech Recognition & Typing fallback
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);
  
  const recognitionRef = useRef(null);
  const speechStartedAtRef = useRef(null);
  const floorBecameSilenceAtRef = useRef(0);
  const personaSpeechTimeoutRef = useRef(null);

  // Report state
  const [reportData, setReportData] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [showTyping, setShowTyping] = useState(false);

  const selectedPersona = PERSONAS[selectedPersonaId] || PERSONAS.warm;

  // Strip the page chrome down to one focal point while a session is live.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.dataset.view = view;
    return () => {
      delete document.body.dataset.view;
    };
  }, [view]);

  // Track when silence starts
  useEffect(() => {
    if (floorState === 'silence') {
      floorBecameSilenceAtRef.current = Date.now();
    }
  }, [floorState]);

  // Policy Engine for Silence & Interruption Tolerance
  useEffect(() => {
    if (view !== 'active' || isProcessingTurn) return;

    const policy = selectedPersona.policy;
    const interval = setInterval(() => {
      const now = Date.now();

      // Silence Tolerance
      if (floorState === 'silence' && policy.silenceToleranceMs) {
        if (now - floorBecameSilenceAtRef.current > policy.silenceToleranceMs) {
          handleUserTurnSubmit('[Silence]', true);
        }
      }

      // Interruption Tolerance
      if (floorState === 'user' && policy.interrupts && policy.interruptAfterMs) {
        if (speechStartedAtRef.current && (now - speechStartedAtRef.current > policy.interruptAfterMs)) {
          handleUserTurnSubmit(liveTranscript || '[Inaudible]', true);
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, [view, isProcessingTurn, floorState, liveTranscript, selectedPersona]);

  // Initialize Speech Recognition support detection
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setSpeechSupported(false);
      }
    }
  }, []);

  // Timer countdown during active session
  useEffect(() => {
    let timer;
    if (view === 'active' && secondsRemaining > 0) {
      timer = setInterval(() => {
        setSecondsRemaining((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            handleFinishSession();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [view, secondsRemaining]);

  // Start speech recognition
  const startRecognition = () => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcriptChunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            handleUserTurnSubmit(transcriptChunk.trim());
            interim = '';
          } else {
            interim += transcriptChunk;
            if (!speechStartedAtRef.current) {
              speechStartedAtRef.current = Date.now();
              setFloorState('user');
              // Check for live interruption
              if (floorState === 'persona') {
                triggerInterruptionAlert();
              }
            }
          }
        }
        setLiveTranscript(interim);
      };

      recognition.onerror = (e) => {
        console.warn('Speech recognition error:', e.error);
        if (e.error === 'not-allowed') {
          setSpeechSupported(false);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
      recognitionRef.current = recognition;
    } catch (err) {
      console.warn('Failed to start speech recognition:', err);
    }
  };

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    setIsListening(false);
  };

  const triggerInterruptionAlert = () => {
    setInterruptionAlert(true);
    if (interruptionTimeout) clearTimeout(interruptionTimeout);
    const t = setTimeout(() => setInterruptionAlert(false), 2500);
    setInterruptionTimeout(t);
  };

  const streamTextToAnam = (text) => {
    if (!anamClientRef.current) return;
    try {
      const talkStream = anamClientRef.current.createTalkMessageStream();
      talkStream.write(text);
      talkStream.end();

      // Estimate speech duration to yield the floor back
      const words = text.split(/\s+/).length;
      const estimatedMs = Math.max(1500, words * 300 + 400); // Rough speaking rate estimate

      setFloorState('persona');
      if (personaSpeechTimeoutRef.current) {
        clearTimeout(personaSpeechTimeoutRef.current);
      }
      
      personaSpeechTimeoutRef.current = setTimeout(() => {
        setFloorState('silence');
      }, estimatedMs);

    } catch (err) {
      console.error('Failed to stream text to Anam:', err);
      setFloorState('silence');
    }
  };

  // Start the 3-minute session
  const handleStartSession = async () => {
    const newSessionId = crypto.randomUUID();
    setSessionId(newSessionId);
    setTurns([]);
    setSecondsRemaining(180);
    setSessionStartTime(Date.now());
    setView('active');
    setErrorMessage(null);
    setIsProcessingTurn(true);

    try {
      // 1. Initialize Anam Session
      const tokenRes = await fetch('/api/anam-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarId: selectedPersona.anamAvatarId }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new Error('Failed to get Anam token');

      const anamClient = createClient(tokenData.sessionToken, {
        disableInputAudio: true // We use our own SpeechRecognition for metrics
      });
      
      anamClientRef.current = anamClient;
      
      // Delay slightly to ensure video element is mounted by React state `view === 'active'`
      setTimeout(async () => {
        try {
          await anamClient.streamToVideoElement('anam-video');
        } catch (e) {
          console.error("Anam Stream attach error:", e);
        }
      }, 100);


      // 2. Initial greeting from Gemini Turn logic
      const turnRes = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: selectedPersonaId,
          sessionId: newSessionId,
          turns: [],
          secondsRemaining: 180,
        }),
      });
      const turnData = await turnRes.json();
      if (!turnRes.ok) {
        throw new Error(turnData.error?.message || 'Failed to start turn');
      }

      const personaTurn = {
        role: 'persona',
        text: turnData.text,
        startedAt: Date.now(),
        endedAt: Date.now() + 2000,
        latencyMs: null,
        overlappedPersona: false,
        onTopic: null,
      };

      setTurns([personaTurn]);

      // 3. Stream text to Anam Avatar
      setTimeout(() => {
        streamTextToAnam(turnData.text);
      }, 500); // Give Anam a brief moment to connect

    } catch (err) {
      console.error('Session start error:', err);
      setErrorMessage(err.message);
    } finally {
      setIsProcessingTurn(false);
      startRecognition();
    }
  };

  // Process a user turn
  const handleUserTurnSubmit = async (text, isAuto = false) => {
    if ((!text || !text.trim()) && !isAuto) return;
    if (isProcessingTurn) return;
    
    const actualText = (text && text.trim()) ? text.trim() : '[Silence]';

    const now = Date.now();
    const userStarted = speechStartedAtRef.current || now - 1500;
    speechStartedAtRef.current = null;
    setLiveTranscript('');
    setManualInput('');

    // If persona was talking and user interrupted, we stop Anam's current speech
    if (floorState === 'persona' && anamClientRef.current) {
       // Anam SDK method to stop current TTS if needed, or we just let it finish.
       // Some versions use .interruptPersona() or .stopTalking().
       try {
         if (typeof anamClientRef.current.interruptPersona === 'function') {
           anamClientRef.current.interruptPersona();
         }
       } catch (e) {}
    }

    if (personaSpeechTimeoutRef.current) {
       clearTimeout(personaSpeechTimeoutRef.current);
    }

    const lastPersonaTurn = [...turns].reverse().find((t) => t.role === 'persona');
    const latencyMs = lastPersonaTurn ? Math.max(0, userStarted - lastPersonaTurn.endedAt) : null;
    const overlapped = (floorState === 'persona');

    const userTurn = {
      role: 'user',
      text: actualText,
      startedAt: userStarted,
      endedAt: now,
      latencyMs,
      overlappedPersona: overlapped,
      onTopic: null,
    };

    const updatedTurns = [...turns, userTurn];
    setTurns(updatedTurns);
    setIsProcessingTurn(true);
    setFloorState('silence');

    try {
      const turnRes = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: selectedPersonaId,
          sessionId,
          turns: updatedTurns,
          secondsRemaining,
        }),
      });

      const turnData = await turnRes.json();
      if (!turnRes.ok) {
        throw new Error(turnData.error?.message || 'Turn generation failed');
      }

      const personaTurn = {
        role: 'persona',
        text: turnData.text,
        startedAt: Date.now(),
        endedAt: Date.now() + 2000,
        latencyMs: null,
        overlappedPersona: false,
        onTopic: null,
      };

      const finalTurns = [...updatedTurns, personaTurn];
      setTurns(finalTurns);

      // Stream text to Anam Avatar
      streamTextToAnam(turnData.text);

    } catch (err) {
      console.error('Turn cycle error:', err);
      setErrorMessage(err.message);
    } finally {
      setIsProcessingTurn(false);
    }
  };

  // Complete session & generate report
  const handleFinishSession = async () => {
    stopRecognition();
    if (personaSpeechTimeoutRef.current) clearTimeout(personaSpeechTimeoutRef.current);
    
    // Stop Anam stream and cleanup
    if (anamClientRef.current) {
        try {
            if (typeof anamClientRef.current.stop === 'function') {
                anamClientRef.current.stop();
            }
        } catch(e) {}
    }

    setView('generating_report');
    const durationMs = sessionStartTime ? Date.now() - sessionStartTime : 180000;

    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          personaId: selectedPersonaId,
          durationMs,
          turns,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to generate report');
      }

      setReportData(data);
      setView('report');
    } catch (err) {
      console.error('Report error:', err);
      setErrorMessage(err.message);
      setView('setup');
    }
  };

  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const lastPersonaLine = [...turns].reverse().find((t) => t.role === 'persona')?.text || '';
  const userIsSpeaking = floorState === 'user' && Boolean(liveTranscript);
  const floorLabel =
    floorState === 'persona'
      ? `${selectedPersona.name} is speaking`
      : floorState === 'user'
      ? 'Your turn — listening'
      : 'The floor is open';

  const focusKey = reportData?.focus?.name;
  const metricKeys = Object.keys(BANDS);
  const orderedMetrics = focusKey ? [focusKey, ...metricKeys.filter((k) => k !== focusKey)] : metricKeys;

  return (
    <div>
      {/* ERROR BANNER */}
      {errorMessage && (
        <div className="notice" role="alert">
          <span>{errorMessage}</span>
          <button type="button" className="notice-dismiss" onClick={() => setErrorMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* ========================================================= */}
      {/* 1. SETUP / PERSONA SELECTOR VIEW                         */}
      {/* ========================================================= */}
      {view === 'setup' && (
        <div className="setup">
          <header className="setup-intro">
            <div>
              <span className="eyebrow">Conversation practice for ADHD adults</span>
              <h2 className="setup-title">
                Rehearse the part that <em>actually</em> goes wrong.
              </h2>
            </div>
            <div>
              <p className="setup-lede">
                Three strangers, each difficult in a different way. Talk to one of them out loud for three minutes.
                Afterwards you get one thing to work on — measured from what happened, not guessed.
              </p>
              <ul className="setup-facts">
                <li>
                  <b>3:00</b>
                  <span>A session runs three minutes and ends by itself. Nothing to decide part-way through.</span>
                </li>
                <li>
                  <b>3</b>
                  <span>Three people to practise against, from gentle to genuinely hard work.</span>
                </li>
                <li>
                  <b>1</b>
                  <span>One thing to work on at the end. Not a scoreboard.</span>
                </li>
              </ul>
            </div>
          </header>

          <section aria-labelledby="chooser-title">
            <div className="chooser-head">
              <h3 id="chooser-title" className="chooser-title">
                Choose who you&rsquo;re talking to
              </h3>
              <span className="eyebrow">Step 1 of 2</span>
            </div>

            <div className="persona-list" role="radiogroup" aria-labelledby="chooser-title">
              {PERSONA_LIST.map((p) => {
                const isSelected = selectedPersonaId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className="persona-row"
                    style={{ '--accent': p.accent }}
                    onClick={() => setSelectedPersonaId(p.id)}
                  >
                    <span className="persona-portrait">
                      <img src={p.avatarImage} alt="" />
                    </span>

                    <span className="persona-body">
                      <span className="persona-nameline">
                        <span className="persona-name">{p.name}</span>
                        <span className="persona-context">{p.context}</span>
                      </span>
                      <span className="persona-blurb">{p.blurb}</span>
                      <span className="persona-traits">
                        {personaTraits(p).map((t) => (
                          <span key={t} className="persona-trait">
                            {t}
                          </span>
                        ))}
                      </span>
                    </span>

                    <span className="difficulty">
                      <span className="difficulty-word">
                        {DIFFICULTY_WORD[p.difficulty]} &middot; {p.difficulty}/5
                      </span>
                      <span className="difficulty-dots" aria-hidden="true">
                        {[1, 2, 3, 4, 5].map((d) => (
                          <span key={d} className={`diff-dot ${d <= p.difficulty ? 'filled' : ''}`} />
                        ))}
                      </span>
                      <span className="persona-check">Selected</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="launch">
            <div className="launch-copy">
              <h3>Practise with {selectedPersona.name}</h3>
              <p>
                {speechSupported
                  ? 'Your microphone carries the conversation. You can switch to typing at any point.'
                  : 'This browser has no speech recognition, so you can type your side of the conversation instead.'}
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={handleStartSession}>
              Start the three minutes
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 2. LIVE CONVERSATION VIEW                                 */}
      {/* ========================================================= */}
      {view === 'active' && (
        <div className="stage" style={{ '--accent': selectedPersona.accent }}>
          <span className="stage-who">
            {selectedPersona.name} &middot; {selectedPersona.context}
          </span>

          <div className="avatar-frame">
            <svg className="avatar-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="ring-track" cx="50" cy="50" r="48" fill="none" strokeWidth="1.4" />
              <circle
                className="ring-remaining"
                cx="50"
                cy="50"
                r="48"
                fill="none"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(0, secondsRemaining) / SESSION_SECONDS)}
              />
            </svg>

            <div className="avatar-media">
              <video id="anam-video" autoPlay playsInline />
              {turns.length === 0 && (
                <div className="avatar-waiting">Connecting to {selectedPersona.name}&hellip;</div>
              )}
            </div>
          </div>

          <p className={`stage-caption ${userIsSpeaking ? 'is-you' : ''}`}>
            {userIsSpeaking ? `“${liveTranscript}”` : lastPersonaLine}
          </p>

          <div className="stage-meta">
            <span className="floor-state">
              <span className={`floor-dot ${floorState}`} />
              {floorLabel}
            </span>
            <span className="time-left" title={`${formatTimer(secondsRemaining)} remaining`}>
              {coarseTimeLeft(secondsRemaining)}
            </span>
          </div>

          {interruptionAlert && (
            <p className="stage-note" role="status">
              You started while {selectedPersona.name} still had the floor.
            </p>
          )}

          <div className="stage-tools">
            {speechSupported && (
              <button
                type="button"
                className={`btn btn-quiet ${isListening ? 'is-on' : ''}`}
                onClick={isListening ? stopRecognition : startRecognition}
              >
                {isListening ? 'Microphone on' : 'Turn microphone on'}
              </button>
            )}
            <button type="button" className="btn-bare" onClick={() => setShowTyping((v) => !v)}>
              {showTyping ? 'Hide the keyboard' : 'Type instead'}
            </button>
            <button type="button" className="btn-bare" onClick={handleFinishSession}>
              End early
            </button>
          </div>

          {(showTyping || !speechSupported) && (
            <div className="type-row">
              <label className="sr-only" htmlFor="manual-say">
                Type what you would say
              </label>
              <input
                id="manual-say"
                type="text"
                placeholder="Type what you would say&hellip;"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && manualInput.trim()) {
                    handleUserTurnSubmit(manualInput);
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (manualInput.trim()) handleUserTurnSubmit(manualInput);
                }}
                disabled={!manualInput.trim() || isProcessingTurn}
              >
                Say it
              </button>
            </div>
          )}

          {turns.length > 0 && (
            <details className="transcript">
              <summary>Show what has been said so far ({turns.length})</summary>
              <dl className="transcript-lines">
                {turns.map((t, idx) => (
                  <div key={idx} className={`transcript-line ${t.role === 'user' ? 'is-user' : ''}`}>
                    <dt>{t.role === 'persona' ? selectedPersona.name : 'You'}</dt>
                    <dd>{t.text}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* 3. GENERATING REPORT SPINNER                              */}
      {/* ========================================================= */}
      {view === 'generating_report' && (
        <div className="waiting" role="status" aria-live="polite">
          <h2>Reading back the conversation</h2>
          <p>Working out which one thing would help most next time. This takes a few seconds.</p>
          <div className="waiting-bar" aria-hidden="true" />
        </div>
      )}

      {/* ========================================================= */}
      {/* 4. POST-SESSION REPORT VIEW                               */}
      {/* ========================================================= */}
      {view === 'report' && reportData && (
        <div className="report">
          <header className="report-top">
            <div>
              <span className="eyebrow">After the session</span>
              <p>
                {selectedPersona.name} &middot; {Math.round((reportData.durationMs || 180000) / 1000)} seconds &middot;{' '}
                {reportData.metrics?.counts?.userTurns || 0} turns from you
              </p>
            </div>
            <p className="report-index">
              Overall{' '}
              <b>
                {reportData.metrics?.composite !== null && reportData.metrics?.composite !== undefined
                  ? (reportData.metrics.composite * 100).toFixed(0)
                  : '--'}
              </b>
            </p>
          </header>

          <section className="focus-block">
            <div>
              <span className="eyebrow">Work on this next</span>
              <h2 className="focus-headline">{reportData.focus?.label || 'Nothing stood out this time'}</h2>
              <p className="focus-coaching">
                {reportData.coaching ||
                  'There was not enough conversation to read anything reliable. Try another three minutes.'}
              </p>
            </div>

            {reportData.focus && (
              <dl className="focus-aside">
                <div className="focus-stat">
                  <dt>Your reading</dt>
                  <dd>{formatMetricValue(reportData.focus.name, reportData.focus.value)}</dd>
                </div>
                <div className="focus-stat">
                  <dt>Comfortable range</dt>
                  <dd>
                    {formatBand(reportData.focus.name)}
                    <small>Everything outside this is worth a look, not a worry.</small>
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <section aria-labelledby="ledger-title">
            <div className="chooser-head">
              <h3 id="ledger-title" className="chooser-title">
                Everything else, for reference
              </h3>
              <span className="eyebrow">Read it or don&rsquo;t</span>
            </div>

            <div className="ledger">
              {orderedMetrics.map((metricKey) => {
                const rawVal = reportData.metrics?.raw?.[metricKey];
                const score = reportData.metrics?.scores?.[metricKey];
                const judged = judgeScore(score);
                return (
                  <div key={metricKey} className={`ledger-row ${metricKey === focusKey ? 'is-focus' : ''}`}>
                    <span className="ledger-label">
                      {BANDS[metricKey].label}
                      {metricKey === focusKey && <span className="ledger-flag">Your focus</span>}
                    </span>
                    <span className="ledger-value">{formatMetricValue(metricKey, rawVal)}</span>
                    <span className={`ledger-judgement ${judged.tone}`}>{judged.text}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="report-close">
            <button type="button" className="btn btn-primary" onClick={() => setView('setup')}>
              Practise again
            </button>
            <span className="report-close-note">
              Nothing here is a diagnosis. It is a record of one three-minute conversation.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Presentation helpers. These only shape how existing values are read;
   nothing here changes what the API returns or how metrics are computed.
   ------------------------------------------------------------------------- */

const SESSION_SECONDS = 180;
const RING_CIRCUMFERENCE = 2 * Math.PI * 48;

// Difficulty is named as well as counted, so the three strangers stay
// distinguishable without relying on their accent colour.
const DIFFICULTY_WORD = {
  1: 'Gentle',
  2: 'Easy going',
  3: 'Demanding',
  4: 'Sparse',
  5: 'Relentless',
};

// Read straight off each persona's policy object so the description and the
// behaviour cannot drift apart.
function personaTraits(p) {
  const traits = [];

  traits.push(
    p.policy.interrupts
      ? `Cuts in if you run past ${Math.round(p.policy.interruptAfterMs / 1000)} seconds`
      : 'Lets you finish your sentence'
  );

  if (p.policy.silenceToleranceMs >= 4000) traits.push('Will sit in a silence');
  else if (p.policy.silenceToleranceMs >= 2000) traits.push('Waits a beat before filling a pause');
  else traits.push('Fills a pause almost immediately');

  if (p.policy.maxWords <= 10) traits.push('Answers in a handful of words');
  else if (p.policy.maxWords <= 20) traits.push('Keeps replies to one short line');
  else traits.push('Gives you a couple of sentences back');

  return traits;
}

// A coarse phrase rather than ticking digits: the exact seconds are still
// available on hover and to screen readers, but they are not on screen
// counting down at you for three minutes.
function coarseTimeLeft(sec) {
  if (sec <= 0) return 'Time';
  if (sec <= 20) return 'Wrapping up';
  if (sec <= 60) return 'Under a minute left';
  if (sec <= 120) return 'A couple of minutes left';
  return 'Just getting started';
}

function formatMetricValue(key, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (key === 'interruptionsPerMin') return `${value.toFixed(1)} per min`;
  if (key === 'medianLatencyMs') return `${Math.round(value)} ms`;
  return `${(value * 100).toFixed(0)}%`;
}

function formatBand(key) {
  const band = BANDS[key]?.good;
  if (!Array.isArray(band)) return '—';
  const [lo, hi] = band;
  if (key === 'interruptionsPerMin') return `${lo.toFixed(1)}–${hi.toFixed(1)} per min`;
  if (key === 'medianLatencyMs') return `${Math.round(lo)}–${Math.round(hi)} ms`;
  return `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`;
}

// Absent and poor must not look the same: an unmeasured metric says so.
function judgeScore(score) {
  if (score === null || score === undefined) return { tone: 'none', text: 'Not measured' };
  if (score >= 0.75) return { tone: 'good', text: 'Comfortable' };
  if (score >= 0.4) return { tone: 'watch', text: 'Near the edge' };
  return { tone: 'off', text: 'Outside the range' };
}
