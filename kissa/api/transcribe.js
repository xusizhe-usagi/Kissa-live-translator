// api/transcribe.js — 课堂高准确转写。
// 浏览器按完整语句上传 16kHz PCM WAV；服务端调用 gpt-4o-transcribe。
// 前端 POST: { audio: <base64 WAV>, prompt?: string, previous?: string }

export const config = {
  api: { bodyParser: { sizeLimit: '3mb' } },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY 未配置' });

  const { audio, prompt = '', previous = '' } = req.body || {};
  if (!audio || typeof audio !== 'string') return res.status(400).json({ error: 'audio required' });
  if (audio.length > 2_800_000) return res.status(413).json({ error: '音频分段过大' });

  let wav;
  try {
    wav = Buffer.from(audio, 'base64');
  } catch {
    return res.status(400).json({ error: 'audio base64 无效' });
  }
  if (wav.length < 48 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return res.status(400).json({ error: '音频不是有效 WAV' });
  }

  const requestedModel = String(process.env.ASR_MODEL || '').trim();
  const model = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']).has(requestedModel)
    ? requestedModel
    : 'gpt-4o-transcribe';

  // 官方建议：分段音频把上一段转写放进 prompt，可保持上下文；术语表也放在这里。
  const contextPrompt = [
    'これは日本語の大学講義です。実際に聞こえる発話を、自然な句読点を付けて正確に書き起こしてください。',
    String(prompt || '').trim(),
    previous ? `直前の書き起こし：${String(previous).slice(-600)}` : '',
  ].filter(Boolean).join('\n').slice(0, 1800);

  try {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'classroom-segment.wav');
    form.append('model', model);
    form.append('language', 'ja');
    form.append('response_format', 'json');
    if (contextPrompt) form.append('prompt', contextPrompt);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${raw.slice(0, 600)}`);

    let data;
    try { data = JSON.parse(raw); }
    catch { data = { text: raw }; }
    return res.status(200).json({ text: String(data.text || '').trim(), model });
  } catch (e) {
    console.error('transcribe failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
