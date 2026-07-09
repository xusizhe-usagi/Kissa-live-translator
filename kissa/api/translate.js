// api/translate.js — 日语句子 → 中文。key 只在服务端。
// 前端 POST: { text, history: [{ja,zh}...], glossary: [{ja,zh,en}...], subject }
// 换翻译供应商:环境变量 TRANSLATE_PROVIDER = openai | anthropic | gemini
// 换模型:TRANSLATE_MODEL(默认 openai 用 gpt-4o-mini;你想用哪个 mini 模型就填哪个,比如你说的 5.4mini 的正式模型名)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, history = [], glossary = [], subject = '' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const provider = (process.env.TRANSLATE_PROVIDER || 'openai').toLowerCase();
  const { system, user } = buildPrompt(String(text), history, glossary, subject);

  try {
    let zh;
    if (provider === 'openai') zh = await callOpenAI(system, user);
    else if (provider === 'anthropic') zh = await callAnthropic(system, user);
    else if (provider === 'gemini') zh = await callGemini(system, user);
    else return res.status(400).json({ error: `unknown TRANSLATE_PROVIDER: ${provider}` });
    return res.status(200).json({ zh: (zh || '').trim() });
  } catch (e) {
    console.error('translate failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

function buildPrompt(text, history, glossary, subject) {
  const glossLines = glossary
    .slice(0, 40)
    .map((g) => `${g.ja} → ${g.zh}${g.en ? `(${g.en})` : ''}`)
    .join('\n');
  const historyLines = history
    .slice(-4)
    .map((h) => `日: ${h.ja}\n中: ${h.zh}`)
    .join('\n');

  const system = [
    '你是大学课堂的同声传译。把老师说的日语口语转成简洁、准确、书面化适中的中文字幕。',
    subject ? `当前课程:${subject}。这是期末考试重点讲评课,涉及考点、页码、章节、公式时务必翻准。` : '',
    '规则:',
    '1. 只输出译文本身,不要任何解释、引号或前缀。',
    '2. 专业术语严格按照下方术语表翻译;英文缩写(如 OLG、TFP、FOC、R&D)保留原样不翻。',
    '3. 语音识别可能有错字,按上下文和术语表纠正后再翻。',
    '4. 数字、页码、"第几章"、"会考/不考"这类信息绝对不能译错或漏掉。',
    '5. 口头语气词(えー、あのー等)直接省略。',
    glossLines ? `\n术语表:\n${glossLines}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    historyLines ? `前文(供参考,保持译名一致):\n${historyLines}\n` : '',
    `请翻译这句:\n${text}`,
  ].join('\n');

  return { system, user };
}

/* ---------------- OpenAI ---------------- */
async function callOpenAI(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置');
  const model = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content;
}

/* ---------------- Anthropic(预留,配好 key 即用) ---------------- */
async function callAnthropic(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY 未配置');
  const model = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

/* ---------------- Gemini(预留,配好 key 即用) ---------------- */
async function callGemini(system, user) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 未配置');
  const model = process.env.TRANSLATE_MODEL || 'gemini-2.5-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
      }),
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
}
