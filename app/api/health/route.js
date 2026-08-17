import { NextResponse } from 'next/server';
import { generateText, synthesizeSpeech, TEXT_MODEL, TTS_MODEL } from '@/lib/gemini';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checkedAt = new Date().toISOString();
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '240181611094';

  let geminiResult = { ok: false, model: TEXT_MODEL, latencyMs: 0, sample: null };
  let geminiTtsResult = { ok: false, model: TTS_MODEL, voice: 'Kore', latencyMs: 0, audioBytes: 0 };
  let firestoreResult = { ok: false, configured: false };

  // 1. Test Text Generation
  const textStart = Date.now();
  try {
    const text = await generateText({
      system: 'You are a test probe. Respond in under 5 words.',
      history: [{ role: 'user', parts: [{ text: 'Ping' }] }],
      maxOutputTokens: 150,
    });
    geminiResult = {
      ok: true,
      model: TEXT_MODEL,
      latencyMs: Date.now() - textStart,
      sample: (text || '').slice(0, 80),
    };
  } catch (err) {
    geminiResult = {
      ok: false,
      model: TEXT_MODEL,
      latencyMs: Date.now() - textStart,
      sample: null,
      error: { code: err.code || 'UPSTREAM_ERROR', message: err.message },
    };
  }

  // 2. Test TTS Synthesis
  const ttsStart = Date.now();
  try {
    const tts = await synthesizeSpeech({
      text: 'Testing audio probe.',
      voice: 'Kore',
    });
    geminiTtsResult = {
      ok: true,
      model: TTS_MODEL,
      voice: 'Kore',
      latencyMs: Date.now() - ttsStart,
      audioBytes: tts.bytes || 0,
    };
  } catch (err) {
    geminiTtsResult = {
      ok: false,
      model: TTS_MODEL,
      voice: 'Kore',
      latencyMs: Date.now() - ttsStart,
      audioBytes: 0,
      error: { code: err.code || 'UPSTREAM_ERROR', message: err.message },
    };
  }

  const ok = geminiResult.ok && geminiTtsResult.ok;

  const responseBody = {
    ok,
    checkedAt,
    gemini: geminiResult,
    geminiTts: geminiTtsResult,
    firestore: firestoreResult,
    googleCloudProject: projectNumber,
  };

  return NextResponse.json(responseBody, { status: ok ? 200 : 503 });
}
