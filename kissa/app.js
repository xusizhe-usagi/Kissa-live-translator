// app.js — 喫茶マクロ同声传译 主逻辑
'use strict';

/* ========== 小工具:安全存储(claude/隐私模式等环境没有 localStorage 也不崩) ========== */
const store = {
  mem: {},
  get(k, def) {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
    catch { return this.mem[k] !== undefined ? this.mem[k] : def; }
  },
  set(k, v) {
    this.mem[k] = v;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

/* ========== IndexedDB:录音分片落盘,页面崩了录音也在 ========== */
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('kissa-rec', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('chunks', { autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async addChunk(blob) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').add(blob);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async allChunks() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const out = [];
      const tx = db.transaction('chunks', 'readonly');
      tx.objectStore('chunks').openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); } else res(out);
      };
      tx.onerror = () => rej(tx.error);
    });
  },
  async clear() {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').clear();
      tx.oncomplete = res;
    });
  },
};

/* ========== 术语表系统 ========== */
// 结构:{ 学科名: { terms: [{ja, zh, en, p, al:[]}], builtin? } },存 localStorage
const Glossary = {
  key: 'kissa.glossaries.v1',
  all() {
    const saved = store.get(this.key, {});
    return Object.assign({}, window.KISSA_BUILTIN_GLOSSARIES || {}, saved);
  },
  save(name, terms) {
    const saved = store.get(this.key, {});
    saved[name] = { terms };
    store.set(this.key, saved);
  },
  remove(name) {
    const saved = store.get(this.key, {});
    delete saved[name];
    store.set(this.key, saved);
  },
  current() {
    const name = store.get('kissa.subject', '宏观经济学');
    const g = this.all()[name];
    return { name, terms: (g && g.terms) || [] };
  },
  // 命中检测:这句日语里出现了哪些术语(含别名),按优先级排序,最多 40 条
  hits(jaText) {
    const { terms } = this.current();
    const out = [];
    for (const t of terms) {
      const keys = [t.ja, ...(t.al || [])].filter(Boolean);
      if (keys.some((k) => k.length >= 2 && jaText.includes(k))) out.push(t);
    }
    out.sort((a, b) => (a.p || 3) - (b.p || 3));
    return out.slice(0, 40).map((t) => ({ ja: t.ja, zh: t.zh, en: t.en }));
  },
  // ASR 提示词:高频考试词优先,控制在 ~700 字符
  asrPrompt() {
    const { name, terms } = this.current();
    const base = `大学の${name}の講義です。期末試験の重点を説明しています。`;
    if (!terms.length) return base; // 空术语表:只给课堂背景,不挂空的専門用語
    const sorted = [...terms].sort((a, b) => (a.p || 3) - (b.p || 3));
    let s = base + '専門用語：';
    for (const t of sorted) {
      const piece = t.ja + (t.en ? `(${t.en})` : '') + '、';
      if (s.length + piece.length > 700) break;
      s += piece;
    }
    return s;
  },
  // 导入:支持 app_lexicon_import.json / 简化 JSON / CSV / "日语=中文" 文本
  parseImport(filename, text) {
    if (filename.endsWith('.json')) {
      const d = JSON.parse(text);
      const records = d.records || d.terms || (Array.isArray(d) ? d : null);
      if (!records) throw new Error('JSON 里找不到 records/terms 数组');
      return records.map((r) => ({
        ja: r.term_ja || r.ja, zh: r.term_zh || r.zh || '', en: r.term_en || r.en || '',
        p: r.priority || r.p || 3,
        al: (r.aliases_ja || []).concat(r.aliases_en || []).concat(r.al || []),
      })).filter((t) => t.ja);
    }
    if (filename.endsWith('.csv')) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const header = lines[0].split(',').map((h) => h.replace(/^\uFEFF/, '').trim());
      const iJa = header.findIndex((h) => /term_ja|^ja$|日/.test(h));
      const iZh = header.findIndex((h) => /term_zh|^zh$|中/.test(h));
      const iEn = header.findIndex((h) => /term_en|^en$|英/.test(h));
      const iP = header.findIndex((h) => /priority|^p$/.test(h));
      if (iJa < 0) throw new Error('CSV 表头里找不到日语列(term_ja/ja/日语)');
      return lines.slice(1).map((l) => {
        const c = splitCsvLine(l);
        return { ja: c[iJa], zh: iZh >= 0 ? c[iZh] : '', en: iEn >= 0 ? c[iEn] : '', p: iP >= 0 ? +c[iP] || 3 : 3, al: [] };
      }).filter((t) => t.ja);
    }
    // 纯文本:每行 "日语=中文" 或 "日语,中文"
    return text.split(/\r?\n/).map((l) => {
      const m = l.split(/[=,，\t]/);
      return m[0] && m[0].trim() ? { ja: m[0].trim(), zh: (m[1] || '').trim(), en: (m[2] || '').trim(), p: 2, al: [] } : null;
    }).filter(Boolean);
  },
};

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ========== 全局状态 ========== */
const S = {
  running: false,
  transcriber: null,
  stream: null,
  recorder: null,
  lines: [],            // {t, ja, zh}
  partial: '',
  startedAt: 0,
  reconnectAttempts: 0,
  wakeLock: null,
  translateQueue: Promise.resolve(),
};

