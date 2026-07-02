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

interface MenuItem {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string;
  description: string;
  bestSeller: boolean;
}

export default function KioskPage() {
  const [uiLang, setUiLang] = useState<'id' | 'en' | 'cn'>('id');
  const t = (key: keyof typeof TRANSLATIONS.id) => TRANSLATIONS[uiLang][key] || TRANSLATIONS.id[key];

  // Settings & Menu Recommendations from Dashboard API
  const [settings, setSettings] = useState<ShopSettings>({
    shopName: 'Kopi Senja',
    logo: '',
    themeBg: 'espresso',
  });
  const [recommendations, setRecommendations] = useState<MenuItem[]>([]);

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

  // Fetch settings and menu items from Dashboard API on load
  useEffect(() => {
    // 1. Fetch Settings
    fetch(`${DASHBOARD_URL}/api/settings`)
      .then(r => r.json())
      .then(data => {
        setSettings(data);
        if (data.language && ['id', 'en', 'cn'].includes(data.language)) {
          setUiLang(data.language as 'id' | 'en' | 'cn');
        }
      })
      .catch(() => console.warn('Could not fetch settings from dashboard, using defaults.'));

    // 2. Fetch Menu for quick recommendations
    fetch(`${DASHBOARD_URL}/api/menu`)
      .then(r => r.json())
      .then((data: MenuItem[]) => {
        // Filter bestsellers or just top 3 items
        const bests = data.filter(item => item.bestSeller && item.stock > 0).slice(0, 3);
        setRecommendations(bests.length > 0 ? bests : data.filter(item => item.stock > 0).slice(0, 3));
      })
      .catch(() => console.warn('Could not fetch menu items.'));
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
      setTranscriptAi(uiLang === 'en' ? 'Hello! How can I help you today?' : uiLang === 'cn' ? '您好！请问有什么可以帮您？' : 'Halo! Ada yang bisa saya bantu hari ini?');
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
      setTranscriptUser(uiLang === 'en' ? 'Sending audio...' : uiLang === 'cn' ? '发送音频...' : 'Mengirim suara...');
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
        setTranscriptAi(uiLang === 'en' ? 'Payment successful! Thank you.' : uiLang === 'cn' ? '支付成功！非常感谢。' : 'Pembayaran QRIS Berhasil! Terima kasih.');
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

      {/* Toast Notification */}
      {toastMessage && (
        <div className="toast">
          <span className="toast-icon">☕</span>
          <span className="toast-text">{toastMessage}</span>
        </div>
      )}

      {/* Language Switcher Bar */}
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

      {/* Full-Screen Premium Kiosk Layout */}
      <div className={`kiosk-container theme-${settings.themeBg}`}>
        
        {/* LEFT COLUMN: Voice Ordering / AI Barista Console */}
        <div className="kiosk-left-panel">
          
          {/* Header Branding */}
          <div className="kiosk-header">
            <div className="brand-wrapper">
              {settings.logo ? (
                settings.logo.startsWith('http') || settings.logo.startsWith('data:') ? (
                  <img src={settings.logo} className="kiosk-logo-img" alt="Logo" />
                ) : (
                  <div className="kiosk-logo-placeholder">{settings.logo}</div>
                )
              ) : (
                <div className="kiosk-logo-placeholder">☕</div>
              )}
              <h1 className="kiosk-title">{settings.shopName} AI</h1>
            </div>
            
            <div className="status-indicator">
              {isRunning ? (
                <span className="status-pill active-status">{t('statusActive')}</span>
              ) : (
                <span className="status-pill standby-status">{t('statusStandby')}</span>
              )}
            </div>
          </div>

          {/* AI Avatar Display & Waveform */}
          <div className="avatar-section">
            <div className={`barista-orb ${aiState}`}>
              <div className="orb-core">
                <span className="orb-emoji">🤖</span>
              </div>
              <div className="orb-glow-ring ring-1"></div>
              <div className="orb-glow-ring ring-2"></div>
            </div>

            {/* Dynamic Waveform Graph */}
            <div className={`voice-wave-container ${aiState}`}>
              {Array.from({ length: 15 }).map((_, i) => (
                <div key={i} className="voice-wave-bar" />
              ))}
            </div>

            <div className="state-label">
              {aiState === 'listening' && t('stateListening')}
              {aiState === 'speaking' && t('stateSpeaking')}
              {aiState === 'thinking' && t('stateThinking')}
              {aiState === 'idle' && t('stateIdle')}
            </div>
          </div>

          {/* Conversation Transcripts Box */}
          <div className="conversation-log-container">
            {transcriptUser && (
              <div className="bubble-card user-bubble">
                <span className="bubble-role">{t('userLabel')}</span>
                <p className="bubble-text">{transcriptUser}</p>
              </div>
            )}
            {transcriptAi && (
              <div className="bubble-card ai-bubble">
                <span className="bubble-role">{t('aiLabel')}</span>
                <p className="bubble-text">{transcriptAi}</p>
              </div>
            )}
            {!transcriptUser && !transcriptAi && (
              <div className="welcome-prompt">
                <p>🙋‍♂️ {uiLang === 'en' ? 'Tap the power button below to start ordering with your voice!' : uiLang === 'cn' ? '点击下方按钮即可开始使用语音点单！' : 'Tekan tombol di bawah untuk mulai memesan dengan suara Anda!'}</p>
              </div>
            )}
          </div>

          {/* Microphones and Controls */}
          <div className="control-bar">
            {!isRunning ? (
              <button className="kiosk-btn-power" onClick={startSimulator}>
                <span className="power-icon">⚡</span>
                <span className="power-text">{t('powerOn')}</span>
              </button>
            ) : (
              <div className="interactive-controls">
                <button
                  className={`kiosk-btn-mic ${isRecording ? 'recording' : 'muted'}`}
                  onClick={() => isRecording ? stopRecording() : startRecording()}
                >
                  <span className="mic-icon">{isRecording ? '🎙️' : '🔇'}</span>
                  <span className="mic-text">{isRecording ? t('micActive') : t('micMuted')}</span>
                </button>
                <button className="kiosk-btn-stop" onClick={stopSimulator}>
                  ⏹️ Stop
                </button>
              </div>
            )}

            {/* Fallback Text Console */}
            {isRunning && (
              <form onSubmit={handleSendTextFallback} className="kiosk-text-input-form">
                <input
                  type="text"
                  className="kiosk-text-input"
                  placeholder={t('fallbackPlaceholder')}
                  value={textFallbackInput}
                  onChange={e => setTextFallbackInput(e.target.value)}
                />
                <button type="submit" className="kiosk-text-submit">{t('send')}</button>
              </form>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN: Bill, Cart, Recommendations & QRIS */}
        <div className="kiosk-right-panel">
          
          <div className="panel-title-bar">
            <h2>🛒 {t('activeCart')}</h2>
          </div>

          {/* Cart items list */}
          <div className="kiosk-cart-box">
            {cart.length === 0 ? (
              <div className="empty-cart-view">
                <div className="empty-icon">☕</div>
                <p className="empty-text">{t('noItems')}</p>
                
                {/* Menu Suggestions when cart is empty */}
                {recommendations.length > 0 && (
                  <div className="suggestions-container">
                    <p className="suggestion-heading">✨ {uiLang === 'en' ? 'Special Recommendations' : uiLang === 'cn' ? '特别推荐' : 'Rekomendasi Spesial'}</p>
                    <div className="suggestion-grid">
                      {recommendations.map(item => (
                        <div key={item.id} className="suggestion-card">
                          <div className="card-top">
                            <span className="suggestion-name">{item.name}</span>
                            {item.bestSeller && <span className="best-tag">🔥 Best</span>}
                          </div>
                          <span className="suggestion-price">Rp {item.price.toLocaleString('id-ID')}</span>
                        </div>
                      ))}
                    </div>
                    <div className="hint-text">
                      💡 {uiLang === 'en' ? 'Try saying: "I want to order ' : uiLang === 'cn' ? '试试说：“我想点一杯' : 'Coba katakan: "Saya mau pesan '}
                      {recommendations[0]?.name}"
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="cart-list">
                {cart.map((item, idx) => (
                  <div className="cart-item-card" key={idx}>
                    <div className="item-details">
                      <span className="item-qty">{item.quantity}x</span>
                      <span className="item-name">{item.name}</span>
                    </div>
                    <span className="item-price">Rp {(item.price * item.quantity).toLocaleString('id-ID')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Cart Summary */}
          {cart.length > 0 && (
            <div className="cart-total-box">
              <div className="total-row">
                <span className="total-label">{t('totalCart')}</span>
                <span className="total-amount">
                  Rp {cart.reduce((sum, item) => sum + (item.price * item.quantity), 0).toLocaleString('id-ID')}
                </span>
              </div>
            </div>
          )}

          {/* QRIS Overlay */}
          {qrisTx && (
            <div className="qris-payment-panel">
              <div className="qris-card">
                <div className="qris-brand">{t('qrisTitle')}</div>
                <div className="qris-merchant">{t('qrisMerchant')} {settings.shopName}</div>
                
                <div className="qris-qr-wrapper">
                  <svg width="160" height="160" viewBox="0 0 100 100" style={{ shapeRendering: 'crispEdges' }}>
                    <rect width="100" height="100" fill="white" />
                    {/* Corner Squares */}
                    <rect x="5" y="5" width="20" height="20" fill="black" /><rect x="10" y="10" width="10" height="10" fill="white" />
                    <rect x="75" y="5" width="20" height="20" fill="black" /><rect x="80" y="10" width="10" height="10" fill="white" />
                    <rect x="5" y="75" width="20" height="20" fill="black" /><rect x="10" y="80" width="10" height="10" fill="white" />
                    
                    {/* Details */}
                    <rect x="35" y="10" width="5" height="10" fill="black" /><rect x="45" y="5" width="15" height="5" fill="black" />
                    <rect x="30" y="30" width="10" height="5" fill="black" /><rect x="55" y="25" width="5" height="15" fill="black" />
                    <rect x="65" y="45" width="15" height="10" fill="black" /><rect x="40" y="50" width="10" height="15" fill="black" />
                    <rect x="30" y="70" width="15" height="5" fill="black" /><rect x="50" y="65" width="5" height="20" fill="black" />
                    <rect x="70" y="75" width="15" height="5" fill="black" /><rect x="80" y="60" width="5" height="10" fill="black" />
                    
                    {/* QRIS Logo Center */}
                    <rect x="40" y="40" width="20" height="20" fill="red" />
                    <text x="50" y="52" fill="white" fontSize="6" fontWeight="bold" textAnchor="middle">QRIS</text>
                  </svg>
                </div>
                
                <div className="qris-total-text">Rp {qrisTx.total.toLocaleString('id-ID')}</div>
                
                <div className="qris-actions">
                  <button className="qris-btn cancel-btn" onClick={() => { setQrisTx(null); setCart([]); showToast(t('toastPaymentCancelled')); }}>
                    {t('qrisBatal')}
                  </button>
                  <button className="qris-btn pay-btn" onClick={handleCompletePaymentMock}>
                    {t('qrisSuccess')}
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>

      </div>

    </div>
  );
}
