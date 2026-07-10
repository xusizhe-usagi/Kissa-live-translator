// api/session.js — 给浏览器发放"短时效令牌",真正的 API key 永远只待在这里(服务端)。
// 前端 POST /api/session { asrPrompt?: string } → { provider, token, model, wsUrl }
//
// 换 ASR 供应商:设置 Vercel 环境变量 ASR_PROVIDER = openai | deepgram | soniox
// 每个供应商一个 mint 函数,照着 mintOpenAI 的样子补全即可。

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provider = (process.env.ASR_PROVIDER || 'openai').toLowerCase();
  const asrPrompt = (req.body && req.body.asrPrompt ? String(req.body.asrPrompt) : '').slice(0, 800);

  try {
    let out;
    if (provider === 'openai') out = await mintOpenAI(asrPrompt);
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
// 模型可用环境变量 ASR_MODEL 覆盖,例如 gpt-4o-transcribe / gpt-4o-mini-transcribe
// 或你账号里更新的转写模型名。
async function mintOpenAI(asrPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置(Vercel → Settings → Environment Variables)');
  const model = process.env.ASR_MODEL || 'gpt-4o-transcribe';

  const transcriptionCfg = {
    model,
    language: 'ja',
    prompt: asrPrompt || undefined,
  };

  // GA 正式版 client_secrets 端点(Beta 已被 OpenAI 关停,不再兜底)
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: transcriptionCfg,
            turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
            noise_reduction: { type: 'far_field' },
          },
        },
      },
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI client_secrets ${r.status}: ${t.slice(0, 400)}`);
  }

  const data = await r.json();
  const token = data.value || (data.client_secret && data.client_secret.value);
  if (!token) throw new Error('返回体里没找到 ephemeral token,原始返回: ' + JSON.stringify(data).slice(0, 300));

  return {
    provider: 'openai',
    token,
    model,
    shape: 'ga',
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