const $ = (id) => document.getElementById(id);

/* ========== 启动 / 停止 ========== */
async function startSession() {
  if (S.running) return;
  setStatus('connecting', '连接中…');
  try {
    // 恢复上次未导出的字幕(同一天内)
    const saved = store.get('kissa.session', null);
    if (saved && saved.lines && saved.lines.length && Date.now() - saved.at < 12 * 3600e3 && S.lines.length === 0) {
      if (confirm(`发现上次留下的 ${saved.lines.length} 条字幕,要接着用吗?(取消=清空重来)`)) {
        S.lines = saved.lines;
        renderAllLines();
      } else {
        store.set('kissa.session', null);
      }
    }

    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });

    await connectASR();
    startRecorder();
    acquireWakeLock();

    S.running = true;
    S.startedAt = S.startedAt || Date.now();
    $('btnMain').textContent = '停止';
    $('btnMain').classList.add('stop');
    tickTimer();
  } catch (e) {
    setStatus('error', '启动失败');
    toast('启动失败:' + e.message);
    cleanup();
  }
}

async function connectASR() {
  const r = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const session = await r.json();
  if (!r.ok) throw new Error(session.error || 'session 接口失败');
  // 高准确模式会把术语表和上一段字幕一起交给 gpt-4o-transcribe。
  session.asrPrompt = Glossary.asrPrompt();

  S.transcriber = window.KissaProviders.createTranscriber(session.provider, {
    onPartial: (text, replace = false) => {
      S.partial = replace ? text : S.partial + text;
      $('partialJa').textContent = S.partial;
    },
    onFinal: (text) => {
      S.partial = '';
      $('partialJa').textContent = '';
      addLine(text);
    },
    onState: (st) => {
      if (st === 'live') {
        S.reconnectAttempts = 0;
        setStatus('live', session.mode === 'accurate' ? '高准确同传中' : '低延迟同传中');
      }
      else if (st === 'dropped') scheduleReconnect();
      else if (st === 'idle') setStatus('idle', '待机');
    },
    onError: (msg) => { console.error(msg); toast(msg); },
    onLevel: (lv) => updateLevel(lv),
  });
  await S.transcriber.start(session, S.stream);
}

function scheduleReconnect() {
  if (!S.running) return;
  S.reconnectAttempts++;
  const wait = Math.min(1000 * Math.pow(1.6, S.reconnectAttempts), 10000);
  setStatus('reconnecting', `重连中(第${S.reconnectAttempts}次)`);
  setTimeout(async () => {
    if (!S.running) return;
    try { await connectASR(); }
    catch (e) { console.error(e); scheduleReconnect(); }
  }, wait);
}

function stopSession() {
  S.running = false;
  cleanup();
  setStatus('idle', '已停止');
  $('btnMain').textContent = '开始同传';
  $('btnMain').classList.remove('stop');
  persistSession();
  toast('已停止。记得导出字幕和录音。');
}

