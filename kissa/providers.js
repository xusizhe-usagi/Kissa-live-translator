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
    this.workletNode = null;
    this.stopped = false;
  }

  async start(session, stream) {
    this.stopped = false;
    const url = session.wsUrl || 'wss://api.openai.com/v1/realtime';
    // 浏览器 WebSocket 不能自定义 Header,ephemeral token 走子协议传递。
    // GA 正式版不能带 openai-beta.realtime-v1,否则报 beta_api_shape_disabled。
    const protocols = ['realtime', 'openai-insecure-api-key.' + session.token];
    if (session.shape === 'beta') protocols.push('openai-beta.realtime-v1');
    this.ws = new WebSocket(url, protocols);

    this.ws.onopen = () => {
      this.cb.onState('live');
      this._startAudio(stream).catch((e) => this.cb.onError('音频管道启动失败: ' + e.message));
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const t = msg.type || '';
      if (t === 'error') {
        this.cb.onError('OpenAI: ' + JSON.stringify(msg.error || msg).slice(0, 200));
        return;
      }
      // 兼容 beta / GA 两代事件名
      if (t.includes('input_audio_transcription.delta') && msg.delta) {
        this.cb.onPartial(msg.delta);
      } else if (t.includes('input_audio_transcription.completed')) {
        const text = msg.transcript || '';
        if (text.trim()) this.cb.onFinal(text.trim());
      }
    };

    this.ws.onclose = () => {
      this._teardownAudio();
      if (!this.stopped) this.cb.onState('dropped'); // 让 app.js 触发自动重连
      else this.cb.onState('idle');
    };
    this.ws.onerror = () => { /* onclose 会跟着触发 */ };
  }

  async _startAudio(stream) {
    // 24kHz 单声道 PCM16 → base64 → input_audio_buffer.append
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

    const workletCode = `
      class PcmSender extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) {
            const pcm = new Int16Array(ch.length);
            for (let i = 0; i < ch.length; i++) {
              const s = Math.max(-1, Math.min(1, ch[i]));
              pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(pcm.buffer, [pcm.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-sender', PcmSender);
    `;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const src = this.audioCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-sender');
    let level = 0;
    this.workletNode.port.onmessage = (e) => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const buf = e.data;
      // 顺手算个音量给 UI
      const view = new Int16Array(buf);
      let sum = 0;
      for (let i = 0; i < view.length; i += 8) sum += Math.abs(view[i]);
      level = sum / (view.length / 8) / 32768;
      if (this.cb.onLevel) this.cb.onLevel(level);
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: arrayBufferToBase64(buf),
      }));
    };
    src.connect(this.workletNode);
    // 不 connect 到 destination,避免回放啸叫
  }

  _teardownAudio() {
    try { this.workletNode && this.workletNode.disconnect(); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    this.workletNode = null;
    this.audioCtx = null;
  }

  stop() {
    this.stopped = true;
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
