import { NextResponse } from 'next/server';
import { generateText, TEXT_MODEL } from '@/lib/gemini';
import { getPersona, enforceWordCap } from '@/lib/personas';
import { logEvent } from '@/lib/logstore';

export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { personaId, sessionId, turns = [], secondsRemaining } = body;

    if (!personaId) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'personaId is required' } },
        { status: 400 }
      );
    }

    const persona = getPersona(personaId);
    const startMs = Date.now();

    // Determine if this turn requires a topic shift
    const personaTurnCount = turns.filter((t) => t.role === 'persona').length;
    let topicShiftInstruction = '';
    if (
      persona.policy.topicShiftEveryTurns > 0 &&
      personaTurnCount > 0 &&
      personaTurnCount % persona.policy.topicShiftEveryTurns === 0
    ) {
      topicShiftInstruction = ' INSTRUCTION FOR THIS TURN: Abruptly and briefly change the subject to a different mundane topic.';
    }

    // Build history for Gemini
    const history = [];
    for (const turn of turns) {
      if (turn.role === 'user') {
        history.push({ role: 'user', parts: [{ text: turn.text }] });
      } else if (turn.role === 'persona') {
        history.push({ role: 'model', parts: [{ text: turn.text }] });
      }
    }

    // If turns are empty (initial start), seed with an opener prompt
    if (history.length === 0) {
      history.push({
        role: 'user',
        parts: [{ text: `[Session starting in context: ${persona.context}. Make a brief opening remark as a stranger.]` }],
      });
    }

    const systemPrompt = persona.system + topicShiftInstruction;
    const rawText = await generateText({
      system: systemPrompt,
      history,
      maxOutputTokens: 100,
      temperature: 0.85,
    });

    const processedText = enforceWordCap(rawText, persona.policy.maxWords);
    const latencyMs = Date.now() - startMs;

    await logEvent({
      sessionId,
      kind: 'persona_turn',
      payload: {
        personaId,
        rawText,
        processedText,
        latencyMs,
        turnIndex: turns.length,
        secondsRemaining,
      },
    });

    return NextResponse.json({
      text: processedText,
      personaId,
      model: TEXT_MODEL,
      latencyMs,
      policy: {
        silenceToleranceMs: persona.policy.silenceToleranceMs,
        interruptAfterMs: persona.policy.interruptAfterMs,
        interrupts: persona.policy.interrupts,
      },
    });
  } catch (err) {
    console.error('Turn generation failed:', err);
    return NextResponse.json(
      {
        error: {
          code: err.code || 'UPSTREAM_ERROR',
          message: err.message || 'Failed to generate persona turn',
        },
      },
      { status: err.status || 500 }
    );
  }
}
