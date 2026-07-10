// api/session.js — 返回转写配置。API key 永远只待在服务端。
// 默认使用课堂高准确模式(gpt-4o-transcribe 分段上传)。
// 如需最低延迟流式字幕,可设置 ASR_MODE=realtime。
//
// 换 ASR 供应商:设置 Vercel 环境变量 ASR_PROVIDER = openai | deepgram | soniox
// 每个供应商一个 mint 函数,照着 mintOpenAI 的样子补全即可。

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const provider = (process.env.ASR_PROVIDER || 'openai').toLowerCase();

  try {
    let out;
    if (provider === 'openai') {
      const mode = String(process.env.ASR_MODE || 'accurate').toLowerCase();
      out = mode === 'realtime' ? await mintOpenAIRealtime() : openAIAccurateConfig();
    }
    else if (provider === 'deepgram') out = await mintDeepgram();
    else if (provider === 'soniox') out = await mintSoniox();
    else return res.status(400).json({ error: `unknown ASR_PROVIDER: ${provider}` });
    return res.status(200).json(out);
  } catch (e) {
    console.error('session mint failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

/* ---------------- OpenAI 高准确模式(默认) ---------------- */
function openAIAccurateConfig() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置(Vercel → Settings → Environment Variables)');

  const requestedModel = String(process.env.ASR_MODEL || '').trim();
  const allowed = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
  const model = allowed.has(requestedModel) ? requestedModel : 'gpt-4o-transcribe';

  return {
    provider: 'openai-accurate',
    mode: 'accurate',
    model,
    sampleRate: 16000,
    frameMs: 100,
    minSegmentMs: 4000,
    silenceMs: 1300,
    maxSegmentMs: 12000,
  };
}

/* ---------------- OpenAI Realtime(可选低延迟模式) ---------------- */
async function mintOpenAIRealtime() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置(Vercel → Settings → Environment Variables)');

  const model = 'gpt-realtime-whisper';
  const allowedDelays = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
  const requestedDelay = String(process.env.ASR_DELAY || 'high').toLowerCase();
  const delay = allowedDelays.has(requestedDelay) ? requestedDelay : 'high';
  const language = 'ja';

  const session = {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model, language, delay },
        // gpt-realtime-whisper 的 GA 模式由客户端提交音频段,不能沿用旧 Beta 的 server_vad。
        turn_detection: null,
      },
    },
  };

  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session }),
  });

  if (!r.ok) {
    const detail = (await r.text()).slice(0, 600);
    throw new Error(`OpenAI Realtime GA 创建会话失败(${r.status}): ${detail}`);
  }

  const data = await r.json();
  const token = data.value || (data.client_secret && data.client_secret.value);
  if (!token) throw new Error('返回体里没找到 ephemeral token,原始返回: ' + JSON.stringify(data).slice(0, 300));

  return {
    provider: 'openai-realtime',
    mode: 'realtime',
    token,
    model,
    language,
    delay,
    shape: 'ga',
    expiresAt: data.expires_at || (data.client_secret && data.client_secret.expires_at) || null,
    // GA 正式版必须是纯 /v1/realtime:不带 intent,也不带任何 Beta header/subprotocol。
    wsUrl: 'wss://api.openai.com/v1/realtime',
  };
}

/* ---------------- Deepgram(预留) ---------------- */
// Deepgram 支持临时 token:POST https://api.deepgram.com/v1/auth/grant
// 前端连 wss://api.deepgram.com/v1/listen?model=nova-3&language=ja...
async function mintDeepgram() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY 未配置');
  const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { Authorization: `Token ${key}` },
  });
  if (!r.ok) throw new Error('Deepgram grant 失败: ' + (await r.text()).slice(0, 300));
  const data = await r.json();
  return {
    provider: 'deepgram',
    token: data.access_token,
    model: process.env.ASR_MODEL || 'nova-3',
    wsUrl: 'wss://api.deepgram.com/v1/listen',
  };
}

/* ---------------- Soniox(预留) ---------------- */
async function mintSoniox() {
  throw new Error('Soniox 适配还没写:参照其文档的 temporary API key 端点,补全本函数并在前端 providers.js 加一个 Transcriber 类即可。');
}
