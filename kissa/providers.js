// providers.js — 前端 ASR 适配层。
// 每个供应商实现同一个接口:
//   new XxxTranscriber({ onPartial(text), onFinal(text), onState(state), onError(msg) })
//   await t.start(sessionInfo, mediaStream)   sessionInfo 来自 /api/session
//   t.stop()
// 想接 Deepgram/Soniox:照 OpenAIRealtimeTranscriber 写一个类,在 PROVIDERS 里注册。

'use strict';

/* ================= OpenAI Realtime(转写模式) ================= */
class OpenAIRealtimeTranscriber {
  constructor(cb) {
    this.cb = cb;
    this.ws = null;
    this.audioCtx = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.muteNode = null;
    this.stopped = false;
    this.opened = false;
    this.bufferedMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
    this.noiseFloor = 0.002;
    this.partialByItem = new Map();
  }

  async start(session, stream) {
    this.stopped = false;
    this.opened = false;
    this._resetSegment();
    const url = session.wsUrl || 'wss://api.openai.com/v1/realtime';
    // 浏览器 WebSocket 不能自定义 Authorization header,短时效令牌通过子协议传递。
    // 这里故意不再兼容 openai-beta.realtime-v1:Beta 已停用,带上它就会报
    // beta_api_shape_disabled。
    const protocols = ['realtime', 'openai-insecure-api-key.' + session.token];
    this.ws = new WebSocket(url, protocols);

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
          // client secret 已绑定配置,这里再发一次官方 GA session.update,保证会话字段明确。
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
                    delay: session.delay || 'low',
                  },
                  turn_detection: null,
                },
              },
            },
          });
          await this._startAudio(stream);
          this.opened = true;
          this.cb.onState('live');
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('音频管道启动失败: ' + e.message));
          } else {
            this.cb.onError('音频管道启动失败: ' + e.message);
          }
          try { this.ws && this.ws.close(); } catch {}
        }
      };

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const t = msg.type || '';
        if (t === 'error') {
          const detail = JSON.stringify(msg.error || msg).slice(0, 500);
          this.cb.onError('OpenAI: ' + detail);
          return;
        }

        if (t === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
          const itemId = msg.item_id || 'current';
          const text = (this.partialByItem.get(itemId) || '') + msg.delta;
          this.partialByItem.set(itemId, text);
          // 第二个参数表示这是当前 item 的完整 partial,不是需要再次拼接的 delta。
          this.cb.onPartial(text, true);
        } else if (t === 'conversation.item.input_audio_transcription.completed') {
          const itemId = msg.item_id || 'current';
          this.partialByItem.delete(itemId);
          const transcript = String(msg.transcript || '').trim();
          if (transcript) this.cb.onFinal(transcript, itemId);
        }
      };

      this.ws.onclose = (ev) => {
        clearTimeout(timeout);
        this._teardownAudio();
        if (!settled && !this.stopped) {
          settled = true;
          reject(new Error(`OpenAI Realtime 连接失败(${ev.code || 0})${ev.reason ? ': ' + ev.reason : ''}`));
          return;
        }
        if (!this.stopped) this.cb.onState('dropped'); // 让 app.js 触发自动重连
        else this.cb.onState('idle');
      };
      this.ws.onerror = () => {
        // 浏览器通常不会在这里给出细节,真正原因会从 onclose 或服务端 error event 返回。
      };
    });
  }

  async _startAudio(stream) {
    // 麦克风实际常为 44.1/48kHz。Worklet 会可靠重采样为官方要求的 24kHz 单声道 PCM16,
    // 并按 100ms 打包,避免旧版每 128 个采样点就发一个 WebSocket 包。
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

    const workletCode = `
      class PcmSender extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ratio = sampleRate / 24000;
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

            while (this.output.length >= 2400) {
              const frame = this.output.splice(0, 2400);
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
      registerProcessor('pcm-sender', PcmSender);
    `;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-sender');
    this.workletNode.port.onmessage = (e) => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const buf = e.data;
      const view = new Int16Array(buf);
      let sum = 0;
      for (let i = 0; i < view.length; i += 4) sum += Math.abs(view[i]);
      const level = sum / Math.ceil(view.length / 4) / 32768;
      if (this.cb.onLevel) this.cb.onLevel(level);
      this._appendAudio(buf, level, 100);
    };
    this.sourceNode.connect(this.workletNode);
    // Web Audio 在部分 Safari/Chrome 版本中只处理连到 destination 的图。
    // 用 0 音量节点保持 Worklet 运转,同时绝不会把麦克风回放出来造成啸叫。
    this.muteNode = this.audioCtx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(this.audioCtx.destination);
  }

  _appendAudio(buf, level, durationMs) {
    this._send({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(buf),
    });
    this.bufferedMs += durationMs;

    // 轻量客户端断句:检测到讲话后的约 700ms 静音就提交;即使一直讲话或环境很吵,
    // 最迟每 6 秒提交一次,不会因 VAD 阈值不合适而漏掉老师的声音。
    const threshold = Math.max(0.004, this.noiseFloor * 2.0);
    const speaking = level > threshold;
    if (speaking) {
      this.voiceSeen = true;
      this.silenceMs = 0;
    } else {
      if (!this.voiceSeen) {
        this.noiseFloor = Math.min(0.03, this.noiseFloor * 0.92 + level * 0.08);
      } else {
        this.silenceMs += durationMs;
      }
    }

    const endedPhrase = this.voiceSeen && this.silenceMs >= 700 && this.bufferedMs >= 500;
    const maxLatency = this.bufferedMs >= 6000;
    if (endedPhrase || maxLatency) this._commitAudio();
  }

  _commitAudio() {
    if (this.bufferedMs < 250 || !this.ws || this.ws.readyState !== 1) return;
    this._send({ type: 'input_audio_buffer.commit' });
    this._resetSegment();
  }

  _resetSegment() {
    this.bufferedMs = 0;
    this.voiceSeen = false;
    this.silenceMs = 0;
  }

  _send(event) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(event));
  }

  _teardownAudio() {
    try { this.sourceNode && this.sourceNode.disconnect(); } catch {}
    try { this.workletNode && this.workletNode.disconnect(); } catch {}
    try { this.muteNode && this.muteNode.disconnect(); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    this.sourceNode = null;
    this.workletNode = null;
    this.muteNode = null;
    this.audioCtx = null;
    this.partialByItem.clear();
    this._resetSegment();
  }

  stop() {
    this.stopped = true;
    // 尽量提交最后不足 6 秒的一段;随后关闭连接。已完成的字幕仍会保存在 app.js。
    try { this._commitAudio(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    this._teardownAudio();
  }
}

/* ================= Deepgram(骨架,以后要换随时补全) =================
class DeepgramTranscriber {
  constructor(cb) { this.cb = cb; }
  async start(session, stream) {
    // 1. url = session.wsUrl + '?model=nova-3&language=ja&interim_results=true&smart_format=true'
    // 2. new WebSocket(url, ['token', session.token])
    // 3. 直接把 MediaRecorder 的 webm/opus chunk 或 PCM 发进去
    // 4. onmessage: data.channel.alternatives[0].transcript,is_final 区分 partial/final
  }
  stop() {}
}
==================================================================== */

const PROVIDERS = {
  openai: OpenAIRealtimeTranscriber,
  // deepgram: DeepgramTranscriber,
};

function createTranscriber(providerName, callbacks) {
  const Cls = PROVIDERS[providerName];
  if (!Cls) throw new Error('前端没有 ' + providerName + ' 的适配器,请在 providers.js 里添加');
  return new Cls(callbacks);
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
