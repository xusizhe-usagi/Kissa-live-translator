// providers.js — 前端 ASR 适配层。
// 默认 openai-accurate：把完整语句音频交给 gpt-4o-transcribe，优先准确度与术语。
// 可选 openai-realtime：gpt-realtime-whisper 原生流式，优先最低延迟。

'use strict';

/* ================= 共享 PCM 捕获与重采样 ================= */
class PcmCapture {
  constructor({ targetRate, frameMs, onFrame, onLevel }) {
    this.targetRate = targetRate;
    this.frameMs = frameMs;
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.audioCtx = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.muteNode = null;
  }

  async start(stream) {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

    const workletCode = `
      class KissaPcmCapture extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const cfg = options.processorOptions || {};
          this.targetRate = cfg.targetRate || 16000;
          this.frameSamples = cfg.frameSamples || 1600;
          this.ratio = sampleRate / this.targetRate;
          this.pending = new Float32Array(0);
          this.position = 0;
          this.output = [];
        }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch && ch.length) {
            const merged = new Float32Array(this.pending.length + ch.length);
            merged.set(this.pending, 0);
            merged.set(ch, this.pending.length);

            while (this.position + 1 < merged.length) {
              const i = Math.floor(this.position);
              const frac = this.position - i;
              this.output.push(merged[i] * (1 - frac) + merged[i + 1] * frac);
              this.position += this.ratio;
            }

            const consumed = Math.floor(this.position);
            this.pending = merged.slice(consumed);
            this.position -= consumed;

            while (this.output.length >= this.frameSamples) {
              const frame = this.output.splice(0, this.frameSamples);
              const pcm = new Int16Array(frame.length);
              for (let i = 0; i < frame.length; i++) {
                const s = Math.max(-1, Math.min(1, frame[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              this.port.postMessage(pcm.buffer, [pcm.buffer]);
            }
          }
          return true;
        }
      }
      registerProcessor('kissa-pcm-capture', KissaPcmCapture);
    `;

    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'kissa-pcm-capture', {
      processorOptions: {
        targetRate: this.targetRate,
        frameSamples: Math.round(this.targetRate * this.frameMs / 1000),
      },
    });
    this.workletNode.port.onmessage = (e) => {
      const buf = e.data;
      const view = new Int16Array(buf);
      let sum = 0;
      for (let i = 0; i < view.length; i += 4) sum += Math.abs(view[i]);
      const level = sum / Math.ceil(view.length / 4) / 32768;
      if (this.onLevel) this.onLevel(level);
      if (this.onFrame) this.onFrame(buf, level, this.frameMs);
    };

    this.sourceNode.connect(this.workletNode);
    // 保持音频图运转但绝不回放麦克风，避免啸叫。
    this.muteNode = this.audioCtx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(this.audioCtx.destination);
  }

  stop() {
    try { this.sourceNode && this.sourceNode.disconnect(); } catch {}
    try { this.workletNode && this.workletNode.disconnect(); } catch {}
    try { this.muteNode && this.muteNode.disconnect(); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    this.sourceNode = null;
    this.workletNode = null;
    this.muteNode = null;
    this.audioCtx = null;
  }
}

/* ================= 默认：gpt-4o-transcribe 高准确模式 ================= */
class OpenAIAccurateTranscriber {
  constructor(cb) {
    this.cb = cb;
    this.capture = null;
    this.session = null;
    this.frames = [];
    this.segmentMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
    this.noiseFloor = 0.002;
    this.lastTranscript = '';
    this.uploadChain = Promise.resolve();
    this.segmentNumber = 0;
    this.stopped = false;
  }

  async start(session, stream) {
    this.session = session;
    this.stopped = false;
    this._resetSegment();
    const sampleRate = session.sampleRate || 16000;
    const frameMs = session.frameMs || 100;
    this.capture = new PcmCapture({
      targetRate: sampleRate,
      frameMs,
      onFrame: (buf, level, ms) => this._handleFrame(buf, level, ms),
      onLevel: (level) => this.cb.onLevel && this.cb.onLevel(level),
    });
    await this.capture.start(stream);
    this.cb.onState('live');
  }

  _handleFrame(buf, level, durationMs) {
    if (this.stopped) return;
    this.frames.push(buf);
    this.segmentMs += durationMs;

    const threshold = Math.max(0.0035, this.noiseFloor * 2.0);
    const speaking = level > threshold;
    if (speaking) {
      this.voiceSeen = true;
      this.silenceMs = 0;
    } else if (this.voiceSeen) {
      this.silenceMs += durationMs;
    } else {
      this.noiseFloor = Math.min(0.03, this.noiseFloor * 0.94 + level * 0.06);
    }

    const minMs = this.session.minSegmentMs || 4000;
    const silenceMs = this.session.silenceMs || 1300;
    const maxMs = this.session.maxSegmentMs || 12000;
    const fullPhrase = this.voiceSeen && this.segmentMs >= minMs && this.silenceMs >= silenceMs;
    // 即使远距离人声没越过本地阈值，12 秒也会送去模型判断，绝不漏掉老师讲话。
    if (fullPhrase || this.segmentMs >= maxMs) this._queueSegment();
  }

