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

  const selectedPersona = PERSONAS[selectedPersonaId] || PERSONAS.warm;

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

  return (
    <div>
      {/* ERROR BANNER */}
      {errorMessage && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid var(--brand-error)',
            color: '#fca5a5',
            padding: '0.85rem 1.25rem',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{errorMessage}</span>
          <button
            onClick={() => setErrorMessage(null)}
            style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ========================================================= */}
      {/* 1. SETUP / PERSONA SELECTOR VIEW                         */}
      {/* ========================================================= */}
      {view === 'setup' && (
        <div>
          <section className="hero-section">
            <span className="hero-tag">ADHD Conversation Rehearsal</span>
            <h2 className="hero-heading">Talk to strangers without high stakes.</h2>
            <p className="hero-subheading">
              Pick a persona for a 3-minute live spoken conversation. Get objective feedback on airtime, pacing, and
              tangent recovery.
            </p>
          </section>

          <div className="persona-grid">
            {PERSONA_LIST.map((p) => {
              const isSelected = selectedPersonaId === p.id;
              return (
                <div
                  key={p.id}
                  className={`persona-card ${isSelected ? 'selected' : ''}`}
                  style={{ '--card-accent': p.accent }}
                  onClick={() => setSelectedPersonaId(p.id)}
                >
                  <div className="persona-card-header">
                    <div className="persona-avatar-preview">
                       <img src={p.avatarImage} alt={p.name} />
                    </div>
                    <div className="difficulty-group">
                      <span>Diff {p.difficulty}</span>
                      <div style={{ display: 'flex', gap: '3px' }}>
                        {[1, 2, 3, 4, 5].map((d) => (
                          <div key={d} className={`diff-dot ${d <= p.difficulty ? 'filled' : ''}`} />
                        ))}
                      </div>
                    </div>
                  </div>

                  <h3 className="persona-name">{p.name}</h3>
                  <p className="persona-blurb">{p.blurb}</p>
                  <div className="persona-context">Context: {p.context}</div>

                  <div className="persona-tags">
                    <div className="persona-tag-item">
                      <span className="tag-bullet">•</span>
                      <span>Video Avatar: {p.anamAvatarId}</span>
                    </div>
                    <div className="persona-tag-item">
                      <span className="tag-bullet">•</span>
                      <span>Max words: {p.policy.maxWords}</span>
                    </div>
                    {p.policy.interrupts && (
                      <div className="persona-tag-item">
                        <span className="tag-bullet" style={{ color: 'var(--brand-warning)' }}>
                          ⚠️
                        </span>
                        <span>Will interrupt after 7s monologue</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="start-action-card">
            <div>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                Ready to practice with {selectedPersona.name}?
              </h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {speechSupported
                  ? 'Microphone speech recognition and Anam Video Avatar are enabled.'
                  : 'Speech recognition not supported in this browser; text fallback enabled.'}
              </p>
            </div>
            <button className="btn-start" onClick={handleStartSession}>
              Start 3-Minute Practice Session
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 2. LIVE CONVERSATION VIEW                                 */}
      {/* ========================================================= */}
      {view === 'active' && (
        <div className="session-container">
          <div className="session-topbar">
            <div className="session-persona-pill">
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: selectedPersona.accent,
                }}
              />
              <span>Talking to {selectedPersona.name}</span>
            </div>
            <div className="timer-display">{formatTimer(secondsRemaining)}</div>
          </div>

          <div className="timer-progress-wrap">
            <div
              className="timer-progress-bar"
              style={{
                width: `${((180 - secondsRemaining) / 180) * 100}%`,
                background: selectedPersona.accent,
              }}
            />
          </div>

          {/* AVATAR STAGE */}
          <div className="avatar-stage" style={{ '--stage-accent': selectedPersona.accent }}>
            
            {/* ANAM VIDEO ELEMENT */}
            <div className="anam-video-container">
               <video id="anam-video" autoPlay playsInline />
            </div>

            {/* Floor Status Indicator */}
            <div className="live-floor-indicator">
              <span className={`floor-dot ${floorState}`} />
              <span>
                {floorState === 'persona'
                  ? `${selectedPersona.name} is speaking...`
                  : floorState === 'user'
                  ? 'Listening to you...'
                  : 'Floor open'}
              </span>
            </div>

            {interruptionAlert && (
              <div className="live-interruption-alert">⚠️ Interruption recorded: speaking over persona floor</div>
            )}

            {/* Transcript Stream */}
            <div className="transcript-feed">
              {turns.length === 0 && (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', margin: 'auto' }}>
                  Connecting to Anam Avatar...
                </div>
              )}
              {turns.map((t, idx) => (
                <div key={idx} className={`turn-bubble ${t.role}`}>
                  <div className="turn-bubble-role">{t.role === 'persona' ? selectedPersona.name : 'You'}</div>
                  <div>{t.text}</div>
                </div>
              ))}
            </div>

            {liveTranscript && (
              <div className="live-speech-preview">
                <em>Hearing: &ldquo;{liveTranscript}&rdquo;</em>
              </div>
            )}
          </div>

          {/* Typing Fallback & Controls */}
          <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
            <input
              type="text"
              placeholder="Or type what you would say..."
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualInput.trim()) {
                  handleUserTurnSubmit(manualInput);
                }
              }}
              style={{
                flex: 1,
                padding: '0.75rem 1rem',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-full)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-sans)',
              }}
            />
            <button
              onClick={() => {
                if (manualInput.trim()) handleUserTurnSubmit(manualInput);
              }}
              disabled={!manualInput.trim() || isProcessingTurn}
              style={{
                padding: '0.75rem 1.5rem',
                background: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-full)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Send
            </button>
          </div>

          <div className="session-controls">
            {speechSupported && (
              <button
                className={`btn-mic-toggle ${isListening ? 'active' : ''}`}
                onClick={isListening ? stopRecognition : startRecognition}
              >
                <span>{isListening ? '🎙️ Mic Active' : '🎙️ Enable Mic'}</span>
              </button>
            )}

            <button className="btn-end-session" onClick={handleFinishSession}>
              Finish &amp; Get Report
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 3. GENERATING REPORT SPINNER                              */}
      {/* ========================================================= */}
      {view === 'generating_report' && (
        <div style={{ textAlign: 'center', padding: '5rem 1.5rem' }}>
          <div className="live-dot" style={{ width: 16, height: 16, margin: '0 auto 1.5rem' }} />
          <h3 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Evaluating Conversation Signals
          </h3>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 450, margin: '0 auto' }}>
            Running Gemini semantic judge across transcript turns and computing objective pragmatic-language metrics...
          </p>
        </div>
      )}

      {/* ========================================================= */}
      {/* 4. POST-SESSION REPORT VIEW                               */}
      {/* ========================================================= */}
      {view === 'report' && reportData && (
        <div className="report-container">
          <div className="report-header">
            <div className="report-title-group">
              <h2>Session Performance Report</h2>
              <p>
                Practiced with <strong>{selectedPersona.name}</strong> •{' '}
                {Math.round((reportData.durationMs || 180000) / 1000)}s duration •{' '}
                {reportData.metrics?.counts?.userTurns || 0} user turns
              </p>
            </div>

            <div className="composite-score-badge">
              <div className="composite-num">
                {reportData.metrics?.composite !== null ? (reportData.metrics.composite * 100).toFixed(0) : '--'}
              </div>
              <div className="composite-label">Overall Index</div>
            </div>
          </div>

          {/* PRIMARY FOCUS CARD */}
          {reportData.focus && (
            <div className="focus-card">
              <div className="focus-card-header" style={{ marginBottom: '1rem' }}>
                <span style={{ 
                  background: 'var(--brand-primary)', color: '#000', padding: '0.2rem 0.6rem', 
                  borderRadius: 'var(--radius-full)', fontSize: '0.8rem', fontWeight: 700 
                }}>
                  Primary Growth Focus
                </span>
                <h3 style={{ marginTop: '0.5rem', fontSize: '1.3rem' }}>{reportData.focus.label}</h3>
              </div>
              <p style={{ lineHeight: 1.6 }}>{reportData.coaching}</p>
            </div>
          )}

          {/* 6 METRIC CARDS */}
          <div className="metrics-grid">
            {Object.keys(BANDS).map((metricKey) => {
              const b = BANDS[metricKey];
              const rawVal = reportData.metrics?.raw?.[metricKey];
              const score = reportData.metrics?.scores?.[metricKey];

              let formattedVal = '--';
              if (rawVal !== null && rawVal !== undefined) {
                if (metricKey === 'turnBalance' || metricKey === 'topicMaintenance' || metricKey === 'tangentRecovery' || metricKey === 'questionRatio') {
                  formattedVal = `${(rawVal * 100).toFixed(0)}%`;
                } else if (metricKey === 'interruptionsPerMin') {
                  formattedVal = `${rawVal.toFixed(1)} / min`;
                } else if (metricKey === 'medianLatencyMs') {
                  formattedVal = `${Math.round(rawVal)} ms`;
                }
              }

              let statusClass = 'good';
              if (score !== null && score !== undefined) {
                if (score < 0.4) statusClass = 'bad';
                else if (score < 0.75) statusClass = 'warn';
              }

              return (
                <div key={metricKey} className="metric-card">
                  <div className="metric-card-top">
                    <span className="metric-label">{b.label}</span>
                    <span className="metric-val">{formattedVal}</span>
                  </div>
                  
                  <div className="metric-meter">
                    <div 
                      className={`metric-meter-fill ${statusClass}`}
                      style={{ width: `${(score || 0) * 100}%` }}
                    />
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {statusClass === 'good' ? b.good : statusClass === 'warn' ? b.warn : b.bad}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="report-actions">
            <button className="btn-start" onClick={() => setView('setup')}>
              Return to Practice Setup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
