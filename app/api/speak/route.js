import { NextResponse } from 'next/server';
import { synthesizeSpeech, TTS_MODEL } from '@/lib/gemini';
import { getPersona } from '@/lib/personas';
import { logEvent } from '@/lib/logstore';

export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { text, personaId, sessionId } = body;

    if (!text || !personaId) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'text and personaId are required' } },
        { status: 400 }
      );
    }

    const persona = getPersona(personaId);
    const startMs = Date.now();

    const { wavBase64, sampleRate, bytes } = await synthesizeSpeech({
      text,
      voice: persona.voice || 'Kore',
    });

    const latencyMs = Date.now() - startMs;

    await logEvent({
      sessionId,
      kind: 'synthesize_speech',
      payload: {
        personaId,
        voice: persona.voice,
        textLength: text.length,
        bytes,
        latencyMs,
      },
    });

    return NextResponse.json({
      wavBase64,
      sampleRate,
      bytes,
      voice: persona.voice,
      model: TTS_MODEL,
      latencyMs,
    });
  } catch (err) {
    console.error('Speech synthesis failed:', err);
    return NextResponse.json(
      {
        error: {
          code: err.code || 'UPSTREAM_ERROR',
          message: err.message || 'Failed to synthesize speech',
        },
      },
      { status: err.status || 500 }
    );
  }
}
