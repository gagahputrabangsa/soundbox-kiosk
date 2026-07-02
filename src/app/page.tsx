'use client';

import React, { useState, useEffect, useRef } from 'react';
import { TRANSLATIONS } from './translations';

// Dashboard API URL (where menu & settings are stored)
const DASHBOARD_URL = (process.env.NEXT_PUBLIC_DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'ws://localhost:3001';

interface ShopSettings {
  shopName: string;
  logo: string;
  themeBg: string;
  screenBgImage?: string;
}

export default function KioskPage() {
  const [uiLang, setUiLang] = useState<'id' | 'en' | 'cn'>('id');
  const t = (key: keyof typeof TRANSLATIONS.id) => TRANSLATIONS[uiLang][key] || TRANSLATIONS.id[key];

  // Settings from Dashboard API
  const [settings, setSettings] = useState<ShopSettings>({
    shopName: 'Kopi Senja',
    logo: '',
    themeBg: 'espresso',
  });

  // Soundbox States
  const [isRunning, setIsRunning] = useState(false);
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [aiState, setAiState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [transcriptUser, setTranscriptUser] = useState('');
  const [transcriptAi, setTranscriptAi] = useState('');
  const [cart, setCart] = useState<Array<{ name: string; quantity: number; price: number }>>([]);
  const [qrisTx, setQrisTx] = useState<any | null>(null);
  const [textFallbackInput, setTextFallbackInput] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // Audio / WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  // Fetch settings from Dashboard API on load
  useEffect(() => {
    fetch(`${DASHBOARD_URL}/api/settings`)
      .then(r => r.json())
      .then(data => {
        setSettings(data);
        if (data.language && ['id', 'en', 'cn'].includes(data.language)) {
          setUiLang(data.language as 'id' | 'en' | 'cn');
        }
      })
      .catch(() => console.warn('Could not fetch settings from dashboard, using defaults.'));
  }, []);

  // Auto-start recording when connected
  useEffect(() => {
    if (wsStatus === 'connected' && isRunning) {
      startRecording();
    }
  }, [wsStatus, isRunning]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // ── Audio Utilities ──────────────────────────────────────────────────────────

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const stopAllPlayback = () => {
    activeSourcesRef.current.forEach(source => { try { source.stop(); } catch (e) {} });
    activeSourcesRef.current = [];
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
  };

  const playPCM16Chunk = (base64Data: string) => {
    try {
      initAudio();
      const ctx = audioContextRef.current!;
      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;

      const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      activeSourcesRef.current.push(source);
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      };

      const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
    } catch (err) {
      console.error('Playback Error:', err);
    }
  };

  // ── WebSocket ────────────────────────────────────────────────────────────────

  const startSimulator = () => {
    if (isRunning) return;
    setIsRunning(true);
    setWsStatus('connecting');
    setCart([]);
    setQrisTx(null);
    setTranscriptUser('');
    setTranscriptAi(t('connecting'));

    const ws = new WebSocket(PROXY_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      setTranscriptAi(t('stateIdle'));
      setAiState('idle');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if ((msg.type === 'response.text.delta' || msg.type === 'response.audio_transcript.delta') && msg.delta) {
          setTranscriptAi(prev => prev + msg.delta);
        } else if (msg.type === 'response.created') {
          setTranscriptAi('');
          setAiState('thinking');
        } else if (msg.type === 'response.audio.delta' && msg.delta) {
          setAiState('speaking');
          playPCM16Chunk(msg.delta);
        } else if (msg.type === 'response.done') {
          setAiState('idle');
        } else if (msg.type === 'input_audio_buffer.speech_started') {
          stopAllPlayback();
          setAiState('listening');
          setTranscriptUser(t('stateListening'));
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          if (msg.transcript) setTranscriptUser(msg.transcript.trim());
        } else if (msg.type === 'error') {
          console.error('Nebula error:', msg.error);
          setTranscriptAi(`Error: ${msg.error?.message || 'Gagal merespons'}`);
          setAiState('idle');
        }

        if (msg.type === 'custom.order_completed') {
          const transaction = msg.transaction;
          setCart(transaction.items);
          setQrisTx(transaction);
          showToast(t('toastTxCreated'));
          stopSimulator();
        }
      } catch (_) {}
    };

    ws.onerror = () => {
      setWsStatus('error');
      setTranscriptAi(t('errorConnection'));
      setIsRunning(false);
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      setIsRunning(false);
      stopRecording();
      stopAllPlayback();
    };
  };

  const stopSimulator = () => {
    if (wsRef.current) wsRef.current.close();
    setIsRunning(false);
    setWsStatus('disconnected');
    setAiState('idle');
    stopRecording();
    stopAllPlayback();
  };

  // ── Microphone Recording ─────────────────────────────────────────────────────

  const startRecording = async () => {
    if (wsStatus !== 'connected' || !wsRef.current) return;
    if (mediaStreamRef.current || recordingAudioContextRef.current) return;
    initAudio();
    setIsRecording(true);
    setAiState('listening');
    setTranscriptUser(t('stateListening'));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      recordingAudioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorNodeRef.current = processor;
      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const buffer = new ArrayBuffer(inputData.length * 2);
        const view = new DataView(buffer);
        let offset = 0;
        for (let i = 0; i < inputData.length; i++, offset += 2) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        const uint8 = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
        const base64Audio = window.btoa(binary);

        wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio }));
      };

      if (audioContextRef.current) {
        nextPlayTimeRef.current = audioContextRef.current.currentTime;
      }
    } catch (err) {
      console.error('Mic error:', err);
      showToast(t('toastMicError'));
      setIsRecording(false);
      setAiState('idle');
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    if (processorNodeRef.current) { processorNodeRef.current.disconnect(); processorNodeRef.current = null; }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach(t => t.stop()); mediaStreamRef.current = null; }
    if (recordingAudioContextRef.current) {
      if (recordingAudioContextRef.current.state !== 'closed') recordingAudioContextRef.current.close().catch(() => {});
      recordingAudioContextRef.current = null;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      wsRef.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_audio", audio: "" }] } }));
      wsRef.current.send(JSON.stringify({ type: "response.create" }));
      setTranscriptUser('Mengirim suara...');
      setAiState('thinking');
    }
  };

  // ── Text Fallback ────────────────────────────────────────────────────────────

  const handleSendTextFallback = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textFallbackInput.trim() || wsStatus !== 'connected' || !wsRef.current) return;
    setTranscriptUser(textFallbackInput);
    wsRef.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: textFallbackInput }] } }));
    wsRef.current.send(JSON.stringify({ type: "response.create" }));
    setTextFallbackInput('');
    setAiState('thinking');
    setTranscriptAi('');
    if (audioContextRef.current) nextPlayTimeRef.current = audioContextRef.current.currentTime;
  };

  // ── Payment ──────────────────────────────────────────────────────────────────

  const handleCompletePaymentMock = async () => {
    if (!qrisTx) return;
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/complete-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: qrisTx })
      });
      const data = await res.json();

      if (res.ok) {
        setQrisTx(null);
        setCart([]);
        setTranscriptAi('Pembayaran QRIS Berhasil! Terima kasih.');
        showToast(t('toastPaymentReceived'));
        try {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.connect(gain); gain.connect(audioCtx.destination);
          osc.type = 'sine'; osc.frequency.setValueAtTime(880, audioCtx.currentTime);
          gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
          osc.start(); osc.stop(audioCtx.currentTime + 0.15);
        } catch (_) {}
      } else {
        showToast(`Pembayaran gagal: ${data.error}`);
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="kiosk-root">

      {/* Toast */}
      {toastMessage && (
        <div className="toast"><span>☕</span> {toastMessage}</div>
      )}

      {/* Language switcher (top-right corner, small) */}
      <div className="lang-switcher">
        {(['id', 'en', 'cn'] as const).map(lang => (
          <button
            key={lang}
            onClick={() => setUiLang(lang)}
            className={`lang-btn ${uiLang === lang ? 'active' : ''}`}
          >
            {lang === 'id' ? 'ID' : lang === 'en' ? 'EN' : '中文'}
          </button>
        ))}
      </div>

      {/* Soundbox Device */}
      <div className={`soundbox-device theme-${settings.themeBg}`}>

        {/* Device Header */}
        <div className="device-header">
          <div className="device-logo-area">
            {settings.logo ? (
              settings.logo.startsWith('http') || settings.logo.startsWith('data:') ? (
                <img src={settings.logo} className="device-logo-img" alt="Logo" />
              ) : (
                <div className="device-logo-placeholder">{settings.logo}</div>
              )
            ) : (
              <div className="device-logo-placeholder">☕</div>
            )}
            <div className="device-title">{settings.shopName} AI</div>
          </div>

          {isRunning ? (
            <span className="device-status-badge online">{t('statusActive')}</span>
          ) : (
            <span className="device-status-badge">{t('statusStandby')}</span>
          )}
        </div>

        {/* Speaker Grill */}
        <div className="speaker-grill">
          {Array.from({ length: 32 }).map((_, i) => (
            <div key={i} className="speaker-hole" />
          ))}
        </div>

        {/* Screen */}
        <div
          className="device-screen"
          style={{
            background: settings.screenBgImage
              ? `linear-gradient(rgba(9, 8, 7, 0.85), rgba(9, 8, 7, 0.95)), url(${settings.screenBgImage}) center/cover no-repeat`
              : undefined
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#a8a29e' }}>{t('smartBarista')}</span>
            <span style={{ fontSize: 10, color: '#78716c' }}>v1.0.3</span>
          </div>

          {/* Waveform */}
          <div className={`voice-wave-container ${aiState}`}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="voice-wave-bar" />
            ))}
          </div>

          {/* Status Text */}
          <div style={{
            textAlign: 'center', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
            color: aiState === 'listening' ? '#3b82f6' : aiState === 'speaking' ? '#10b981' : aiState === 'thinking' ? '#a855f7' : '#a8a29e'
          }}>
            {aiState === 'listening' && t('stateListening')}
            {aiState === 'speaking' && t('stateSpeaking')}
            {aiState === 'thinking' && t('stateThinking')}
            {aiState === 'idle' && t('stateIdle')}
          </div>

          {/* Transcript */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {transcriptUser && (
              <div className="transcript-bubble user">
                <span style={{ fontSize: 10, color: '#3b82f6', fontWeight: 700, display: 'block' }}>{t('userLabel')}</span>
                {transcriptUser}
              </div>
            )}
            {transcriptAi && (
              <div className="transcript-bubble assistant">
                <span style={{ fontSize: 10, color: '#10b981', fontWeight: 700, display: 'block' }}>{t('aiLabel')}</span>
                {transcriptAi}
              </div>
            )}
          </div>

          {/* Cart */}
          <div className="device-cart-area">
            <span style={{ fontSize: 10, color: '#a8a29e', fontWeight: 700, textTransform: 'uppercase' }}>{t('activeCart')}</span>
            {cart.length === 0 ? (
              <div style={{ margin: 'auto', fontSize: 12, color: '#78716c', textAlign: 'center' }}>{t('noItems')}</div>
            ) : (
              cart.map((item, idx) => (
                <div className="cart-item-row" key={idx}>
                  <div>
                    <span className="cart-item-qty">{item.quantity}x</span>
                    <span>{item.name}</span>
                  </div>
                  <span>Rp {(item.price * item.quantity).toLocaleString('id-ID')}</span>
                </div>
              ))
            )}
            {cart.length > 0 && (
              <div className="cart-total-section">
                <span>{t('totalCart')}</span>
                <span>Rp {cart.reduce((sum, item) => sum + (item.price * item.quantity), 0).toLocaleString('id-ID')}</span>
              </div>
            )}
          </div>

          {/* QRIS Overlay */}
          {qrisTx && (
            <div className="qris-overlay">
              <div className="qris-header">{t('qrisTitle')}</div>
              <div style={{ fontSize: 11, color: '#a8a29e', textAlign: 'center', marginTop: -8 }}>
                {t('qrisMerchant')} {settings.shopName}
              </div>
              <div className="qris-code-container">
                <svg width="150" height="150" viewBox="0 0 100 100" style={{ shapeRendering: 'crispEdges' }}>
                  <rect width="100" height="100" fill="white" />
                  <rect x="5" y="5" width="20" height="20" fill="black" /><rect x="10" y="10" width="10" height="10" fill="white" />
                  <rect x="75" y="5" width="20" height="20" fill="black" /><rect x="80" y="10" width="10" height="10" fill="white" />
                  <rect x="5" y="75" width="20" height="20" fill="black" /><rect x="10" y="80" width="10" height="10" fill="white" />
                  <rect x="35" y="10" width="5" height="10" fill="black" /><rect x="45" y="5" width="15" height="5" fill="black" />
                  <rect x="30" y="30" width="10" height="5" fill="black" /><rect x="55" y="25" width="5" height="15" fill="black" />
                  <rect x="65" y="45" width="15" height="10" fill="black" /><rect x="40" y="50" width="10" height="15" fill="black" />
                  <rect x="30" y="70" width="15" height="5" fill="black" /><rect x="50" y="65" width="5" height="20" fill="black" />
                  <rect x="70" y="75" width="15" height="5" fill="black" /><rect x="80" y="60" width="5" height="10" fill="black" />
                  <rect x="40" y="40" width="20" height="20" fill="red" />
                  <text x="50" y="52" fill="white" fontSize="6" fontWeight="bold" textAnchor="middle">QRIS</text>
                </svg>
              </div>
              <div className="qris-total">Rp {qrisTx.total.toLocaleString('id-ID')}</div>
              <div style={{ display: 'flex', gap: 10, width: '100%', marginTop: 12 }}>
                <button className="btn btn-danger" onClick={() => { setQrisTx(null); setCart([]); showToast(t('toastPaymentCancelled')); }} style={{ flex: 1, borderRadius: 12 }}>
                  {t('qrisBatal')}
                </button>
                <button className="btn btn-primary" onClick={handleCompletePaymentMock} style={{ flex: 2, borderRadius: 12 }}>
                  {t('qrisSuccess')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="device-controls">
          {!isRunning ? (
            <button className="btn btn-primary" onClick={startSimulator} style={{ width: '100%', height: 48, borderRadius: 24, fontSize: 15, fontWeight: 700 }}>
              {t('powerOn')}
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className={`mic-button ${isRecording ? 'active' : 'muted'}`}
                  onClick={() => isRecording ? stopRecording() : startRecording()}
                  style={{ padding: '10px 20px', borderRadius: '24px', border: 'none', backgroundColor: isRecording ? '#10b981' : '#78716c', color: 'white', fontWeight: 'bold', cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {isRecording ? t('micActive') : t('micMuted')}
                </button>
                <button className="btn btn-danger" onClick={stopSimulator} style={{ width: 64, borderRadius: 24 }}>⏹️</button>
              </div>
              <form onSubmit={handleSendTextFallback} className="text-chat-fallback">
                <input
                  type="text"
                  className="text-chat-fallback-input"
                  placeholder={t('fallbackPlaceholder')}
                  value={textFallbackInput}
                  onChange={e => setTextFallbackInput(e.target.value)}
                />
                <button type="submit" className="text-chat-fallback-submit">{t('send')}</button>
              </form>
            </div>
          )}
        </div>

        <div style={{ textAlign: 'center', fontSize: 10, color: '#78716c', marginTop: -8 }}>
          {uiLang === 'en' ? 'Click Mic to talk, or use text chat above to type.'
            : uiLang === 'cn' ? '点击麦克风开始对话，或使用上方文本框输入。'
            : 'Tekan tombol Mic untuk bicara, atau gunakan input teks di atasnya untuk mengetik.'}
        </div>

      </div>
    </div>
  );
}
