import { NextResponse } from 'next/server';

if (process.env.NODE_ENV !== 'production' && typeof process !== 'undefined') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { avatarId } = body;

    const response = await fetch('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig: {
          avatarId: avatarId || 'default-avatar-id',
          // We don't need voiceId or llmId because we are doing audio passthrough
          // where we send audio directly.
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anam Token Error:', errorText);
      return NextResponse.json({ error: 'Failed to generate token' }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Anam Token Exception:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
