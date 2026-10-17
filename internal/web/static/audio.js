// RX audio playback, two mutually exclusive modes sharing one AudioContext
// and AudioWorklet ring buffer (see pcm-player-processor.js):
//
//   - PCM: /audio-ws?codec=pcm, raw 16kHz mono 16-bit samples,
//     no encode/decode step anywhere. Lowest possible latency, ~256kbit/s.
//   - Opus ("Mobil"): /audio-ws?codec=opus, decoded in-browser via the
//     WebCodecs AudioDecoder. Much less bandwidth for mobile connections,
//     at the cost of the codec's own small algorithmic delay.
//
// Both resample from the radio's fixed 16kHz to whatever rate the
// AudioContext actually runs at, since that varies by browser/device. An
// optional RNNoise denoising stage (see ensureRNNoise/pushSamples below) can
// sit in between, toggled by the "RNnoise" button next to PROC.
(function () {
  const RADIO_SAMPLE_RATE = 16000;
  const OPUS_FRAME_MS = 20;
  // The AF slider controls this directly (stream volume, client-side only
  // — the radio's own AF/AG gain doesn't affect the LAN audio tap at all,
  // verified by watching the stream's amplitude stay put while cranking AF
  // from ~17% to ~85% on the radio). Max of 8x gives comfortable headroom
  // over the real signal's typical -13 to -15dBFS peaks; clamped below to
  // avoid clipping if a louder moment comes through anyway.
  const MAX_VOLUME_GAIN = 8;
  const VOLUME_KEY = "hamrc.volume";

  function loadVolume() {
    try {
      const v = parseInt(localStorage.getItem(VOLUME_KEY), 10);
      if (Number.isFinite(v) && v >= 0 && v <= 255) return v;
    } catch {
      // localStorage unavailable — fall through to the default.
    }
    return Math.round((3 / MAX_VOLUME_GAIN) * 255); // matches the old fixed 3x default
  }

  let playbackGain = (loadVolume() / 255) * MAX_VOLUME_GAIN;

  const volumeSlider = makeSlider("af-slider", (value) => {
    playbackGain = (value / 255) * MAX_VOLUME_GAIN;
    try {
      localStorage.setItem(VOLUME_KEY, value);
    } catch {
      // localStorage unavailable — the slider still works, just won't
      // remember the setting across reloads.
    }
  });
  volumeSlider.applyValue(loadVolume());
  // Bridge for app.js's power-off/power-on slider animation (Nutzer-Wunsch,
  // 2026-10-14) — AF is browser-local (see this file's own top comment), so
  // app.js can't reach volumeSlider directly across script files. Purely
  // display: applyValue never touches playbackGain or localStorage, only
  // the slider's onChange (a real drag/click) does that.
  window.hamrcSetAFVolumeDisplay = (v) => volumeSlider.applyValue(v);
  // Getter counterpart: the real stored value (not whatever applyValue last
  // displayed) — loadVolume() always reflects the last actual drag/click,
  // since applyValue deliberately never touches localStorage (see above).
  // Lets app.js restore the slider to the user's real volume on reconnect
  // without having to snapshot it itself before zeroing the display.
  window.hamrcGetAFVolumeDisplay = () => loadVolume();

  // Separate, browser-local volume for mithören another client's TX (Nutzer-
  // Wunsch, 2026-10-15: "jeder bevorzugt andere Werte"). The relay has no
  // channel of its own — the server mixes a transmitting client's mic audio
  // straight into the normal RX stream (see onPCM/broadcastRXAudio in
  // main.go, which skips real radio-origin RX while someone sends, leaving
  // only the relay) — so this file can't tell relay bytes from real RX bytes
  // by looking at them. remoteTxActive (set via hamrcSetRemoteTxActive,
  // called from app.js's applyState using state.tx && !myTX — i.e. SOMEONE
  // ELSE is sending) is the same signal the server itself relies on to know
  // which audio is currently flowing, used here client-side to pick which
  // gain applies to pushSamples' incoming samples. 100% = unity (the relay
  // already arrives at "normal RX-ish volume", see TXAudio's own doc
  // comment in web.go) — independent of the AF slider on purpose, mirroring
  // how the radio's own TX Monitor (MO0/ML) has its own level separate from
  // AF rather than being a multiplier on it.
  const TX_RELAY_VOLUME_KEY = "open890rc.txRelayVolume";
  function loadTxRelayVolume() {
    try {
      const v = parseInt(localStorage.getItem(TX_RELAY_VOLUME_KEY), 10);
      if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
    } catch {
      // localStorage unavailable — fall through to the default.
    }
    return 100;
  }
  let txRelayVolumePercent = loadTxRelayVolume();
  let remoteTxActive = false;
  window.hamrcGetTxRelayVolume = () => txRelayVolumePercent;
  window.hamrcSetTxRelayVolume = (percent) => {
    txRelayVolumePercent = percent;
    try {
      localStorage.setItem(TX_RELAY_VOLUME_KEY, String(percent));
    } catch {
      // localStorage unavailable — the slider still works, just won't
      // remember the setting across reloads.
    }
  };
  window.hamrcSetRemoteTxActive = (active) => {
    remoteTxActive = active;
  };

  // One AUDIO button (on/off) plus a codec dropdown in the audio settings
  // overlay (Nutzer-Wunsch 2026-10-11; before: separate PCM and OPUS buttons).
  const audioButton = document.getElementById("audio-button");
  const codecSelect = document.getElementById("audio-codec");
  // Record button only makes sense while RX audio is actually playing (2026-10-12
  // user request) — app.js owns that button but has no visibility into activeMode,
  // so it's told through this bridge, same pattern as hamrcSetNowPlaying etc.
  function setAudioActive(active) {
    audioButton.classList.toggle("active", active);
    if (window.hamrcOnAudioActiveChanged) window.hamrcOnAudioActiveChanged(active);
  }
  const CODEC_KEY = "open890rc.rxCodec";
  function loadCodec() {
    try {
      const v = localStorage.getItem(CODEC_KEY);
      if (v === "pcm" || v === "opus") return v;
    } catch {
      // default
    }
    return "opus"; // same default as the former auto start
  }
  let selectedCodec = loadCodec();
  codecSelect.value = selectedCodec;

  let audioCtx = null;
  let workletNode = null;
  let ws = null;
  let opusDecoder = null;
  let opusTimestamp = 0;
  let activeMode = null; // "pcm" | "opus" | null

  // Real <audio> element carrying the ACTUAL RX audio (not a silent decoy —
  // see below for why that was replaced). iOS Safari only keeps a
  // background/locked-screen tab's JS (and with it our WebSocket +
  // AudioWorklet-based playback) alive if the page has a real, unmuted
  // <audio>/<video> element actively playing at the moment it backgrounds —
  // a Web Audio API graph (AudioContext -> destination) alone does NOT
  // count, confirmed live: locking the phone during PCM/Opus playback killed
  // the audio entirely, and didn't even show the Media Session lock-screen
  // controls set up above (iOS considered the page to have no legitimate
  // ongoing playback at all, not just muted it).
  // First attempt (2026-09-27) used a tiny looping SILENT WAV on its own,
  // otherwise-unused <audio> element purely to satisfy that check, with the
  // real sound still going straight to audioCtx.destination as before.
  // Nutzer bestätigt (2026-09-29): that did NOT fix it — playback still died
  // on lock, no lock-screen controls appeared. Most likely reason: modern
  // iOS versions specifically detect and disregard silent/near-silent
  // looping clips used exactly for this purpose (a widely-known, widely-
  // abused hack Apple has since cracked down on) — nothing was necessarily
  // implemented wrong, the technique itself stopped working.
  // Fix: route the REAL RX audio through this element instead of straight to
  // audioCtx.destination (see ensurePlayer) — workletNode connects to a
  // MediaStreamAudioDestinationNode, whose stream becomes this element's
  // srcObject. iOS then sees genuine, audible media playing, indistinguish-
  // able from any real music-streaming PWA (the operator's own comparison —
  // "so wie es Musikplayer ja auch haben") rather than a hack to detect.
  // Appended (hidden) to the DOM rather than left detached, matching the
  // common recommendation for this pattern's reliability on iOS.
  const streamAudioEl = new Audio();
  streamAudioEl.style.display = "none";
  document.body.appendChild(streamAudioEl);
  // Re-assert the "live, not seekable" position state (markLive, defined
  // below) once the element's OWN "playing" event actually fires, not just
  // once right after calling .play() in startPCM/startOpus. Nutzer-Report,
  // 2026-09-29: RX audio surviving the lock screen now works (see the real
  // <audio> element above), but the OS's skip-back/skip-forward controls
  // came back — likely because iOS reads its live/seekable state off the
  // element itself, and that wasn't necessarily settled yet at the exact
  // moment .play() was called with a freshly assigned MediaStream srcObject.
  // Calling markLive() again once "playing" fires is a low-cost extra
  // assertion at a point the element is definitely actually running.
  streamAudioEl.addEventListener("playing", () => markLive());

  // Media Session API: shows "now playing" info (frequency/mode as the
  // title) in the lock screen/control center/CarPlay etc., and lets
  // hardware media keys or a headset's play/pause button control the
  // stream, same as any other web audio/video player. Purely cosmetic/
  // convenience — playback itself works identically without it, this just
  // makes it look and behave like a real live stream to the OS instead of
  // an anonymous background tab making noise.
  let nowPlayingTitle = "TS-890S";
  let nowPlayingSubtitle = "";
  let nowPlayingNR = "";
  // The album line normally just names the app; while the status line has
  // something to say (errors, PA alarms, "Keine Verbindung", ...) it shows
  // that instead — same text, same on/off timing as app.js's own #status-info
  // (statusMessageFor already ranks/expires messages there; this just mirrors
  // whatever it currently reads), so an operator glancing at the lock screen
  // sees the same warning they'd see on the page (Nutzer-Wunsch, 2026-10-12).
  let nowPlayingAlbum = "";
  function updateMediaSessionMetadata() {
    if (!("mediaSession" in navigator)) return;
    // Stream type (PCM/Opus) rides along on the artist line too (Nutzer-
    // Wunsch, 2026-09-29) — appended here rather than passed in from app.js,
    // since only this file knows which codec (activeMode) is actually
    // running right now. The NR mode (Nutzer-Wunsch, 2026-10-07; "" when NR
    // is off) comes from app.js (nowPlayingNR, set via hamrcSetNowPlaying's
    // 3rd argument) but still goes at the very end, after the codec — app.js
    // doesn't know the codec, so it can't place it there itself.
    const codec = activeMode ? activeMode.toUpperCase() : "";
    let artist = nowPlayingSubtitle && codec ? `${nowPlayingSubtitle} · ${codec}` : nowPlayingSubtitle || codec;
    if (nowPlayingNR) artist = artist ? `${artist} + ${nowPlayingNR}` : nowPlayingNR;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlayingTitle,
      artist,
      album: nowPlayingAlbum || "Open890RC",
      // Without this, the OS Now Playing widget falls back to a tiny
      // generic placeholder instead of real cover art (Nutzer-Report,
      // 2026-09-29, screenshot comparison against another app's much
      // bigger artwork) — MediaMetadata never had an artwork entry at all.
      // Reuses the same icon already embedded for the site favicon/home-
      // screen icon (apple-touch-icon.png, 180x180) rather than a separate
      // asset.
      artwork: [{ src: "apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    });
  }
  window.hamrcSetNowPlaying = function (title, subtitle, nr) {
    nowPlayingTitle = title;
    nowPlayingSubtitle = subtitle;
    nowPlayingNR = nr || "";
    if (activeMode) updateMediaSessionMetadata();
  };
  window.hamrcSetStatusAlbum = function (text) {
    nowPlayingAlbum = text || "";
    if (activeMode) updateMediaSessionMetadata();
  };
  // Declares this a live stream to the OS (Nutzer-Wunsch, 2026-09-29): with
  // no position state set at all, macOS/iOS' Now Playing widget showed
  // rewind/fast-forward controls by default, which make no sense for a live
  // feed with nothing to seek through. duration:Infinity is the documented
  // Media Session signal for "live, not seekable" — replaces those with a
  // live indicator instead. Nutzer-Report, 2026-09-29: on a real iPhone the
  // 10-second skip buttons stayed regardless (iOS falling back to its own
  // defaults for an "unhandled" seek action, even with duration:Infinity set)
  // — rather than keep fighting that, they now do something useful: step the
  // VFO by 1kHz, see the seekbackward/seekforward/previoustrack/nexttrack
  // handlers below (repurposed since suppressing them outright didn't work).
  function markLive() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      navigator.mediaSession.setPositionState({ duration: Infinity, playbackRate: 1, position: 0 });
    } catch {
      // Some engines throw for unsupported position-state shapes — cosmetic
      // feature, fine to just skip it there.
    }
  }
  let lastActiveMode = "pcm";
  if ("mediaSession" in navigator) {
    // "play" resumes whichever codec was last active (falls back to PCM if
    // the stream was never started yet this session); "pause"/"stop" both
    // just stop — there's no meaningful paused-but-resumable state here,
    // it's a live feed, not seekable media.
    navigator.mediaSession.setActionHandler("play", () => {
      audioShouldBeRunning = true;
      if (lastActiveMode === "opus") startOpus();
      else startPCM();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      audioShouldBeRunning = false;
      stop();
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      audioShouldBeRunning = false;
      stop();
    });
  }

  // Track-skip keys (arrows) instead of the 10-second seek keys: step the VFO
  // by 1kHz. Per a working setup elsewhere (tip, 2026-10-03): iOS shows the
  // arrows only when previoustrack/nexttrack handlers exist and NO
  // seekbackward/seekforward handlers do — and the handlers must be set while
  // the <audio> element is already playing, i.e. after play(), not at page
  // load (the 2026-09-29 attempt registered them at load, which is why iOS
  // ignored them). So this runs from the element's "playing" event and after
  // each start; seek handlers are explicitly cleared.
  // window.hamrcStepFreq is app.js's bridge (reuses the frequency digits' path).
  function registerSkipHandlers() {
    if (!("mediaSession" in navigator)) return;
    const stepDown = () => window.hamrcStepFreq && window.hamrcStepFreq(-1000);
    const stepUp = () => window.hamrcStepFreq && window.hamrcStepFreq(1000);
    for (const [action, handler] of [
      ["seekbackward", null],
      ["seekforward", null],
      ["previoustrack", stepDown],
      ["nexttrack", stepUp],
    ]) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every engine supports every action — fine to just skip it there.
      }
    }
  }
  streamAudioEl.addEventListener("playing", registerSkipHandlers);

  function wsProto() {
    return location.protocol === "https:" ? "wss" : "ws";
  }

  // Continuous-phase linear resampler. Only a fallback for browsers that
  // won't give us an AudioContext running natively at the radio's 16kHz
  // (see ensurePlayer; ensureMicCapture forces the same rate on the TX side
  // and no longer needs this at all) — a naive per-block resample that
  // restarts its phase at 0 for every incoming chunk creates a tiny
  // discontinuity at every block boundary (audible as crackling, since
  // 16kHz never divides evenly into 44.1/48kHz) and precision degrades if
  // the read position is instead tracked as an ever-growing summed float.
  // Both are avoided here by carrying the fractional phase (always kept
  // small, by rebasing it against a short rolling buffer) across calls
  // instead of resetting or letting it grow unbounded.
  function makeContinuousResampler() {
    let pending = new Float32Array(0);
    let phase = 0;
    return function resample(samples, fromRate, toRate) {
      if (fromRate === toRate) return samples;
      const ratio = toRate / fromRate;

      const buf = new Float32Array(pending.length + samples.length);
      buf.set(pending, 0);
      buf.set(samples, pending.length);

      const lastValidSrcPos = buf.length - 1;
      const outLen = Math.max(0, Math.floor((lastValidSrcPos - phase) * ratio) + 1);

      const out = new Float32Array(outLen);
      let srcPos = phase;
      for (let i = 0; i < outLen; i++) {
        const i0 = Math.floor(srcPos);
        const i1 = i0 + 1;
        const frac = srcPos - i0;
        out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
        srcPos += 1 / ratio;
      }

      const keepFrom = Math.floor(srcPos);
      pending = buf.slice(keepFrom);
      phase = srcPos - keepFrom;

      return out;
    };
  }

  let resampleFloat = makeContinuousResampler();
  function resetResampler() {
    resampleFloat = makeContinuousResampler();
    rnnoiseUpsample = makeContinuousResampler();
    rnnoisePending = new Float32Array(0);
  }

  // Optional RX noise suppression (RNNoise, Nutzer-Wunsch 2026-10-07),
  // off by default, toggled by the "RNnoise" button next to PROC. Runs on
  // the MAIN THREAD, not inside pcm-player-processor.js's AudioWorklet —
  // same reasoning as the TX mic path's resampling/framing (see
  // handleMicChunk's own comment): the worklet has a hard real-time
  // deadline a WASM/RNN call could jeopardize, the main thread doesn't.
  //
  // RNNoise (github.com/xiph/rnnoise, WASM build from @jitsi/rnnoise-wasm —
  // the same build Jitsi Meet itself ships for this exact purpose) is fixed
  // to 48kHz, 480-sample (10ms) frames — fromRate is resampled up to that
  // (a SEPARATE continuous resampler from resampleFloat above: mixing two
  // different fromRate/toRate pairs through one continuous resampler would
  // corrupt its carried-over fractional phase) regardless of the radio's own
  // rate, denoised frame by frame, then handed to the existing
  // resampleFloat/playback path same as undenoised audio would be — so this
  // adds a small, constant extra latency (well under one 480-sample frame)
  // but no new resampling path beyond what already existed.
  //
  // The library's C API takes/returns float samples scaled like 16-bit PCM
  // (i.e. roughly +-32768), not Web Audio's normalized +-1.0 — confirmed
  // against the upstream rnnoise_demo.c, which reads int16 samples and casts
  // straight to float with no normalization — so samples are scaled by
  // 32768 going in and back down coming out, same convention handleMicChunk
  // already uses the other way for the TX path.
  const RNNOISE_RATE = 48000;
  const RNNOISE_FRAME_SAMPLES = 480;
  const RNNOISE_KEY = "open890rc.rnnoise";
  let rnnoiseEnabled = false;
  try {
    rnnoiseEnabled = localStorage.getItem(RNNOISE_KEY) === "1";
  } catch {
    // default
  }
  let rnnoiseModule = null;
  let rnnoiseState = 0;
  let rnnoiseInPtr = 0;
  let rnnoiseOutPtr = 0;
  let rnnoiseLoadPromise = null;
  let rnnoiseUpsample = makeContinuousResampler();
  let rnnoisePending = new Float32Array(0);

  // ensureRNNoise can be re-entered while a previous call is still in-flight
  // (toggled off then on again before loading finished) — rnnoiseLoadPromise
  // caches the single in-flight attempt instead of starting a second,
  // redundant module load. Same bug class/fix as ensureMicCapture's own
  // concurrency guard earlier this session, applied preemptively here.
  async function ensureRNNoise() {
    if (rnnoiseModule) return;
    if (rnnoiseLoadPromise) return rnnoiseLoadPromise;
    rnnoiseLoadPromise = (async () => {
      const { default: createRNNWasmModuleSync } = await import("./rnnoise/rnnoise-sync.js");
      const mod = createRNNWasmModuleSync();
      await mod.ready;
      const state = mod._rnnoise_create(0);
      const inPtr = mod._malloc(RNNOISE_FRAME_SAMPLES * 4);
      const outPtr = mod._malloc(RNNOISE_FRAME_SAMPLES * 4);
      rnnoiseModule = mod;
      rnnoiseState = state;
      rnnoiseInPtr = inPtr;
      rnnoiseOutPtr = outPtr;
    })();
    try {
      await rnnoiseLoadPromise;
    } catch (e) {
      console.error("audio: RNNoise failed to load, RX denoising disabled", e);
      rnnoiseEnabled = false;
    } finally {
      rnnoiseLoadPromise = null;
    }
  }

  // Denoises one exact RNNOISE_FRAME_SAMPLES frame in place into out
  // (separate array: RNNoise's own C API takes distinct in/out buffers).
  // Re-reads Module.HEAPF32 on every call rather than caching it once — an
  // Emscripten heap can grow and detach earlier typed array views, though
  // unlikely to ever happen here given RNNoise's small, fixed memory use.
  function denoiseFrame(inFrame, out, outOffset) {
    const heap = rnnoiseModule.HEAPF32;
    const inIdx = rnnoiseInPtr / 4;
    const outIdx = rnnoiseOutPtr / 4;
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) {
      heap[inIdx + i] = inFrame[i] * 32768;
    }
    rnnoiseModule._rnnoise_process_frame(rnnoiseState, rnnoiseOutPtr, rnnoiseInPtr);
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) {
      out[outOffset + i] = heap[outIdx + i] / 32768;
    }
  }

  // Accumulates arbitrarily-sized 48kHz chunks into exact
  // RNNOISE_FRAME_SAMPLES frames (same accumulate-then-emit pattern as the
  // TX path's handleMicChunk), denoises each complete one, and returns
  // however many denoised samples are ready — any remainder stays buffered
  // for the next call.
  function runRNNoise(samples48k) {
    const merged = new Float32Array(rnnoisePending.length + samples48k.length);
    merged.set(rnnoisePending, 0);
    merged.set(samples48k, rnnoisePending.length);

    const frameCount = Math.floor(merged.length / RNNOISE_FRAME_SAMPLES);
    const out = new Float32Array(frameCount * RNNOISE_FRAME_SAMPLES);
    for (let f = 0; f < frameCount; f++) {
      denoiseFrame(merged.subarray(f * RNNOISE_FRAME_SAMPLES, (f + 1) * RNNOISE_FRAME_SAMPLES), out, f * RNNOISE_FRAME_SAMPLES);
    }
    rnnoisePending = merged.slice(frameCount * RNNOISE_FRAME_SAMPLES);
    return out;
  }

  window.hamrcGetRNNoise = () => rnnoiseEnabled;
  window.hamrcSetRNNoise = function (enabled) {
    rnnoiseEnabled = !!enabled;
    try {
      localStorage.setItem(RNNOISE_KEY, rnnoiseEnabled ? "1" : "0");
    } catch {
      // valid for this page only
    }
    // Fresh phase/buffer rather than carrying over state from before the
    // toggle — this path wasn't necessarily even running a moment ago.
    rnnoiseUpsample = makeContinuousResampler();
    rnnoisePending = new Float32Array(0);
    if (rnnoiseEnabled) ensureRNNoise().catch(() => {});
  };

  // Bug found live, 2026-10-08: restoring rnnoiseEnabled from localStorage
  // above does NOT by itself load the WASM module — only an actual click
  // through hamrcSetRNNoise did that. A page load that restored
  // rnnoiseEnabled=true from a previous session showed "AI NR" immediately
  // (the UI only checks the flag) while audio stayed unprocessed
  // (pushSamples also requires rnnoiseModule, which stayed null until the
  // operator toggled the button once, incidentally triggering a load).
  // Kick the load off here too, matching what an "on" state actually needs
  // — placed after every relevant `let` above, not next to where the flag
  // is first read, since ensureRNNoise touches rnnoiseModule/rnnoiseState/
  // etc. synchronously on its very first line and calling it any earlier
  // would hit those while still in their temporal dead zone.
  if (rnnoiseEnabled) ensureRNNoise().catch(() => {});

  // No dedicated button here — folded into the main screen's NR cycle
  // button as its 4th step ("AI NR", Nutzer-Wunsch, 2026-10-07), see
  // nrCycle in app.js. hamrcGetRNNoise/hamrcSetRNNoise above are what that
  // button actually drives.

  // The radio sends little-endian 16-bit signed samples. (Verified against
  // a raw packet capture: decoding as big-endian produced implausible
  // sample-to-sample swings between large positive/negative values; this
  // ordering gives a smooth, plausible waveform.)
  function decodePCM16LE(bytes) {
    const out = new Float32Array(bytes.length / 2);
    for (let i = 0; i < out.length; i++) {
      let v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
      if (v > 32767) v -= 65536;
      out[i] = v / 32768;
    }
    return out;
  }

  // Latency readout (#audio-latency in app.js): unplayed backlog in the
  // worklet's ring buffer (reported by the worklet), the browser's own
  // output latency, and (Opus only) the WebCodecs decode time.
  let bufferedSeconds = 0;
  let opusDecodeMs = null; // null until the first packet was decoded
  let opusDecodeStartTimes = [];
  window.hamrcGetAudioLatency = function () {
    if (!activeMode || !audioCtx) return null;
    const outputSeconds = (audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0);
    return {
      mode: activeMode,
      bufferMs: bufferedSeconds * 1000,
      outputMs: outputSeconds * 1000,
      decodeMs: activeMode === "opus" ? opusDecodeMs : 0, // null = nothing decoded yet
    };
  };

  // Limits of the RX playback buffer (see pcm-player-processor.js): trim once the
  // backlog passes `trigger` seconds, back down to `target`. Set in the Setup
  // window, kept per browser.
  const RX_TRIM_KEY = "hamrc.rxTrim";
  const RX_TRIM_DEFAULT = { trigger: 0.7, target: 0.1 };
  let rxTrim = { ...RX_TRIM_DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(RX_TRIM_KEY));
    if (saved && saved.trigger >= 0.2 && saved.target >= 0.05 && saved.target <= saved.trigger - 0.05) {
      rxTrim = { trigger: saved.trigger, target: saved.target };
    }
  } catch {
    // no/invalid saved value: defaults
  }
  window.hamrcGetRxTrim = () => ({ ...rxTrim });
  window.hamrcSetRxTrim = (trigger, target) => {
    rxTrim = { trigger, target };
    try {
      localStorage.setItem(RX_TRIM_KEY, JSON.stringify(rxTrim));
    } catch {
      // storage unavailable: valid for this page only
    }
    if (workletNode) workletNode.port.postMessage({ config: rxTrim });
  };

  // Servo slip (see pcm-player-processor.js): drift compensation in the playback
  // worklet, on by default, switchable in the Setup window (per browser). Off =
  // plain playback with silence on underrun and a hard trim.
  const RX_SLIP_KEY = "hamrc.rxServoSlip";
  let rxServoSlip = true;
  try {
    if (localStorage.getItem(RX_SLIP_KEY) === "0") rxServoSlip = false;
  } catch {
    // default
  }
  const rxMode = () => (rxServoSlip ? "slip" : "plain");
  window.hamrcGetRxServoSlip = () => rxServoSlip;
  window.hamrcSetRxServoSlip = (enabled) => {
    rxServoSlip = !!enabled;
    try {
      localStorage.setItem(RX_SLIP_KEY, rxServoSlip ? "1" : "0");
    } catch {
      // valid for this page only
    }
    if (workletNode) workletNode.port.postMessage({ mode: rxMode() });
  };

  async function ensurePlayer() {
    if (audioCtx) return;
    // Ask for a context running natively at the radio's own rate: then the
    // browser's own continuous, high-quality resampler does the one-time
    // conversion up to the hardware's output rate, instead of us naively
    // resampling every incoming network chunk on its own (see resampleFloat
    // above for what goes wrong there). Not all browsers honor a custom
    // rate — pushSamples checks the actual resulting sampleRate and falls
    // back to resampling itself when it doesn't match.
    try {
      audioCtx = new AudioContext({ sampleRate: RADIO_SAMPLE_RATE });
    } catch {
      audioCtx = new AudioContext();
    }
    resetResampler();
    bufferedSeconds = 0;
    // Routed through streamAudioEl (see its own comment above) instead of
    // straight to audioCtx.destination, so a real <audio> element is what's
    // actually making the sound — required for iOS to treat this as
    // legitimate background-playable media. The destination/element are set
    // up and resume()/play() are called HERE, before the await below, not
    // after: iOS/WebKit only associates this call's user gesture (the TON
    // button click that got us into ensurePlayer in the first place) with a
    // resume()/play() made synchronously (or via plain microtasks) right
    // after it — a genuine async yield like audioWorklet.addModule() below
    // loses that association, leaving the context/element permanently
    // "pending" until some unrelated later tap happens to trigger
    // armAudioUnlock()'s fallback (Nutzer-Report, 2026-10-14, iPhone: TON
    // showed active but no sound, and the server logged a "browser buffer
    // trimmed" line for nearly every incoming Opus packet — the worklet was
    // receiving and buffering fine, just never being read because the
    // context was never actually running). The destination is valid (if
    // silent) before workletNode exists, so play() has real media to attach
    // to right away; workletNode.connect(dest) below then just starts
    // feeding an element that's already unlocked and playing.
    const dest = audioCtx.createMediaStreamDestination();
    streamAudioEl.srcObject = dest.stream;
    audioCtx.resume().catch(() => {});
    streamAudioEl.play().catch((e) => {
      // Autoplay blocked (page just loaded, no user gesture yet, or too long
      // ago, e.g. audio auto-started after a radio power-on) — armAudioUnlock
      // below remains the fallback for this case.
      console.error("audio: starting playback element failed", e);
    });
    await audioCtx.audioWorklet.addModule("pcm-player-processor.js");
    workletNode = new AudioWorkletNode(audioCtx, "pcm-player-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    workletNode.port.postMessage({ config: rxTrim });
    workletNode.port.postMessage({ mode: rxMode() });
    workletNode.port.onmessage = (event) => {
      if (event.data && typeof event.data.bufferedSeconds === "number") bufferedSeconds = event.data.bufferedSeconds;
      if (event.data && event.data.trimmed && window.hamrcReportTrim) {
        window.hamrcReportTrim(event.data.trimmed.before, event.data.trimmed.after, activeMode);
      }
    };
    workletNode.connect(dest);
    attachRxToRecording(); // a running recording survives an RX restart
    armAudioUnlock();
  }

  // Without a user gesture the context/element stay blocked (iOS: pending
  // forever instead of failing). The stream is already set up, so on every
  // gesture retry both — and keep retrying until sound is really running.
  // iOS only accepts touchend/click as a gesture (NOT pointerdown/touchstart),
  // and a single failed retry must not disarm the listeners.
  const UNLOCK_EVENTS = ["touchend", "click", "pointerup", "keydown"];
  let unlockArmed = false;
  function audioRunning() {
    return !!audioCtx && audioCtx.state === "running" && !streamAudioEl.paused;
  }
  function disarmAudioUnlock() {
    if (!unlockArmed) return;
    unlockArmed = false;
    for (const ev of UNLOCK_EVENTS) document.removeEventListener(ev, onUnlockGesture, true);
  }
  function onUnlockGesture() {
    if (!audioCtx) {
      disarmAudioUnlock();
      return;
    }
    const resumed = audioCtx.resume().catch(() => {});
    const played = streamAudioEl.play().catch(() => {});
    Promise.all([resumed, played]).then(() => {
      if (audioRunning() || !audioCtx) disarmAudioUnlock();
    });
  }
  function armAudioUnlock() {
    if (unlockArmed || audioRunning()) return;
    unlockArmed = true;
    for (const ev of UNLOCK_EVENTS) document.addEventListener(ev, onUnlockGesture, true);
  }

  function applyGain(samples, gain) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    }
    return out;
  }

  // fromRate is the ACTUAL sample rate of `samples`, not an assumption.
  // Root-caused live (2026-09-28, "Opus RX sehr langsam auf Chromium/
  // Ubuntu, nicht auf iPhone/Mac"): WebCodecs AudioDecoder, configured for
  // opus @ 16000Hz (see startOpus), silently decodes at 48000Hz on
  // Chromium regardless — verified directly against a real Opus packet
  // from our own server-side encoder in this project's own Chromium-based
  // browser tool: audioData.sampleRate came back 48000 with 960 frames for
  // the same 20ms an honored 16000Hz config would've given 320 frames for.
  // The previous version of this function always assumed RADIO_SAMPLE_RATE
  // (16000) regardless of where the samples actually came from, so those
  // 960 samples got treated as 60ms of 16kHz audio instead of the true
  // 20ms of 48kHz audio — 3x too many samples played out per real 20ms
  // chunk, i.e. exactly 1/3 speed. Safari/WebKit apparently DOES honor the
  // requested rate (no reports from iPhone/Mac), so this only ever showed
  // up on Chromium.
  // Diagnostic (2026-10-07, rare client-reported "Klatschen" with no
  // corresponding radio->server UDP loss): measures gaps between calls to
  // this shared PCM/Opus chokepoint. A gap here right before a worklet
  // underrun warning would point at a server->browser delivery stall
  // (WebSocket/main-thread), not at anything upstream of the server.
  let lastPushTime = 0;
  function pushSamples(samples, fromRate) {
    if (rxMuted) return;
    // iOS: before the unlock gesture actually lands (see ensurePlayer/
    // armAudioUnlock above), audioCtx stays "suspended" — its worklet never
    // runs process(), so nothing ever drains what pushSamples feeds it, and
    // the ring buffer fills to the trim threshold on essentially every
    // incoming packet (Nutzer-Report, 2026-10-14: continuous "browser buffer
    // trimmed" log lines, several per second, persisting even before any tap
    // happened at all — not something the ensurePlayer reordering above can
    // fix, since without ANY gesture yet there is genuinely nothing to
    // associate resume()/play() with). Dropping samples here instead of
    // posting them into a buffer nobody can read yet avoids that pointless
    // fill-and-trim churn (and the matching log spam) — normal pushing
    // resumes by itself on the first call after the context actually starts
    // running, with an empty buffer rather than a stale backlog.
    if (!audioCtx || audioCtx.state !== "running") return;
    const now = performance.now();
    if (lastPushTime && now - lastPushTime > 50) {
      console.warn("rx audio push gap " + (now - lastPushTime).toFixed(0) + "ms");
    }
    lastPushTime = now;

    let toPlay = samples;
    let toPlayRate = fromRate;
    if (rnnoiseEnabled && rnnoiseModule) {
      toPlay = runRNNoise(rnnoiseUpsample(samples, fromRate, RNNOISE_RATE));
      toPlayRate = RNNOISE_RATE;
    }

    const boosted = applyGain(toPlay, remoteTxActive ? txRelayVolumePercent / 100 : playbackGain);
    const resampled =
      audioCtx.sampleRate === toPlayRate ? boosted : resampleFloat(boosted, toPlayRate, audioCtx.sampleRate);
    workletNode.port.postMessage(resampled, [resampled.buffer]);
  }

  // restart = true: an internal teardown right before startPCM/startOpus
  // builds the player again (post-TX RX rebuild, codec switch, reset button).
  // The audio is not "off" in that case, so the active state is left alone —
  // otherwise app.js saw an "inactive" blip and ended a running recording at
  // every TX release (bug found 2026-10-15).
  function stop(restart = false) {
    const wasActive = activeMode;
    activeMode = null;
    if (!restart) {
      setAudioActive(false);
      if (window.hamrcReportAudioCodec) window.hamrcReportAudioCodec("");
    }

    if (ws) {
      ws.close();
      ws = null;
    }
    if (opusDecoder) {
      try {
        opusDecoder.close();
      } catch {
        // already closed
      }
      opusDecoder = null;
    }
    detachRxFromRecording();
    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    resetResampler();
    streamAudioEl.pause();
    streamAudioEl.srcObject = null;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    return wasActive;
  }

  // startPCM/startOpus (below) are called automatically on every TX release
  // (see hamrcSetMicStreaming's comment further down for why) in addition to
  // the manual button clicks and the reset button — so two calls can fire in
  // quick succession (e.g. two fast PTT cycles) before the first one's
  // `await ensurePlayer()` has finished. ensurePlayer's own guard
  // (`if (audioCtx) return`) doesn't protect against that: stop() nulls
  // audioCtx synchronously, so a second call's stop() can close the FIRST
  // call's audioCtx out from under it while its addModule() is still
  // pending, corrupting both. audioRestartChain serializes every call
  // through startPCM/startOpus so one restart always fully finishes (or
  // fails) before the next one's stop() even runs, regardless of which
  // call site triggered it.
  let audioRestartChain = Promise.resolve();
  function serializeRestart(fn) {
    const run = audioRestartChain.then(fn, fn);
    audioRestartChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function startPCM() {
    return serializeRestart(startPCMNow);
  }

  async function startPCMNow() {
    stop(true);
    try {
      await ensurePlayer();
    } catch (e) {
      setAudioActive(false);
      throw e;
    }

    ws = new WebSocket(`${wsProto()}://${location.host}/audio-ws?codec=pcm`);
    ws.binaryType = "arraybuffer";

    ws.onclose = () => {
      if (activeMode === "pcm") stop();
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      window.hamrcReportTraffic(event.data.byteLength, "audio");
      pushSamples(decodePCM16LE(new Uint8Array(event.data)), RADIO_SAMPLE_RATE);
    };

    activeMode = "pcm";
    lastActiveMode = "pcm";
    setAudioActive(true);
    if (window.hamrcReportAudioCodec) window.hamrcReportAudioCodec("pcm");
    updateMediaSessionMetadata();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    markLive();
    registerSkipHandlers();
    warmMic();
  }

  async function startOpus(silent = false) {
    return serializeRestart(() => startOpusNow(silent));
  }

  async function startOpusNow(silent) {
    if (typeof AudioDecoder === "undefined") {
      if (!silent) window.alert(window.t("Opus wird von diesem Browser nicht unterstützt (WebCodecs AudioDecoder fehlt)."));
      return;
    }

    stop(true);
    try {
      await ensurePlayer();
    } catch (e) {
      setAudioActive(false);
      throw e;
    }

    opusTimestamp = 0;
    opusDecodeStartTimes = [];
    opusDecodeMs = null;
    opusDecoder = new AudioDecoder({
      output: (audioData) => {
        const startedAt = opusDecodeStartTimes.shift();
        if (startedAt !== undefined) {
          const ms = performance.now() - startedAt;
          opusDecodeMs = opusDecodeMs === null ? ms : opusDecodeMs * 0.9 + ms * 0.1;
        }
        const float32 = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(float32, { planeIndex: 0, format: "f32-planar" });
        const decodedRate = audioData.sampleRate;
        audioData.close();
        pushSamples(float32, decodedRate);
      },
      error: (e) => console.error("audio: opus decode error", e),
    });
    opusDecoder.configure({
      codec: "opus",
      sampleRate: RADIO_SAMPLE_RATE,
      numberOfChannels: 1,
    });

    ws = new WebSocket(`${wsProto()}://${location.host}/audio-ws?codec=opus`);
    ws.binaryType = "arraybuffer";

    ws.onclose = () => {
      if (activeMode === "opus") stop();
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      window.hamrcReportTraffic(event.data.byteLength, "audio");
      opusDecodeStartTimes.push(performance.now());
      if (opusDecodeStartTimes.length > 50) opusDecodeStartTimes.shift();
      opusDecoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: opusTimestamp,
          data: event.data,
        })
      );
      opusTimestamp += OPUS_FRAME_MS * 1000;
    };

    activeMode = "opus";
    lastActiveMode = "opus";
    setAudioActive(true);
    if (window.hamrcReportAudioCodec) window.hamrcReportAudioCodec("opus");
    updateMediaSessionMetadata();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    markLive();
    registerSkipHandlers();
    warmMic();
  }

  // Desired state, separate from activeMode (the actual current codec or
  // null): only an explicit on/off (button, media-session pause/stop) ever
  // changes this. stop() itself also fires for reasons that are NOT a user
  // wish to be off — an internal restart, a codec switch, or the WS simply
  // dropping (iOS is known to kill a backgrounded tab's WebSocket, e.g.
  // while a download/share sheet from the Record feature has focus,
  // 2026-10-12 user report: RX audio was off and the button unlit after
  // returning to the page). Those must leave this flag alone so the
  // visibilitychange handler below knows to reconnect automatically.
  let audioShouldBeRunning = false;
  function startSelected(auto) {
    audioShouldBeRunning = true;
    if (selectedCodec === "pcm") return startPCM(auto);
    return startOpus(auto);
  }

  audioButton.addEventListener("click", () => {
    if (activeMode) {
      audioShouldBeRunning = false;
      stop();
    } else startSelected();
  });

  // Tab regains visibility (e.g. after the Record download's share/preview
  // sheet, or iOS backgrounding the tab for any other reason) and audio was
  // supposed to be running but the stream died in the meantime: reconnect
  // it the same way the "reset RX audio" path does, no user action needed.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioShouldBeRunning && !activeMode) startSelected(true);
  });

  // Changing the codec while audio runs restarts it with the new one.
  codecSelect.addEventListener("change", () => {
    selectedCodec = codecSelect.value === "pcm" ? "pcm" : "opus";
    try {
      localStorage.setItem(CODEC_KEY, selectedCodec);
    } catch {
      // valid for this page only
    }
    if (activeMode && activeMode !== selectedCodec) {
      stop();
      startSelected();
    }
  });

  // app.js: start RX audio ("Mobil", Opus) by itself once the radio is up. A
  // browser may block playback without a user gesture; ensurePlayer then keeps
  // the stream ready and starts playing on the first click/tap/key on the page.
  window.hamrcAutoStartAudio = function () {
    if (!activeMode) startSelected(true);
  };

  // "PCM" / "OPUS" while audio runs, "" otherwise (traffic overlay label).
  window.hamrcAudioCodec = function () {
    return activeMode ? activeMode.toUpperCase() : "";
  };

  window.hamrcAudioActive = function () {
    return !!activeMode;
  };
  // app.js: stop RX audio when the radio connection goes away.
  window.hamrcStopAudioForRadioOff = function () {
    if (activeMode) stop();
  };

  // Mic audio for TX. Captured once permission is granted and kept running
  // afterward — re-acquiring the stream (and re-prompting, on some browsers)
  // on every PTT press would add latency right when it matters most. Only
  // actually SENT to the server while TX is active, via a WebSocket opened
  // on key-down and closed on key-up. Codec follows whichever RX button
  // (PCM/Mobil) is currently active — "the codec selected below" — and
  // defaults to PCM if neither is (e.g. TX pressed before RX ever started).
  const MIC_OPUS_BITRATE = 16000;
  const MIC_FRAME_SAMPLES = 320; // 20ms at 16kHz — the radio's required TX frame size
  // Needed gain is very device-dependent (mic hardware varies a lot without
  // AGC to normalize it) — this is a starting point, adjustable in the
  // connect/setup overlay's "Browser Mic Gain" slider, not a universal
  // constant. Confirmed clean (2026-10-07, without the limiter below) on a
  // Mac's built-in mic at 1.5x and an iPhone's at 2.0x. MIC_GAIN_MAX was
  // briefly raised to 3.0x the same day, reverted right back — too loud.
  const MIC_GAIN_DEFAULT = 1.5;
  const MIC_GAIN_MAX = 2.5; // keep in sync with app.js's own MIC_GAIN_MAX (tenths)
  let micCtx = null;
  let micStream = null;
  let micWorklet = null;
  let micGainNode = null;
  let micChainOutNode = null; // final mic-chain node before micWorklet (gain, or the limiter when on) — tapped for recording, see "Recording" below
  let micGainValue = MIC_GAIN_DEFAULT;
  try {
    // Same key/format as app.js's mic gain slider (tenths).
    const saved = Number(localStorage.getItem("open890rc.micGain"));
    if (saved >= 1) micGainValue = Math.min(saved / 10, MIC_GAIN_MAX);
  } catch (e) {
    // localStorage unavailable — keep the default.
  }
  let micWs = null;
  let micOpusEncoder = null;
  let micTimestamp = 0;
  let micPending = new Float32Array(0);

  // Exported so app.js's mic gain slider can adjust this live, independent
  // of ensureMicCapture having run yet (a click before TX is first pressed
  // just updates the stored value; the node picks it up once created).
  window.hamrcSetMicGain = function (value) {
    micGainValue = Math.min(value, MIC_GAIN_MAX);
    if (micGainNode) micGainNode.gain.value = micGainValue;
    if (meterGainNode) meterGainNode.gain.value = micGainValue;
  };

  // Optional limiter between micGainNode and the worklet — see
  // ensureMicCapture's own comment for the history (an always-on,
  // aggressively-set one here used to make TX sound distorted/scratchy,
  // removed 2026-10-07; this gentler replacement added back 2026-10-11, on
  // by default). Threshold/ratio/attack are live-adjustable testweise-Regler
  // (Nutzer-Wunsch, 2026-10-14: the fixed values weren't audibly catching
  // mic peaks — "die kratzen total") — knee/release stay fixed at their
  // original values, not exposed. Applied live via micLimiterNode (the real
  // TX chain's limiter, once ensureMicCapture has run) AND meterLimiterNode
  // (the Setup window's level-meter limiter, see buildMeterChain below) so
  // adjusting a slider takes effect immediately, even mid-transmission, and
  // the on-screen meter stays an honest preview of what TX audio gets.
  const MIC_LIMITER_KEY = "open890rc.micLimiter";
  const MIC_LIMITER_THRESHOLD_KEY = "open890rc.micLimiterThreshold";
  const MIC_LIMITER_RATIO_KEY = "open890rc.micLimiterRatio";
  const MIC_LIMITER_ATTACK_KEY = "open890rc.micLimiterAttack";
  // On by default (Nutzer-Wunsch 2026-10-11); only an explicit "0" turns it off.
  let micLimiterEnabled = true;
  let micLimiterThresholdDb = -1;
  let micLimiterRatio = 6;
  let micLimiterAttackMs = 10;
  try {
    if (localStorage.getItem(MIC_LIMITER_KEY) === "0") micLimiterEnabled = false;
    // getItem returns null for a key that was never saved, and Number(null)
    // is 0 — indistinguishable from an actually-saved "0" unless checked
    // for explicitly first. Threshold's and attack's valid ranges both
    // include 0 at one end, so without this check a fresh browser profile
    // would silently read back as 0 dB / 0 ms instead of the real defaults
    // (-1 dB / 10 ms) — found live, 2026-10-14.
    const tRaw = localStorage.getItem(MIC_LIMITER_THRESHOLD_KEY);
    if (tRaw !== null) {
      const t = Number(tRaw);
      if (Number.isFinite(t) && t >= -24 && t <= 0) micLimiterThresholdDb = t;
    }
    const rRaw = localStorage.getItem(MIC_LIMITER_RATIO_KEY);
    if (rRaw !== null) {
      const r = Number(rRaw);
      if (r >= 1 && r <= 20) micLimiterRatio = r;
    }
    const aRaw = localStorage.getItem(MIC_LIMITER_ATTACK_KEY);
    if (aRaw !== null) {
      const a = Number(aRaw);
      if (Number.isFinite(a) && a >= 0 && a <= 50) micLimiterAttackMs = a;
    }
  } catch {
    // defaults
  }
  // "Mikrofon dauerhaft offenhalten" (opt-in, per browser): keeps the microphone chain
  // open between transmissions so a TX press only has to open the WebSocket.
  // Off = the old behaviour (mic released after every TX). Needed because
  // opening a Bluetooth mic makes the device switch to its headset profile,
  // which takes seconds; the price of keeping it open is that Bluetooth stays
  // in that profile (narrow-band playback) and iOS may keep its audio session
  // in play-and-record mode.
  const MIC_KEEP_WARM_KEY = "open890rc.micKeepWarm";
  let micKeepWarm = false;
  try {
    micKeepWarm = localStorage.getItem(MIC_KEEP_WARM_KEY) === "1";
  } catch {
    // default off
  }
  window.hamrcGetMicKeepWarm = () => micKeepWarm;
  let micLimiterNode = null;
  window.hamrcGetMicLimiter = () => micLimiterEnabled;
  window.hamrcSetMicLimiter = (enabled) => {
    micLimiterEnabled = !!enabled;
    if (meterCtx) buildMeterChain();
    try {
      localStorage.setItem(MIC_LIMITER_KEY, micLimiterEnabled ? "1" : "0");
    } catch {
      // valid for this page only
    }
  };
  window.hamrcGetMicLimiterThreshold = () => micLimiterThresholdDb;
  window.hamrcSetMicLimiterThreshold = (db) => {
    micLimiterThresholdDb = db;
    if (micLimiterNode) micLimiterNode.threshold.value = db;
    if (meterLimiterNode) meterLimiterNode.threshold.value = db;
    try {
      localStorage.setItem(MIC_LIMITER_THRESHOLD_KEY, String(db));
    } catch {
      // valid for this page only
    }
  };
  window.hamrcGetMicLimiterRatio = () => micLimiterRatio;
  window.hamrcSetMicLimiterRatio = (ratio) => {
    micLimiterRatio = ratio;
    if (micLimiterNode) micLimiterNode.ratio.value = ratio;
    if (meterLimiterNode) meterLimiterNode.ratio.value = ratio;
    try {
      localStorage.setItem(MIC_LIMITER_RATIO_KEY, String(ratio));
    } catch {
      // valid for this page only
    }
  };
  window.hamrcGetMicLimiterAttack = () => micLimiterAttackMs;
  window.hamrcSetMicLimiterAttack = (ms) => {
    micLimiterAttackMs = ms;
    if (micLimiterNode) micLimiterNode.attack.value = ms / 1000;
    if (meterLimiterNode) meterLimiterNode.attack.value = ms / 1000;
    try {
      localStorage.setItem(MIC_LIMITER_ATTACK_KEY, String(ms));
    } catch {
      // valid for this page only
    }
  };

  // Level meter for the Setup window (VOIP tab): measures the browser mic AFTER
  // Mic Gain (and the limiter, if on) — i.e. exactly what handleMicChunk will
  // hand to the radio link — so the Mic Gain slider can be set by eye. Its own
  // capture (separate stream/context) that only runs while the tab is shown,
  // independent of the TX capture below. The peak (dBFS) of the last ~64 ms is
  // reported every animation frame; null = no mic access.
  let meterCtx = null;
  let meterStream = null;
  let meterGainNode = null;
  let meterAnalyser = null;
  let meterLimiterNode = null;
  let meterRaf = 0;
  let meterCb = null;
  let meterSrc = null;
  function buildMeterChain() {
    if (meterGainNode) meterGainNode.disconnect();
    if (meterLimiterNode) meterLimiterNode.disconnect();
    meterGainNode = meterCtx.createGain();
    meterGainNode.gain.value = micGainValue;
    meterSrc.connect(meterGainNode);
    let out = meterGainNode;
    meterLimiterNode = null;
    if (micLimiterEnabled) {
      // Same settings as the TX chain's limiter (ensureMicCapture).
      meterLimiterNode = meterCtx.createDynamicsCompressor();
      meterLimiterNode.threshold.value = micLimiterThresholdDb;
      meterLimiterNode.knee.value = 10;
      meterLimiterNode.ratio.value = micLimiterRatio;
      meterLimiterNode.attack.value = micLimiterAttackMs / 1000;
      meterLimiterNode.release.value = 0.15;
      out.connect(meterLimiterNode);
      out = meterLimiterNode;
    }
    out.connect(meterAnalyser);
  }
  window.hamrcStartMicMeter = async function (onLevel) {
    meterCb = onLevel;
    if (meterCtx) return;
    try {
      meterStream = await getMicStream({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      if (meterCb) meterCb(null);
      return;
    }
    if (!meterCb) {
      // stopped while the permission prompt was open
      for (const t of meterStream.getTracks()) t.stop();
      meterStream = null;
      return;
    }
    try {
      meterCtx = new AudioContext({ sampleRate: RADIO_SAMPLE_RATE });
    } catch {
      meterCtx = new AudioContext();
    }
    meterSrc = meterCtx.createMediaStreamSource(meterStream);
    meterAnalyser = meterCtx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    buildMeterChain();
    const buf = new Float32Array(meterAnalyser.fftSize);
    const tick = () => {
      meterAnalyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      if (meterCb) meterCb(peak > 0 ? 20 * Math.log10(peak) : -120);
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  };
  function stopMeterCapture() {
    cancelAnimationFrame(meterRaf);
    if (!meterCtx) return false;
    for (const t of meterStream.getTracks()) t.stop();
    meterCtx.close();
    meterCtx = meterStream = meterGainNode = meterAnalyser = meterLimiterNode = meterSrc = null;
    return true;
  }
  window.hamrcStopMicMeter = function () {
    meterCb = null;
    // iOS may leave RX playback degraded after a mic session (same as after TX,
    // see hamrcSetMicStreaming): rebuild the RX stream like that does.
    if (stopMeterCapture() && window.hamrcRestartRxAudio) window.hamrcRestartRxAudio();
  };

  // --- Microphone choice (2026-10-15) ------------------------------------
  // Which input device the browser mic path uses; "" = the system default.
  // Picking the built-in mic keeps a Bluetooth speaker/car kit on its
  // playback profile (no switch to the headset profile). Per browser.
  const MIC_DEVICE_KEY = "open890rc.micDevice";
  let micDeviceId = "";
  try {
    micDeviceId = localStorage.getItem(MIC_DEVICE_KEY) || "";
  } catch {
    // default device
  }
  // getUserMedia with the chosen device; a device that is gone (unplugged,
  // Bluetooth off) falls back to the default instead of blocking TX.
  async function getMicStream(constraints) {
    if (micDeviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          ...constraints,
          audio: { ...constraints.audio, deviceId: { exact: micDeviceId } },
        });
      } catch (e) {
        if (!e || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
        console.warn("audio: chosen microphone not available, using the default", e);
      }
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  // [{id, label}] of the input devices plus the stored choice. Labels only
  // exist once mic permission was granted (the Mic Gain tab's meter asks).
  window.hamrcListMics = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { devices: [], selected: micDeviceId };
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
    return { devices, selected: micDeviceId };
  };
  window.hamrcSetMicDevice = async function (id) {
    micDeviceId = id || "";
    try {
      if (micDeviceId) localStorage.setItem(MIC_DEVICE_KEY, micDeviceId);
      else localStorage.removeItem(MIC_DEVICE_KEY);
    } catch {
      // valid for this page only
    }
    // level meter: rebuild on the new device (no RX restart, it keeps running)
    const cb = meterCb;
    if (cb && stopMeterCapture()) await window.hamrcStartMicMeter(cb);
    // a warm (idle) TX chain: rebuild on the new device; an active TX picks it up next time
    if (micCtx && !micActive && !micWanted) {
      micChain = micChain
        .then(() => {
          if (!micActive && !micWanted) releaseMicCapture();
        })
        .catch(() => {});
      await micChain;
      warmMic();
    }
  };
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (window.hamrcOnMicDevicesChanged) window.hamrcOnMicDevicesChanged();
      if (window.hamrcOnOutputDevicesChanged) window.hamrcOnOutputDevicesChanged();
    });
  }

  // --- Output device choice (2026-10-16) ---------------------------------
  // Where the RX audio plays ("" = system default). Uses setSinkId() on the
  // <audio> element all RX sound goes through (streamAudioEl). Only Chromium
  // and Firefox have it; iOS/Safari decide the route themselves (Control
  // Center), so the row stays hidden there. Per browser.
  const OUTPUT_DEVICE_KEY = "open890rc.outputDevice";
  let outputDeviceId = "";
  try {
    outputDeviceId = localStorage.getItem(OUTPUT_DEVICE_KEY) || "";
  } catch {
    // default device
  }
  window.hamrcOutputSelectable = typeof streamAudioEl.setSinkId === "function";
  // A device that is gone (unplugged, Bluetooth off) falls back to the default.
  async function applyOutputDevice() {
    if (!window.hamrcOutputSelectable) return;
    try {
      await streamAudioEl.setSinkId(outputDeviceId);
    } catch (e) {
      console.warn("audio: chosen output device not available, using the default", e);
      try {
        await streamAudioEl.setSinkId("");
      } catch {
        // keep whatever the browser has
      }
    }
  }
  applyOutputDevice();
  window.hamrcListOutputs = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { devices: [], selected: outputDeviceId };
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Ausgabe ${i + 1}` }));
    return { devices, selected: outputDeviceId };
  };
  window.hamrcSetOutputDevice = async function (id) {
    outputDeviceId = id || "";
    try {
      if (outputDeviceId) localStorage.setItem(OUTPUT_DEVICE_KEY, outputDeviceId);
      else localStorage.removeItem(OUTPUT_DEVICE_KEY);
    } catch {
      // valid for this page only
    }
    await applyOutputDevice();
  };

  async function ensureMicCapture() {
    if (micCtx) {
      // a context built without a user gesture (warm-up) may sit suspended
      if (micCtx.state === "suspended") await micCtx.resume().catch(() => {});
      return;
    }
    // Otherwise the first gap measurement after rebuilding mic capture (every
    // TX press, see releaseMicCapture) compares against the last chunk of the
    // PREVIOUS TX session, logging the silent time between transmissions as a
    // bogus multi-second "GAP" instead of a real main-thread stall.
    micGapLast = 0;

    micStream = await getMicStream({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        // Off again. Was turned on suspecting it'd prevent hot mic input
        // from hard-clipping in handleMicChunk's Math.max(-1, Math.min(1,
        // ...)) — but the diagnostic test tone that "proved" the pipeline
        // clean afterward is generated server-side and never touches
        // getUserMedia/AGC at all, so that never actually tested this
        // setting; the real fix that test validated was the architecture
        // rebuild (native-rate context, removing the buggy custom
        // resampler/anti-aliasing filters). With AGC on, the operator
        // found a new, worse problem: obvious gain-hunting on silence —
        // the browser's WebRTC AGC continuously chases a target loudness,
        // so with no speech to lock onto it keeps raising gain and
        // amplifying the noise floor, audible as rising hiss. Fixed,
        // non-adaptive gain (the Mic Gain slider's GainNode below) doesn't
        // have that failure mode: silence just stays silent.
        autoGainControl: false,
      },
    });

    // Forced to the radio's own rate, same as RX's AudioContext — removes
    // the need for any resampling or anti-aliasing filtering of our own
    // (both since deleted from this file): the browser's native capture
    // resampler is the same well-tested one every other Web Audio input
    // path already relies on. This mirrors open890's own approach more
    // directly than the from-scratch resampler this file used to have.
    // Unlike RX, no fallback resampler exists for this path anymore (kept
    // deliberately simple per the rebuild) — if a browser ever ignores this
    // request, TX audio would be the wrong speed/pitch, so that's logged
    // loudly rather than silently mishandled.
    try {
      micCtx = new AudioContext({ sampleRate: RADIO_SAMPLE_RATE });
    } catch {
      micCtx = new AudioContext();
    }
    if (micCtx.sampleRate !== RADIO_SAMPLE_RATE) {
      console.error(
        `audio: mic AudioContext runs at ${micCtx.sampleRate}Hz, not the requested ${RADIO_SAMPLE_RATE}Hz — TX audio to the radio will be the wrong speed/pitch.`
      );
    }

    await micCtx.audioWorklet.addModule("mic-capture-processor.js");
    micWorklet = new AudioWorkletNode(micCtx, "mic-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // A worklet with no path to a real destination can stop being processed
    // in some browsers; route through a muted gain node instead of
    // connecting nowhere.
    const silence = micCtx.createGain();
    silence.gain.value = 0;
    micWorklet.connect(silence);
    silence.connect(micCtx.destination);

    // Boosts the mic signal before it's sent, since without autoGainControl
    // a quiet mic needs real gain applied somewhere. Local to this browser
    // tab, applied instantly — unlike the fixed server-side TX attenuation
    // (internal/audio/tx.go, TXAttenuation), this never needs a
    // server round trip.
    micGainNode = micCtx.createGain();
    micGainNode.gain.value = micGainValue;

    // A DynamicsCompressor limiter sat here unconditionally for a while
    // (threshold -3dB, ratio 20:1, knee 0, attack 3ms) — added when a quiet
    // iPhone mic needed a high Mic Gain (~7.0x) to read correctly on the
    // radio's ALC, where occasional speech peaks could push samples past
    // +-1.0 into handleMicChunk's hard clip below. REMOVED (2026-10-07):
    // reported live as making TX sound distorted/scratchy, unchanged even
    // down to 0.5x Mic Gain — ruling out plain overgain clipping (the
    // limiter's own settings don't scale with the gain slider) and pointing
    // at the limiter's own aggressive settings (hard knee, fast attack)
    // producing audible pumping on speech. Confirmed live: removing it made
    // TX audio clean again on both Mac and iPhone mics, at this file's
    // current Mic Gain default/max (much lower than the original 7.0x
    // case) — handleMicChunk's hard clip below remains as the actual safety
    // net at these levels.
    //
    // Re-added here as an opt-in (micLimiterEnabled, Setup window's VOIP
    // tab, off by default) for whoever still needs more Mic Gain headroom
    // than MIC_GAIN_MAX allows and wants a safety margin above the hard
    // clip — deliberately gentler than the removed one: threshold close to
    // full scale (stays transparent for normal speech, only engages near
    // genuine clipping), soft knee and a moderate ratio instead of a near-
    // brickwall one, to avoid the same audible pumping. Not live-verified.
    let micChainOut = micGainNode;
    micLimiterNode = null;
    if (micLimiterEnabled) {
      const limiter = micCtx.createDynamicsCompressor();
      limiter.threshold.value = micLimiterThresholdDb;
      limiter.knee.value = 10;
      limiter.ratio.value = micLimiterRatio;
      limiter.attack.value = micLimiterAttackMs / 1000;
      limiter.release.value = 0.15;
      micGainNode.connect(limiter);
      micChainOut = limiter;
      micLimiterNode = limiter;
    }

    micCtx.createMediaStreamSource(micStream).connect(micGainNode);
    micChainOut.connect(micWorklet);
    micChainOutNode = micChainOut;
    micWorklet.port.onmessage = (event) => handleMicChunk(event.data);
  }

  // Diagnostic only: measures how regularly the worklet's postMessage calls
  // actually reach the main thread. The worklet's own process() runs on a
  // dedicated real-time audio thread at a rock-solid hardware-clocked
  // interval regardless of what the main thread is doing — but delivery of
  // its postMessage to this handler can still stall if the main thread is
  // busy (state broadcasts, DOM/SVG updates, GC, ...). That stall is exactly
  // what server-side timing (see gapStats in web.go) can't distinguish from
  // network jitter, so this is measured separately and logged to the
  // console — check devtools while reproducing the crackle.
  let micGapLast = 0;
  let micGapCount = 0;
  let micGapMin = 0;
  let micGapMax = 0;
  let micGapSum = 0;
  function trackMicChunkTiming() {
    const now = performance.now();
    if (micGapLast) {
      const gap = now - micGapLast;
      if (gap > 20) {
        console.warn(`mic capture: GAP ${gap.toFixed(1)}ms between worklet chunks reaching the main thread`);
      }
      micGapCount++;
      micGapSum += gap;
      if (!micGapMin || gap < micGapMin) micGapMin = gap;
      if (gap > micGapMax) micGapMax = gap;
      if (micGapCount % 200 === 0) {
        console.log(
          `mic capture timing: n=${micGapCount} avg=${(micGapSum / micGapCount).toFixed(2)}ms min=${micGapMin.toFixed(2)}ms max=${micGapMax.toFixed(2)}ms`
        );
        micGapCount = 0;
        micGapMin = 0;
        micGapMax = 0;
        micGapSum = 0;
      }
    }
    micGapLast = now;
  }

  // Accumulates the worklet's raw chunks (already at 16kHz — see
  // ensureMicCapture) into exact MIC_FRAME_SAMPLES-sized frames, mirroring
  // the RX player's own accumulate-then-emit pattern in the opposite
  // direction. Runs on the main thread, not the audio-rendering thread, so
  // the per-call array growth here doesn't risk the hard real-time deadline
  // a worklet's process() has to meet.
  function handleMicChunk(floatChunk) {
    // Warm mic between transmissions: nothing to send to, drop the audio.
    if (!micWs) {
      micPending = new Float32Array(0);
      micGapLast = 0;
      return;
    }
    trackMicChunkTiming();

    const merged = new Float32Array(micPending.length + floatChunk.length);
    merged.set(micPending, 0);
    merged.set(floatChunk, micPending.length);
    micPending = merged;

    while (micPending.length >= MIC_FRAME_SAMPLES) {
      const frame = micPending.subarray(0, MIC_FRAME_SAMPLES);
      const int16 = new Int16Array(MIC_FRAME_SAMPLES);
      for (let i = 0; i < MIC_FRAME_SAMPLES; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      sendMicFrame(int16);
      micPending = micPending.slice(MIC_FRAME_SAMPLES);
    }
  }

  function sendMicFrame(int16Frame) {
    if (micOpusEncoder) {
      const audioData = new AudioData({
        format: "s16",
        sampleRate: RADIO_SAMPLE_RATE,
        numberOfChannels: 1,
        numberOfFrames: int16Frame.length,
        timestamp: micTimestamp,
        data: int16Frame.buffer,
      });
      micTimestamp += OPUS_FRAME_MS * 1000;
      micOpusEncoder.encode(audioData);
      audioData.close();
      return;
    }
    if (micWs && micWs.readyState === WebSocket.OPEN) {
      micWs.send(int16Frame.buffer);
    }
  }

  async function startMicStreaming(codec) {
    await ensureMicCapture();
    attachMicToRecording(); // no-op unless a recording is currently running

    if (codec === "opus") {
      if (typeof AudioEncoder === "undefined") {
        throw new Error("Opus-Encoding wird von diesem Browser nicht unterstützt");
      }
      micTimestamp = 0;
      micOpusEncoder = new AudioEncoder({
        output: (chunk) => {
          if (!micWs || micWs.readyState !== WebSocket.OPEN) return;
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          micWs.send(buf);
        },
        error: (e) => console.error("audio: mic opus encode error", e),
      });
      micOpusEncoder.configure({
        codec: "opus",
        sampleRate: RADIO_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: MIC_OPUS_BITRATE,
      });
    } else {
      micOpusEncoder = null;
    }

    micWs = new WebSocket(`${wsProto()}://${location.host}/audio-tx-ws?codec=${codec}`);
    micWs.onerror = () => micWs.close();
  }

  function stopMicStreaming(forceRelease = false) {
    if (micOpusEncoder) {
      try {
        micOpusEncoder.close();
      } catch {
        // already closed
      }
      micOpusEncoder = null;
    }
    if (micWs) {
      micWs.close();
      micWs = null;
    }
    if (micKeepWarm && !forceRelease) {
      // keep the capture chain open, just stop feeding the recording and drop
      // any half-built frame
      detachMicFromRecording();
      micPending = new Float32Array(0);
      return;
    }
    releaseMicCapture();
  }

  // Fully tears down mic capture — releases the actual microphone hardware
  // (stream.getTracks().forEach(stop), not just closing the WS/encoder
  // above) and closes micCtx so the next TX press rebuilds everything via
  // ensureMicCapture's `if (micCtx) return` guard. This used to be left
  // running permanently after the first TX press (only the WS/encoder were
  // torn down), on the theory that avoiding a fresh getUserMedia call each
  // time saved noticeable latency/re-prompting — but the operator found RX
  // playback gets stuck very quiet specifically after transmitting (TX or
  // TUNE), on an iPhone, and recovering only with a full browser restart.
  // A live "recording" indicator staying on forever likely keeps iOS's Web
  // Audio session in its play-and-record mode for the rest of the page's
  // life instead of reverting to plain playback between transmissions,
  // which iOS is known to apply different (often quieter) output routing/
  // volume behavior under — matching exactly what was reported. Permission
  // is already granted after the first request, so re-acquiring the stream
  // on each subsequent TX press doesn't reprompt, just re-negotiates
  // hardware — worth the small extra latency to let iOS's audio session
  // actually reset between transmissions.
  function releaseMicCapture() {
    detachMicFromRecording(); // before micCtx goes away below
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (micWorklet) {
      micWorklet.disconnect();
      micWorklet = null;
    }
    micGainNode = null;
    micChainOutNode = null;
    micLimiterNode = null;
    if (micCtx) {
      micCtx.close();
      micCtx = null;
    }
    micPending = new Float32Array(0);
  }

  // Manual counterpart to the automatic post-TX restart above, for the
  // "RX audio reset" button (app.js) — a still-not-fully-diagnosed report of
  // RX getting choppy/dropout-prone after a while, worst after testing
  // TX/TUNE, where switching PCM/Opus makes no difference (so not codec-
  // specific) and only a full SERVER restart cleared it, not the
  // server-side-only UDP re-bind the button originally did alone (see
  // cmd/open890rc/main.go's resetRXAudio). That server restart's one
  // qualitative difference from the button, besides everything already
  // reset server-side, is that it forcibly drops the browser's own
  // /audio-ws connection — and the comment above already documents this
  // exact client only staying fixed by tearing down and recreating the RX
  // AudioContext, not by anything server-side. So the reset button now
  // does that too, not just the server-side rebind. No-op if RX isn't
  // currently playing (nothing to restart).
  window.hamrcRestartRxAudio = async function () {
    if (activeMode === "pcm") await startPCM();
    else if (activeMode === "opus") await startOpus();
  };

  // While transmitting, RX playback is cut immediately: queued RX audio
  // still draining from the ring buffer would be picked up by the mic and
  // transmitted. Muting drops new RX chunks and flushes what's queued.
  let rxMuted = false;
  window.hamrcMuteRx = function (on) {
    rxMuted = on;
    if (on && workletNode) workletNode.port.postMessage({ flush: true });
    // Otherwise the push-gap diagnostic (pushSamples above) misreports the
    // entire muted (TX) duration as a delivery stall the moment RX resumes —
    // pushSamples returns before touching its own timestamp while muted, so
    // without this reset it compares against a timestamp from before TX even
    // started.
    if (on) lastPushTime = 0;
  };

  // The one connection point to app.js's TX button: the two files otherwise
  // stay decoupled (this one owns audio, app.js owns radio control).
  //
  // Calls are serialized and re-evaluated against the LATEST wanted state
  // (Nutzer-Report 2026-10-11: a very short TX press sometimes showed
  // "Mikrofonzugriff fehlgeschlagen"). Starting the mic is async
  // (getUserMedia, addModule); a quick release used to run releaseMicCapture in
  // the middle of it, nulling/closing micCtx under the half-finished start
  // (-> errors like "context must be an instance of BaseAudioContext" or null
  // access), and a second quick press saw the half-built micCtx and returned
  // early. Now each step waits for the previous one, and a start that finished
  // after the key was already released is torn down again.
  let micWanted = false;
  let micActive = false;
  let micChain = Promise.resolve();
  async function applyMicState() {
    if (micWanted) {
      if (micActive) return;
      try {
        await startMicStreaming(activeMode === "opus" ? "opus" : "pcm");
        micActive = true;
      } catch (e) {
        stopMicStreaming(true); // drop a half-built capture so the next press starts clean
        if (micWanted) {
          console.error("audio: starting mic capture failed", e);
          window.alert(window.t("Mikrofonzugriff fehlgeschlagen: " + e.message));
        }
        return;
      }
      if (micWanted) return;
    }
    // not (or no longer) wanted
    const wasActive = micActive;
    micActive = false;
    if (!wasActive) return;
    window.hamrcMuteRx(false);
    stopMicStreaming();
    // Releasing the mic alone did NOT fix the reported "RX audio stuck quiet
    // after TX" bug on iPhone (see releaseMicCapture): the RX AudioContext has
    // to be recreated, same as a manual PCM/Opus off/on click.
    // Not with a warm mic: the mic stays open anyway, and rebuilding RX
    // would only disturb a Bluetooth link once more.
    if (micKeepWarm) return;
    if (activeMode === "pcm") await startPCM();
    else if (activeMode === "opus") await startOpus();
  }
  // Opens the mic chain ahead of time (keep-warm option). Silent on failure:
  // a permission prompt nobody asked for must not turn into an alert.
  function warmMic() {
    if (!micKeepWarm) return;
    micChain = micChain
      .then(async () => {
        if (!micKeepWarm || micActive || micWanted) return;
        try {
          await ensureMicCapture();
        } catch (e) {
          console.warn("audio: warming up the mic failed", e);
          releaseMicCapture();
        }
      })
      .catch((e) => console.error("audio: mic warm-up failed", e));
    return micChain;
  }
  window.hamrcSetMicKeepWarm = function (enabled) {
    micKeepWarm = !!enabled;
    try {
      localStorage.setItem(MIC_KEEP_WARM_KEY, micKeepWarm ? "1" : "0");
    } catch {
      // valid for this page only
    }
    if (micKeepWarm) return warmMic();
    micChain = micChain
      .then(() => {
        if (!micActive && !micWanted) releaseMicCapture();
      })
      .catch((e) => console.error("audio: releasing the mic failed", e));
    return micChain;
  };
  window.hamrcSetMicStreaming = function (enabled) {
    micWanted = !!enabled;
    if (enabled) window.hamrcMuteRx(true);
    else window.hamrcMuteRx(false);
    micChain = micChain.then(applyMicState).catch((e) => console.error("audio: mic state change failed", e));
    return micChain;
  };

  // --- Recording (2026-10-12 user request) ---------------------------------
  // Records RX audio always, and — while this browser is actually
  // transmitting — this browser's own TX/mic audio too, mixed into one
  // file. The mix bus is a MediaStreamDestination created in RX's
  // AudioContext (audioCtx): it's the long-lived context, always present
  // whenever recording would make sense, unlike micCtx which is torn down
  // and rebuilt on every single TX press (see ensureMicCapture/
  // releaseMicCapture above). A node from a DIFFERENT AudioContext can't be
  // connected directly — Web Audio nodes only ever connect within their own
  // context — so the mic chain is tapped into its OWN MediaStreamDestination
  // (living in micCtx) and that stream is re-imported into audioCtx via
  // createMediaStreamSource, the standard way to move audio across two
  // AudioContexts. Native MediaRecorder output only (no bundled MP3 encoder,
  // confirmed with the operator): audio/webm;opus on Chrome/Firefox,
  // audio/mp4;aac on Safari, whichever the browser actually supports.
  let mediaRecorder = null;
  let recordChunks = [];
  // The mix bus lives in its OWN AudioContext (recCtx), not in RX's: RX's
  // AudioContext is closed and rebuilt on every TX release (iOS workaround),
  // and a recorder hanging off it ended with the first transmission. RX and
  // mic are bridged into recCtx through MediaStreams, re-attached after each
  // RX restart (bug found 2026-10-15: recording stopped at TX release).
  let recCtx = null;
  let recordingDest = null; // MediaStreamDestination in recCtx, the mix bus
  let rxRecordTap = null; // {dest, source} bridging the current RX worklet into recCtx
  let micRecordTap = null; // {dest, source} while a TX cycle feeds the recording

  function pickRecordMimeType() {
    const candidates = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  // Called after every ensureMicCapture (from startMicStreaming) — a no-op
  // unless a recording is actually running, so it's safe to call unconditionally
  // on every TX press.
  function attachMicToRecording() {
    if (!recordingDest || !micCtx || !micChainOutNode || micRecordTap) return;
    const dest = micCtx.createMediaStreamDestination();
    micChainOutNode.connect(dest);
    const source = recCtx.createMediaStreamSource(dest.stream);
    source.connect(recordingDest);
    micRecordTap = { dest, source };
  }
  function attachRxToRecording() {
    if (!recordingDest || !recCtx || !audioCtx || !workletNode || rxRecordTap) return;
    const dest = audioCtx.createMediaStreamDestination();
    workletNode.connect(dest);
    const source = recCtx.createMediaStreamSource(dest.stream);
    source.connect(recordingDest);
    rxRecordTap = { dest, source };
  }
  function detachRxFromRecording() {
    if (!rxRecordTap) return;
    try {
      rxRecordTap.source.disconnect();
    } catch (e) {}
    rxRecordTap = null;
  }
  function detachMicFromRecording() {
    if (!micRecordTap) return;
    try {
      micRecordTap.source.disconnect();
    } catch (e) {}
    micRecordTap = null;
  }

  // meta: the filename (without extension) app.js has already built from
  // date/time/frequency/mode — this file only knows about audio, not radio
  // state, so app.js supplies it rather than this reaching into lastState.
  window.hamrcStartRecording = async function () {
    if (mediaRecorder) return false;
    if (!window.MediaRecorder) {
      window.alert(window.t("Aufnahme wird von diesem Browser nicht unterstützt."));
      return false;
    }
    await ensurePlayer(); // recording needs RX's AudioContext as its mix bus host
    if (!audioCtx || !workletNode) return false;
    recCtx = new AudioContext();
    recordingDest = recCtx.createMediaStreamDestination();
    attachRxToRecording();
    attachMicToRecording(); // picks up an already-running TX immediately
    const mimeType = pickRecordMimeType();
    try {
      mediaRecorder = new MediaRecorder(recordingDest.stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      console.error("audio: starting MediaRecorder failed", e);
      window.alert(window.t("Aufnahme konnte nicht gestartet werden: " + e.message));
      detachRxFromRecording();
      detachMicFromRecording();
      recordingDest = null;
      recCtx.close();
      recCtx = null;
      return false;
    }
    recordChunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordChunks.push(e.data);
    };
    mediaRecorder.start(1000);
    return true;
  };

  window.hamrcStopRecording = function (filenameBase) {
    if (!mediaRecorder) return;
    const rec = mediaRecorder;
    const mimeType = rec.mimeType || "audio/webm";
    rec.onstop = () => {
      const blob = new Blob(recordChunks, { type: mimeType });
      recordChunks = [];
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    rec.stop();
    mediaRecorder = null;
    detachRxFromRecording();
    detachMicFromRecording();
    recordingDest = null;
    if (recCtx) {
      recCtx.close();
      recCtx = null;
    }
  };

  // Abort + discard (Esc, see app.js) — same teardown as hamrcStopRecording
  // but no onstop handler, so no blob gets built and no download triggers;
  // the buffered chunks are simply dropped.
  window.hamrcCancelRecording = function () {
    if (!mediaRecorder) return;
    const rec = mediaRecorder;
    rec.onstop = null;
    rec.stop();
    mediaRecorder = null;
    recordChunks = [];
    detachRxFromRecording();
    detachMicFromRecording();
    recordingDest = null;
    if (recCtx) {
      recCtx.close();
      recCtx = null;
    }
  };
})();