function cleanup() {
  try { S.transcriber && S.transcriber.stop(); } catch {}
  try { S.recorder && S.recorder.state !== 'inactive' && S.recorder.stop(); } catch {}
  try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { S.wakeLock && S.wakeLock.release(); } catch {}
  S.transcriber = null; S.recorder = null; S.stream = null; S.wakeLock = null;
}

/* ========== 录音(与转写并行,IndexedDB 落盘) ========== */
function startRecorder() {
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  S.recMime = S.recorder.mimeType || 'audio/webm';
  S.recorder.ondataavailable = (e) => { if (e.data && e.data.size) idb.addChunk(e.data).catch(console.error); };
  S.recorder.start(10000); // 每 10 秒落一片
}

async function exportRecording() {
  const chunks = await idb.allChunks();
  if (!chunks.length) return toast('还没有录音数据');
  const ext = (S.recMime || 'audio/webm').includes('mp4') ? 'm4a' : 'webm';
  downloadBlob(new Blob(chunks, { type: S.recMime || 'audio/webm' }), `课堂录音_${stamp()}.${ext}`);
}

/* ========== 字幕 ========== */
function addLine(ja) {
  const line = { t: Date.now(), ja, zh: '…' };
  S.lines.push(line);
  renderLine(line);
  persistSession();

  // 串行翻译,保持顺序
  S.translateQueue = S.translateQueue.then(async () => {
    try {
      const history = S.lines.filter((l) => l.zh && l.zh !== '…').slice(-4).map((l) => ({ ja: l.ja, zh: l.zh }));
      const r = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ja,
          history,
          glossary: Glossary.hits(ja),
          subject: Glossary.current().name,
        }),
      });
      const data = await r.json();
      line.zh = r.ok ? data.zh : '[翻译失败]';
    } catch (e) {
      line.zh = '[翻译失败]';
    }
    updateLineZh(line);
    persistSession();
  });
}

function renderLine(line) {
  const el = document.createElement('div');
  el.className = 'line';
  el.dataset.t = line.t;
  el.innerHTML = `<div class="ja"></div><div class="zh"></div>`;
  el.querySelector('.ja').textContent = line.ja;
  el.querySelector('.zh').textContent = line.zh;
  $('subtitles').appendChild(el);
  autoScroll();
}

function updateLineZh(line) {
  const el = $('subtitles').querySelector(`[data-t="${line.t}"] .zh`);
  if (el) el.textContent = line.zh;
  autoScroll();
}

function renderAllLines() {
  $('subtitles').innerHTML = '';
  S.lines.forEach(renderLine);
}

function autoScroll() {
  const box = $('stage');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
}

function persistSession() {
  store.set('kissa.session', { at: Date.now(), lines: S.lines });
}