  _queueSegment(force = false) {
    if (!this.frames.length || this.segmentMs < (force ? 800 : 2500)) return;
    const frames = this.frames;
    const durationMs = this.segmentMs;
    this._resetSegment();

    const audio = pcmFramesToWavBase64(frames, this.session.sampleRate || 16000);
    const segmentNumber = ++this.segmentNumber;
    this.cb.onPartial(`正在精听第 ${segmentNumber} 段（约 ${Math.round(durationMs / 1000)} 秒）…`, true);

    // 串行上传，保证字幕和上一段上下文严格按课堂顺序。
    this.uploadChain = this.uploadChain.then(async () => {
      const text = await this._uploadWithRetry(audio, 0);
      if (!text) {
        this.cb.onPartial('', true);
        return;
      }
      this.lastTranscript = text;
      this.cb.onFinal(text, `accurate-${segmentNumber}`);
    }).catch((e) => {
      this.cb.onPartial('', true);
      this.cb.onError('高准确转写失败: ' + e.message);
    });
  }

  async _uploadWithRetry(audio, attempt) {
    try {
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio,
          prompt: this.session.asrPrompt || '',
          previous: this.lastTranscript,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return String(data.text || '').trim();
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, 900));
      return this._uploadWithRetry(audio, attempt + 1);
    }
  }

  _resetSegment() {
    this.frames = [];
    this.segmentMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
  }

  stop() {
    if (this.stopped) return;
    if (this.frames.length && this.segmentMs >= 800) this._queueSegment(true);
    this.stopped = true;
    this.capture && this.capture.stop();
    this.capture = null;
    this.cb.onState('idle');
  }
}

/* ================= 可选：gpt-realtime-whisper 低延迟模式 ================= */
class OpenAIRealtimeTranscriber {
  constructor(cb) {
    this.cb = cb;
    this.ws = null;
    this.capture = null;
    this.stopped = false;
    this.bufferedMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
    this.noiseFloor = 0.002;
    this.partialByItem = new Map();
  }

  async start(session, stream) {
    this.stopped = false;
    this._resetSegment();
    const protocols = ['realtime', 'openai-insecure-api-key.' + session.token];
    this.ws = new WebSocket(session.wsUrl || 'wss://api.openai.com/v1/realtime', protocols);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ws && this.ws.close(); } catch {}
        reject(new Error('OpenAI Realtime 连接超时'));
      }, 15000);

      this.ws.onopen = async () => {
        try {
          this._send({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: {
                    model: session.model || 'gpt-realtime-whisper',
                    language: session.language || 'ja',
                    delay: session.delay || 'high',
                  },
                  turn_detection: null,
                },
              },
            },
          });
          this.capture = new PcmCapture({
            targetRate: 24000,
            frameMs: 100,
            onFrame: (buf, level, ms) => this._appendAudio(buf, level, ms),
            onLevel: (level) => this.cb.onLevel && this.cb.onLevel(level),
          });
          await this.capture.start(stream);
          this.cb.onState('live');
          settled = true;
          clearTimeout(timeout);
          resolve();
        } catch (e) {
          settled = true;
          clearTimeout(timeout);
          reject(e);
        }
      };

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const type = msg.type || '';
        if (type === 'error') return this.cb.onError('OpenAI: ' + JSON.stringify(msg.error || msg).slice(0, 500));
        if (type === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
          const id = msg.item_id || 'current';
          const text = (this.partialByItem.get(id) || '') + msg.delta;
          this.partialByItem.set(id, text);
          this.cb.onPartial(text, true);
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
          const id = msg.item_id || 'current';
          this.partialByItem.delete(id);
          const text = String(msg.transcript || '').trim();
          if (text) this.cb.onFinal(text, id);
        }
      };

      this.ws.onclose = (ev) => {
        clearTimeout(timeout);
        this.capture && this.capture.stop();
        this.capture = null;
        if (!settled && !this.stopped) {
          settled = true;
          reject(new Error(`OpenAI Realtime 连接失败(${ev.code || 0})`));
          return;
        }
        this.cb.onState(this.stopped ? 'idle' : 'dropped');
      };
    });
  }

  _appendAudio(buf, level, durationMs) {
    this._send({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(buf) });
    this.bufferedMs += durationMs;
    const speaking = level > Math.max(0.004, this.noiseFloor * 2.0);
    if (speaking) {
      this.voiceSeen = true;
      this.silenceMs = 0;
    } else if (this.voiceSeen) {
      this.silenceMs += durationMs;
    } else {
      this.noiseFloor = Math.min(0.03, this.noiseFloor * 0.94 + level * 0.06);
    }
    const fullPhrase = this.voiceSeen && this.bufferedMs >= 3500 && this.silenceMs >= 1400;
    if (fullPhrase || this.bufferedMs >= 12000) this._commitAudio();
  }

  _commitAudio() {
    if (this.bufferedMs < 250 || !this.ws || this.ws.readyState !== 1) return;
    this._send({ type: 'input_audio_buffer.commit' });
    this._resetSegment();
  }

  _send(event) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(event));
  }

  _resetSegment() {
    this.bufferedMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
  }

  stop() {
    this.stopped = true;
    try { this._commitAudio(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    this.capture && this.capture.stop();
    this.capture = null;
  }
}

const PROVIDERS = {
  'openai-accurate': OpenAIAccurateTranscriber,
  'openai-realtime': OpenAIRealtimeTranscriber,
};

function createTranscriber(providerName, callbacks) {
  const Cls = PROVIDERS[providerName];
  if (!Cls) throw new Error('前端没有 ' + providerName + ' 的适配器');
  return new Cls(callbacks);
}

function pcmFramesToWavBase64(frames, sampleRate) {
  const pcmBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const wav = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(wav);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes, true);

  const out = new Uint8Array(wav, 44);
  let offset = 0;
  for (const frame of frames) {
    const bytes = new Uint8Array(frame);
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return arrayBufferToBase64(wav);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

window.KissaProviders = { createTranscriber };
