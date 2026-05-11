# Realtime EN → JA Translator

> Built this for my friend [Adarsh](https://www.linkedin.com/in/adarshxs/) who's travelling to Japan next week. 🇯🇵

Live English-to-Japanese speech translation using OpenAI's Realtime API. Audio streams directly browser ↔ OpenAI over WebRTC. Your API key stays on the server — only a short-lived ephemeral token is sent to the browser.

## Setup

```bash
cd ~/Documents/realtime-translator
npm install
cp .env.local.example .env.local   # then edit .env.local and paste your OPENAI_API_KEY
npm run dev
```

Open **http://localhost:3000** (not the LAN IP — `getUserMedia` requires a secure context, and only `localhost` counts as one over plain HTTP). Click **Start listening**, allow mic access, and speak English. Japanese translation comes back as both text and audio.

## How it works

- `app/api/session/route.ts` — server route. Calls `POST https://api.openai.com/v1/realtime/sessions` with your `OPENAI_API_KEY` and returns the ephemeral `client_secret` to the browser. Your real key never leaves the server.
- `app/page.tsx` — client. Opens an `RTCPeerConnection`, attaches the mic track, exchanges SDP with `https://api.openai.com/v1/realtime?model=...` using the ephemeral token, plays the remote audio track, and renders transcripts from the data channel events.
- The model is configured server-side as a strict one-way English → Japanese interpreter. Input transcription is hard-locked to `language: "en"` so accented English doesn't get misidentified as another language.

## Config knobs

All in [`app/api/session/route.ts`](app/api/session/route.ts):

| Setting | Value | Notes |
| --- | --- | --- |
| `MODEL` | `gpt-4o-realtime-preview-2024-12-17` | The Realtime model. |
| `VOICE` | `alloy` | Other options: `echo`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`. |
| Transcription model | `gpt-4o-transcribe` | Much more accurate than `whisper-1` and less prone to hallucinating "Bye"/"Thank you" filler over silence. |
| Transcription language | `en` | Forced. Without this, accented English sometimes gets transcribed as Telugu/Hindi/etc. |
| VAD `threshold` | `0.7` | Higher = less twitchy on background noise. |
| VAD `silence_duration_ms` | `900` | Higher = won't fire turns on brief pauses or breathing. |

The client side has a small filter in [`app/page.tsx`](app/page.tsx) that drops common transcription-hallucination phrases (bare "Bye.", "Thank you.", "Thanks for watching.", etc.) from the UI on both source and translation panels.

## Cost

`gpt-4o-realtime-preview` is roughly **\$0.06 / minute of input audio** and **\$0.24 / minute of output audio** (output is the bulk of the bill). Click **Stop** when you're not actively using it — the session keeps streaming audio until you do.

## Troubleshooting

**`Cannot read properties of undefined (reading 'getUserMedia')`** — you opened the LAN IP (e.g. `http://10.0.0.8:3000`) instead of `http://localhost:3000`. Browsers strip `navigator.mediaDevices` on insecure origins; only `localhost` is a secure context over plain HTTP.

**Phantom "Bye" / "Thank you" turns appear when you're silent** — transcription hallucinations over silence. The client filter catches the common ones; if you see a new phrase recur, add it to `HALLUCINATION_PHRASES` in [`app/page.tsx`](app/page.tsx).

**Translation comes back in English instead of Japanese** — shouldn't happen now that the prompt is locked, but if it does, restart `npm run dev` (the session config is sent at connection time; old browser tabs use the old prompt).

**Mic permission denied** — check your OS mic permission for the browser (System Settings → Privacy & Security → Microphone on macOS).

## Hosting it

This is a local-only setup. To deploy:

- **Vercel** (easiest): push to a Git repo, import on vercel.com, set `OPENAI_API_KEY` as an environment variable. HTTPS is automatic.
- **Render / Railway / Fly.io**: also work fine. Same env var setup.
- Anywhere else: needs HTTPS (for mic access) and Node 18+.
