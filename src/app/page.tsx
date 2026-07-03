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
  activeDiscount?: number;
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
  // Auth Gates
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [uiLang, setUiLang] = useState<'id' | 'en' | 'cn'>('id');
  const t = (key: keyof typeof TRANSLATIONS.id) => TRANSLATIONS[uiLang][key] || TRANSLATIONS.id[key];

  // Settings & Menu Recommendations from Dashboard API
  const [settings, setSettings] = useState<ShopSettings>({
    shopName: 'Kopi Senja',
    logo: '',
    themeBg: 'espresso',
  });
  const [recommendations, setRecommendations] = useState<MenuItem[]>([]);
  const [fullMenu, setFullMenu] = useState<MenuItem[]>([]);

  // Mode: 'voice' or 'touch'
  const [orderMode, setOrderMode] = useState<'voice' | 'touch'>('voice');

  // Touchscreen ordering states
  const [touchCategory, setTouchCategory] = useState<string>('All');
  const [touchCart, setTouchCart] = useState<Array<{ id: string; name: string; price: number; quantity: number; notes: string }>>([]);
  const [touchCustomerName, setTouchCustomerName] = useState('');
  const [touchCheckoutStep, setTouchCheckoutStep] = useState<'menu' | 'qris'>('menu');
  const [touchQrisTx, setTouchQrisTx] = useState<any | null>(null);

  // Soundbox States
  const [isRunning, setIsRunning] = useState(false);
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [aiState, setAiState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [transcriptUser, setTranscriptUser] = useState('');
  const [transcriptAi, setTranscriptAi] = useState('');
  const [cart, setCart] = useState<Array<{ name: string; quantity: number; price: number }>>([]);
  const [qrisTx, setQrisTx] = useState<any | null>(null);
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

  // Check auth on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('soundbox_kiosk_auth');
      if (stored === 'telkomsel123') {
        setIsAuthenticated(true);
      }
    }
  }, []);

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === 'telkomsel123') {
      setIsAuthenticated(true);
      localStorage.setItem('soundbox_kiosk_auth', 'telkomsel123');
      setAuthError('');
    } else {
      setAuthError('Password salah! Coba lagi.');
    }
  };

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

    // 2. Fetch Menu for quick recommendations + full touch-mode menu
    fetch(`${DASHBOARD_URL}/api/menu`)
      .then(r => r.json())
      .then((data: MenuItem[]) => {
        setFullMenu(data);
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

  const startSimulator = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setWsStatus('connecting');
    setCart([]);
    setQrisTx(null);
    setTranscriptUser('');
    setTranscriptAi(t('connecting'));

    // Fetch fresh settings, menu list, and reports before starting session
    let latestSettings = settings;
    let latestMenu = [];
    let latestTx = [];

    try {
      const [sRes, mRes, rRes] = await Promise.all([
        fetch(`${DASHBOARD_URL}/api/settings`).then(r => r.json()).catch(() => settings),
        fetch(`${DASHBOARD_URL}/api/menu`).then(r => r.json()).catch(() => []),
        fetch(`${DASHBOARD_URL}/api/reports`).then(r => r.json()).catch(() => ({ transactions: [] }))
      ]);
      latestSettings = sRes;
      latestMenu = mRes;
      latestTx = rRes.transactions || [];

      // Update local states as well
      setSettings(latestSettings);
      const bests = latestMenu.filter((item: any) => item.bestSeller && item.stock > 0).slice(0, 3);
      setRecommendations(bests.length > 0 ? bests : latestMenu.filter((item: any) => item.stock > 0).slice(0, 3));
    } catch (e) {
      console.warn("Could not retrieve latest configuration from Dashboard API. Falling back to cached state.");
    }

    const ws = new WebSocket(PROXY_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      
      // Handshake latest menu data directly to WebSocket proxy
      ws.send(JSON.stringify({
        type: 'custom.client_init',
        menu: latestMenu,
        settings: latestSettings,
        transactions: latestTx
      }));

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

  // ── Touchscreen Ordering Handlers ────────────────────────────────────────────

  const touchAddToCart = (item: MenuItem) => {
    setTouchCart(prev => {
      const existing = prev.find(c => c.id === item.id);
      if (existing) return prev.map(c => c.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { id: item.id, name: item.name, price: item.price, quantity: 1, notes: '' }];
    });
    showToast(`${item.name} ditambahkan ✓`);
  };

  const touchUpdateQty = (id: string, delta: number) => {
    setTouchCart(prev => prev
      .map(c => c.id === id ? { ...c, quantity: Math.max(0, c.quantity + delta) } : c)
      .filter(c => c.quantity > 0)
    );
  };

  const touchUpdateNotes = (id: string, notes: string) => {
    setTouchCart(prev => prev.map(c => c.id === id ? { ...c, notes } : c));
  };

  const touchPlaceOrder = async () => {
    if (touchCart.length === 0 || !touchCustomerName.trim()) return;
    const discountRate = Number(settings.activeDiscount) || 0;
    const subtotal = touchCart.reduce((s, i) => s + i.price * i.quantity, 0);
    const discountAmount = subtotal * (discountRate / 100);
    const finalTotal = subtotal - discountAmount;
    const tx = {
      id: `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      customerName: touchCustomerName.trim(),
      items: touchCart.map(i => ({ menuId: i.id, name: i.name, price: i.price, quantity: i.quantity, notes: i.notes })),
      total: finalTotal,
      discount: discountAmount
    };
    setTouchQrisTx(tx);
    setTouchCheckoutStep('qris');
  };

  const touchCompletePayment = async () => {
    if (!touchQrisTx) return;
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/complete-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: touchQrisTx })
      });
      const data = await res.json();
      if (res.ok) {
        fetch(`${DASHBOARD_URL}/api/menu`).then(r => r.json()).then(setFullMenu).catch(() => {});
        setTouchCart([]);
        setTouchCustomerName('');
        setTouchQrisTx(null);
        setTouchCheckoutStep('menu');
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

  if (!isAuthenticated) {
    return (
      <div className="kiosk-root">
        <form onSubmit={handleLoginSubmit} style={{
          width: '90%',
          maxWidth: '380px',
          padding: '40px 30px',
          background: 'rgba(28, 25, 23, 0.7)',
          backdropFilter: 'blur(16px)',
          border: '1px solid var(--border-color, rgba(120, 113, 108, 0.2))',
          borderRadius: '24px',
          textAlign: 'center',
          boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
          animation: 'slide-fade 0.4s ease-out'
        }}>
          <div style={{
            width: '64px', height: '64px', margin: '0 auto 20px',
            background: 'linear-gradient(135deg, #d97706, #78350f)',
            borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '28px', boxShadow: '0 8px 24px rgba(217, 119, 6, 0.25)'
          }}>
            🔒
          </div>
          <h2 style={{ fontSize: '20px', fontWeight: '800', marginBottom: '8px', color: '#fafaf9', letterSpacing: '-0.02em' }}>
            Soundbox.AI Kiosk
          </h2>
          <p style={{ fontSize: '13px', color: '#78716c', marginBottom: '24px', lineHeight: '1.5' }}>
            Kiosk ini terkunci. Harap hubungi kasir/staf kafe untuk membuka akses voice ordering.
          </p>

          {authError && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              color: '#ef4444',
              padding: '10px 14px',
              borderRadius: '12px',
              fontSize: '13px',
              marginBottom: '16px',
              textAlign: 'left'
            }}>
              ⚠️ {authError}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left', marginBottom: '24px' }}>
            <label style={{ fontSize: '11px', fontWeight: '800', color: '#a8a29e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>PIN / Password Akses</label>
            <input
              type="password"
              required
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              style={{
                width: '100%',
                height: '46px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(120, 113, 108, 0.15)',
                borderRadius: '12px',
                padding: '0 16px',
                color: '#fafaf9',
                outline: 'none',
                fontSize: '16px',
                textAlign: 'center',
                letterSpacing: '0.2em'
              }}
              placeholder="••••••••"
            />
          </div>

          <button type="submit" style={{
            width: '100%',
            height: '46px',
            border: 'none',
            background: 'linear-gradient(135deg, #d97706, #b45309)',
            color: '#0b0908',
            fontWeight: '800',
            fontSize: '14px',
            borderRadius: '23px',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(217, 119, 6, 0.2)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            transition: 'all 0.2s'
          }}>
            Buka Kiosk
          </button>
        </form>
      </div>
    );
  }

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
             
          {/* Conversation Transcripts Box — Voice mode only */}
          {orderMode === 'voice' && (
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
          )}

          {/* Touch mode: Category + Menu Grid */}
          {orderMode === 'touch' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: 10 }}>
              {/* Category Tabs */}
              {(() => {
                const cats = ['All', ...Array.from(new Set(fullMenu.map(i => i.category)))];
                return (
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, flexShrink: 0 }}>
                    {cats.map(cat => (
                      <button key={cat} onClick={() => setTouchCategory(cat)} style={{ padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 700, fontSize: 12, transition: 'all 0.15s', background: touchCategory === cat ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)' : 'rgba(255,255,255,0.07)', color: touchCategory === cat ? '#fff' : '#a8a29e' }}>
                        {cat}
                      </button>
                    ))}
                  </div>
                );
              })()}
              {/* Menu Grid */}
              <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingRight: 4 }}>
                {fullMenu.filter(item => (touchCategory === 'All' || item.category === touchCategory) && item.stock > 0).map(item => {
                  const inCart = touchCart.find(c => c.id === item.id);
                  return (
                    <div key={item.id} onClick={() => touchAddToCart(item)} style={{ background: inCart ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.05)', border: inCart ? '1.5px solid rgba(139,92,246,0.5)' : '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '10px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 12, color: '#f5f5f4', lineHeight: 1.3 }}>{item.name}</span>
                        {item.bestSeller && <span style={{ fontSize: 10, background: 'rgba(245,158,11,0.2)', color: '#f59e0b', padding: '1px 5px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 700 }}>🔥</span>}
                      </div>
                      <span style={{ fontSize: 11, color: '#78716c' }}>{item.category}</span>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--accent-color)' }}>Rp {item.price.toLocaleString('id-ID')}</span>
                        {inCart ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} onClick={e => e.stopPropagation()}>
                            <button onClick={() => touchUpdateQty(item.id, -1)} style={{ width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(139,92,246,0.3)', color: '#c4b5fd', fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>−</button>
                            <span style={{ fontWeight: 800, fontSize: 13, color: '#c4b5fd', minWidth: 14, textAlign: 'center' }}>{inCart.quantity}</span>
                            <button onClick={() => touchUpdateQty(item.id, 1)} style={{ width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(139,92,246,0.3)', color: '#c4b5fd', fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>+</button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: '#8b5cf6', fontWeight: 700 }}>+ Tambah</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {fullMenu.filter(item => (touchCategory === 'All' || item.category === touchCategory) && item.stock > 0).length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', color: '#57534e', padding: 24, fontSize: 13 }}>Tidak ada menu tersedia.</div>
                )}
              </div>
            </div>
          )}

          {/* Mode Switcher + Voice Controls (bottom) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            {/* Mode Toggle */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setOrderMode('voice'); if (isRunning) stopSimulator(); }} style={{ flex: 1, padding: '9px 0', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12, transition: 'all 0.2s', background: orderMode === 'voice' ? 'linear-gradient(135deg, var(--accent-color), var(--accent-hover))' : 'rgba(255,255,255,0.06)', color: orderMode === 'voice' ? '#0b0908' : '#a8a29e' }}>
                🎙️ {uiLang === 'en' ? 'Voice Order' : 'Voice Order'}
              </button>
              <button onClick={() => { setOrderMode('touch'); if (isRunning) stopSimulator(); }} style={{ flex: 1, padding: '9px 0', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12, transition: 'all 0.2s', background: orderMode === 'touch' ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)' : 'rgba(255,255,255,0.06)', color: orderMode === 'touch' ? '#fff' : '#a8a29e' }}>
                👆 {uiLang === 'en' ? 'Touch Order' : 'Touch Order'}
              </button>
            </div>

            {/* Voice mode controls */}
            {orderMode === 'voice' && (
              <div className="control-bar">
                {!isRunning ? (
                  <button className="kiosk-btn-power" onClick={startSimulator}>
                    <span className="power-icon">⚡</span>
                    <span className="power-text">{t('powerOn')}</span>
                  </button>
                ) : (
                  <div className="interactive-controls">
                    <button className={`kiosk-btn-mic ${isRecording ? 'recording' : 'muted'}`} onClick={() => isRecording ? stopRecording() : startRecording()}>
                      <span className="mic-icon">{isRecording ? '🎙️' : '🔇'}</span>
                      <span className="mic-text">{isRecording ? t('micActive') : t('micMuted')}</span>
                    </button>
                    <button className="kiosk-btn-stop" onClick={stopSimulator}>⏹️ Stop</button>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN: Cart & QRIS */}
        <div className="kiosk-right-panel">

          {/* VOICE MODE: cart + QRIS */}
          {orderMode === 'voice' && (
            <>
              <div className="panel-title-bar">
                <h2>🛒 {t('activeCart')}</h2>
              </div>
              <div className="kiosk-cart-box">
                {cart.length === 0 ? (
                  <div className="empty-cart-view">
                    <div className="empty-icon">☕</div>
                    <p className="empty-text">{t('noItems')}</p>
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
                          💡 {uiLang === 'en' ? 'Try saying: "I want to order ' : uiLang === 'cn' ? '试试说："我想点一杯' : 'Coba katakan: "Saya mau pesan '}
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
              {cart.length > 0 && (() => {
                const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                const dr = Number(settings.activeDiscount) || 0;
                const da = subtotal * (dr / 100);
                const total = subtotal - da;
                return (
                  <div className="cart-total-box" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {dr > 0 && (<><div className="total-row" style={{ fontSize: 13, color: '#a8a29e' }}><span>Subtotal</span><span>Rp {subtotal.toLocaleString('id-ID')}</span></div><div className="total-row" style={{ fontSize: 13, color: '#f59e0b' }}><span>Promo ({dr}%)</span><span>-Rp {da.toLocaleString('id-ID')}</span></div></>)}
                    <div className="total-row"><span className="total-label">{t('totalCart')}</span><span className="total-amount">Rp {total.toLocaleString('id-ID')}</span></div>
                  </div>
                );
              })()}
              {qrisTx && (
                <div className="qris-payment-panel">
                  <div className="qris-card">
                    <div className="qris-brand">{t('qrisTitle')}</div>
                    <div className="qris-merchant">{t('qrisMerchant')} {settings.shopName}</div>
                    {qrisTx?.customerName && <div style={{ fontSize: 15, color: '#a78bfa', fontWeight: 700, marginTop: 4 }}>👤 {uiLang === 'en' ? 'Order for:' : 'Atas nama:'} {qrisTx.customerName}</div>}
                    <div className="qris-qr-wrapper">
                      <svg width="160" height="160" viewBox="0 0 100 100" style={{ shapeRendering: 'crispEdges' }}>
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
                    <div className="qris-total-text">Rp {qrisTx.total.toLocaleString('id-ID')}</div>
                    <div className="qris-actions">
                      <button className="qris-btn cancel-btn" onClick={() => { setQrisTx(null); setCart([]); showToast(t('toastPaymentCancelled')); }}>{t('qrisBatal')}</button>
                      <button className="qris-btn pay-btn" onClick={handleCompletePaymentMock}>{t('qrisSuccess')}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* TOUCH MODE: cart + notes + name + QRIS */}
          {orderMode === 'touch' && (
            <>
              <div className="panel-title-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>🛒 {uiLang === 'en' ? 'Your Order' : 'Pesanan Anda'}</h2>
                {touchCheckoutStep === 'qris' && (
                  <button onClick={() => { setTouchCheckoutStep('menu'); setTouchQrisTx(null); }} style={{ fontSize: 12, color: '#a8a29e', background: 'rgba(255,255,255,0.06)', border: 'none', padding: '4px 10px', borderRadius: 8, cursor: 'pointer' }}>← Kembali</button>
                )}
              </div>

              {touchCheckoutStep === 'menu' && (
                <>
                  <div className="kiosk-cart-box">
                    {touchCart.length === 0 ? (
                      <div className="empty-cart-view">
                        <div className="empty-icon">👆</div>
                        <p className="empty-text">{uiLang === 'en' ? 'Tap menu items on the left to add' : 'Ketuk menu di sebelah kiri untuk menambah pesanan'}</p>
                      </div>
                    ) : (
                      <div className="cart-list">
                        {touchCart.map(item => (
                          <div key={item.id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 12px', marginBottom: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <span style={{ fontWeight: 700, fontSize: 13 }}>{item.name}</span>
                              <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--accent-color)' }}>Rp {(item.price * item.quantity).toLocaleString('id-ID')}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button onClick={() => touchUpdateQty(item.id, -1)} style={{ width: 26, height: 26, borderRadius: '50%', border: 'none', background: 'rgba(239,68,68,0.15)', color: '#f87171', fontWeight: 800, cursor: 'pointer', fontSize: 16 }}>−</button>
                              <span style={{ fontWeight: 800, fontSize: 14, minWidth: 20, textAlign: 'center' }}>{item.quantity}</span>
                              <button onClick={() => touchUpdateQty(item.id, 1)} style={{ width: 26, height: 26, borderRadius: '50%', border: 'none', background: 'rgba(139,92,246,0.15)', color: '#a78bfa', fontWeight: 800, cursor: 'pointer', fontSize: 16 }}>+</button>
                              <input type="text" value={item.notes} onChange={e => touchUpdateNotes(item.id, e.target.value)} placeholder={uiLang === 'en' ? 'Notes (e.g. less sugar)' : 'Catatan (less sugar...)'} style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '4px 8px', color: '#f5f5f4', fontSize: 11, outline: 'none' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {touchCart.length > 0 && (() => {
                    const subtotal = touchCart.reduce((s, i) => s + i.price * i.quantity, 0);
                    const dr = Number(settings.activeDiscount) || 0;
                    const da = subtotal * (dr / 100);
                    const finalTotal = subtotal - da;
                    return (
                      <div style={{ padding: '0 2px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
                        <div className="cart-total-box" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {dr > 0 && (<><div className="total-row" style={{ fontSize: 12, color: '#a8a29e' }}><span>Subtotal</span><span>Rp {subtotal.toLocaleString('id-ID')}</span></div><div className="total-row" style={{ fontSize: 12, color: '#f59e0b' }}><span>Promo ({dr}%)</span><span>-Rp {da.toLocaleString('id-ID')}</span></div></>)}
                          <div className="total-row"><span className="total-label">Total</span><span className="total-amount">Rp {finalTotal.toLocaleString('id-ID')}</span></div>
                        </div>
                        <input type="text" value={touchCustomerName} onChange={e => setTouchCustomerName(e.target.value)} placeholder={uiLang === 'en' ? '👤 Your name (required)' : '👤 Nama pemesan (wajib diisi)'} style={{ width: '100%', background: 'rgba(139,92,246,0.08)', border: '1.5px solid rgba(139,92,246,0.3)', borderRadius: 10, padding: '10px 14px', color: '#f5f5f4', fontSize: 13, outline: 'none', fontWeight: 600 }} />
                        <button onClick={touchPlaceOrder} disabled={!touchCustomerName.trim()} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', cursor: touchCustomerName.trim() ? 'pointer' : 'not-allowed', background: touchCustomerName.trim() ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)' : 'rgba(255,255,255,0.08)', color: touchCustomerName.trim() ? '#fff' : '#57534e', fontWeight: 800, fontSize: 14, transition: 'all 0.2s' }}>
                          💳 {uiLang === 'en' ? 'Proceed to Payment' : 'Lanjut Bayar'}
                        </button>
                      </div>
                    );
                  })()}
                </>
              )}

              {touchCheckoutStep === 'qris' && touchQrisTx && (
                <div className="qris-payment-panel">
                  <div className="qris-card">
                    <div className="qris-brand">{t('qrisTitle')}</div>
                    <div className="qris-merchant">{t('qrisMerchant')} {settings.shopName}</div>
                    <div style={{ fontSize: 15, color: '#a78bfa', fontWeight: 700, marginTop: 4 }}>👤 {uiLang === 'en' ? 'Order for:' : 'Atas nama:'} {touchQrisTx.customerName}</div>
                    <div className="qris-qr-wrapper">
                      <svg width="160" height="160" viewBox="0 0 100 100" style={{ shapeRendering: 'crispEdges' }}>
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
                    <div className="qris-total-text">Rp {touchQrisTx.total.toLocaleString('id-ID')}</div>
                    <div className="qris-actions">
                      <button className="qris-btn cancel-btn" onClick={() => { setTouchQrisTx(null); setTouchCheckoutStep('menu'); showToast(t('toastPaymentCancelled')); }}>{t('qrisBatal')}</button>
                      <button className="qris-btn pay-btn" onClick={touchCompletePayment}>{t('qrisSuccess')}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

        </div>

      </div>

    </div>
  );
}
