// api/session.js — 给浏览器发放短时效令牌,真正的 API key 永远只待在服务端。
// 前端 POST /api/session → { provider, token, model, language, delay, wsUrl }
//
// 换 ASR 供应商:设置 Vercel 环境变量 ASR_PROVIDER = openai | deepgram | soniox
// 每个供应商一个 mint 函数,照着 mintOpenAI 的样子补全即可。

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const provider = (process.env.ASR_PROVIDER || 'openai').toLowerCase();

  try {
    let out;
    if (provider === 'openai') out = await mintOpenAI();
    else if (provider === 'deepgram') out = await mintDeepgram();
    else if (provider === 'soniox') out = await mintSoniox();
    else return res.status(400).json({ error: `unknown ASR_PROVIDER: ${provider}` });
    return res.status(200).json(out);
  } catch (e) {
    console.error('session mint failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

/* ---------------- OpenAI Realtime(转写模式) ---------------- */
// 2026-07 GA:实时流式转写使用 gpt-realtime-whisper。
// gpt-4o-transcribe / gpt-4o-mini-transcribe 属于请求式转写,不能再当作 Realtime 模型。
async function mintOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置(Vercel → Settings → Environment Variables)');

  const requestedModel = String(process.env.ASR_MODEL || '').trim();
  const requestOnlyModels = new Set([
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'whisper-1',
  ]);
  // 兼容兔子在 Vercel 里可能残留的旧 ASR_MODEL,避免升级后还要手工删变量。
  const model = !requestedModel || requestOnlyModels.has(requestedModel)
    ? 'gpt-realtime-whisper'
    : requestedModel;
  const allowedDelays = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
  const requestedDelay = String(process.env.ASR_DELAY || 'low').toLowerCase();
  const delay = allowedDelays.has(requestedDelay) ? requestedDelay : 'low';
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
    provider: 'openai',
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
