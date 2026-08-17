import { NextResponse } from 'next/server';
import { generateText, synthesizeSpeech, TEXT_MODEL, TTS_MODEL } from '@/lib/gemini';
import { logEvent, getStoreStatus } from '@/lib/logstore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checkedAt = new Date().toISOString();
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '240181611094';

  let geminiResult = { ok: false, model: TEXT_MODEL, latencyMs: 0, sample: null };
  let geminiTtsResult = { ok: false, model: TTS_MODEL, voice: 'Kore', latencyMs: 0, audioBytes: 0 };
  // Actually write something. This field used to be hardcoded false, which meant the
  // health check reported on storage without ever touching it -- a probe that cannot pass
  // is not measuring anything.
  let firestoreResult = { ok: false, configured: false };
  const storeStart = Date.now();
  try {
    const status = getStoreStatus();
    await logEvent({
      sessionId: 'health-probe',
      kind: 'health_check',
      payload: { checkedAt, source: 'api/health' },
    });
    firestoreResult = {
      ok: status.backend === 'firestore',
      configured: status.backend === 'firestore',
      backend: status.backend,
      projectId: status.projectId || null,
      database: status.database || null,
      latencyMs: Date.now() - storeStart,
      // A JSONL fallback is a working store, but it is NOT durable on serverless and is
      // not the Google Cloud product. Say which one actually ran.
      note: status.backend === 'firestore' ? undefined : 'Falling back to local JSONL; not durable on Vercel.',
    };
  } catch (err) {
    firestoreResult = {
      ok: false,
      configured: true,
      latencyMs: Date.now() - storeStart,
      error: { code: err?.code || 'UPSTREAM_ERROR', message: String(err?.message || err).slice(0, 200) },
    };
  }

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
