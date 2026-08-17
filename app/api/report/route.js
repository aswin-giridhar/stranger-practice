import { NextResponse } from 'next/server';
import { generateJson } from '@/lib/gemini';
import { computeMetrics, weakestMetric } from '@/lib/metrics';
import { logSession } from '@/lib/logstore';

export const runtime = 'nodejs';

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    turnJudgments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          turnIndex: { type: 'INTEGER' },
          onTopic: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
        },
        required: ['turnIndex', 'onTopic'],
      },
    },
    coaching: { type: 'STRING' },
  },
  required: ['turnJudgments', 'coaching'],
};

export async function POST(req) {
  try {
    const body = await req.json();
    const { sessionId, personaId, durationMs = 180000, turns = [] } = body;

    if (!sessionId || !personaId) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'sessionId and personaId are required' } },
        { status: 400 }
      );
    }

    // Step 1: Gemini semantic judge for on-topic turn labeling and coaching
    const userTurnIndices = [];
    const transcriptLines = turns.map((t, idx) => {
      if (t.role === 'user') userTurnIndices.push(idx);
      return `Turn ${idx} [${t.role.toUpperCase()}]: ${t.text}`;
    });

    let judged = false;
    let coaching = 'Keep practising conversation pacing and staying aware of active turns.';
    const annotatedTurns = turns.map((t) => ({ ...t }));

    if (userTurnIndices.length > 0) {
      const judgeSystem = [
        'You are an expert conversation analyst evaluating a casual conversation practice session with an adult.',
        'Your job is strictly educational and non-clinical. Do not diagnose, judge character, or offer therapy.',
        'Evaluate whether each USER turn is on-topic relative to the flow of conversation up to that point.',
        'Provide 2-3 concise, actionable sentences of warm, plain-language conversational coaching focused on one constructive habit.',
      ].join(' ');

      const judgePrompt = [
        'Here is the conversation transcript:',
        transcriptLines.join('\n'),
        '',
        `Judge each user turn (indices: ${userTurnIndices.join(', ')}) for onTopic (true/false), and provide 2-3 sentences of constructive coaching.`,
      ].join('\n');

      try {
        const judgeResult = await generateJson({
          system: judgeSystem,
          prompt: judgePrompt,
          schema: JUDGE_SCHEMA,
          temperature: 0.2,
        });

        if (judgeResult && Array.isArray(judgeResult.turnJudgments)) {
          const map = new Map();
          for (const item of judgeResult.turnJudgments) {
            map.set(item.turnIndex, Boolean(item.onTopic));
          }
          for (const idx of userTurnIndices) {
            if (map.has(idx)) {
              annotatedTurns[idx].onTopic = map.get(idx);
            } else {
              annotatedTurns[idx].onTopic = true;
            }
          }
          if (judgeResult.coaching) {
            coaching = judgeResult.coaching;
          }
          judged = true;
        }
      } catch (judgeErr) {
        console.warn('Gemini topic judge failed, falling back to unjudged metrics:', judgeErr);
        judged = false;
      }
    }

    // Step 2: Deterministic metric computation in code
    const metrics = computeMetrics(annotatedTurns, { durationMs });
    const focus = weakestMetric(metrics);

    const sessionRecord = {
      sessionId,
      personaId,
      durationMs,
      turns: annotatedTurns,
      metrics,
      focus,
      coaching,
      judged,
    };

    const logged = await logSession(sessionRecord);

    return NextResponse.json({
      sessionId,
      personaId,
      durationMs,
      metrics,
      focus,
      coaching,
      judged,
      logId: logged?.logId || null,
    });
  } catch (err) {
    console.error('Report generation failed:', err);
    return NextResponse.json(
      {
        error: {
          code: err.code || 'UPSTREAM_ERROR',
          message: err.message || 'Failed to generate report',
        },
      },
      { status: err.status || 500 }
    );
  }
}