/* ========== 导出 ========== */
function fmtTime(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}
function srtTime(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},${pad(ms % 1000, 3)}`;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function exportTxt() {
  if (!S.lines.length) return toast('还没有字幕');
  const txt = S.lines.map((l) => `[${fmtTime(l.t)}]\n日 ${l.ja}\n中 ${l.zh}\n`).join('\n');
  downloadBlob(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `字幕_${stamp()}.txt`);
}
function exportSrt() {
  if (!S.lines.length) return toast('还没有字幕');
  const base = S.lines[0].t;
  const srt = S.lines.map((l, i) => {
    const st = l.t - base;
    const en = (S.lines[i + 1] ? S.lines[i + 1].t : l.t + 4000) - base;
    return `${i + 1}\n${srtTime(st)} --> ${srtTime(en)}\n${l.ja}\n${l.zh}\n`;
  }).join('\n');
  downloadBlob(new Blob([srt], { type: 'text/plain;charset=utf-8' }), `字幕_${stamp()}.srt`);
}
function exportJson() {
  if (!S.lines.length) return toast('还没有字幕');
  downloadBlob(new Blob([JSON.stringify(S.lines, null, 2)], { type: 'application/json' }), `字幕_${stamp()}.json`);
}
async function copyAll() {
  if (!S.lines.length) return toast('还没有字幕');
  const txt = S.lines.map((l) => `${l.ja}\n${l.zh}`).join('\n\n');
  try { await navigator.clipboard.writeText(txt); toast('已复制全部字幕'); }
  catch { toast('复制失败,请用导出按钮'); }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ========== Wake Lock / 计时 / 状态 ========== */
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      S.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running) acquireWakeLock();
});

function tickTimer() {
  if (!S.running) return;
  const s = Math.floor((Date.now() - S.startedAt) / 1000);
  $('timer').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  setTimeout(tickTimer, 1000);
}

function setStatus(kind, text) {
  const dot = $('statusDot');
  dot.className = 'dot ' + kind;
  $('statusText').textContent = text;
}

let levelRaf = null;
function updateLevel(lv) {
  if (levelRaf) return;
  levelRaf = requestAnimationFrame(() => {
    $('level').style.transform = `scaleX(${Math.min(1, lv * 8)})`;
    levelRaf = null;
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* ========== 术语表 UI ========== */
function refreshSubjectSelect() {
  const sel = $('subjectSelect');
  const all = Glossary.all();
  const cur = store.get('kissa.subject', '宏观经济学');
  sel.innerHTML = '';
  Object.keys(all).forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = `${name}(${all[name].terms.length}词)`;
    if (name === cur) o.selected = true;
    sel.appendChild(o);
  });
}

function openGlossaryPanel() {
  refreshSubjectSelect();
  const { name, terms } = Glossary.current();
  $('glossaryText').value = terms.map((t) => `${t.ja}=${t.zh}${t.en ? '=' + t.en : ''}`).join('\n');
  $('glossaryPanel').classList.add('open');
}

function bindUI() {
  $('btnMain').onclick = () => (S.running ? stopSession() : startSession());
  $('btnGlossary').onclick = openGlossaryPanel;
  $('btnCloseGlossary').onclick = () => $('glossaryPanel').classList.remove('open');
  $('btnTxt').onclick = exportTxt;
  $('btnSrt').onclick = exportSrt;
  $('btnJson').onclick = exportJson;
  $('btnCopy').onclick = copyAll;
  $('btnRec').onclick = exportRecording;
  $('btnClear').onclick = async () => {
    if (!confirm('清空本机的字幕和录音缓存?(导出过的文件不受影响)')) return;
    S.lines = []; renderAllLines(); store.set('kissa.session', null);
    await idb.clear(); toast('已清空');
  };

  $('subjectSelect').onchange = (e) => { store.set('kissa.subject', e.target.value); openGlossaryPanel(); };

  $('btnNewSubject').onclick = () => {
    const name = prompt('新学科名称(比如:微观经济学 / 计量经济学):');
    if (!name) return;
    Glossary.save(name.trim(), []);
    store.set('kissa.subject', name.trim());
    openGlossaryPanel();
  };

  $('btnSaveGlossary').onclick = () => {
    const { name } = Glossary.current();
    const all = Glossary.all();
    if (all[name] && all[name].builtin) {
      // 内置表另存为可编辑副本
      const terms = Glossary.parseImport('.txt', $('glossaryText').value);
      Glossary.save(name, terms);
    } else {
      Glossary.save(name, Glossary.parseImport('.txt', $('glossaryText').value));
    }
    toast('术语表已保存');
    refreshSubjectSelect();
  };

  $('importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const terms = Glossary.parseImport(f.name, text);
      const { name } = Glossary.current();
      const existing = Glossary.current().terms;
      const merged = mergeTerms(existing, terms);
      Glossary.save(name, merged);
      toast(`导入 ${terms.length} 条,合并后共 ${merged.length} 条`);
      openGlossaryPanel();
    } catch (err) {
      toast('导入失败:' + err.message);
    }
    e.target.value = '';
  };
}

function mergeTerms(a, b) {
  const map = new Map();
  [...a, ...b].forEach((t) => map.set(t.ja, t));
  return [...map.values()];
}

/* ========== 启动 ========== */
window.addEventListener('load', () => {
  bindUI();
  refreshSubjectSelect();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {});
  }
  // 恢复未导出字幕的提示
  const saved = store.get('kissa.session', null);
  if (saved && saved.lines && saved.lines.length) {
    toast(`本机存有上次的 ${saved.lines.length} 条字幕,点"开始同传"可恢复,或直接导出`);
    S.lines = saved.lines;
    renderAllLines();
  }
});
