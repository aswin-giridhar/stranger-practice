// Thin Gemini REST client. Deliberately no SDK: npm installs on this machine's /mnt/* mount
// are slow, and every dependency is another thing that can break the deploy.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

if (process.env.NODE_ENV !== 'production' && typeof process !== 'undefined') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

// Free-tier request quota is metered PER MODEL (the 429 body names the model it applies
// to). So a rate-limited primary does not mean we are out of capacity -- a different model
// has its own untouched bucket. Measured today: gemini-2.5-flash returned 429 while
// gemini-3-flash-preview answered normally on the same key, seconds apart.
//
// This is a stopgap for a free-tier key, not a substitute for billing. It buys headroom;
// it does not create capacity that isn't there.
const TEXT_FALLBACKS = (process.env.GEMINI_TEXT_FALLBACKS || 'gemini-3-flash-preview,gemini-3.1-flash-lite')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

/** Models to try in order: the configured primary, then each distinct fallback. */
function textModelChain() {
  return [TEXT_MODEL, ...TEXT_FALLBACKS.filter((m) => m !== TEXT_MODEL)];
}

/** A 429 is the only error worth trying another model for. Anything else is our bug. */
function isRateLimited(err) {
  return err?.status === 429;
}

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    // Absent config and a broken upstream must not look the same to callers.
    const e = new Error('GEMINI_API_KEY is not configured');
    e.code = 'CONFIG_MISSING';
    throw e;
  }
  return k;
}

async function call(model, body) {
  const res = await fetch(`${BASE}/${model}:generateContent?key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // A 200 with a non-JSON body is an upstream problem, not an empty result.
    const e = new Error(`Gemini returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    e.code = 'UPSTREAM_MALFORMED';
    throw e;
  }
  if (!res.ok || data.error) {
    const e = new Error(data.error?.message || `Gemini HTTP ${res.status}`);
    e.code = 'UPSTREAM_ERROR';
    e.status = res.status;
    throw e;
  }
  return data;
}

/** Generate a persona turn. Returns plain text. */
/**
 * Try each model in the chain, moving on ONLY when rate-limited. The model that actually
 * answered is returned alongside the payload so callers can report it truthfully rather
 * than reporting the one we intended to use.
 */
async function callText(body) {
  const chain = textModelChain();
  let lastErr;
  for (const model of chain) {
    try {
      const data = await call(model, body);
      return { data, model };
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
    }
  }
  lastErr.triedModels = chain;
  throw lastErr;
}

export async function generateText({ system, history, maxOutputTokens = 300, temperature = 0.9 }) {
  const { data } = await callText({
    systemInstruction: { parts: [{ text: system }] },
    contents: history,
    generationConfig: { temperature, maxOutputTokens, topP: 0.95 },
  });
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ');
  if (!text || !text.trim()) {
    const e = new Error('Gemini returned no text content');
    e.code = 'UPSTREAM_EMPTY';
    e.detail = data?.candidates?.[0]?.finishReason || 'unknown';
    throw e;
  }
  return text.trim();
}

/** Structured JSON out of Gemini, schema-constrained so we do not parse prose. */
export async function generateJson({ system, prompt, schema, temperature = 0.2 }) {
  const { data } = await callText({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('Gemini JSON mode returned unparseable output');
    e.code = 'UPSTREAM_MALFORMED';
    throw e;
  }
}

/**
 * Gemini native TTS. Returns a browser-playable WAV as a base64 string.
 * The API hands back raw 24kHz mono 16-bit PCM with no container, so we prepend a
 * WAV header ourselves -- without it browsers refuse to play the bytes.
 */
export async function synthesizeSpeech({ text, voice = 'Kore' }) {
  const data = await call(TTS_MODEL, {
    contents: [{ parts: [{ text: `Read aloud: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });

  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) {
    const e = new Error('Gemini TTS returned no audio payload');
    e.code = 'UPSTREAM_EMPTY';
    throw e;
  }
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  return { wavBase64: wrapPcmAsWav(pcm, rate).toString('base64'), sampleRate: rate, bytes: pcm.length };
}

export function wrapPcmAsWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
