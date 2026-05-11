"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ConnState = "idle" | "connecting" | "connected" | "error";

type Turn = {
  id: string;
  text: string;
  done: boolean;
};

const MODEL = "gpt-4o-realtime-preview-2024-12-17";

// Transcription models sometimes hallucinate stock phrases over silence/noise.
const HALLUCINATION_PHRASES = new Set([
  "bye",
  "goodbye",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching!",
  "thank you very much",
  "you",
  ".",
  "okay",
  "ok",
  "hmm",
  "uh",
  "um",
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございました。",
]);

function isLikelyHallucination(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?。、！？\s]+$/g, "")
    .trim();
  if (!normalized) return true;
  return HALLUCINATION_PHRASES.has(normalized);
}

// Icons (inline SVG so no extra deps).
const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const ErrorIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const EmptyMicIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
  >
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const METER_BARS = 5;

export default function Home() {
  const [state, setState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sourceTurns, setSourceTurns] = useState<Turn[]>([]);
  const [translatedTurns, setTranslatedTurns] = useState<Turn[]>([]);
  const [meterLevels, setMeterLevels] = useState<number[]>(() =>
    new Array(METER_BARS).fill(0),
  );

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const droppedResponseIds = useRef<Set<string>>(new Set());

  const upsertTurn = (
    setter: React.Dispatch<React.SetStateAction<Turn[]>>,
    id: string,
    updater: (prev: Turn | undefined) => Turn,
  ) => {
    setter((turns) => {
      const idx = turns.findIndex((t) => t.id === id);
      if (idx === -1) return [...turns, updater(undefined)];
      const next = turns.slice();
      next[idx] = updater(next[idx]);
      return next;
    });
  };

  const handleServerEvent = useCallback((ev: MessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "conversation.item.input_audio_transcription.delta": {
        const id = msg.item_id as string;
        const delta = (msg.delta as string) ?? "";
        upsertTurn(setSourceTurns, id, (prev) => ({
          id,
          text: (prev?.text ?? "") + delta,
          done: false,
        }));
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const id = msg.item_id as string;
        const transcript = (msg.transcript as string) ?? "";
        if (isLikelyHallucination(transcript)) {
          setSourceTurns((turns) => turns.filter((t) => t.id !== id));
        } else {
          upsertTurn(setSourceTurns, id, () => ({
            id,
            text: transcript,
            done: true,
          }));
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const id = msg.response_id as string;
        if (droppedResponseIds.current.has(id)) break;
        const delta = (msg.delta as string) ?? "";
        upsertTurn(setTranslatedTurns, id, (prev) => ({
          id,
          text: (prev?.text ?? "") + delta,
          done: false,
        }));
        break;
      }
      case "response.audio_transcript.done": {
        const id = msg.response_id as string;
        const transcript = (msg.transcript as string) ?? "";
        if (
          droppedResponseIds.current.has(id) ||
          isLikelyHallucination(transcript)
        ) {
          droppedResponseIds.current.add(id);
          setTranslatedTurns((turns) => turns.filter((t) => t.id !== id));
          break;
        }
        upsertTurn(setTranslatedTurns, id, () => ({
          id,
          text: transcript,
          done: true,
        }));
        break;
      }

      case "error": {
        setError(
          `Realtime error: ${msg.error?.message ?? JSON.stringify(msg.error)}`,
        );
        break;
      }
    }
  }, []);

  const startMeter = (stream: MediaStream) => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        // Split spectrum into METER_BARS bands, average each band, normalize.
        const bandSize = Math.floor(buf.length / METER_BARS);
        const levels: number[] = [];
        for (let i = 0; i < METER_BARS; i++) {
          let sum = 0;
          for (let j = 0; j < bandSize; j++) sum += buf[i * bandSize + j];
          const avg = sum / bandSize / 255;
          levels.push(Math.min(1, avg * 1.6));
        }
        setMeterLevels(levels);
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // analyser is optional decoration; ignore failures
    }
  };

  const stopMeter = () => {
    if (meterRafRef.current != null) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setMeterLevels(new Array(METER_BARS).fill(0));
  };

  const stop = useCallback(() => {
    stopMeter();
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.getSenders().forEach((s) => s.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    setState((s) => (s === "error" ? "error" : "idle"));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setSourceTurns([]);
    setTranslatedTurns([]);
    droppedResponseIds.current.clear();
    setState("connecting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is not available. Open this page at http://localhost:3000 (not the LAN IP) — mic access requires a secure context.",
        );
      }

      const sessRes = await fetch("/api/session", { method: "POST" });
      if (!sessRes.ok) {
        const detail = await sessRes.text();
        throw new Error(`Session mint failed: ${detail}`);
      }
      const sess = await sessRes.json();
      const ephemeralKey: string | undefined = sess?.client_secret?.value;
      if (!ephemeralKey) throw new Error("No client_secret in session response");

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = audioElRef.current ?? new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = mic;
      mic.getTracks().forEach((track) => pc.addTrack(track, mic));
      startMeter(mic);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", handleServerEvent);
      dc.addEventListener("open", () => setState("connected"));
      dc.addEventListener("close", () => setState("idle"));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
          },
        },
      );
      if (!sdpRes.ok) {
        const detail = await sdpRes.text();
        throw new Error(`SDP exchange failed: ${detail}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setState("error");
      stop();
    }
  }, [handleServerEvent, stop]);

  useEffect(() => () => stop(), [stop]);

  const recording = state === "connected" || state === "connecting";
  const statusLabel =
    state === "idle"
      ? "Tap to start"
      : state === "connecting"
        ? "Connecting…"
        : state === "connected"
          ? "Listening"
          : "Error";

  // Build aligned turn pairs by arrival order (most recent at the bottom).
  const pairs: Array<{
    key: string;
    source?: Turn;
    target?: Turn;
    live: boolean;
  }> = [];
  const maxLen = Math.max(sourceTurns.length, translatedTurns.length);
  for (let i = 0; i < maxLen; i++) {
    const source = sourceTurns[i];
    const target = translatedTurns[i];
    const live = (source && !source.done) || (target && !target.done) || false;
    pairs.push({
      key: source?.id ?? target?.id ?? String(i),
      source,
      target,
      live: !!live,
    });
  }

  return (
    <main>
      <header className="app-header">
        <div className="brand">
          <div className="logo">和</div>
          <div className="brand-text">
            <h1>Realtime Translator</h1>
            <div className="langs">Live speech interpreter</div>
          </div>
        </div>
        <div className="lang-pill">
          <span>English</span>
          <span className="arrow">→</span>
          <span>日本語</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-row">
          <div className="hero-text">
            <h2>Speak English, hear Japanese</h2>
            <p>
              Press the mic and start talking. Your speech streams to OpenAI's
              Realtime API and the Japanese translation comes back as both text
              and natural-sounding voice.
            </p>
          </div>
          <div className="hero-actions">
            <div className="status-block">
              <div className={`status ${state}`}>
                <span className="dot" />
                {statusLabel}
              </div>
              <div className={`meter ${recording ? "active" : ""}`}>
                {meterLevels.map((lv, i) => (
                  <span
                    key={i}
                    style={{ height: `${Math.max(8, lv * 100)}%` }}
                  />
                ))}
              </div>
            </div>
            <button
              className={`mic-button ${recording ? "recording" : ""}`}
              onClick={recording ? stop : start}
              disabled={state === "connecting"}
              aria-label={recording ? "Stop listening" : "Start listening"}
            >
              {recording ? <StopIcon /> : <MicIcon />}
            </button>
          </div>
        </div>
      </section>

      <div className="section-label">Conversation</div>

      {pairs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <EmptyMicIcon />
          </div>
          <h3>Ready when you are</h3>
          <p>
            Tap the mic above and start speaking in English. Pairs of your words
            and their Japanese translation will appear here.
          </p>
        </div>
      ) : (
        <div className="conversation">
          {pairs.map((p) => (
            <div key={p.key} className={`turn-pair ${p.live ? "live" : ""}`}>
              <div className="turn-cell source">
                <span className="tag">
                  <span className="tag-dot" /> English
                </span>
                <div
                  className={`turn-text ${
                    !p.source ? "empty" : p.source.done ? "" : "pending"
                  }`}
                >
                  {p.source?.text || (p.source ? "" : "Listening…")}
                  {p.source && !p.source.done && <span className="cursor" />}
                </div>
              </div>
              <div className="turn-cell target">
                <span className="tag">
                  <span className="tag-dot" /> 日本語
                </span>
                <div
                  className={`turn-text ja ${
                    !p.target ? "empty" : p.target.done ? "" : "pending"
                  }`}
                >
                  {p.target?.text ||
                    (p.target ? "" : "Waiting for translation…")}
                  {p.target && !p.target.done && <span className="cursor" />}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="error">
          <ErrorIcon />
          <span>{error}</span>
        </div>
      )}

      <footer className="app-footer">
        <span>
          Audio streams browser ↔ OpenAI directly via WebRTC. Your API key never
          leaves the server.
        </span>
        <span>
          Model <code>{MODEL}</code>
        </span>
      </footer>
    </main>
  );
}
