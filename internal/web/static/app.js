const freqEl = document.getElementById("freq");
// Two instances share this class: the original in .meter-block (phone, and
// still present on desktop but hidden there) plus a desktop-only duplicate
// positioned right under the status row (Nutzer-Wunsch, 2026-10-08: "die
// messages oben mittig in der ersten Zeile... da ist gut Platz dafür") —
// the original can't just be moved there, its position:absolute is relative
// to .meter-block specifically, which is what centers it over the meter on
// phone. Same two-elements-one-source idea as the busy LED
// (#busy-indicator/#busy-indicator-desktop); these two setters keep both in
// sync so every existing call site below only has one thing to update.
const statusEls = document.querySelectorAll(".status-message");
// Desktop clock (date and time, browser clock, radio display style: 11/OCT/'26, 20:40).
const CLOCK_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function updateClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${pad(d.getDate())}/${CLOCK_MONTHS[d.getMonth()]}/'${pad(d.getFullYear() % 100)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dateEl = document.getElementById("clock-date");
  const timeEl = document.getElementById("clock-time");
  if (dateEl.textContent !== date) dateEl.textContent = date;
  if (timeEl.textContent !== time) timeEl.textContent = time;
}
updateClock();
setInterval(updateClock, 1000);

// Active VFO indicator (radio display style: a pointer at the active letter, A and B
// stacked); a click on a letter switches to that VFO (FR0/FR1). Two instances, one
// for the phone and one for the desktop layout — both are kept in sync here.
for (const btn of document.querySelectorAll(".vfo-ab button")) {
  btn.addEventListener("click", () => send({ type: "setVfo", value: btn.dataset.vfo === "B" ? 1 : 0 }));
}
// The indicator lives inside #freq (right behind the last digit); every redraw of the
// digits clears #freq, so it is put back as the last child after each change.
const vfoIndicator = document.querySelector(".vfo-ab-desktop");
function attachVfoIndicator() {
  if (freqEl.lastElementChild !== vfoIndicator) freqEl.appendChild(vfoIndicator);
}
new MutationObserver(attachVfoIndicator).observe(freqEl, { childList: true });
attachVfoIndicator();
function applyVfoIndicator(active) {
  for (const row of document.querySelectorAll(".vfo-ab .vfo-row")) {
    row.classList.toggle("active", row.dataset.vfo === active);
  }
}

// Small/unobtrusive readout of the INACTIVE VFO's frequency (2026-10-12 user
// request) — both vfoAHz/vfoBHz are already known at all times (queried at
// connect, kept live via AI2), no need to wait for a switch to see it.
const vfoOtherFreqEl = document.getElementById("vfo-other-freq");
function applyVfoOtherFreq(state) {
  if (!vfoOtherFreqEl) return;
  const otherLetter = state.activeReceiver === "B" ? "A" : "B";
  const otherHz = otherLetter === "B" ? state.vfoBHz : state.vfoAHz;
  vfoOtherFreqEl.textContent = otherHz ? `${otherLetter} ${otherHz.toLocaleString("de-DE")}` : "";
}

function setStatusText(text) {
  statusEls.forEach((el) => (el.textContent = text));
}
function setStatusClass(cls, on) {
  statusEls.forEach((el) => el.classList.toggle(cls, on));
}
// Two instances share this class: the original in .filter-info-row (phone,
// and still present on desktop) plus a desktop-only duplicate positioned in
// the status row (Nutzer-Wunsch, 2026-10-08) — querySelectorAll + a shared
// class keeps both in sync from one update instead of needing a second,
// separately-maintained call site.
const busyIndicators = document.querySelectorAll(".busy-indicator");

// Same order as the wire codes in internal/cat/cat.go's modeNames.
const MODES = [
  "LSB", "USB", "CW", "FM", "AM", "FSK", "CW-R", "FSK-R",
  "PSK", "PSK-R", "LSB-D", "USB-D", "FM-D", "AM-D",
];

// Displayed in meters (matching how hams actually refer to bands), but the
// value sent to the server is the MHz-based identifier internal/cat/cat.go's
// EncodeBand expects.
const BANDS = [
  { value: "1.8", label: "160m" },
  { value: "3.5", label: "80m" },
  { value: "7", label: "40m" },
  { value: "10", label: "30m" },
  { value: "14", label: "20m" },
  { value: "18", label: "17m" },
  { value: "21", label: "15m" },
  { value: "24", label: "12m" },
  { value: "28", label: "10m" },
  { value: "50", label: "6m" },
  { value: "GEN", label: "GEN" },
];

let ws = null;
let currentHz = 0;
let currentNB1 = false;
let currentNB2 = false;
let currentProc = false;
let currentTX = false;
let currentMicStreaming = false;
// Raw slider units (10ths, 10=1.0x..100=10.0x) for the browser-side mic gain
// applied locally before TX audio is sent, replacing the radio's own "MG"
// mic gain command on the same main-screen slider (moved to its own VOIP-tab
// slider 2026-10-04, see MIC_GAIN_STORAGE_KEY below).
// Nutzer-Wunsch, 2026-09-29: with audio arriving at the radio over the LAN
// VoIP path, the radio's own analog mic gain ("MG") never applies to it, so
// that slider was adjusting a setting with no effect on what's actually
// transmitted. 50 = 5.0x, confirmed clean for this operator's mic; see
// audio.js's own MIC_GAIN_DEFAULT (must stay in sync — see hamrcSetMicGain's
// call below).
const MIC_GAIN_DEFAULT = 15;
// Hard cap for the browser mic gain (tenths: 25 = 2.5x) — briefly raised to
// 3.0x (Nutzer-Wunsch, 2026-10-07) but reverted the same day, too loud. PROC
// level keeps the radio's own 0-100 range, see PROC_LEVEL_MAX.
const MIC_GAIN_MAX = 25;
const PROC_LEVEL_MAX = 100;
// Remembered per browser (localStorage, tenths); audio.js reads the same key
// for its own starting gain.
const MIC_GAIN_STORAGE_KEY = "open890rc.micGain";
function loadMicGainRaw() {
  try {
    // per-microphone map written by audio.js, legacy single value as fallback
    const map = JSON.parse(localStorage.getItem("open890rc.micGainByDevice") || "{}");
    const dev = localStorage.getItem("open890rc.micDevice") || "";
    const v = Number(map[dev]) >= 1 ? Number(map[dev]) : Number(localStorage.getItem(MIC_GAIN_STORAGE_KEY));
    if (v >= 1) return Math.min(Math.round(v), MIC_GAIN_MAX);
  } catch (e) {
    // localStorage unavailable — use the default.
  }
  return MIC_GAIN_DEFAULT;
}
let browserMicGainRaw = loadMicGainRaw();

// Live total-traffic readout (#audio-bitrate, despite the name — kept as-is
// rather than renamed across HTML/CSS/JS for a label-only change): sums
// incoming bytes from ALL THREE WebSocket connections this app uses (this
// file's own /ws control/CAT-state connection, audio.js's /audio-ws, and
// waterfall.js's /waterfall-ws when the scope is on), not just audio like
// it used to. Each module reports its own bytes via
// window.hamrcReportTraffic(bytes); reported once a second here so it
// reflects whatever combination is actually active rather than a fixed
// per-stream number.
// Bytes are kept per source ("ctrl" = /ws, "audio" = /audio-ws, "scope" =
// /waterfall-ws) so the detail window (click on the kB/s figure) can show them
// separately; the figure itself is their sum.
const trafficBytes = { ctrl: 0, audio: 0, scope: 0 };
window.hamrcReportTraffic = function (bytes, source = "ctrl") {
  trafficBytes[source] += bytes;
};
// Each cut of the RX audio ring buffer (backlog too large, see
// pcm-player-processor.js) is reported to the server, which writes it to its
// log with a running count.
let rxTrimCount = 0;
window.hamrcReportTrim = function (beforeSeconds, afterSeconds, codec) {
  rxTrimCount++;
  send({ type: "rxTrim", before: beforeSeconds, after: afterSeconds, mode: codec || "", n: rxTrimCount });
};
// Which RX audio codec (if any) this browser is currently playing, shown
// per client in the client list (Nutzer-Wunsch, 2026-10-16: "clients
// können ja verschieden[e Codecs] [nutzen]") — the server has no way to
// tie a separate /audio-ws connection back to this /ws client on its own,
// so audio.js reports it here on start/stop.
window.hamrcReportAudioCodec = function (codec) {
  send({ type: "audioCodec", codec: codec || "" });
};
const trafficEl = document.getElementById("audio-bitrate");
const trafficOverlay = document.getElementById("traffic-overlay");
function updateTrafficOverlay(kbyte) {
  const fmt = (v) => `${v.toFixed(1)} kB/s`;
  document.getElementById("traf-ctrl").textContent = fmt(kbyte.ctrl);
  document.getElementById("traf-audio").textContent = fmt(kbyte.audio);
  const codec = window.hamrcAudioCodec ? window.hamrcAudioCodec() : "";
  document.getElementById("traf-audio-label").textContent = codec ? `RX-Audio (${codec})` : "RX-Audio";
  document.getElementById("traf-scope").textContent = fmt(kbyte.scope);
  document.getElementById("traf-total").textContent = fmt(kbyte.ctrl + kbyte.audio + kbyte.scope);
}
let lastTrafficKbyte = { ctrl: 0, audio: 0, scope: 0 };
setInterval(() => {
  const kbyte = {};
  for (const key of Object.keys(trafficBytes)) {
    kbyte[key] = trafficBytes[key] / 1000; // kilobytes per second (1 kB = 1000 B)
    trafficBytes[key] = 0;
  }
  lastTrafficKbyte = kbyte;
  const total = kbyte.ctrl + kbyte.audio + kbyte.scope;
  trafficEl.textContent = total > 0 ? `${Math.ceil(total)} kB/s` : "";
  if (!trafficOverlay.hidden) updateTrafficOverlay(kbyte);
}, 1000);
trafficEl.addEventListener("click", () => {
  if (!trafficEl.textContent) return;
  trafficOverlay.hidden = false;
  updateTrafficOverlay(lastTrafficKbyte);
});
document.getElementById("traffic-close").addEventListener("click", () => (trafficOverlay.hidden = true));
trafficOverlay.addEventListener("click", (e) => {
  if (e.target === trafficOverlay) trafficOverlay.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") trafficOverlay.hidden = true;
});

// RX-audio latency readout (#audio-latency): backlog in the player's ring
// buffer + browser output latency (+ Opus decode time), both reported by
// audio.js via window.hamrcGetAudioLatency(), plus half the round trip to
// the server, measured with a ping/pong over /ws (assumes a symmetric
// path). Measured from the moment the audio packets arrive AT THE SERVER —
// the TS-890 -> server leg isn't observable.
let latencyRttMs = null;
// 1234 ms -> "1.2 sek" from one second up.
function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} sek` : `${Math.round(ms)} ms`;
}
const latencyEl = document.getElementById("audio-latency");
const latencyOverlay = document.getElementById("latency-overlay");
function latencyBreakdown() {
  const a = window.hamrcGetAudioLatency && window.hamrcGetAudioLatency();
  if (!a) return null;
  const networkMs = latencyRttMs === null ? 0 : latencyRttMs / 2;
  return { ...a, networkMs, rttMs: latencyRttMs, totalMs: a.bufferMs + a.outputMs + (a.decodeMs || 0) + networkMs };
}
function updateLatency() {
  const l = latencyBreakdown();
  latencyEl.textContent = l ? formatMs(l.totalMs) : "";
  if (latencyOverlay.hidden) return;
  const fmt = (v) => (v === null ? "–" : formatMs(v));
  document.getElementById("lat-buffer").textContent = l ? fmt(l.bufferMs) : "–";
  document.getElementById("lat-output").textContent = l ? fmt(l.outputMs) : "–";
  document.getElementById("lat-network").textContent = l ? fmt(latencyRttMs === null ? null : l.networkMs) : "–";
  document.getElementById("lat-decode-row").hidden = !l || l.mode !== "opus";
  document.getElementById("lat-decode").textContent = l ? fmt(l.decodeMs) : "–"; // null → "–"
  document.getElementById("lat-total").textContent = l ? fmt(l.totalMs) : "–";
  document.getElementById("lat-rtt").textContent = fmt(latencyRttMs);
}
setInterval(updateLatency, 500);
setInterval(() => send({ type: "ping", t: performance.now() }), 2000);
window.hamrcOnPong = function (t) {
  const rtt = performance.now() - t;
  latencyRttMs = latencyRttMs === null ? rtt : latencyRttMs * 0.7 + rtt * 0.3;
};
latencyEl.addEventListener("click", () => {
  if (!latencyEl.textContent) return;
  latencyOverlay.hidden = false;
  updateLatency();
});
document.getElementById("latency-close").addEventListener("click", () => (latencyOverlay.hidden = true));
latencyOverlay.addEventListener("click", (e) => {
  if (e.target === latencyOverlay) latencyOverlay.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") latencyOverlay.hidden = true;
});

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Generic yes/no confirm dialog, used anywhere a destructive click (delete a
// TX Messages recording, delete a user, ...) needs confirmation. NOT
// window.confirm() — that's a native, synchronous, page-blocking dialog, and
// blocking the JS thread stalls everything else running on it too, audibly
// cutting off RX audio while the dialog is open (Nutzer-Report 2026-10-27:
// "kein Ton mehr im Hintergrund" while a TX Messages delete confirmation was
// up) — the actual audio decode/playback runs on the AudioWorklet's own
// thread, but feeding it new samples from the WebSocket's onmessage handler
// does not, and that's exactly what a blocked main thread stops. This
// overlay is a normal DOM element, so nothing else on the page pauses.
// Returns a Promise<boolean> (true = confirmed), same shape window.confirm()
// had — call sites just needed one `await` added, nothing else.
const confirmOverlay = document.getElementById("confirm-overlay");
const confirmMessageEl = document.getElementById("confirm-message");
const confirmOkButton = document.getElementById("confirm-ok");
const confirmCancelButton = document.getElementById("confirm-cancel");
let confirmResolve = null;
function finishConfirm(result) {
  if (!confirmResolve) return;
  confirmOverlay.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve(result);
}
function showConfirmDialog(message, confirmLabel) {
  confirmMessageEl.textContent = message;
  confirmOkButton.textContent = confirmLabel || "Löschen";
  confirmOverlay.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
confirmOkButton.addEventListener("click", () => finishConfirm(true));
confirmCancelButton.addEventListener("click", () => finishConfirm(false));
confirmOverlay.addEventListener("click", (e) => {
  if (e.target === confirmOverlay) finishConfirm(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !confirmOverlay.hidden) finishConfirm(false);
});

// Trailing-edge throttle shared by the sliders: a fast drag/scroll burst
// collapses into the latest value, sent at most every `intervalMs`, instead
// of flooding the radio's CAT parser with one command per pixel/tick.
function makeThrottledSender(intervalMs) {
  let pending = null;
  let timer = null;
  return (msg) => {
    pending = msg;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      send(pending);
    }, intervalMs);
  };
}

// Live sender for the filter sliders (width, shift, LC/HC, APF): while the
// handle is being dragged, the value goes to the radio right away (throttled,
// and only when it changed) so the sound follows the slider; releasing sends
// the final value once more so the radio never ends on a stale one.
function makeLiveSender(type, intervalMs = 150) {
  let last = null;
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending !== null && pending !== last) {
      last = pending;
      send({ type, value: pending });
    }
  };
  return {
    live(value) {
      pending = value;
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    final(value) {
      clearTimeout(timer);
      timer = null;
      pending = value;
      flush();
      last = null; // next drag always starts fresh, the radio may have changed meanwhile
    },
  };
}
const audioWidthSender = makeLiveSender("setAudioWidth");
const shiftSender = makeLiveSender("setShift");
const loCutSender = makeLiveSender("setLoCut");
const hiCutSender = makeLiveSender("setHiCut");
const apfShiftSender = makeLiveSender("setApfShift");
const apfGainSender = makeLiveSender("setApfGain");

// Splits a frequency into per-character digits, each tagged with the Hz
// value a click/scroll on it should add or subtract (the decimal point gets
// no place value and isn't interactive). MHz-side digits are marked so the
// mouse wheel can be disabled there (too coarse/easy to trigger by accident)
// while clicking stays available on every digit.
function buildDigits(hz) {
  const [intPart, decPart] = (hz / 1_000_000).toFixed(6).split(".");
  const digits = [];

  for (let k = 0; k < intPart.length; k++) {
    const power = 6 + (intPart.length - 1 - k);
    digits.push({ char: intPart[k], place: 10 ** power, wheelEnabled: false });
  }
  digits.push({ char: ".", place: null });
  for (let i = 0; i < decPart.length; i++) {
    if (i === 3) digits.push({ char: ".", place: null });
    digits.push({ char: decPart[i], place: 10 ** (5 - i), wheelEnabled: true });
  }

  return digits;
}

// True while a frequency is being typed on the keypad: the display shows the
// typed text, so renderFreq must not overwrite it (see kpRender).
let freqEntering = false;
// With RIT on (RX) or XIT on (TX) the radio shows VFO + the shared offset. currentHz stays the plain VFO (digit steps, tuning), only
// the display adds the offset.
let freqTxOffsetHz = 0;
function renderFreq(hz) {
  if (freqEntering) return;
  hz = Math.max(0, hz + freqTxOffsetHz);
  freqEl.innerHTML = "";
  for (const d of buildDigits(hz)) {
    const span = document.createElement("span");
    span.textContent = d.char;

    if (d.place === null) {
      span.className = "sep";
      freqEl.appendChild(span);
      continue;
    }

    span.className = "digit";
    span.title = d.wheelEnabled
      ? `Klick oben/unten oder Mausrad: ±${d.place} Hz`
      : `Klick oben/unten: ±${d.place} Hz`;

    span.addEventListener("click", (e) => {
      const rect = span.getBoundingClientRect();
      const topHalf = e.clientY - rect.top < rect.height / 2;
      adjustFreq(topHalf ? d.place : -d.place);
    });

    if (d.wheelEnabled) {
      span.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          adjustFreq(e.deltaY < 0 ? -d.place : d.place);
        },
        { passive: false }
      );
    }

    freqEl.appendChild(span);
  }
}

function adjustFreq(deltaHz) {
  currentHz = Math.max(0, currentHz + deltaHz);
  renderFreq(currentHz);
  sendSetFreq(currentHz);
}

// Trailing-edge throttle: a fast wheel/click burst on one digit collapses
// into the latest value, sent at most every 100ms, instead of flooding the
// radio's CAT parser with one command per tick.
//
// pendingHz doubles as a guard against a display flicker: the radio takes a
// moment to actually retune, so a state broadcast that arrives before it
// catches up (e.g. an S-meter tick, which fires several times a second)
// still carries the OLD frequency. Without this guard, applyState would
// treat that stale broadcast as an external change and snap the display
// back to the old value for a moment before the real confirmation arrives.
// While a change is pending, incoming broadcasts are ignored until one
// reports exactly the requested frequency (confirmed) or PENDING_TIMEOUT_MS
// passes (give up waiting and trust the radio again — e.g. it clamped the
// request at a band edge instead of applying it verbatim).
let pendingHz = null;
let pendingSince = 0;
let sendTimer = null;
const PENDING_TIMEOUT_MS = 1500;

function sendSetFreq(hz) {
  pendingHz = hz;
  pendingSince = performance.now();
  if (sendTimer) return;

  sendTimer = setTimeout(() => {
    sendTimer = null;
    if (pendingHz !== null) send({ type: "setFreq", hz: pendingHz });
  }, 100);
}

// Bridge for waterfall.js's click-to-tune (that file owns the waterfall
// canvas, this one owns radio control — same split as audio.js/app.js
// elsewhere in this project). Goes through the same optimistic-update path
// as the frequency digits themselves so a click doesn't visually flicker
// while waiting for the radio to confirm.
// fromScope: hz is a frequency on the scope axis, which is centred on the displayed
// frequency (VFO + RIT/XIT offset), so the VFO is hz minus that offset.
window.hamrcTuneToFreq = function (hz, fromScope) {
  currentHz = Math.max(0, hz - (fromScope ? freqTxOffsetHz : 0));
  renderFreq(currentHz);
  sendSetFreq(currentHz);
};

// Bridge for audio.js's repurposed lock-screen skip/seek buttons (Nutzer-
// Wunsch, 2026-09-29) — steps the VFO by a relative amount instead of tuning
// to an absolute frequency, otherwise the same split/optimistic-update path
// as hamrcTuneToFreq above. Just calls the existing digit-wheel step logic.
window.hamrcStepFreq = function (deltaHz) {
  adjustFreq(deltaHz);
};

// Builds the thin black divider lines that give the meter bars their
// segmented LED look: an SVG mask hides a black overlay everywhere except
// these 2px slices, letting the colored fill underneath show through only in
// between them. Each bar has its OWN mask element now, not one shared mask
// referenced from two different <svg> roots — the SWR bar's own mask lived
// inside .s-meter-svg, which desktop hides (display:none) to show the
// analog gauge instead, and a mask inside a display:none ancestor doesn't
// reliably apply to elements referencing it from elsewhere (found live,
// 2026-10-09: the SWR bar rendered as a single solid black rect instead of
// its segmented stripes once .s-meter-svg was hidden — Nutzer-Report: "ich
// sehe nur einen schwarzen Strich").
function buildSegmentMask(id) {
  const mask = document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  for (let i = 0; i <= 70; i++) {
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", i * 5 - 1);
    rect.setAttribute("y", "-3");
    rect.setAttribute("width", "2");
    rect.setAttribute("height", "25");
    rect.setAttribute("fill", "white");
    mask.appendChild(rect);
  }
}

// Analog needle-gauge version of the S/PO bar meter, desktop-only (see
// style.css — the bar stays the phone/default rendering). The scale itself is
// a STATIC SVG in index.html (#meter-analog), rebuilt 1:1 from the operator's
// reference bitmap (open890rc_smeter.bmp, viewBox = the bitmap's own 512x240
// pixels) — earlier versions generated the scale here from trig, which never
// looked like the reference (2026-10-09: "ich gebe Dir eine BMP Vorlage und
// Du baust daraus ein SVG nach"). What stays in JS is only the needle: it
// rotates about the pivot below the dial (read off the reference's own sample
// needle: x = 96 + 0.611*(y-60), meeting the dial's centre line at
// y ~ 323.5) and must cross the S track exactly at the tick for the current
// reading. The S track is a circle about (257,720), r 657.4 (measured), so
// each raw value maps to an angle on that circle (table below, tick angles
// measured off the bitmap) and the needle is the ray from the pivot through
// that point, ending just past the ticks. Needle physics (spring-damper)
// further below are unchanged.
const ANALOG_PIVOT = { x: 257, y: 323.5 };
const ANALOG_DIAL_C = { x: 257, y: 720 };
const ANALOG_S_R = 657.4;
const ANALOG_NEEDLE_R = 672; // tip stops just short of the longest ticks (677-679)
// [raw 0-70, angle in degrees on the S circle, + = right]: S1..S9 every 4 raw
// (same calibration as the bar's own S ticks: S9 = 34.4), then the +dB zone
// with its minor ticks (+10/+30/+50 dB); raw 0 and 70 extrapolated to the
// ends of the printed track.
const ANALOG_ANGLES = [
  [0, -20.4], [2.4, -18.18], [6.4, -14.42], [10.4, -11.88], [14.4, -9.42], [18.4, -7.3],
  [22.4, -5.26], [26.4, -3.38], [30.4, -1.56], [34.4, 0.04], [40.4, 3.1], [46.4, 6.0],
  [52, 9.0], [57.6, 12.1], [63.6, 15.65], [69.6, 19.1], [70, 19.4],
];
function analogAngleDeg(raw) {
  const pts = ANALOG_ANGLES;
  const v = Math.max(0, Math.min(70, raw));
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [r0, a0] = pts[i - 1];
      const [r1, a1] = pts[i];
      return a0 + ((v - r0) / (r1 - r0)) * (a1 - a0);
    }
  }
  return pts[pts.length - 1][1];
}
// Needle tip: ray from the pivot through the point at angle a on the circle
// of radius circleR (S track while receiving, PO track while transmitting),
// intersected with the circle of radius ANALOG_NEEDLE_R about the dial centre.
function analogNeedleTip(a, circleR) {
  const rad = (a * Math.PI) / 180;
  const px = ANALOG_DIAL_C.x + circleR * Math.sin(rad);
  const py = ANALOG_DIAL_C.y - circleR * Math.cos(rad);
  let dx = px - ANALOG_PIVOT.x;
  let dy = py - ANALOG_PIVOT.y;
  const n = Math.hypot(dx, dy);
  dx /= n;
  dy /= n;
  // |F + t*d - C|^2 = R^2, larger root
  const fx = ANALOG_PIVOT.x - ANALOG_DIAL_C.x;
  const fy = ANALOG_PIVOT.y - ANALOG_DIAL_C.y;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - ANALOG_NEEDLE_R * ANALOG_NEEDLE_R;
  const t = -b + Math.sqrt(b * b - c);
  return { x: ANALOG_PIVOT.x + t * dx, y: ANALOG_PIVOT.y + t * dy };
}


// raw (0-70) -> approximate dBm, piecewise-linear through the standard ham
// S-meter convention (S9 = -73dBm, 6dB per S-unit below it, 1:1 above it in
// the +dB zone) applied at the SAME raw points as the S ticks in ANALOG_ANGLES — same
// idea as R8500's raw_to_smeter_scale/smeter_scale_to_dbm chain, just
// collapsed into one direct table since our own raw-to-S calibration is
// already effectively linear per-segment.
const ANALOG_DBM_POINTS = [
  [0, -127], [2.4, -121], [10.4, -109], [18.4, -97], [26.4, -85], [34.4, -73],
  [46.4, -53], [57.6, -33], [69.6, -13], [70, -12],
];
function analogRawToDbm(raw) {
  const pts = ANALOG_DBM_POINTS;
  for (let i = 1; i < pts.length; i++) {
    if (raw <= pts[i][0]) {
      const [r0, d0] = pts[i - 1];
      const [r1, d1] = pts[i];
      return d0 + ((raw - r0) / (r1 - r0)) * (d1 - d0);
    }
  }
  return pts[pts.length - 1][1];
}


// While transmitting the needle reads the PO row instead: watts = raw/70*100
// (same assumption as the bar meter), drawn on the reference's own non-linear
// 0-250 W tick spacing (measured: [watts, angle on the PO circle]) but
// relabelled 0-150 W, so w watts sit where the reference has w*250/150 and
// full drive (100 W) stops at ~2/3 of the sweep instead of the far end.
const ANALOG_PO_R = 649.5;
const ANALOG_PO_SCALE_MAX_W = 150;
const ANALOG_PO_ANGLES = [
  [0, -18.14], [10, -10.22], [20, -7.24], [30, -5.06], [40, -3.24], [50, -1.68], [60, -0.32],
  [70, 1.02], [80, 2.22], [90, 3.38], [100, 4.36], [110, 5.5], [120, 6.52], [130, 7.46],
  [140, 8.4], [150, 9.38], [160, 10.34], [170, 11.14], [180, 12.06], [190, 12.96],
  [200, 13.86], [210, 14.78], [220, 15.7], [230, 16.5], [240, 17.38], [250, 18.18],
];
// Which PO scale the dial shows: "std" (radio alone, 0-150 W printed, raw 70 = 100 W) or,
// with the PA in OPERATE, the PA scale: 0-1000 W (LOW/MID) or 0-1500 W (HIGH), whose
// end is raw 70 (the same raw values the bar meter gets from meterValues).
let analogPoScaleShown = null;
function analogPoScale() {
  const st = lastState;
  if (!st || !ampInOperate(st) || st.ampTuning) return "std";
  return powerScaleMax(st) >= 1500 ? "pa1500" : "pa1000";
}
function syncAnalogPoScale() {
  const scale = analogPoScale();
  if (scale === analogPoScaleShown) return;
  analogPoScaleShown = scale;
  const kind = scale === "std" ? "std" : "pa";
  for (const g of document.querySelectorAll("[data-po-ticks]")) g.style.display = g.dataset.poTicks === kind ? "" : "none";
  for (const g of document.querySelectorAll("[data-po-labels]")) g.style.display = g.dataset.poLabels === scale ? "" : "none";
}
function analogPoAngleDeg(raw) {
  const v = Math.max(0, Math.min(70, raw));
  const w = (v / 70) * 100;
  const refW = analogPoScale() === "std" ? (w * 250) / ANALOG_PO_SCALE_MAX_W : (v / 70) * 250;
  const pts = ANALOG_PO_ANGLES;
  for (let i = 1; i < pts.length; i++) {
    if (refW <= pts[i][0]) {
      const [w0, a0] = pts[i - 1];
      const [w1, a1] = pts[i];
      return a0 + ((refW - w0) / (w1 - w0)) * (a1 - a0);
    }
  }
  return pts[pts.length - 1][1];
}

// TX meter mode, chosen with the PWR/SWR buttons under the gauge (desktop):
// while transmitting the one needle reads either the PO row or the SWR row.
let analogMeterMode = "pwr";
try {
  const m = localStorage.getItem("open890rc.meterMode");
  if (m === "swr" || m === "alc" || m === "id") analogMeterMode = m;
} catch (e) {}
// Shared by the PWR/SWR/ALC/IC buttons below and the desktop bars-view
// toggle further down (that one needs ALC data flowing for its own ALC bar
// even though the needle itself is hidden — see setDesktopMeterView's own
// comment). The server only streams a given extra meter (ALC/IC) while some
// client has asked for it (main.go), hence the explicit send here.
// persist=false: a mode forced by the desktop bars view (ALC data for the bar) is not the user's choice and
// must not overwrite the stored one, or after a reload in bars view the needle came back on ALC.
function setAnalogMeterMode(mode, persist = true) {
  if (analogMeterMode === mode) return;
  analogMeterMode = mode;
  if (persist) {
    try {
      localStorage.setItem("open890rc.meterMode", analogMeterMode);
    } catch (e) {}
  }
  for (const b of document.querySelectorAll(".meter-mode-btn")) b.classList.toggle("active", b.dataset.mode === analogMeterMode);
  send({ type: "setMeterMode", mode: analogMeterMode });
}
// Needle angle on the dial's SWR row: [bar raw value (see swrToRaw), angle on
// the SWR circle], tick angles measured off the reference (1, 1.5, 2, 3, 5, end).
const ANALOG_SWR_R = 572.7;
const ANALOG_SWR_ANGLES = [[0, -14.78], [5.6, -8.22], [18, -4.38], [34, 0.04], [52, 4.68], [70, 16.6]];
function analogSwrAngleDeg(raw) {
  const pts = ANALOG_SWR_ANGLES;
  const v = Math.max(0, Math.min(70, raw));
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [r0, a0] = pts[i - 1];
      const [r1, a1] = pts[i];
      return a0 + ((v - r0) / (r1 - r0)) * (a1 - a0);
    }
  }
  return pts[pts.length - 1][1];
}
// ALC row = the thick bar at the bottom of the dial (no ticks) = the OK range,
// continued by the thin line to its right = over-drive. Raw 0 at the bar's left
// tip, raw 35 (assumed: the bar meter's own low/high split) at the bar's right
// end, raw 70 at the very end of the thin line (the scale's end stop).
const ANALOG_ALC_R = 520;
const ANALOG_ALC_ANGLES = [[0, -13.8], [35, 1.9], [70, 14.0]];
function analogAlcAngleDeg(raw) {
  const v = Math.max(0, Math.min(70, raw));
  const [a, b] = v <= 35 ? [ANALOG_ALC_ANGLES[0], ANALOG_ALC_ANGLES[1]] : [ANALOG_ALC_ANGLES[1], ANALOG_ALC_ANGLES[2]];
  return a[1] + ((v - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
}
// IC row (drain current, "RM4"): 0-20 A printed, raw 0-70 = 0-20 A (assumed
// linear, 3.5 raw per A); tick angles measured off the reference.
const ANALOG_IC_R = 599;
const ANALOG_ID_ANGLES = [[0, -16.16], [17.5, -8.22], [35, -1.34], [52.5, 5.4], [70, 12.8]];
function analogIdAngleDeg(raw) {
  const pts = ANALOG_ID_ANGLES;
  const v = Math.max(0, Math.min(70, raw));
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [r0, a0] = pts[i - 1];
      const [r1, a1] = pts[i];
      return a0 + ((v - r0) / (r1 - r0)) * (a1 - a0);
    }
  }
  return pts[pts.length - 1][1];
}
function analogTargetRaw() {
  if (!(lastState && lastState.tx)) return meterTarget.s;
  if (analogMeterMode === "swr") return meterTarget.swr;
  if (analogMeterMode === "alc") return meterTarget.alc;
  if (analogMeterMode === "id") return meterTarget.id;
  return meterTarget.s;
}
// ALC "OK" limit in raw units (the thick bar's right end); above it the little
// red LED at the end of the ALC scale lights while transmitting.
const ANALOG_ALC_OK_RAW = ANALOG_ALC_ANGLES[1][0];
// Gauges currently in the document that need their needle updated: the real
// #meter-analog, plus, while the settings overlay (long press on the gauge)
// is open, a live COPY of it — see mountMeterOverlayGauge further below.
// The real node stays exactly where it is (Nutzer-Wunsch 2026-10-18: "das
// meter soll nicht aus der gui herausspringen beim öffnen des overlay. wir
// zeigen eine kopie an" — an earlier version relocated the real node into
// the overlay instead, which this replaces). Looked up by CLASS within each
// root rather than by id: id must stay unique per document, and the clone
// duplicates its whole subtree including every id in it.
const analogGaugeRoots = [document.getElementById("meter-analog")];
function updateAnalogNeedle(raw) {
  syncAnalogPoScale();
  const tx = !!(lastState && lastState.tx);
  let tip;
  if (tx && analogMeterMode === "swr") tip = analogNeedleTip(analogSwrAngleDeg(raw), ANALOG_SWR_R);
  else if (tx && analogMeterMode === "id") tip = analogNeedleTip(analogIdAngleDeg(raw), ANALOG_IC_R);
  else if (tx && analogMeterMode === "alc") tip = analogNeedleTip(analogAlcAngleDeg(raw), ANALOG_ALC_R);
  else if (tx) tip = analogNeedleTip(analogPoAngleDeg(raw), ANALOG_PO_R);
  else tip = analogNeedleTip(analogAngleDeg(raw), ANALOG_S_R);
  const dbmText = tx ? "" : `${Math.round(analogRawToDbm(raw))} dBm`;
  for (const root of analogGaugeRoots) {
    root.querySelector(".analog-alc-led").classList.toggle("on", tx && meterTarget.alc > ANALOG_ALC_OK_RAW);
    const needle = root.querySelector(".analog-needle");
    needle.setAttribute("x1", ANALOG_PIVOT.x);
    needle.setAttribute("y1", ANALOG_PIVOT.y);
    needle.setAttribute("x2", tip.x);
    needle.setAttribute("y2", tip.y);
    const shadow = root.querySelector(".analog-needle-shadow");
    shadow.setAttribute("x1", ANALOG_PIVOT.x);
    shadow.setAttribute("y1", ANALOG_PIVOT.y);
    shadow.setAttribute("x2", tip.x);
    shadow.setAttribute("y2", tip.y);
    root.querySelector(".analog-dbm").textContent = dbmText;
  }
}

// Needle inertia: a spring-damper simulation instead of a plain ease, so the
// needle has real physical-feeling weight including slight overshoot, same
// as a genuine analog meter movement — ported directly from R8500_control's
// _animate_smeter (identical stiffness/damping constants: for a linear
// spring-damper the settle time and overshoot % only depend on those two
// numbers, not on the value domain's scale, so reusing them unchanged here
// on our 0-70 raw range — vs. R8500's own 0-15 — still reproduces the exact
// same motion "genauso", per the operator's request). Deliberately a
// SEPARATE animation loop from meterFrame's simple exponential ease (which
// keeps driving the bar meter's fill, phone and the analog gauge's digital
// SWR row below it) — chaining the spring off the bar's own already-eased
// value would double-smooth and lose the characteristic overshoot.
const ANALOG_SPRING_STIFFNESS = 200.0;
const ANALOG_SPRING_DAMPING = 25.0;
let analogNeedleDisplayed = 0;
let analogNeedleVelocity = 0;
let analogLastFrame = performance.now();

// User-adjustable needle feel (long press on the gauge → #meter-overlay,
// wired further below, near the NB overlay). Nutzer-Wunsch 2026-10-18:
// "schnell ansteigt (wie bisher), aber eine einstellbare hold gegen
// abfallen". Two independent knobs:
// - meterInertiaPct scales the spring's TIME CONSTANT: stiffness ∝ 1/k²,
//   damping ∝ 1/k keeps the damping RATIO (and with it the overshoot
//   shape) unchanged, only how fast the whole motion plays out — the
//   standard trick for time-scaling a 2nd-order system, rather than
//   tuning stiffness/damping independently and accidentally changing how
//   much it overshoots. 100% = the original constants above, unchanged.
//   Range 50-300% (not 0-∞): below 50% the spring is stiff enough that the
//   explicit-Euler-ish integration below genuinely goes unstable at normal
//   frame rates — reported live as "zwei Zeiger" (the needle double-imaging
//   as it diverges instead of settling), confirmed by eigenvalue analysis
//   of the update step, fixed by narrowing the slider's range rather than
//   trying to out-clamp dt further.
// - meterFallMs is a genuine PEAK HOLD (Nutzer-Wunsch 2026-10-18, after an
//   earlier "just rate-limit the drop" version felt like it did nothing —
//   on a real, noisy/fluctuating signal almost every reading is a "new"
//   (even if tiny) peak, which kept re-arming a plain rate limiter before
//   it could ever show): a new peak is tracked instantly as before, but
//   then the value fed to the spring stays PINNED there — flat, ignoring
//   any lower reading — for meterFallMs, and only once that expires does it
//   start following the live value again. 0 = off, i.e. the original
//   behaviour (target tracks the radio instantly both ways).
// - meterReleasePct (Nutzer-Wunsch 2026-10-18, after the hold-then-release
//   above: "nach Ablauf der Abfallzeit springt sie viel zu schnell zurück
//   ... Besser wäre das zurück langsamer zu machen als das vor"): once
//   released, the spring used to chase the lower value with the SAME
//   stiffness/damping as a rise, which reads as a snap. Applied only while
//   the needle is actually moving DOWN (target < displayed, every frame —
//   covers the hold's release AND any ordinary downward signal step, not
//   just the hold case), it multiplies meterInertiaPct's time-scale factor
//   k by this on top, same "scale stiffness/damping together to keep the
//   damping ratio (and so the overshoot shape) unchanged" trick as
//   meterInertiaPct itself — a rise is completely unaffected. 100% = no
//   extra slowdown (symmetric, today's behaviour); default 250% so release
//   reads as a deliberate, weighted sink rather than a snap-back.
const METER_INERTIA_DEFAULT = 100;
const METER_FALL_MS_DEFAULT = 0;
const METER_RELEASE_DEFAULT = 250;
function loadMeterInertiaPct() {
  try {
    // Clamped (not just range-checked) rather than falling back to the
    // default on an out-of-range value: a value saved before the range was
    // tightened to 50-300% (2026-10-18, see the slider's min/max — below
    // 50% the explicit-Euler spring genuinely goes unstable and the needle
    // visibly double-images, "zwei Zeiger" bug report) should land on the
    // nearest now-valid value, not silently jump back to 100%.
    const v = Number(localStorage.getItem("open890rc.meterInertiaPct"));
    if (Number.isFinite(v) && v > 0) return Math.max(50, Math.min(300, v));
  } catch (e) {
    // localStorage unavailable — use the default.
  }
  return METER_INERTIA_DEFAULT;
}
function loadMeterFallMs() {
  try {
    // Clamped like loadMeterInertiaPct: range tightened from 0-3000 to
    // 0-1000 (Nutzer-Wunsch 2026-10-18), a value saved before that should
    // land on the new max rather than falling back to the default.
    const v = Number(localStorage.getItem("open890rc.meterFallMs"));
    if (Number.isFinite(v) && v >= 0) return Math.min(1000, v);
  } catch (e) {
    // localStorage unavailable — use the default.
  }
  return METER_FALL_MS_DEFAULT;
}
function loadMeterReleasePct() {
  try {
    const v = Number(localStorage.getItem("open890rc.meterReleasePct"));
    if (Number.isFinite(v) && v > 0) return Math.max(100, Math.min(500, v));
  } catch (e) {
    // localStorage unavailable — use the default.
  }
  return METER_RELEASE_DEFAULT;
}
let meterInertiaPct = loadMeterInertiaPct();
let meterFallMs = loadMeterFallMs();
let meterReleasePct = loadMeterReleasePct();
// The value actually fed into the spring: the live raw value, except while
// a hold is active (see meterFallMs above), when it stays pinned at the
// held peak. analogHoldUntil is the performance.now() timestamp the current
// hold expires at — once "now" passes it, the very next lower reading falls
// through to the "track the live value" branch below and stays there
// (recomputed every frame) until a genuinely new peak arrives and pins it
// again. Both tracked together with WHICH source the value came from
// (receive S vs. TX PWR/SWR/ALC/IC, see analogTargetRaw) so a TX edge or a
// meter-mode click snaps straight to the new source's raw value instead of
// holding/falling from a leftover peak that belonged to a different scale.
let analogHeldTarget = 0;
let analogHoldUntil = 0;
let analogFallingSourceKey = null;
function animateAnalogNeedle(now) {
  // Clamp dt: an explicit-Euler spring this stiff can overshoot into
  // instability for very large steps (a backgrounded tab resuming, etc.) —
  // R8500 sidesteps this entirely with a fixed 20ms step (after(20, ...));
  // rAF's real elapsed time is better normally (frame-rate independent) but
  // needs this guard for the same reason.
  const dt = Math.min(0.05, (now - analogLastFrame) / 1000);
  analogLastFrame = now;
  const raw = analogTargetRaw();
  const sourceKey = lastState && lastState.tx ? analogMeterMode : "s";
  if (sourceKey !== analogFallingSourceKey) {
    analogFallingSourceKey = sourceKey;
    analogHeldTarget = raw;
    analogHoldUntil = now; // no hold carried over from a different source
  } else if (raw >= analogHeldTarget) {
    // A new (or equal) peak always wins immediately — attack stays exactly
    // as fast as with no hold at all — and gets its own fresh hold window.
    analogHeldTarget = raw;
    analogHoldUntil = now + meterFallMs; // meterFallMs 0 ⇒ already expired
  } else if (now >= analogHoldUntil) {
    // Not holding (expired, or never started): follow the live value.
    analogHeldTarget = raw;
  }
  // else: still within the hold window — stay pinned at analogHeldTarget,
  // the current (lower) raw reading is ignored for now.
  const target = analogHeldTarget;
  // Falling (needle needs to move DOWN towards target) gets the extra
  // meterReleasePct slowdown on top of meterInertiaPct; rising does not —
  // see meterReleasePct's own comment above for why.
  const falling = target < analogNeedleDisplayed;
  const k = (meterInertiaPct / 100) * (falling ? meterReleasePct / 100 : 1);
  const stiffness = ANALOG_SPRING_STIFFNESS / (k * k);
  const damping = ANALOG_SPRING_DAMPING / k;
  const accel = stiffness * (target - analogNeedleDisplayed) - damping * analogNeedleVelocity;
  analogNeedleVelocity += accel * dt;
  analogNeedleDisplayed += analogNeedleVelocity * dt;
  if (Math.abs(target - analogNeedleDisplayed) < 0.01 && Math.abs(analogNeedleVelocity) < 0.01) {
    analogNeedleDisplayed = target;
    analogNeedleVelocity = 0;
  }
  updateAnalogNeedle(analogNeedleDisplayed);
  requestAnimationFrame(animateAnalogNeedle);
}

// Updates one meter's bar: val is the radio's raw 0-70ish needle-deflection
// reading, shared across the S/ALC/SWR meters. 0-35 fills the cyan "low"
// section (S1-S9), 35-70 continues into the red "high" section (+20/+40/+60).
// The red part of the top meter starts at sRedSplit (raw units): 35 for the
// S scale, the last 20% (56) of the scale when it shows TX power.
let sRedSplit = 35;
function updateMeter(prefix, val) {
  val = Math.max(0, Math.min(70, val));
  const split = prefix === "s" ? sRedSplit : 35;

  const low = document.getElementById(`${prefix}-meter-low`);
  const high = document.getElementById(`${prefix}-meter-high`);

  low.setAttribute("width", Math.min(val, split) * 5);
  high.setAttribute("x", split * 5);
  high.setAttribute("width", val > split ? (val - split) * 5 : 0);
  // The analog needle is NOT driven from here: it has its own spring-damper
  // animation loop (animateAnalogNeedle) reading meterTarget.s directly —
  // chaining it off this already-eased val would double-smooth and lose the
  // needle's characteristic overshoot (see that function's own comment).
  // SWR no longer has an analog-gauge needle at all (removed 2026-10-09,
  // see the analog gauge note in index.html) — the digital bar below the gauge
  // (.swr-meter-svg, shown on desktop again) is driven by this exact same
  // updateMeter("swr", ...) call already, nothing extra needed here.
}

// Smoothing: the radio reports the meters in coarse steps (sometimes several
// bars at once), so applyState only sets the TARGET and a frame loop eases
// the shown value towards it (exponential, time-based, ~METER_SMOOTH_TAU_MS).
const METER_SMOOTH_TAU_MS = 25;
const meterTarget = { s: 0, swr: 0, alc: 0, id: 0 };
// "alc" smoothed/drawn too (the desktop ALC bar, see updateMeter's own
// comment) — "id" isn't, it has no bar, only the analog needle reads it.
const meterShown = { s: 0, swr: 0, alc: 0 };
let meterLastFrame = performance.now();
function meterFrame(now) {
  const alpha = 1 - Math.exp(-(now - meterLastFrame) / METER_SMOOTH_TAU_MS);
  meterLastFrame = now;
  for (const key of ["s", "swr", "alc"]) {
    let diff = meterTarget[key] - meterShown[key];
    if (Math.abs(diff) < 0.05) {
      if (diff === 0) continue;
      meterShown[key] = meterTarget[key];
    } else {
      meterShown[key] += diff * alpha;
    }
    updateMeter(key, meterShown[key]);
    if (key === "s") sMeterValue = meterShown[key];
  }
  if (txMsgOpen) updateTxMsgAlcMeter(meterShown.alc);
  requestAnimationFrame(meterFrame);
}
requestAnimationFrame(meterFrame);

// S-meter peak-hold: a thin marker jumps to a new high immediately, but a
// falling signal only drags it back down once it's held there for
// S_PEAK_HOLD_MS. Broadcasts only arrive when the S-meter value changes, so
// a steady quiet signal would never re-check the hold — a timer polls
// sMeterValue on its own instead of being driven by applyState.
const S_PEAK_HOLD_MS = 1000;
let sMeterValue = 0;
let sPeakValue = 0;
let sPeakSetAt = 0;

function updateSMeterPeak() {
  const now = performance.now();
  if (sMeterValue >= sPeakValue || now - sPeakSetAt >= S_PEAK_HOLD_MS) {
    sPeakValue = sMeterValue;
    sPeakSetAt = now;
  }
  const clamped = Math.max(0, Math.min(70, sPeakValue));
  const peak = document.getElementById("s-meter-peak");
  peak.setAttribute("x", clamped * 5);
  peak.classList.toggle("high", clamped > sRedSplit);
}

setInterval(updateSMeterPeak, 50);

// A row of buttons (AGC/NR/NB) where exactly the values in setActive() are
// highlighted. Building is separate from wiring (onClick) so state updates
// from the server can drive setActive() independently of user clicks.
function makeButtonGroup(containerId, values) {
  const container = document.getElementById(containerId);
  const normalized = values.map((v) => (typeof v === "object" ? v : { value: v, label: String(v) }));
  const buttons = new Map();

  for (const { value, label } of normalized) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    container.appendChild(btn);
    buttons.set(value, btn);
  }

  return {
    onClick(handler) {
      for (const [value, btn] of buttons) {
        btn.addEventListener("click", () => handler(value));
      }
    },
    setActive(activeValues) {
      for (const [value, btn] of buttons) {
        btn.classList.toggle("active", activeValues.includes(value));
      }
    },
  };
}

const nbGroup = makeButtonGroup("nb-buttons", [
  { value: "1", label: "NB1" },
  { value: "2", label: "NB2" },
]);
nbGroup.onClick((value) => {
  const which = Number(value);
  const enabled = which === 1 ? !currentNB1 : !currentNB2;
  send({ type: "setNB", which, enabled });
});

const antCycle = makeCycleButton(
  "ant-button",
  [
    { value: "1", label: "ANT 1" },
    { value: "2", label: "ANT 2" },
  ],
  (ant) => send({ type: "setAnt", ant })
);

// A single button that cycles through `states` in order on each click
// (AGC/NR/BC/PROC), instead of a separate button per option — same idea as
// makeButtonGroup, just far more compact. The label always shows the
// current state; setCurrent() keeps it in sync with the server (including
// external changes, e.g. someone turning a physical knob) so a click always
// advances from the *actual* current state, not a stale local guess. Each
// state is either a plain value (label === value, e.g. "OFF") or a
// {value, label} pair when they differ (e.g. value 1, label "NR1").
// isActive is optional — defaults to "anything but the first state counts
// as active" (matches AGC/NR/BC/PROC, where state[0] is always "OFF"), but
// the scope-rate cycle button below needs the opposite convention (its
// first/default state, "high", is the normal operating state and should
// look active/lit; only its LAST state, "off", should look dim).
function makeCycleButton(buttonId, states, onSelect, isActive) {
  const button = document.getElementById(buttonId);
  const normalized = states.map((s) => (typeof s === "object" ? s : { value: s, label: String(s) }));
  const activePredicate = isActive || ((value) => value !== normalized[0].value);
  let currentValue = normalized[0].value;

  function labelFor(value) {
    const item = normalized.find((s) => s.value === value);
    return item ? item.label : String(value);
  }

  // Optional per-state tooltip (e.g. explaining AI NR) — states that don't
  // set one just clear the title, same as today's no-tooltip behavior.
  function titleFor(value) {
    const item = normalized.find((s) => s.value === value);
    return (item && item.title) || "";
  }

  // Optional subset of values the cycle may step through (e.g. NR has only
  // NR1 in FM); null = all states.
  let allowed = null;

  button.addEventListener("click", () => {
    const pool = allowed ? normalized.filter((s) => allowed.includes(s.value)) : normalized;
    const idx = pool.findIndex((s) => s.value === currentValue);
    const next = pool[(idx + 1) % pool.length];
    onSelect(next.value);
  });

  return {
    setAllowed(values) {
      allowed = values;
    },
    setCurrent(value) {
      currentValue = value;
      button.textContent = labelFor(value);
      button.title = titleFor(value);
      button.classList.toggle("active", activePredicate(value));
    },
  };
}

// Button text includes its own function prefix (Nutzer-Wunsch, 2026-09-28:
// "AGC OFF"/"AGC S"/"AGC M"/"AGC F" etc. directly on the button, instead of
// a separate .ctrl-label span) — reclaims the whole label column's width as
// touch area, and lets ~4 of these compact buttons share one row instead of
// alternating label/button/label/button.
const agcCycle = makeCycleButton(
  "agc-button",
  [
    { value: "OFF", label: "AGC OFF" },
    { value: "S", label: "AGC S" },
    { value: "M", label: "AGC M" },
    { value: "F", label: "AGC F" },
  ],
  (value) => send({ type: "setAGC", agc: value })
);

// 4th step "AI NR" (Nutzer-Wunsch, 2026-10-07): client-side RNNoise (see
// audio.js) instead of the radio's own NR, folded into the same button
// rather than a separate standalone one — mutually exclusive with radio NR
// (entering it sends "setNR" 0, since both running together makes no
// sense), so the button always shows exactly one of OFF/NR1/NR2/AI NR. The
// two are otherwise fully decoupled on the wire (RNNoise never touches a
// CAT command, radio NR never touches audio.js) — only this button's own
// onSelect and applyState's sync (see below) keep them looking mutually
// exclusive in the UI.
// After the click on "AI NR" the radio still reports its old NR 1/2 for a moment
// (the NR0 confirmation arrives later; S-meter broadcasts in between carry the
// stale value). Without this guard applyState saw "radio NR on + RNNoise on" and
// switched AI NR straight off again, so the button went NR2 -> OFF and AI NR
// never showed (Nutzer-Report 2026-10-11).
let aiNrPendingUntil = 0;
const AI_NR_PENDING_MS = 2500;
const nrCycle = makeCycleButton(
  "nr-button",
  [
    { value: 0, label: "NR OFF", title: "Rauschreduzierung aktivieren / mehrmals drücken für AI NR" },
    { value: 1, label: "NR1" },
    { value: 2, label: "NR2" },
    { value: "ai", label: "AI NR", title: "RNNoise - AI based noise reduction" },
  ],
  (value) => {
    if (value === "ai") {
      aiNrPendingUntil = performance.now() + AI_NR_PENDING_MS;
      send({ type: "setNR", value: 0 });
      window.hamrcSetRNNoise(true);
      nrCycle.setCurrent("ai");
    } else {
      aiNrPendingUntil = 0;
      const wasAi = window.hamrcGetRNNoise();
      if (wasAi) window.hamrcSetRNNoise(false);
      send({ type: "setNR", value });
      // Leaving AI NR changes nothing the radio reports (its NR was 0 all along), so no state broadcast
      // follows and the button kept showing "AI NR" until some unrelated broadcast came in: show the
      // new step at once.
      if (wasAi) nrCycle.setCurrent(value);
    }
  }
);

// OFF state shows just "BC", no "OFF" suffix (Nutzer-Wunsch, 2026-11-02:
// "wenn er nicht leuchtet ist er ja aus" — same reasoning PROC already
// uses, unlit already says off).
const bcCycle = makeCycleButton(
  "bc-button",
  [
    { value: 0, label: "BC" },
    { value: 1, label: "BC1" },
    { value: 2, label: "BC2" },
  ],
  (value) => send({ type: "setBC", value })
);

// Desktop: AF and SQL sit directly under the meter, above the ANT 1 rows, flush with the buttons (Nutzer-Wunsch
// 2026-11-01), which leaves room in the right slider block for the NOTCH row below PWR. On a phone they
// stay in the slider block, before RFG.
(function relocateAfSqlForLayout() {
  const afRow = document.getElementById("af-row");
  const sqlRow = document.getElementById("sql-row");
  const leftSliders = document.getElementById("left-sliders");
  const leftStack = document.getElementById("left-stack");
  const meterBlock = document.querySelector(".meter-block");
  const sliderCol = document.querySelector(".slider-col");
  if (!afRow || !sqlRow || !leftSliders || !leftStack || !meterBlock || !sliderCol) return;
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  function apply() {
    if (desktopQuery.matches) {
      leftSliders.append(afRow, sqlRow);
      meterBlock.append(leftSliders); // directly under the meter-mode keys
    } else {
      leftStack.prepend(leftSliders);
      sliderCol.insertBefore(sqlRow, sliderCol.firstChild);
      sliderCol.insertBefore(afRow, sqlRow);
    }
  }
  apply();
  desktopQuery.addEventListener("change", apply);
  // AF/SQL are exactly as long as the RFG/PWR/NOTCH sliders on the right (Nutzer-Wunsch 2026-11-01); the
  // right ones take whatever their column gives them, so follow that width.
  const rfSlider = document.getElementById("rf-slider");
  const syncWidth = () => {
    const w = rfSlider.getBoundingClientRect().width;
    if (w > 0) leftSliders.style.setProperty("--sw", `${w}px`);
  };
  // ... and start level with the front of the ANT 1 button (the button rows are not always flush left)
  const antGroup = document.getElementById("ant-button").parentElement;
  const syncIndent = () => {
    if (!desktopQuery.matches) return;
    const d = antGroup.getBoundingClientRect().left - leftSliders.getBoundingClientRect().left;
    if (Number.isFinite(d)) leftSliders.style.setProperty("--al", `${Math.max(0, d)}px`);
  };
  const syncAll = () => {
    syncWidth();
    syncIndent();
  };
  syncAll();
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncAll);
    ro.observe(rfSlider);
    ro.observe(antGroup.parentElement);
  }
  window.addEventListener("resize", syncAll);
})();

// Manual notch: a click switches it on/off, a long press steps the width N -> M -> W (NW0/1/2).
// Its position is the NOTCH slider on the audio scope (positionNotchSlider).
const nchButton = document.getElementById("nch-button");
nchButton.addEventListener("click", () => {
  if (lastState && notchAvailable(lastState.mode)) send({ type: "setNotch", enabled: !lastState.notchOn });
});
onLongPress(nchButton, () => lastState && notchAvailable(lastState.mode) && send({ type: "setNotchWidth", value: ((lastState && lastState.notchWidth) + 1) % 3 }));

// RF attenuator: 0=off, 1=6dB, 2=12dB, 3=18dB ("RA" on the wire).
const attCycle = makeCycleButton(
  "att-button",
  [
    { value: 0, label: "ATT OFF" },
    { value: 1, label: "ATT 6dB" },
    { value: 2, label: "ATT 12dB" },
    { value: 3, label: "ATT 18dB" },
  ],
  (value) => send({ type: "setATT", value })
);

// Preamp: 0=off, 1, 2 ("PA" on the wire).
const preCycle = makeCycleButton(
  "pre-button",
  [
    { value: 0, label: "PRE OFF" },
    { value: 1, label: "PRE 1" },
    { value: 2, label: "PRE 2" },
  ],
  (value) => send({ type: "setPRE", value })
);

// PRE moves into the AT/TUNE/AGC/ANT/ATT row on desktop, between ANT and
// AGC (Nutzer-Wunsch, 2026-10-09), but stays in its original NR/NB/BC/PRE
// row on phone. Its button lives in a different flex container (ctrl-row-2)
// than the row it needs to join on desktop (ctrl-row-1) — CSS `order` only
// reorders siblings within the same container, so style.css can't place it
// there by itself (see that rule's own comment). Relocating the actual DOM
// node (not a clone, so the click handler wired above keeps working) on
// each crossing of the same breakpoint style.css uses instead.
(function relocatePreButtonForLayout() {
  const preGroup = document.getElementById("pre-button")?.closest(".btn-group");
  const ctrlRow1 = document.querySelector(".ctrl-row-1");
  const antGroup = document.getElementById("ant-button")?.closest(".btn-group");
  const ctrlRow2 = document.querySelector(".ctrl-row-2");
  if (!preGroup || !ctrlRow1 || !antGroup || !ctrlRow2) return;
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  function apply() {
    if (desktopQuery.matches) {
      ctrlRow1.insertBefore(preGroup, antGroup.nextSibling);
    } else {
      ctrlRow2.appendChild(preGroup);
    }
  }
  apply();
  desktopQuery.addEventListener("change", apply);
})();

// RIT/XIT knobs move under the Filter dropdown on desktop (Nutzer-Wunsch,
// 2026-10-13: "unter das Filter dropdown... mit klein RIT darunter stehen
// sonst weiss man nicht wofür der Knopf ist" — first placed left of NR OFF,
// then moved again once XIT joined it to its right) — #eq-row already has
// grid-area: eqmid, the same grid column the Band/Mode/Filter dropdowns sit
// in, and is otherwise empty on desktop now that TX EQ/RX EQ relocate next
// to PROC instead (see relocateEqButtonsForLayout below), so reusing it
// needs no new grid placement at all. Same cross-container relocation trick
// as the PRE button above. Stays in its original spot (hidden on phone
// regardless, see .rit-knob-wrap's own CSS) when back below the breakpoint,
// just to leave the DOM in a sane state.
(function relocateRitXitKnobsForLayout() {
  const ritWrap = document.getElementById("rit-knob-wrap");
  const xitWrap = document.getElementById("xit-knob-wrap");
  const eqRow = document.getElementById("eq-row");
  const paRow = document.getElementById("pa-row");
  if (!ritWrap || !xitWrap || !eqRow || !paRow) return;
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  // Desktop: the BW/shift/RIT text line sits right above the RIT/XIT knobs (Nutzer-Wunsch 2026-11-02, the tuning
  // wheel took its old place under the dropdowns); phone: back where it was.
  const infoRow = document.querySelector(".filter-info-row");
  const infoHome = infoRow ? { parent: infoRow.parentNode, next: infoRow.nextSibling } : null;
  function apply() {
    if (desktopQuery.matches) {
      eqRow.insertBefore(ritWrap, eqRow.firstChild);
      eqRow.insertBefore(xitWrap, ritWrap.nextSibling);
      if (infoRow) eqRow.insertBefore(infoRow, eqRow.firstChild);
    } else {
      paRow.insertAdjacentElement("afterend", ritWrap);
      ritWrap.insertAdjacentElement("afterend", xitWrap);
      if (infoRow) infoHome.parent.insertBefore(infoRow, infoHome.next);
    }
  }
  apply();
  desktopQuery.addEventListener("change", apply);
})();

// PA buttons (#pa-row): on desktop in the first button row of the left column, as its own line above ANT 1
// (Nutzer-Wunsch 2026-10-30); on the phone back in its own row where it always was.
(function relocatePaRowForLayout() {
  const paRow = document.getElementById("pa-row");
  const ctrlRow1 = document.querySelector(".ctrl-row-1");
  const extrasRow = document.getElementById("extras-row");
  if (!paRow || !ctrlRow1 || !extrasRow) return;
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  function apply() {
    if (desktopQuery.matches) ctrlRow1.insertBefore(paRow, ctrlRow1.firstChild);
    else extrasRow.insertAdjacentElement("afterend", paRow);
  }
  apply();
  desktopQuery.addEventListener("change", apply);
})();

// TX EQ and RX EQ move to sit immediately left of PROC on desktop, in the
// order RX EQ, TX EQ, PROC (2026-10-12 user requests: "TX Eqalizer links vom
// PROC button anordnen", then "RX equalizer links vom TX EQ platzieren"),
// but stay in their original eq-row on phone (where eq-row is hidden
// entirely anyway — see .eq-row's own CSS comment). Same cross-container
// relocation trick as the PRE button above: .mic-proc-row's PROC button is
// itself position:absolute with padding-right reserving its own room, and
// the row is justify-content:flex-end, so normal (non-absolute) flex
// children inserted there land flush against the start of that reserved
// space — i.e. exactly left of PROC — with no extra positioning rule
// needed; inserting TX EQ first and then RX EQ before it (both as
// "first child") gets the RX EQ, TX EQ, PROC left-to-right order. TX
// Monitor (2026-10-14, desktop-only) joins the same relocation, inserted
// last so it lands leftmost: TX MON, RX EQ, TX EQ, PROC. TX MSG (2026-10-29,
// "TX MSG button links neben TX MON anordnen" — previously stacked under
// PROC instead, didn't last) joins last of all, landing leftmost of
// everything: TX MSG, TX MON, RX EQ, TX EQ, PROC.
(function relocateEqButtonsForLayout() {
  const txMsgGroup = document.getElementById("txmsg-button")?.closest(".btn-group");
  const txMonGroup = document.getElementById("txmon-button")?.closest(".btn-group");
  const txEqGroup = document.getElementById("txeq-button")?.closest(".btn-group");
  const rxEqGroup = document.getElementById("rxeq-button")?.closest(".btn-group");
  const nchGroup = document.getElementById("nch-button")?.closest(".btn-group");
  const bcGroup = document.getElementById("bc-button")?.closest(".btn-group");
  const procGroup = document.getElementById("proc-button")?.closest(".btn-group");
  const procRow = document.querySelector(".mic-proc-row");
  // Nutzer-Wunsch 2026-10-30: on desktop the four buttons sit in #extras-row (grid
  // area where the PA row used to be), no longer next to PROC.
  const extrasRow = document.getElementById("extras-row");
  const ctrlRow2 = document.querySelector(".ctrl-row-2");
  const nbButtons = document.getElementById("nb-buttons");
  if (!txMsgGroup || !txMonGroup || !txEqGroup || !rxEqGroup || !nchGroup || !bcGroup || !procGroup || !procRow || !extrasRow || !ctrlRow2 || !nbButtons) return;
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  function apply() {
    if (desktopQuery.matches) {
      // order left to right: TX MSG, TX MON, RX EQ, TX EQ
      // PROC joins right of TX EQ (Nutzer-Wunsch 2026-11-01)
      extrasRow.append(txMsgGroup, txMonGroup, rxEqGroup, txEqGroup, procGroup);
    } else {
      // Phone (Nutzer-Wunsch, 2026-10-14: "NB1, NB2, BC in mobilansicht
      // entfernen und dafür RX EQ, TX EQ hinzufügen"): NB1/NB2/BC stay in
      // the DOM here (just hidden by their own CSS, see that rule's
      // comment) so RX EQ/TX EQ land in the visual gap they leave behind —
      // right after NR OFF, in the row's existing flex order.
      ctrlRow2.insertBefore(rxEqGroup, nbButtons.nextSibling);
      ctrlRow2.insertBefore(txEqGroup, rxEqGroup.nextSibling);
      procRow.append(procGroup); // phone: PROC sits under the TX button again
    }
  }
  bcGroup.after(nchGroup); // NOTCH sits right of BC (desktop only, hidden on a phone)
  apply();
  desktopQuery.addEventListener("change", apply);
})();

// Same name-on-the-button style as AT/AGC/ANT/ATT etc. above (Nutzer-Wunsch,
// 2026-09-29 — was previously "MIC"/"ON", not matching that row's pattern of
// showing the function's own name plus its current state). Unlike those,
// BOTH states just read "PROC" (Nutzer-Wunsch, 2026-09-29: dropped "OFF" too
// — unlit already means off, same as lit already means on, spelling out
// either is redundant) — the identical text also keeps the button's width
// constant, so it no longer shifts the gap to the slider on every click.
const procCycle = makeCycleButton(
  "proc-button",
  [
    { value: false, label: "PROC", title: "Ein/Aus - lange drücken für Einstellungen" },
    { value: true, label: "PROC", title: "Ein/Aus - lange drücken für Einstellungen" },
  ],
  (enabled) => send({ type: "setProc", enabled })
);

const atCycle = makeCycleButton(
  "at-button",
  [
    { value: false, label: "AT OFF" },
    { value: true, label: "AT ON" },
  ],
  (enabled) => send({ type: "setTuner", enabled })
);

// Nutzer-Report (2026-09-29): excluding state.tuning from the mic-streaming
// trigger (see applyState below) wasn't reliable enough on its own — the
// radio reports TX and tuning-active as two SEPARATE CAT messages, so
// nothing guarantees they arrive in the same broadcast; a brief
// tx=true/tuning=false window still slipped through and started mic
// capture. We know locally, the instant the button is actually clicked,
// that a tune cycle is starting — well before any radio confirmation at
// all — so suppress the mic trigger off that instead of waiting on the
// radio's own (racy) tuning flag.
//
// First version used a flat timeout (suppress for N seconds after the
// click) — Nutzer-Report, 2026-09-29: that blocked a genuine TX/mic press
// made shortly after a tune cycle finished, for as long as the timeout still
// had time left, even though the radio was already back in RX. Nutzer-
// Wunsch: lift the suppression as soon as the radio is actually receiving
// again instead of guessing a fixed duration. During tuning the radio is
// transmitting (keyed against its own internal test signal, see above), so
// it stops reporting fresh receive data until the tune cycle's own TX pulse
// ends — the same tx:true -> tx:false transition already tracked for
// everything else here IS that "receiving again" signal, no separate
// S-meter-specific check needed. tuneSuppressSeenTxHigh tracks whether
// we've actually seen that pulse yet (so an unrelated, ALREADY-false tx at
// the moment of the click — the normal case, radio was just idling —
// doesn't immediately clear the suppression before the real pulse even
// starts). TUNE_MIC_SUPPRESS_TIMEOUT_MS is a generous safety cap in case
// that pulse is somehow never observed (e.g. a broadcast gets lost) —
// without it, a lost broadcast would leave the suppression stuck forever.
let tuneSuppressMic = false;
let tuneSuppressSeenTxHigh = false;
let tuneSuppressDeadline = 0;
const TUNE_MIC_SUPPRESS_TIMEOUT_MS = 15000;

const tuneButton = document.getElementById("tune-button");
tuneButton.addEventListener("click", () => {
  if (!txAllowed) return; // the button is also .disabled, this covers e.g. a stray Enter/Space
  tuneSuppressMic = true;
  tuneSuppressSeenTxHigh = false;
  tuneSuppressDeadline = performance.now() + TUNE_MIC_SUPPRESS_TIMEOUT_MS;
  send({ type: "setTune" });
});

const txButton = document.getElementById("tx-button");
// Big TX button inside Simple Mode (Nutzer-Wunsch 2026-10-24, see
// #simple-mode-overlay/setSimpleMode further down) — shares every bit of
// txButton's click/hold-to-talk/title/disabled wiring below via txButtons,
// rather than a second parallel implementation that could drift out of sync.
const txAreaButton = document.getElementById("tx-area-button");
const txButtons = [txButton, txAreaButton];
function isCwMode(mode) {
  return mode === "CW" || mode === "CW-R";
}
// Only the client that asked for TX opens its microphone and mutes its RX; the
// radio's TX state is broadcast to every client, the others stay passive
// (Nutzer-Frage 2026-10-11). myTXUntil = this client's pending/active request.
let myTX = false;
let myTXSeenHigh = false;
let myTXDeadline = 0;
// The microphone is wanted from the moment THIS client asks for TX (the click),
// not only once the radio confirms it: building the mic path (getUserMedia,
// Bluetooth profile switch, ...) is the slow part, so it runs in parallel with
// the radio's own TX switch-over (Nutzer-Wunsch 2026-10-15).
function micWantedNow(state) {
  // A voice message recording with the LAN source (PB5 3) takes its audio
  // from the same TX audio path as a real transmission, but the radio does
  // not transmit - so the mic must stream without myTX (Nutzer-Report
  // 2026-10-29: recording stayed silent).
  if (txMsgRecMic) return true;
  return myTX && !state.tuning && !state.ampTuning && !tuneSuppressMic && !isCwMode(state.mode);
}
let txMsgRecMic = false;
let txMsgRecSeenActive = false;
let txMsgRecDeadline = 0;
function syncMicNow() {
  if (!lastState || !lastState.connected || !window.hamrcSetMicStreaming) return;
  const want = micWantedNow(lastState);
  if (want === currentMicStreaming) return;
  currentMicStreaming = want;
  return window.hamrcSetMicStreaming(want);
}
// The TX button turns red as soon as THIS client asks for TX (we assume the command
// reaches the radio, Nutzer-Wunsch 2026-10-21) and does not wait for the radio's
// confirmation; real transmitting is shown by the Busy/TX LED. It also follows
// state.tx, so another client's TX still lights it.
function paintTxButton() {
  const on = currentTX || myTX;
  for (const b of txButtons) b.classList.toggle("active", on);
  meterTxToggle.classList.toggle("active", on);
}
function setTX(enabling) {
  if (enabling && !txAllowed) return; // no TX access (listen-only user) — releasing is always fine
  if (enabling) {
    stopActiveTxMsg(); // Nutzer-Wunsch 2026-10-28: pressing TX also stops an active TX MSG
    myTX = true;
    myTXSeenHigh = false;
    myTXDeadline = performance.now() + 5000; // dropped if the radio never confirms
    // if the radio never confirms (not connected, command lost) the optimistic red must not stay
    setTimeout(() => {
      if (myTX && !currentTX && performance.now() >= myTXDeadline) {
        myTX = false;
        paintTxButton();
        syncMicNow();
      }
    }, 5100);
  } else {
    myTX = false;
  }
  paintTxButton();
  if (enabling && window.hamrcMuteRx && !(lastState && isCwMode(lastState.mode))) {
    // Cut RX playback at the click, not only once the radio confirms TX.
    window.hamrcMuteRx(true);
    // Safety: if TX never starts (e.g. not connected), un-mute again.
    setTimeout(() => {
      if (!currentMicStreaming && window.hamrcMuteRx) window.hamrcMuteRx(false);
    }, 3000);
  }
  send({ type: "setTX", enabled: enabling });
  syncMicNow();
}
function toggleTX() {
  if (currentTX && !myTX) return; // someone else is transmitting: do not cut in
  setTX(!currentTX);
}
// Optional "hold to talk" for the TX button (per browser): TX runs while the button is
// held, like the T key. Pointer capture keeps the touch on the button even when the
// finger slides off it; losing the pointer for any reason (lift, cancel, tab hidden)
// ends TX via pttRelease. Dropdown "TX/RX umschalten" = the plain toggle.
const TX_HOLD_KEY = "open890rc.txHold";
let txHoldMode = true; // default: TX only while held; only a stored "0" means toggle
try {
  if (localStorage.getItem(TX_HOLD_KEY) === "0") txHoldMode = false;
} catch (_) {}
for (const btn of txButtons) {
  btn.addEventListener("click", (e) => {
    if (txHoldMode) return; // handled by the pointer events below
    toggleTX();
  });
  btn.addEventListener("pointerdown", (e) => {
    if (!txHoldMode || e.button > 0 || btn.disabled) return;
    e.preventDefault();
    if ((currentTX && !myTX) || currentTX || pttHeld) return;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (_) {}
    pttHeld = true;
    setTX(true);
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
    btn.addEventListener(ev, () => {
      if (txHoldMode) pttRelease();
    });
  }
  btn.addEventListener("contextmenu", (e) => {
    if (txHoldMode) e.preventDefault(); // long press on iOS/Android must not open a menu
  });
}

// Push-to-talk on the T key (the letter, whatever the keyboard layout): transmit
// while it is held, back to receive on release (Nutzer-Wunsch 2026-10-10; Ctrl and
// the keypad's 0 were tried first — T is not used anywhere in the page outside text
// fields). Safeguards:
// the release must always arrive — losing focus or hiding the tab ends TX at once;
// no PTT while typing in a field, with a dialog open, without radio, during a tune,
// with Ctrl/Alt/Cmd held (browser shortcuts such as Ctrl+T = new tab), or when TX
// was already started with the mouse.
const PTT_OVERLAYS = [
  "eq-overlay",
  "eqedit-overlay",
  "nr-overlay",
  "nb-overlay",
  "txmon-overlay",
  "proc-settings-overlay",
  "filter-settings-overlay",
  "audio-overlay",
  // Easy Mode has its own giant TX button (Nutzer-Wunsch 2026-10-24) — the
  // "t" key is just another way to drive the exact same thing, no reason to
  // block it while this one is open.
  "simple-mode-overlay",
];
const isPttKey = (e) => typeof e.key === "string" && e.key.toLowerCase() === "t";
let pttHeld = false; // the key is down and started this TX
function pttRelease() {
  if (!pttHeld) return;
  pttHeld = false;
  myTX = false;
  paintTxButton();
  send({ type: "setTX", enabled: false }); // also when TX is not confirmed yet
  syncMicNow();
}
function pttBlocked(e) {
  const t = e.target;
  const tag = (t && t.tagName) || "";
  // sliders and checkboxes keep focus after a click/drag but take no text
  const nonText = tag === "INPUT" && ["range", "checkbox", "radio", "button"].includes(t.type);
  if ((tag === "INPUT" && !nonText) || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return true;
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  // Sound-related setting windows leave PTT working, so a change can be heard live
  // while transmitting; every other open window (connection, users, login, ...) blocks it.
  const open = document.querySelectorAll(".overlay:not([hidden])");
  for (const o of open) if (!PTT_OVERLAYS.includes(o.id)) return true;
  if (!lastState || !lastState.connected || lastState.tuning) return true;
  if (!txAllowed) return true;
  return false;
}
document.addEventListener("keydown", (e) => {
  if (!isPttKey(e) || e.ctrlKey || e.altKey || e.metaKey) return;
  if (pttBlocked(e)) return;
  e.preventDefault();
  if (e.repeat || pttHeld || currentTX) return;
  if (lastState && lastState.tx) return;
  pttHeld = true;
  setTX(true);
});
document.addEventListener("keyup", (e) => {
  if (isPttKey(e)) pttRelease();
});
window.addEventListener("blur", pttRelease);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pttRelease();
});

// The meter used to double as a second TX tap target (useful when the TX
// button scrolled out of view on a phone) — removed on operator request,
// 2026-10-08: "entferne die Senden Funktion bei Druck auf S-Meter/SWR
// Meter... es reicht hier der TX button". The element stays (still carries
// the TX-active glow via .active, synced in applyState below) but no
// longer reacts to clicks/taps.
const meterTxToggle = document.getElementById("meter-tx-toggle");

// Wraps a native <input type="range">: touch dragging just works (unlike
// the old hand-rolled div slider, which only ever tracked a mouse via
// mousemove — it never followed a finger on mobile at all). onChange(value)
// fires on every interaction (drag, tap, arrow keys, wheel) — callers that
// send the value to the radio wrap it in their own makeThrottledSender so a
// fast drag doesn't flood the CAT parser; the AF slider (client-side stream
// volume, no network involved) just applies it straight away.
// valueLabelId, if given, is kept showing the live value (e.g. "17W") in
// step with the input, including during drag, not just once applied.
function makeSlider(inputId, onChange, initialMax = 255, valueLabelId = null, formatLabel = (v) => `${v}`, fillId = null) {
  const input = document.getElementById(inputId);
  const valueLabel = valueLabelId && document.getElementById(valueLabelId);
  const fillEl = fillId && document.getElementById(fillId);
  let max = initialMax;
  input.max = max;

  function render() {
    if (valueLabel) valueLabel.textContent = formatLabel(Number(input.value));
    if (fillEl) setLevelFill(fillEl, input);
  }

  input.addEventListener("input", () => {
    render();
    onChange(Number(input.value));
  });

  // Range inputs have no built-in wheel behavior; arrow keys already nudge
  // by 1 natively, so mirror that for the mouse wheel too. Reads input.min
  // rather than assuming 0 — every slider using this helper used to start
  // at 0, but the mic limiter threshold slider (2026-10-14) is the first
  // with a negative range, and a hardcoded 0 floor would have silently
  // capped wheel-scrolling there short of its real minimum.
  input.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const min = Number(input.min) || 0;
      const next = Math.max(min, Math.min(max, Number(input.value) + (e.deltaY < 0 ? 5 : -5)));
      input.value = next;
      render();
      onChange(next);
    },
    { passive: false }
  );

  render();

  return {
    applyValue(newValue) {
      input.value = newValue;
      render();
    },
    // For sliders whose range depends on what they currently control (the
    // MIC/PROC slider) — also used by the wheel handler above.
    setMax(newMax) {
      max = newMax;
      input.max = newMax;
      render();
    },
  };
}

// Animates a slider's DISPLAYED position smoothly between two values instead
// of snapping — used for the power-off "drive to zero" and the matching
// power-on "drive to the real value" (Nutzer-Wunsch, 2026-10-14). Purely
// visual: calls applyValue only, never the slider's own onChange, so no
// setRFGain/setSquelch/setPower (or anything else) gets sent to the radio
// mid-animation. A running tween on the same slider is cancelled and
// replaced rather than left to fight the new one (relevant if the radio
// reconnects again quickly after a power-off, before the first tween finished).
const activeTweens = new WeakMap();
function tweenSliderTo(sliderObj, inputEl, toValue, durationMs) {
  const existing = activeTweens.get(inputEl);
  if (existing) cancelAnimationFrame(existing);
  const fromValue = Number(inputEl.value);
  if (fromValue === toValue) {
    sliderObj.applyValue(toValue);
    return;
  }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic: brisk start, gentle settle
    sliderObj.applyValue(Math.round(fromValue + (toValue - fromValue) * eased));
    if (t < 1) {
      activeTweens.set(inputEl, requestAnimationFrame(step));
    } else {
      activeTweens.delete(inputEl);
    }
  }
  activeTweens.set(inputEl, requestAnimationFrame(step));
}

// Power-off "spin down to zero" / power-on "spin up to the real value"
// (Nutzer-Wunsch, 2026-10-14) — AF/SQL/RFG/PWR tween to each slider's own
// minimum when the TS890 is switched off, and the waterfall/spectrum fades
// out over the same SHUTDOWN_ANIM_MS (see .waterfall-wrap's own CSS
// transition, same duration, kept in sync here). AF is browser-local (not
// radio state, see audio.js) — reconnect restores it via
// window.hamrcGetAFVolumeDisplay(), the real stored value, not a value we'd
// have to snapshot ourselves before zeroing the display.
const SHUTDOWN_ANIM_MS = 900;
// 0 = no reconnect animation pending; otherwise a performance.now() deadline
// (see onConnectedChange) up to which an incoming broadcast's rfGain/
// squelch/power should retarget the slider tween rather than snap instantly.
let sliderReconnectAnimationUntil = 0;
// Mirror of the above for the OUTGOING direction: 0 = no shutdown in
// progress; otherwise a deadline up to which applyState should force the
// S-meter's target to 0 instead of the broadcast's real reading — without
// this, a live TX890-ausschalten/Trennen sequence (connection stays up for a
// few more seconds) keeps delivering real S-meter broadcasts that would
// fight the "drive to 0" below and the needle would just keep reading
// whatever's on the air (Nutzer-Wunsch, 2026-10-14).
let shutdownAnimationUntil = 0;
// Forces applyState's radioOff computation to true once the shutdown
// animation's 900ms are up, even if the real disconnect confirmation (TS890
// ausschalten's multi-second PA-then-radio sequence, or a Trennen round
// trip) hasn't actually landed yet — see the setTimeout in
// playShutdownAnimation. Cleared again on a genuine reconnect
// (onConnectedChange).
let forceRadioOffDisplay = false;
// Elements playShutdownAnimation dimmed to 0.4 and deliberately leaves there
// (see its own comment) — finishShutdownFade needs this exact list again to
// know what to leave alone vs. the meter/waterfall/freq exception, and
// onConnectedChange needs it to restore everything on a genuine reconnect.
let shutdownDimElements = [];
// main > * isn't always what actually RENDERS a box: on desktop, .controls
// and .ctrl-row-group are both display:contents (pure layout pass-throughs,
// see style.css — their own children become main's direct grid items, see
// that rule's own comment) — opacity on a display:contents element has NO
// visual effect at all (there's no box to paint it on), even though
// getComputedStyle happily keeps reporting whatever value was assigned,
// which is exactly what made this look like it "worked" when only checked
// numerically (Nutzer-Report, 2026-10-14: "die Buttons dimmen alle nicht
// mit" — true on desktop, confirmed live: .controls' own opacity was
// changing in computed style the whole time, just never painted). Descends
// into any display:contents element instead of tagging it directly, so the
// elements that actually get dimmed are always real, paintable boxes.
function collectDimTargets(root) {
  const targets = [];
  for (const el of root.children) {
    if (getComputedStyle(el).display === "contents") {
      targets.push(...collectDimTargets(el));
    } else {
      targets.push(el);
    }
  }
  return targets;
}

// Drives an element's inline opacity directly via rAF instead of a CSS
// class+transition — CSS transitions turned out unreliable for this
// specific case (Nutzer-Report, 2026-10-14: "dimmen vorher nicht mit
// herunter", confirmed even after fixing the transition-bundling issue and
// the display:contents issue above: some elements still jumped straight to
// their end value instead of animating). This is the exact same rAF-tween
// approach tweenSliderTo already uses for the sliders, which DOES visibly
// animate correctly — same mechanism, now also used for opacity.
const activeOpacityTweens = new WeakMap();
function tweenOpacityTo(el, toOpacity, durationMs) {
  const existing = activeOpacityTweens.get(el);
  if (existing) cancelAnimationFrame(existing);
  const current = Number.parseFloat(el.style.opacity);
  const fromOpacity = Number.isFinite(current) ? current : 1;
  // durationMs <= 0 means "snap", used for the meter/waterfall/freq exempt
  // elements right as the real off-state appears — also avoids a 0/0 = NaN
  // from the (now - start) / durationMs division below.
  if (fromOpacity === toOpacity || durationMs <= 0) {
    el.style.opacity = String(toOpacity);
    activeOpacityTweens.delete(el);
    return;
  }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic, same as tweenSliderTo
    el.style.opacity = String(fromOpacity + (toOpacity - fromOpacity) * eased);
    if (t < 1) {
      activeOpacityTweens.set(el, requestAnimationFrame(step));
    } else {
      activeOpacityTweens.delete(el);
    }
  }
  activeOpacityTweens.set(el, requestAnimationFrame(step));
}

function playShutdownAnimation() {
  const wrap = document.querySelector(".waterfall-wrap");
  if (wrap) tweenOpacityTo(wrap, 0, SHUTDOWN_ANIM_MS);
  // Everything else on the page (buttons, dropdowns, control rows, AND the
  // frequency display — Nutzer-Report, 2026-10-14: "die Frequenzanzeige
  // dimmt nicht mit") dims to 0.4 over the same duration, started at the
  // same moment — the same dimmed look main.controls-off/[inert] already
  // give the "genuinely off" state (see setControlsDisabled), just reached
  // gradually here instead of snapping. The meter and the frequency display
  // both get the SAME treatment even though they're normally exempt from
  // [inert] dimming (they must stay readable once truly off — the meter
  // needle at 0, "OFF" on the digits) — handled by finishShutdownFade
  // tweening them back to full opacity right as that "off" content appears.
  // The non-exempt elements are deliberately left at 0.4 afterwards (not
  // reset) — see finishShutdownFade's own comment for why: the generic
  // main > [inert] 0.4 rule can't reach anything inside a display:contents
  // ancestor either, so without this they'd have no dimmed "off" look at
  // all on desktop once the animation itself is done.
  shutdownDimElements = collectDimTargets(document.querySelector("main")).filter(
    (el) => !el.matches(".status-row, .status-message-desktop, .waterfall-wrap")
  );
  for (const el of shutdownDimElements) tweenOpacityTo(el, 0.4, SHUTDOWN_ANIM_MS);
  shutdownAnimationUntil = performance.now() + SHUTDOWN_ANIM_MS;
  // The existing exponential meter smoothing (meterFrame/meterTarget, tau
  // 25ms) already chases whatever target it's given — just give it 0 and it
  // falls there on its own, same mechanism as any other meter movement.
  meterTarget.s = 0;
  meterTarget.swr = 0;
  meterTarget.alc = 0;
  meterTarget.id = 0;
  const rfInput = document.getElementById("rf-slider");
  const sqlInput = document.getElementById("sql-slider");
  const pwrInput = document.getElementById("pwr-slider");
  tweenSliderTo(rfSlider, rfInput, Number(rfInput.min), SHUTDOWN_ANIM_MS);
  tweenSliderTo(sqlSlider, sqlInput, Number(sqlInput.min), SHUTDOWN_ANIM_MS);
  tweenSliderTo(pwrSlider, pwrInput, Number(pwrInput.min), SHUTDOWN_ANIM_MS);
  if (window.hamrcSetAFVolumeDisplay) {
    const afInput = document.getElementById("af-slider");
    tweenSliderTo({ applyValue: window.hamrcSetAFVolumeDisplay }, afInput, Number(afInput.min), SHUTDOWN_ANIM_MS);
  }
  // By 900ms, show the real "off" state (frequency OFF-display, mode/band/
  // filter dropdowns back to their "--" placeholder, setControlsDisabled's
  // inert+dim) regardless of whether the server has actually confirmed the
  // disconnect yet — TS890 ausschalten in particular can take several more
  // seconds (PA off, then the radio), during which real broadcasts would
  // otherwise keep the page looking fully "on" underneath the fade. The
  // reactive radioOff check in applyState (below) still runs too and covers
  // the case where the real disconnect lands FASTER than this.
  setTimeout(() => {
    forceRadioOffDisplay = true;
    if (lastState) applyState(lastState);
  }, SHUTDOWN_ANIM_MS);
}

// Called exactly when the waterfall actually goes to its "off" state
// (hamrcSetWaterfallEnabled(false) or the radioOff-driven
// hamrcSetWaterfallRadioOff(true)), so the real content fades out smoothly
// first and the "Spektrum aus" hint then appears and stays (Nutzer-Report,
// 2026-10-14: previously the canvas was cleared and the hint shown
// immediately, and the hint itself was what the opacity transition then
// faded away — the opposite of the request). The meter and frequency
// display snap back to full visibility at the same instant (0ms "tween" —
// dimming was only ever for the transition, they must stay readable once
// genuinely off: the meter needle at 0, "OFF" on the digits) — everything
// else in shutdownDimElements is deliberately left at 0.4, since that's the
// resting "off" look for ordinary controls and nothing else would put it
// back (see playShutdownAnimation's own comment on why main > [inert]
// alone can't reach these elements).
function finishShutdownFade() {
  const wrap = document.querySelector(".waterfall-wrap");
  if (wrap) tweenOpacityTo(wrap, 1, 0);
  const meterBlock = document.querySelector(".meter-block");
  if (meterBlock) tweenOpacityTo(meterBlock, 1, 0);
  const freq = document.getElementById("freq");
  if (freq) tweenOpacityTo(freq, 1, 0);
}

const rfThrottle = makeThrottledSender(80);
const rfSlider = makeSlider("rf-slider", (value) => rfThrottle({ type: "setRFGain", value }));

const sqlThrottle = makeThrottledSender(80);
const sqlSlider = makeSlider("sql-slider", (value) => sqlThrottle({ type: "setSquelch", value }));

const pwrThrottle = makeThrottledSender(80);
const pwrSlider = makeSlider(
  "pwr-slider",
  (value) => pwrThrottle({ type: "setPower", value }),
  100,
  "pwr-value",
  (v) => `${v}W`
);

// The browser-side mic gain (window.hamrcSetMicGain, exported by audio.js,
// applied locally before the TX audio is sent) lives in the settings
// overlay's VOIP tab: Nutzer-Wunsch, 2026-10-04. Units there are tenths (10 =
// 1.0x).
const micGainSlider = makeSlider(
  "mic-gain-slider",
  (value) => {
    browserMicGainRaw = value;
    // audio.js remembers it for the selected microphone
    window.hamrcSetMicGain(value / 10);
  },
  MIC_GAIN_MAX,
  "mic-gain-value",
  (v) => `${(v / 10).toFixed(1)}x`,
  "mic-gain-fill"
);
// Only the slider's own visual value here — NOT window.hamrcSetMicGain
// (audio.js loads after this script, so it wouldn't exist yet); audio.js reads
// the same localStorage key for its own starting gain.
micGainSlider.applyValue(browserMicGainRaw);
// Switching the microphone loads that microphone's remembered gain.
window.hamrcOnMicGainChanged = (raw) => {
  browserMicGainRaw = raw;
  micGainSlider.applyValue(raw);
};

// A click-to-open dropdown (used for both mode and band): shows `items` as a
// menu under `buttonId`, calls onSelect with the clicked one's value, and
// closes on selection or an outside click. Each item is either a plain
// string (value === label, e.g. mode names) or a {value, label} pair when
// the displayed text differs from the wire value (e.g. band "40m" -> "7").
// Shared across every makeDropdown instance (mode/band/filter) so a single
// capture-phase listener (added once, below) can dismiss whichever one is
// open no matter which button/menu pair it belongs to.
const dropdownRegistry = [];

// A click outside all open dropdowns should ONLY dismiss them — not also
// activate whatever control happened to be underneath (e.g. clicking the AGC
// button while the mode dropdown is open should just close the mode
// dropdown, not close it AND toggle AGC). Capture phase runs before the
// click's actual target gets its own bubble-phase listener, so stopping it
// here prevents that target from ever seeing the click at all. A click that
// lands on an open dropdown's own button/menu is deliberately exempted —
// that's the normal "toggle it closed again" / "pick an item" interaction,
// handled by their own listeners below as before.
document.addEventListener(
  "click",
  (e) => {
    const openOnes = dropdownRegistry.filter((d) => !d.menu.hidden);
    if (openOnes.length === 0) return;
    const insideAnOpenOne = openOnes.some(
      (d) => d.menu.contains(e.target) || d.button.contains(e.target)
    );
    // Leave menu.hidden alone when the click landed on an open dropdown's
    // own button/menu — that click's own listener (toggle button, or an
    // item's own handler) already knows how to handle it correctly, and
    // touching `hidden` here first would race with the button's own
    // `hidden = !hidden` toggle (observed: it flipped straight back open).
    if (insideAnOpenOne) return;
    for (const { menu } of openOnes) menu.hidden = true;
    e.stopPropagation();
    e.preventDefault();
  },
  true
);

function makeDropdown(buttonId, menuId, items, onSelect) {
  const button = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  dropdownRegistry.push({ button, menu });
  const normalized = items.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item
  );
  let current = "";

  for (const { value, label, html } of normalized) {
    const li = document.createElement("li");
    if (html) li.innerHTML = html;
    else li.textContent = label;
    li.dataset.value = value;
    li.addEventListener("click", () => {
      menu.hidden = true;
      onSelect(value);
    });
    menu.appendChild(li);
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  return {
    setCurrent(value) {
      if (value === current) return;
      current = value;
      const item = normalized.find((i) => i.value === value);
      button.textContent = (item && item.label) || value || "--";
      for (const li of menu.children) {
        li.classList.toggle("current", li.dataset.value === value);
      }
    },
  };
}

const modeDropdown = makeDropdown("mode-button", "mode-menu", MODES, (mode) =>
  send({ type: "setMode", mode })
);
const bandDropdown = makeDropdown("band-button", "band-menu", BANDS, (band) =>
  send({ type: "setBand", band })
);
// Wire-level values stay "A"/"B"/"C" (matching cat.EncodeIFFilter/FL00-02).
// Displayed as "FILA"/"FILB"/"FILC" (2026-10-12 user request, renamed from
// the earlier "FIL1"/"FIL2"/"FIL3" — see this map's own history for why
// that used numbers instead of open890's lettering in the first place).
const FILTER_LABELS = { A: "FILA", B: "FILB", C: "FILC" };
const FILTER_SETTINGS_ITEM = "SETTINGS";
// The wrench of the client settings button at the top right (#audio-settings-button), so the entry that
// opens the filter settings reads as the same kind of "client settings" action (Nutzer-Wunsch 2026-10-30);
// no "CFG" text beside it any more (2026-10-31).
const GEAR_ICON_HTML =
  '<svg class="gear-icon gear-fill" viewBox="0 0 24 24"><path d="M22.7 19 13.6 9.9c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4Z" /></svg>';
const filterDropdown = makeDropdown(
  "filter-button",
  "filter-menu",
  [
    ...Object.entries(FILTER_LABELS).map(([value, label]) => ({ value, label })),
    { value: FILTER_SETTINGS_ITEM, label: "", html: GEAR_ICON_HTML },
  ],
  (filter) => {
    if (filter === FILTER_SETTINGS_ITEM) {
      openFilterSettingsOverlay();
      return;
    }
    send({ type: "setIFFilter", filter });
  }
);

// Used by the on-screen filter info row (BW/Shift, full precision — the
// Media Session artist line below wants a much shorter, compact form
// instead, see formatKHzCompact/hamrcSetNowPlaying's call site).
function filterInfoText(state) {
  if (!state.audioWidthHz) return "";
  let text = `BW ${(state.audioWidthHz / 1000).toFixed(2)} kHz`;
  if (state.audioHasShift) {
    text += ` · Shift ${(state.audioShiftHz / 1000).toFixed(2)} kHz`;
  }
  // RIT/XIT knobs dropped their own value labels (Nutzer-Wunsch, 2026-10-13:
  // shown here instead, e.g. "RIT -0.35 kHz") — only while actually on. Both
  // share the same offset (ritOffsetHz — there's only the one, see
  // internal/cat/rit.go), so if both happen to be on at once this shows the
  // identical Hz value twice under each one's own name, which still reads
  // correctly: it answers "is RIT on" and "is XIT on" independently.
  const hz = state.ritOffsetHz || 0;
  const hzText = `${hz >= 0 ? "+" : ""}${(hz / 1000).toFixed(2)} kHz`;
  if (state.ritOn) text += ` · RIT ${hzText}`;
  if (state.xitOn) text += ` · XIT ${hzText}`;
  return text;
}

// Compact kHz formatting for the Media Session artist line (Nutzer-Wunsch,
// 2026-09-29): "3kHz" for a whole number, "2.8kHz" when it isn't — shorter
// than filterInfoText's fixed two-decimal form, which reads fine in the
// on-screen filter row but is unnecessarily long for a lock-screen line.
function formatKHzCompact(hz) {
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}kHz`;
}

const audioFilterInfo = document.getElementById("audio-filter-info");
function updateAudioFilterInfo(state) {
  audioFilterInfo.textContent = filterInfoText(state);
}

// Filter settings overlay: roofing filter (same A/B/C selection as the main
// dropdown, just easier to reach alongside width) and the audio filter's
// WIDTH, as a slider. Dragging only updates the live kHz label; the actual
// command is sent once on release ("change", not "input"), which then gets
// snapped server-side to the nearest value the radio's lookup table actually
// supports (see cat.EncodeAudioWidth) — dragging to an in-between value and
// having it settle onto a real one on release feels like a normal slider.
let lastState = null;
let lastNowPlayingTitle = null;
let lastNowPlayingArtist = null;
let lastNowPlayingNR = null;
let lastNowPlayingAlbum = null;

const filterSettingsOverlay = document.getElementById("filter-settings-overlay");
const filterWidthRow = document.getElementById("filter-width-row");
const filterWidthSlider = document.getElementById("filter-width-slider");
const filterWidthValueEl = document.getElementById("filter-width-value");
const filterShiftRow = document.getElementById("filter-shift-row");
const filterShiftSlider = document.getElementById("filter-shift-slider");
const filterShiftValueEl = document.getElementById("filter-shift-value");
const filterLoHiCutRow = document.getElementById("filter-lohicut-row");
const locutSlider = document.getElementById("locut-slider");
const hicutSlider = document.getElementById("hicut-slider");
const locutValueEl = document.getElementById("locut-value");
const hicutValueEl = document.getElementById("hicut-value");
const lohicutFill = document.getElementById("lohicut-fill");
const roofingGroup = makeButtonGroup(
  "filter-settings-roofing-buttons",
  Object.entries(FILTER_LABELS).map(([value, label]) => ({ value, label }))
);
roofingGroup.onClick((filter) => send({ type: "setIFFilter", filter }));

// Filter window sliders in the flat track/fill look of the Hi/Lo cut slider (.level-slider): the fill
// runs from the left edge (width, APF gain) or from the zero point (shift, APF shift, which can be
// negative). Redrawn with every redraw of the scope while the window is open.
function setCenteredFill(fillEl, slider) {
  const min = Number(slider.min), max = Number(slider.max);
  const span = max - min || 1;
  const zero = Math.max(0, Math.min(1, (0 - min) / span));
  const pos = Math.max(0, Math.min(1, (Number(slider.value) - min) / span));
  fillEl.style.left = `${Math.min(zero, pos) * 100}%`;
  fillEl.style.width = `${Math.abs(pos - zero) * 100}%`;
}
function updateFilterFills() {
  setCenteredFill(document.getElementById("filter-width-fill"), filterWidthSlider);
  setCenteredFill(document.getElementById("filter-shift-fill"), filterShiftSlider);
  setCenteredFill(document.getElementById("apf-fill"), apfSlider);
  setCenteredFill(document.getElementById("apf-gain-fill"), apfGainSlider);
}
function updateFilterWidthLabel() {
  filterWidthValueEl.textContent = `${(Number(filterWidthSlider.value) / 1000).toFixed(2)} kHz`;
}

function updateFilterShiftLabel() {
  filterShiftValueEl.textContent = `${(Number(filterShiftSlider.value) / 1000).toFixed(2)} kHz`;
}

// Tracks whether the user currently has a finger/pointer on a slider, so
// applyState can keep syncing it live while the overlay is open (needed
// because switching the roofing filter recalls DIFFERENT values, arriving as
// a follow-up broadcast slightly after the filter-change one — a single
// "refresh once when the filter changes" missed that later update) WITHOUT
// fighting an in-progress drag the way a naive unconditional sync would.
let filterWidthDragging = false;
filterWidthSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
filterWidthSlider.addEventListener("input", () => {
  updateFilterWidthLabel();
  drawFilterGraph();
  audioWidthSender.live(Number(filterWidthSlider.value));
});
filterWidthSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  audioWidthSender.final(Number(filterWidthSlider.value));
});

// Shift shown alongside Width (both real, radio-reported values for CW/SSB
// in shift/width mode — see cat.FilterWidthShift/ShiftRange) rather than
// mutually exclusive with it the way Width vs. LC/HC are, so it reuses the
// same filterWidthDragging flag/guard (Nutzer-Wunsch, 2026-09-28) rather
// than a separate one refreshFilterSettingsOverlay's caller wouldn't know
// to check.
filterShiftSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
filterShiftSlider.addEventListener("input", () => {
  updateFilterShiftLabel();
  drawFilterGraph();
  shiftSender.live(Number(filterShiftSlider.value));
});
filterShiftSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  shiftSender.final(Number(filterShiftSlider.value));
});

// AM/FM have no single "width" — only independent lo-cut/hi-cut (see
// cat.AudioLoHiCut) — shown as a dual-handle slider: two native range inputs
// sharing one visual track (see the .dual-slider CSS for how), each only
// ever moving its own handle. Both share the SAME min/max so their thumb
// positions land proportionally on one real Hz axis instead of each being
// relative to its own separate range.
// The radio only offers fixed values (AM hi-cut: 2.0-3.0 kHz in 100 Hz steps,
// then 3.5, 4.0, 5.0 kHz; FM: 1.0-3.0 kHz in 100 Hz steps, then 3.4, 4.0, 5.0),
// sent in the snapshot as audioLoCutSteps/audioHiCutSteps. Handles snap to the
// nearest allowed value while dragging instead of showing values the radio
// would round anyway.
function snapToSteps(value, steps) {
  if (!steps || steps.length === 0) return value;
  let best = steps[0];
  for (const st of steps) if (Math.abs(st - value) < Math.abs(best - value)) best = st;
  return best;
}
function snapLoHiCutSliders() {
  locutSlider.value = snapToSteps(Number(locutSlider.value), lastState && lastState.audioLoCutSteps);
  hicutSlider.value = snapToSteps(Number(hicutSlider.value), lastState && lastState.audioHiCutSteps);
}

function updateLoHiCutLabels() {
  locutValueEl.textContent = `${(Number(locutSlider.value) / 1000).toFixed(2)} kHz`;
  hicutValueEl.textContent = `${(Number(hicutSlider.value) / 1000).toFixed(2)} kHz`;
}

function updateLoHiCutFill() {
  const min = Number(locutSlider.min);
  const max = Number(locutSlider.max);
  const span = max - min || 1;
  const loPct = ((Number(locutSlider.value) - min) / span) * 100;
  const hiPct = ((Number(hicutSlider.value) - min) / span) * 100;
  lohicutFill.style.left = `${loPct}%`;
  lohicutFill.style.right = `${100 - hiPct}%`;
}

locutSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
hicutSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
locutSlider.addEventListener("input", () => {
  snapLoHiCutSliders();
  updateLoHiCutLabels();
  updateLoHiCutFill();
  drawFilterGraph();
  loCutSender.live(Number(locutSlider.value));
});
hicutSlider.addEventListener("input", () => {
  snapLoHiCutSliders();
  updateLoHiCutLabels();
  updateLoHiCutFill();
  drawFilterGraph();
  hiCutSender.live(Number(hicutSlider.value));
});
locutSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  snapLoHiCutSliders();
  loCutSender.final(Number(locutSlider.value));
});
hicutSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  snapLoHiCutSliders();
  hiCutSender.final(Number(hicutSlider.value));
});

// Passband graphic: trapezoid over an audio-frequency axis, like the radio's
// own WIDTH/SHIFT display. Edges come from the sliders so it follows a drag
// live. CW is centred on the pitch + shift (pitch read from the radio via
// "PT", 700 Hz until it answers). No graphic for FSK/PSK (no shift/cut data
// there).
const CW_PITCH_HZ_ASSUMED = 700;
const filterGraphSvg = document.getElementById("filter-graph");
// The graphic at the top of the filter settings is the live scope now (renderAscope below); the old
// passband-only drawing is gone. Kept under its old name for the many places that redraw it.
function drawFilterGraph() {
  scheduleAscope();
}

// Audio scope on the desktop (Nutzer-Wunsch 2026-10-30), under the sliders: the radio's AF spectrum
// (##DD3 lines, /audioscope-ws) drawn like the passband graphic of the filter settings, with the
// header of the radio's own display (LC/BW/HC), the centre of the audio axis and the active roofing
// filter (RFT). The radio only sends it while a browser asks (setAudioScope). The axis range per mode
// is the one filterGraphParams uses; the radio's real range is not documented, so the spectrum and
// the filter outline may be off by a constant factor until compared with the radio display.
const ascopeSvg = document.getElementById("ascope");
const ASCOPE_MAX_LEVEL = 50; // ##DD3 values are 00h..32h (0..50): 0 = top (0 dB), 50 = not shown (-50 dB), see the Kenwood reference
// Spectrum look, switched by a click on the scope (Nutzer-Wunsch 2026-10-30): 0 gradient from blue to light grey
// the louder it gets, 1 green like the waterfall, 2 outline only. Kept per browser. (The plain blue fill was
// dropped after trying the four looks.)
const ASCOPE_STYLE_KEY = "open890rc.ascopeLook";
const ASCOPE_STYLES = 3;
let ascopeStyle = 0;
try {
  ascopeStyle = Math.max(0, Math.min(ASCOPE_STYLES - 1, Number(localStorage.getItem(ASCOPE_STYLE_KEY)) || 0));
} catch (e) {}
function cycleAscopeStyle() {
  ascopeStyle = (ascopeStyle + 1) % ASCOPE_STYLES;
  try {
    localStorage.setItem(ASCOPE_STYLE_KEY, String(ascopeStyle));
  } catch (e) {}
  scheduleAscope();
}
for (const el of [ascopeSvg, filterGraphSvg]) {
  el.style.cursor = "pointer";
  el.addEventListener("click", (e) => {
    // a click on the header strip (A/B/C box, LC/BW/HC) steps through the filters instead (Nutzer-Wunsch 2026-11-03)
    // (the whole grey header strip counts: its 20 units of the SVG's viewBox height)
    const vb = el.viewBox && el.viewBox.baseVal;
    const rect = el.getBoundingClientRect();
    const inHeader = vb && vb.height && rect.height && ((e.clientY - rect.top) * vb.height) / rect.height <= 20;
    if (inHeader && lastState && lastState.ifFilter) {
      const order = ["A", "B", "C"];
      send({ type: "setIFFilter", filter: order[(order.indexOf(lastState.ifFilter) + 1) % order.length] });
      return;
    }
    cycleAscopeStyle();
  });
  // no context menu on the picture (it kept the whole page stuck while it was open, Nutzer-Report 2026-10-30)
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
let ascopeData = null;
// What is drawn: ascopeData eased towards, so the ~8 lines a second the radio sends look like a fluid movement
// instead of 8 jumps (Nutzer-Wunsch 2026-10-30). ascopeAnim runs only while something is still moving.
let ascopeShown = null;
let ascopeAnim = 0;
let ascopeAnimLast = 0;
let ascopeAnimDrawn = 0;
const ASCOPE_EASE_MS = 50; // time constant of the easing (70 first, then 35 was too restless, Nutzer-Wunsch 2026-10-30)
function ascopeStep(now) {
  ascopeAnim = 0;
  if (!ascopeData) {
    ascopeShown = null;
    return;
  }
  if (!ascopeShown || ascopeShown.length !== ascopeData.length) ascopeShown = Float32Array.from(ascopeData);
  const alpha = 1 - Math.exp(-(now - ascopeAnimLast) / ASCOPE_EASE_MS);
  ascopeAnimLast = now;
  let moving = false;
  for (let i = 0; i < ascopeData.length; i++) {
    const d = ascopeData[i] - ascopeShown[i];
    if (Math.abs(d) > 0.15) {
      ascopeShown[i] += d * alpha;
      moving = true;
    } else {
      ascopeShown[i] = ascopeData[i];
    }
  }
  if (now - ascopeAnimDrawn >= 30) { // at most ~33 drawings a second
    ascopeAnimDrawn = now;
    drawAscope();
  }
  if (moving) ascopeAnim = requestAnimationFrame(ascopeStep);
  else drawAscope();
}
function startAscopeAnim() {
  if (ascopeAnim) return;
  ascopeAnimLast = performance.now();
  ascopeAnim = requestAnimationFrame(ascopeStep);
}
let ascopeWs = null;
let ascopeWanted = false;
let ascopeRetry = null;
let ascopeFrame = 0;
const ascopeDesktop = window.matchMedia("(min-width: 800px)");
function openAscopeWs() {
  if (ascopeWs) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/audioscope-ws`);
  ascopeWs = sock;
  sock.binaryType = "arraybuffer";
  sock.onmessage = (event) => {
    const bytes = new Uint8Array(event.data);
    window.hamrcReportTraffic(bytes.length, "scope");
    ascopeData = bytes;
    startAscopeAnim();
  };
  sock.onclose = () => {
    if (ascopeWs === sock) ascopeWs = null;
    if (ascopeWanted) {
      clearTimeout(ascopeRetry);
      ascopeRetry = setTimeout(() => {
        if (ascopeWanted) openAscopeWs();
      }, 2000);
    }
  };
  sock.onerror = () => sock.close();
}
function syncAscopeStream() {
  const want = !!((ascopeDesktop.matches || !filterSettingsOverlay.hidden) && lastState && lastState.connected && !document.hidden);
  if (want === ascopeWanted) return;
  ascopeWanted = want;
  send({ type: "setAudioScope", enabled: want });
  if (want) {
    openAscopeWs();
  } else {
    clearTimeout(ascopeRetry);
    if (ascopeWs) ascopeWs.close();
    ascopeWs = null;
    ascopeData = null;
    ascopeShown = null;
    scheduleAscope();
  }
}
document.addEventListener("visibilitychange", syncAscopeStream);
if (window.ResizeObserver) new ResizeObserver(() => scheduleAscope()).observe(ascopeSvg);
ascopeDesktop.addEventListener("change", syncAscopeStream);
new MutationObserver(() => {
  syncAscopeStream();
  scheduleAscope();
}).observe(filterSettingsOverlay, { attributes: true, attributeFilter: ["hidden"] });
// At most ~15 redraws a second: the radio sends many lines per second and the state broadcasts (S meter)
// come just as often, neither needs a redraw each.
const ASCOPE_MIN_INTERVAL_MS = 66;
let ascopeLastDraw = 0;
function scheduleAscope() {
  if (ascopeFrame) return;
  const wait = Math.max(0, ascopeLastDraw + ASCOPE_MIN_INTERVAL_MS - performance.now());
  ascopeFrame = setTimeout(() => {
    ascopeFrame = requestAnimationFrame(() => {
      ascopeFrame = 0;
      ascopeLastDraw = performance.now();
      drawAscope();
    });
  }, wait);
}
// The filter scope's frequency axis and the filter outline on it, from the live state (not the filter
// window's sliders, which only follow the radio while that window is open). The scope's span depends
// on the mode and filter, the rules are the ones open890 found out for this radio (audio_scope.ex):
// SSB/FM hi/lo cut: 0-3000 Hz, or 0-5000 when HC >= 3400; AM: 0-5000; SSB shift/width: 0-3000, or
// 0-5000 when shift + width/2 > 3000; FSK/PSK: 0-500 Hz for widths up to 500, else 0-3000; CW:
// 1000 Hz (width < 700) or 3000 Hz wide, centred on the pitch (open890 has 500/1500 here, which did not
// match photos of the radio display: width 300 fills 30% of the axis, width 800 about 27%). Where the
// switch between the two lies is a guess (700, as in open890). Returns null without filter data.
function ascopeGeometry(st) {
  const mode = st.mode || "";
  if (mode.startsWith("CW") && st.audioHasShift) {
    const width = st.audioWidthHz, shift = st.audioShiftHz;
    const pitch = st.cwPitchHz || CW_PITCH_HZ_ASSUMED;
    const span = width < 700 ? 1000 : 3000; // measured on photos of the radio display (width 300: 1000 Hz, width 800: 3000 Hz)
    const center = pitch + shift;
    return { x0: pitch - span / 2, x1: pitch + span / 2, lo: center - width / 2, hi: center + width / 2, titles: [`WIDTH:${width}`, "", `SHIFT:${shift}`] };
  }
  if (st.audioHasLoHiCut) {
    const lo = st.audioLoCutHz, hi = st.audioHiCutHz;
    const total = mode === "AM" || mode === "AM-D" || hi >= 3400 ? 5000 : 3000;
    return { x0: 0, x1: total, lo, hi, titles: [`LC: ${lo}`, `BW:${Math.max(0, hi - lo)}`, `HC:${hi}`] };
  }
  if (st.audioHasShift) {
    const width = st.audioWidthHz, shift = st.audioShiftHz;
    const total = shift + width / 2 > 3000 ? 5000 : 3000;
    return { x0: 0, x1: total, lo: shift - width / 2, hi: shift + width / 2, titles: [`WIDTH:${width}`, "", `SHIFT:${shift}`] };
  }
  if (st.audioWidthHz > 0) {
    const width = st.audioWidthHz;
    const total = width <= 500 ? 500 : 3000;
    return { x0: 0, x1: total, lo: total / 2 - width / 2, hi: total / 2 + width / 2, titles: [`WIDTH:${width}`, "", ""] };
  }
  return null;
}
// Draws the scope into an SVG: `st` = the filter state to show (the live state, or the live state with
// the filter window's slider values while that window is open), apf = optional CW audio peak filter shift.
// x position (viewBox units) of the notch for BP value `pos`: on the 0-3000 Hz axis it is pos/255*3000 Hz
// (open890 draws it so on its 0-3000 and 0-5000 axes); in CW the radio spreads it over the whole 1000 Hz
// axis (narrow) or the middle part of the 3000 Hz axis (wide). Both are taken from open890, not yet
// compared with the radio's display.
// AM and FM (also the -D modes) have no notch on the TS-890 (Kenwood PC Command Reference, user hint).
function notchAvailable(mode) {
  return !["AM", "AM-D", "FM", "FM-D"].includes(mode || "");
}
// Positions are on the spectrum data's own scale (the data runs from `left` to `right`, a little wider than the
// filter axis), so that the notch line sits in the middle of the dip the radio puts into the curve.
const NOTCH_WIDTH_HZ = [150, 300, 600]; // Normal, Middle, Wide (estimates)
function notchX(st, g, pos, left, right) {
  const xd = (hz) => left + (Math.max(g.x0, Math.min(g.x1, hz)) - g.x0) / (g.x1 - g.x0) * (right - left);
  if ((st.mode || "").startsWith("CW") && st.audioHasShift) {
    const narrow = g.x1 - g.x0 <= 1000;
    const frac = narrow ? pos / 255 : 70 / 212 + pos / 255 / 3;
    return left + frac * (right - left);
  }
  return xd((pos / 255) * 3000);
}
const notchSlider = document.getElementById("notch-slider");
const notchSender = makeLiveSender("setNotchPos");
let notchDragging = false;
notchSlider.addEventListener("pointerdown", () => {
  notchDragging = true;
});
notchSlider.addEventListener("input", () => {
  if (lastState) lastState.notchPos = Number(notchSlider.value); // the marker follows the finger at once
  scheduleAscope();
  notchSender.live(Number(notchSlider.value));
});
notchSlider.addEventListener("change", () => {
  notchDragging = false;
  notchSender.final(Number(notchSlider.value));
});
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, () => setTimeout(() => (notchDragging = false), 0));
}
function renderAscope(svg, st, apf) {
  const g = ascopeGeometry(st) || { x0: 0, x1: 3000, lo: 0, hi: 0, titles: [st.mode || "", "", ""] };
  // The scope under the sliders is as wide as the layout gives it at a fixed height, so the drawing
  // gets wider (not taller) with the room: the viewBox width follows the element's aspect ratio. The
  // one in the filter settings keeps its fixed shape.
  const H = 97;
  let W = 232;
  if (svg.id === "ascope") {
    const box = svg.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) W = Math.max(160, Math.round((H * box.width) / box.height));
    if (svg.getAttribute("viewBox") !== `0 0 ${W} ${H}`) svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  }
  const left = 4, right = W - 4, top = 24, base = 81; // 15% higher than 84/68 (Nutzer-Wunsch 2026-10-30)
  // The axis end sits a little before the right edge so that a filter edge AT the end of the axis (HC 3000
  // on the 0-3000 axis) still has room for its sloped flank, like on the radio's display; the spectrum
  // data runs on to the right edge.
  const slope = 8, plotRight = right - 10;
  const x = (hz) => left + (Math.max(g.x0, Math.min(g.x1, hz)) - g.x0) / (g.x1 - g.x0) * (plotRight - left);
  // like the radio's display: a grey strip on top with the active filter (A/B/C) in a white box, then
  // LC on the left, BW in the middle and HC on the right; the labels below the axis have no background
  let out = `<rect class="fg-frame" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="5"/>`;
  // the header strip is a dark grey gradient (per SVG id: a gradient inside a hidden SVG is not found)
  const gid = `${svg.id}-head`;
  out += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58585b"/><stop offset="1" stop-color="#2c2c2f"/></linearGradient></defs>`;
  out += `<rect x="1" y="1" width="${W - 2}" height="19" fill="url(#${gid})"/>`;
  const filt = st.ifFilter || "";
  if (filt) out += `<rect class="fg-a-box" x="2.5" y="2" width="16" height="16" rx="2"/><text class="fg-a-text" x="10.5" y="15" text-anchor="middle">${filt}</text>`;
  out += `<text class="fg-hd" x="24" y="14.5">${g.titles[0]}</text>`;
  if (g.titles[1]) out += `<text class="fg-hd" x="${W / 2 + 6}" y="14.5" text-anchor="middle">${g.titles[1]}</text>`;
  if (g.titles[2]) out += `<text class="fg-hd" x="${W - 5}" y="14.5" text-anchor="end">${g.titles[2]}</text>`;
  // The spectrum polygon is a placeholder in the static markup; only its points change with every line of
  // data (the markup is only rebuilt when something else changed), which keeps the page's main thread free
  // for the waterfall (Nutzer-Report 2026-10-30: the waterfall stuttered with the scope running).
  const spectrum = ascopeShown || ascopeData;
  const hasSpectrum = !!(spectrum && spectrum.length > 1);
  if (hasSpectrum) {
    const sid = `${svg.id}-spectrum`;
    // gradient for style 0: dark blue at the axis, light grey at the top (user space: the plot height)
    out += `<defs><linearGradient id="${sid}" gradientUnits="userSpaceOnUse" x1="0" y1="${base}" x2="0" y2="${top}"><stop offset="0" stop-color="#1f35c9" stop-opacity="0.75"/><stop offset="0.55" stop-color="#6f86e8" stop-opacity="0.8"/><stop offset="1" stop-color="#d8dbdf" stop-opacity="0.95"/></linearGradient></defs>`;
    const looks = [
      `fill:url(#${sid});stroke:rgba(255,255,255,0.45)`,
      "fill:rgba(60,190,90,0.55);stroke:rgba(160,255,175,0.75)",
      "fill:none;stroke:rgba(255,255,255,0.85);stroke-width:0.9",
    ];
    const tag = ascopeStyle === 2 ? "polyline" : "polygon";
    out += `<${tag} class="fg-spectrum" points="" style="${looks[ascopeStyle]}"/>`;
  }
  out += `<line class="fg-axis" x1="${left}" y1="${base}" x2="${right}" y2="${base}"/>`;
  const centerHz = (g.x0 + g.x1) / 2;
  const mid = x(centerHz);
  out += `<line class="fg-center" x1="${mid}" y1="${top}" x2="${mid}" y2="${base}"/>`;
  out += `<text class="fg-ft" x="${mid + 3}" y="${base + 11}">${Math.round(centerHz)}</text>`;
  const rft = st.ifFilter && st.filterWidthHz ? st.filterWidthHz[st.ifFilter] : 0;
  if (rft) out += `<text class="fg-ft" x="${right - 2}" y="${base + 11}" text-anchor="end">RFT:${rft / 1000} k</text>`;
  if (g.hi > g.lo) {
    // the left flank is vertical when the low edge sits at the start of the axis (LC 0), else sloped
    const xl = x(g.lo), xh = x(g.hi);
    const lowStart = g.lo <= g.x0 ? `${xl},${base}` : `${Math.max(left, xl - slope)},${base}`;
    const highEnd = `${Math.min(right, xh + slope)},${base}`;
    out += `<polyline class="fg-shape-line" points="${lowStart} ${xl},${top} ${xh},${top} ${highEnd}"/>`;
  }
  if (apf) {
    // audio peak filter (CW): a narrow peak at pitch + APF shift, width only visual
    const ax = x(apf.hz);
    const half = [3, 5, 8][apf.bw] || 5;
    out += `<polygon class="fg-apf" points="${ax - half},${base} ${ax},${top + 4} ${ax + half},${base}"/>`;
    out += `<text class="fg-apf-label" x="${ax + 7}" y="${top + 12}">APF</text>`;
  }
  // manual notch at the notch frequency (BP 0-255), drawn like the radio does (see below). Shown only for the live view, not while the TX filter is on display.
  const dspLabels = [];
  if (st.notchOn && !st.txView && notchAvailable(st.mode)) {
    const nx = notchX(st, g, st.notchPos, left, right);
    // like the radio's display: a thin vertical line, topped by a small "Y" (two arms meeting on the line).
    // The line stops at about 80% of the plot height (Nutzer-Wunsch), the Y is as wide as the notch itself:
    // NOTCH_WIDTH_HZ are estimates for Normal/Middle/Wide (the Hz values are not in the Kenwood reference).
    const half = (NOTCH_WIDTH_HZ[st.notchWidth] || NOTCH_WIDTH_HZ[0]) / 2 * ((right - left) / (g.x1 - g.x0));
    const armY = top + Math.min(half * 1.2, 14);
    const lineEnd = top + (base - top) * 0.8;
    out += `<polyline class="fg-notch-line" fill="none" points="${nx - half},${top} ${nx},${armY} ${nx + half},${top}"/>`;
    out += `<line class="fg-notch-line" x1="${nx}" y1="${armY}" x2="${nx}" y2="${lineEnd}"/>`;
    dspLabels.push(`NOTCH ${["N", "M", "W"][st.notchWidth] || "N"}`);
  }
  // active noise functions are listed the same way (Nutzer-Wunsch 2026-11-01): NR1/NR2 (or NR AI for the
  // browser-side noise reduction), NB1, NB2, BC1/BC2, left to right along the bottom edge
  if (!st.txView) {
    if (st.nr) dspLabels.push(`NR${st.nr}`);
    else if (window.hamrcGetRNNoise && window.hamrcGetRNNoise()) dspLabels.push("NR AI");
    if (st.nb1) dspLabels.push("NB1");
    if (st.nb2) dspLabels.push("NB2");
    if (st.bc) dspLabels.push(`BC${st.bc}`);
  }
  let labelX = left + 2;
  for (const text of dspLabels) {
    out += `<text class="fg-notch-label" x="${labelX}" y="${base + 11}">${text}</text>`;
    labelX += text.length * 5.4 + 3.5; // 8px label font, measured about 5.3 per character
  }
  if (svg._ascopeMarkup !== out) {
    svg.innerHTML = out;
    svg._ascopeMarkup = out;
  }
  if (hasSpectrum) {
    const n = spectrum.length;
    const corners = ascopeStyle !== 2; // the outline is the curve only, no closing lines along the axis
    const parts = corners ? [`${left},${base}`] : [];
    for (let i = 0; i < n; i++) {
      const v = Math.min(spectrum[i], ASCOPE_MAX_LEVEL);
      parts.push(`${(left + (i / (n - 1)) * (right - left)).toFixed(1)},${(base - ((ASCOPE_MAX_LEVEL - v) / ASCOPE_MAX_LEVEL) * (base - top - 2)).toFixed(1)}`);
    }
    if (corners) parts.push(`${right},${base}`);
    svg.querySelector(".fg-spectrum").setAttribute("points", parts.join(" "));
  }
}
// Both scopes: the one under the sliders (desktop) and the one in the filter settings window.
// While transmitting the radio's display shows the TX filter (menu items TX Filter Low/High Cut, read at
// connect) with LC/BW/HC, no filter letter and no RFT; the spectrum is that of the transmit signal, which
// the radio keeps sending as ##DD3 (empty in the photo only because nothing was being said). Returns that view of the
// state, or null when not transmitting or the radio has no TX filter in this mode (CW, FM, FSK/PSK).
function ascopeTxView(st) {
  if (!st.tx || st.tuning || !st.txFilterLoCutHz || !st.txFilterHiCutHz) return null;
  return Object.assign({}, st, {
    txView: true,
    audioHasLoHiCut: true,
    audioHasShift: false,
    audioLoCutHz: st.txFilterLoCutHz,
    audioHiCutHz: st.txFilterHiCutHz,
    ifFilter: "",
  });
}
function drawAscope() {
  if (!lastState) return;
  const txView = ascopeTxView(lastState);
  const show = !!(ascopeDesktop.matches && lastState.connected);
  ascopeSvg.toggleAttribute("hidden", !show); // SVG elements have no .hidden property
  if (show) renderAscope(ascopeSvg, txView || lastState);
  if (!filterSettingsOverlay.hidden && txView) {
    filterGraphSvg.toggleAttribute("hidden", false);
    renderAscope(filterGraphSvg, txView);
  } else if (!filterSettingsOverlay.hidden) {
    updateFilterFills();
    // the window follows its sliders while they are dragged, ahead of the radio's confirmation
    const st = Object.assign({}, lastState);
    if (st.audioHasLoHiCut) {
      st.audioLoCutHz = Number(locutSlider.value);
      st.audioHiCutHz = Number(hicutSlider.value);
    } else if (st.audioHasShift || st.audioWidthHz > 0) {
      st.audioWidthHz = Number(filterWidthSlider.value);
      if (st.audioHasShift) st.audioShiftHz = Number(filterShiftSlider.value);
    }
    const isCW = (st.mode || "").startsWith("CW");
    const pitch = st.cwPitchHz || CW_PITCH_HZ_ASSUMED;
    const apf = isCW && st.apfOn && st.apfKnown ? { hz: pitch + Number(apfSlider.value), bw: st.apfBwKnown ? st.apfBw : 1 } : undefined;
    filterGraphSvg.toggleAttribute("hidden", !st.connected);
    if (st.connected) renderAscope(filterGraphSvg, st, apf);
  }
}

// APF (audio peak filter, CW only): on/off button + shift slider (-200..+200
// Hz around the pitch). Shift is sent on release; the graphic follows live.
const apfRow = document.getElementById("apf-row");
const apfToggle = document.getElementById("apf-toggle");
const apfSlider = document.getElementById("apf-slider");
const apfValueEl = document.getElementById("apf-value");
function updateApfLabel() {
  const hz = Number(apfSlider.value);
  apfValueEl.textContent = `${hz > 0 ? "+" : ""}${hz} Hz`;
}
apfToggle.addEventListener("click", () => {
  send({ type: "setApf", enabled: !(lastState && lastState.apfOn) });
});
apfSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
apfSlider.addEventListener("input", () => {
  updateApfLabel();
  drawFilterGraph();
  apfShiftSender.live(Number(apfSlider.value));
});
apfSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  apfShiftSender.final(Number(apfSlider.value));
});

// A click on a slider without changing its value never fires "change", which
// would leave filterWidthDragging stuck on and freeze the whole overlay's
// sync (APF button not following the radio). Releasing the pointer anywhere
// ends the drag; the slider's own "change" has already been queued by then.
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, () => {
    setTimeout(() => {
      filterWidthDragging = false;
    }, 0);
  });
}

// APF pass bandwidth (NAR/MID/WIDE, "AP2") and gain (0-6, "AP3"), CW only
// like the rest of the APF controls.
const APF_BW_LABELS = ["NAR", "MID", "WIDE"];
const apfBwRow = document.getElementById("apf-bw-row");
const apfGainRow = document.getElementById("apf-gain-row");
const apfGainSlider = document.getElementById("apf-gain-slider");
const apfGainValueEl = document.getElementById("apf-gain-value");
const apfBwGroup = makeButtonGroup(
  "apf-bw-buttons",
  APF_BW_LABELS.map((label, i) => ({ value: String(i), label }))
);
apfBwGroup.onClick((value) => send({ type: "setApfBw", value: Number(value) }));
function updateApfGainLabel() {
  apfGainValueEl.textContent = apfGainSlider.value;
}
apfGainSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
apfGainSlider.addEventListener("input", () => {
  updateApfGainLabel();
  apfGainSender.live(Number(apfGainSlider.value));
});
apfGainSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  apfGainSender.final(Number(apfGainSlider.value));
});

// SSB filter display: how the radio itself shows/stores the SSB passband
// (menu EX00611 / EX00612) — SHIFT/WIDTH or HI/LO CUT. The sliders below
// follow it (width+shift vs. two cuts); only offered in SSB modes.
const ssbModeRow = document.getElementById("ssb-filter-mode-row");
const ssbModeGroup = makeButtonGroup("ssb-filter-mode-buttons", [
  { value: "shiftWidth", label: "Shift/Width" },
  { value: "hiLoCut", label: "Hi/Lo Cut" },
]);
ssbModeGroup.onClick((value) => send({ type: "setSsbFilterMode", enabled: value === "hiLoCut" }));

function refreshFilterSettingsOverlay() {
  if (!lastState) return;
  roofingGroup.setActive([lastState.ifFilter]);
  ssbModeRow.hidden = !lastState.ssbFilterMode;
  ssbModeGroup.setActive(lastState.ssbFilterMode ? [lastState.ssbFilterMode] : []);

  filterWidthRow.hidden = !!lastState.audioHasLoHiCut;
  filterLoHiCutRow.hidden = !lastState.audioHasLoHiCut;

  if (lastState.audioHasLoHiCut) {
    // Shared axis for both handles: lo-cut's own min up to hi-cut's own
    // max, so e.g. AM's lo-cut (0-300Hz) occupies just the left sliver of
    // the same track hi-cut (2000-5000Hz) spans, matching their real
    // relative position on the frequency axis instead of each filling the
    // whole track on its own separate scale.
    const min = lastState.audioLoCutMinHz || 0;
    const max = lastState.audioHiCutMaxHz || 5000;
    for (const s of [locutSlider, hicutSlider]) {
      s.min = min;
      s.max = max;
      s.step = 10;
    }
    locutSlider.value = lastState.audioLoCutHz || min;
    hicutSlider.value = lastState.audioHiCutHz || max;
    snapLoHiCutSliders();
    updateLoHiCutLabels();
    updateLoHiCutFill();
  } else {
    filterWidthSlider.disabled = !lastState.audioWidthSettable;
    // Rounded down to a multiple of the 100Hz step: the table's real min
    // (e.g. 50 Hz) isn't itself step-aligned, which would otherwise make the
    // browser silently snap the just-set value to the nearest step position
    // and briefly show a value that doesn't match the actual current width.
    filterWidthSlider.min = Math.floor((lastState.audioWidthMinHz || 0) / 100) * 100;
    filterWidthSlider.max = lastState.audioWidthMaxHz || 3000;
    filterWidthSlider.value = lastState.audioWidthHz || filterWidthSlider.min;
    updateFilterWidthLabel();
  }

  // Independent of the width/lo-hi-cut branch above: shift only exists at
  // all for CW/CW-R and SSB in shift/width mode (never together with
  // lo/hi-cut — see cat.FilterWidthShift/ShiftRange), so audioHasShift
  // alone decides visibility here.
  filterShiftRow.hidden = !lastState.audioHasShift;
  if (lastState.audioHasShift) {
    filterShiftSlider.min = Math.floor((lastState.audioShiftMinHz || 0) / 10) * 10;
    filterShiftSlider.max = lastState.audioShiftMaxHz || 3000;
    filterShiftSlider.value = lastState.audioShiftHz ?? filterShiftSlider.min; // 0 is a valid shift
    updateFilterShiftLabel();
  }
  apfRow.hidden = !(lastState.mode || "").startsWith("CW");
  apfToggle.textContent = lastState.apfOn ? "ON" : "OFF";
  apfToggle.classList.toggle("active", !!lastState.apfOn);
  apfSlider.disabled = !lastState.apfOn;
  if (lastState.apfKnown && !filterWidthDragging) apfSlider.value = lastState.apfShiftHz;
  updateApfLabel();
  const isCW = (lastState.mode || "").startsWith("CW");
  apfBwRow.hidden = !isCW;
  apfGainRow.hidden = !isCW;
  apfBwGroup.setActive(lastState.apfBwKnown ? [String(lastState.apfBw)] : []);
  if (lastState.apfGainKnown && !filterWidthDragging) apfGainSlider.value = lastState.apfGain;
  updateApfGainLabel();
  drawFilterGraph();
}

// VoIP jitter buffer (##KN4, KNS admin only): sent on release, synced from
// the radio's reply otherwise. Dimmed rather than hidden without a KNS admin
// login (Nutzer-Wunsch, 2026-10-14: "sonst grau", same treatment as the VoIP
// audio input/output level sliders below — visible either way so it's clear
// the control exists, just unusable without admin).
const jitterRow = document.getElementById("jitter-row");
const jitterSlider = document.getElementById("jitter-slider");
const jitterValueEl = document.getElementById("jitter-value");
const jitterFillEl = document.getElementById("jitter-fill");
const JITTER_CHOICES_MS = [80, 200, 500, 800]; // the only values the radio accepts
let jitterDragging = false;
// Same single-handle .level-slider-fill width update for all three sliders
// here (jitter + the two VoIP levels below) — left edge is always 0, so
// just the value's share of max, unlike the waterfall's floating-pair
// .dual-slider-fill (which has two independent edges).
function setLevelFill(fillEl, slider) {
  // Same "0 is falsy" trap fixed elsewhere for localStorage reads — here it's
  // the min/max HTML attributes: an unset one reads back as "" (not null),
  // but `Number(slider.max) || 100` still silently swaps a legitimate "0"
  // (e.g. the mic limiter threshold's max, 0 dB) for the 100 fallback. Found
  // live, 2026-10-14: threshold's fill stuck at ~19% instead of 100% at its
  // max, because the fallback turned its real range (-24..0) into (-24..100).
  const min = slider.min !== "" ? Number(slider.min) : 0;
  const max = slider.max !== "" ? Number(slider.max) : 100;
  const pct = ((Number(slider.value) - min) / (max - min)) * 100;
  fillEl.style.width = `${pct}%`;
}
function updateJitterLabel() {
  jitterValueEl.textContent = `${JITTER_CHOICES_MS[Number(jitterSlider.value)]} ms`;
  setLevelFill(jitterFillEl, jitterSlider);
}
jitterSlider.addEventListener("pointerdown", () => {
  jitterDragging = true;
});
jitterSlider.addEventListener("input", updateJitterLabel);
jitterSlider.addEventListener("change", () => {
  jitterDragging = false;
  send({ type: "setJitterBuffer", value: JITTER_CHOICES_MS[Number(jitterSlider.value)] });
});
function syncJitterBuffer(state) {
  jitterSlider.disabled = !(state.connected && state.radioAdmin);
  if (!jitterDragging && state.jitterBufferMs) {
    let nearest = 0;
    JITTER_CHOICES_MS.forEach((ms, i) => {
      if (Math.abs(ms - state.jitterBufferMs) < Math.abs(JITTER_CHOICES_MS[nearest] - state.jitterBufferMs)) nearest = i;
    });
    jitterSlider.value = nearest;
    updateJitterLabel();
  }
}

// VoIP audio input/output level ("##KN3", Nutzer-Wunsch 2026-10-14): same
// admin-only-to-set, dimmed-when-not pattern as the jitter buffer above —
// one slider per side (P1 0/1), sent on release, 0-100, default 49.
const voipInputSlider = document.getElementById("voip-input-slider");
const voipInputValueEl = document.getElementById("voip-input-value");
const voipInputFillEl = document.getElementById("voip-input-fill");
const voipOutputSlider = document.getElementById("voip-output-slider");
const voipOutputValueEl = document.getElementById("voip-output-value");
const voipOutputFillEl = document.getElementById("voip-output-fill");
let voipInputDragging = false;
let voipOutputDragging = false;
voipInputSlider.addEventListener("pointerdown", () => {
  voipInputDragging = true;
});
voipInputSlider.addEventListener("input", () => {
  voipInputValueEl.textContent = voipInputSlider.value;
  setLevelFill(voipInputFillEl, voipInputSlider);
});
voipInputSlider.addEventListener("change", () => {
  voipInputDragging = false;
  send({ type: "setVoipInLevel", value: Number(voipInputSlider.value) });
});
voipOutputSlider.addEventListener("pointerdown", () => {
  voipOutputDragging = true;
});
voipOutputSlider.addEventListener("input", () => {
  voipOutputValueEl.textContent = voipOutputSlider.value;
  setLevelFill(voipOutputFillEl, voipOutputSlider);
});
voipOutputSlider.addEventListener("change", () => {
  voipOutputDragging = false;
  send({ type: "setVoipOutLevel", value: Number(voipOutputSlider.value) });
});
function syncVoipLevels(state) {
  const enabled = state.connected && state.radioAdmin;
  voipInputSlider.disabled = !enabled;
  voipOutputSlider.disabled = !enabled;
  if (!voipInputDragging) {
    voipInputSlider.value = state.voipInLevel || 0;
    voipInputValueEl.textContent = voipInputSlider.value;
    setLevelFill(voipInputFillEl, voipInputSlider);
  }
  if (!voipOutputDragging) {
    voipOutputSlider.value = state.voipOutLevel || 0;
    voipOutputValueEl.textContent = voipOutputSlider.value;
    setLevelFill(voipOutputFillEl, voipOutputSlider);
  }
}
// Initial fill width/value text for the HTML defaults (49/49/1), before any
// state broadcast has arrived to trigger the sync functions above.
updateJitterLabel();
voipInputValueEl.textContent = voipInputSlider.value;
setLevelFill(voipInputFillEl, voipInputSlider);
voipOutputValueEl.textContent = voipOutputSlider.value;
setLevelFill(voipOutputFillEl, voipOutputSlider);

function openFilterSettingsOverlay() {
  refreshFilterSettingsOverlay();
  filterSettingsOverlay.hidden = false;
}

document.getElementById("filter-settings-close").addEventListener("click", () => {
  filterSettingsOverlay.hidden = true;
});
filterSettingsOverlay.addEventListener("click", (e) => {
  if (e.target === filterSettingsOverlay) filterSettingsOverlay.hidden = true;
});

// PROC settings overlay: effect type (Soft/Hard, "PR1") plus the Input/Output
// levels ("PL", always sent/read as a pair) as two separate sliders — replaces
// the old single inline "LVL" slider next to the PROC button (Nutzer-Wunsch,
// 2026-10-07: PROC has its own Input AND Output in SSB, plus two
// independently-stored Soft/Hard presets the radio keeps apart). Shares
// filterWidthDragging with the filter overlay's sliders — same "stay live
// while open, don't fight an in-progress drag" guard, see that flag's own
// comment above.
const procSettingsOverlay = document.getElementById("proc-settings-overlay");
const procInSlider = document.getElementById("proc-in-slider");
const procInValueEl = document.getElementById("proc-in-value");
const procOutSlider = document.getElementById("proc-out-slider");
const procOutValueEl = document.getElementById("proc-out-value");
const procInSender = makeLiveSender("setProcLevelIn");
const procOutSender = makeLiveSender("setProcLevelOut");
const procTypeGroup = makeButtonGroup("proc-type-buttons", [
  { value: "soft", label: "Soft" },
  { value: "hard", label: "Hard" },
]);
procTypeGroup.onClick((value) => send({ type: "setProcType", enabled: value === "hard" }));

procInSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
procInSlider.addEventListener("input", () => {
  procInValueEl.textContent = procInSlider.value;
  procInSender.live(Number(procInSlider.value));
});
procInSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  procInSender.final(Number(procInSlider.value));
});

procOutSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
procOutSlider.addEventListener("input", () => {
  procOutValueEl.textContent = procOutSlider.value;
  procOutSender.live(Number(procOutSlider.value));
});
procOutSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  procOutSender.final(Number(procOutSlider.value));
});

function refreshProcSettingsOverlay() {
  if (!lastState) return;
  procTypeGroup.setActive(lastState.procTypeKnown ? [lastState.procTypeHard ? "hard" : "soft"] : []);
  procInSlider.value = lastState.procLevelIn;
  procInValueEl.textContent = lastState.procLevelIn;
  procOutSlider.value = lastState.procLevelOut;
  procOutValueEl.textContent = lastState.procLevelOut;
}

function openProcSettingsOverlay() {
  refreshProcSettingsOverlay();
  procSettingsOverlay.hidden = false;
}

// A long press on PROC opens its settings, whether PROC is on or off (was the CFG
// button). onLongPress is defined with the equalizer buttons further down (hoisted).
onLongPress(document.getElementById("proc-button"), openProcSettingsOverlay);
document.getElementById("proc-settings-close").addEventListener("click", () => {
  procSettingsOverlay.hidden = true;
});
procSettingsOverlay.addEventListener("click", (e) => {
  if (e.target === procSettingsOverlay) procSettingsOverlay.hidden = true;
});

// TX/RX equalizer (EQT0/EQT1, EQR0/EQR1): an on/off button each; a long press on
// it opens the effect choice. The TX equalizer does not exist in CW/FSK/PSK, its
// button is disabled there.
const EQ_EFFECTS_TX = ["High Boost 1", "High Boost 2", "Formant Pass", "Bass Boost 1", "Bass Boost 2", "Conventional", "User 1", "User 2", "User 3"];
const EQ_EFFECTS_RX = ["High Boost 1", "High Boost 2", "Formant Pass", "Bass Boost 1", "Bass Boost 2", "Flat", "User 1", "User 2", "User 3"];
const txEqCycle = makeCycleButton(
  "txeq-button",
  [
    { value: false, label: "TX EQ", title: "Ein/Aus - lange drücken für Einstellungen" },
    { value: true, label: "TX EQ", title: "Ein/Aus - lange drücken für Einstellungen" },
  ],
  (value) => send({ type: "setTxEq", enabled: value })
);
const rxEqCycle = makeCycleButton(
  "rxeq-button",
  [
    { value: false, label: "RX EQ", title: "Ein/Aus - lange drücken für Einstellungen" },
    { value: true, label: "RX EQ", title: "Ein/Aus - lange drücken für Einstellungen" },
  ],
  (value) => send({ type: "setRxEq", enabled: value })
);
const eqOverlay = document.getElementById("eq-overlay");
const eqEffectsEl = document.getElementById("eq-effects");
let eqOverlayKind = null; // "tx" | "rx" while open
function eqEffectButtons(kind) {
  const names = kind === "tx" ? EQ_EFFECTS_TX : EQ_EFFECTS_RX;
  eqEffectsEl.replaceChildren(
    ...names.map((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.dataset.effect = String(i);
      b.addEventListener("click", () => send({ type: kind === "tx" ? "setTxEqEffect" : "setRxEqEffect", value: i }));
      return b;
    })
  );
}
function refreshEqOverlay() {
  if (eqEditKind) refreshEqEdit();
  if (!eqOverlayKind || !lastState) return;
  const current = eqOverlayKind === "tx" ? lastState.txEqEffect : lastState.rxEqEffect;
  for (const b of eqEffectsEl.children) b.classList.toggle("active", Number(b.dataset.effect) === current);
}
function openEqOverlay(kind) {
  eqOverlayKind = kind;
  document.getElementById("eq-overlay-title").textContent = kind === "tx" ? "TX Equalizer" : "RX Equalizer";
  eqEffectButtons(kind);
  refreshEqOverlay();
  eqOverlay.hidden = false;
}
function closeEqOverlay() {
  eqOverlay.hidden = true;
  eqOverlayKind = null;
}

// TX Messages (desktop only, Nutzer-Wunsch 2026-10-27): the radio's six
// voice message memory channels. Opening the overlay turns the radio's
// Voice Message List display on (PB0) — everything else about voice
// messages refuses while it's off, see cat/voicemsg.go — and queries all
// six channels; closing it turns the list display back off. Simple
// last-client-wins policy, no per-client tracking (same known limitation as
// the ALC/ID meter's wantMeter in main.go): two browsers both opening this
// at once isn't handled specially.
const txMsgOverlay = document.getElementById("txmsg-overlay");
const txMsgButton = document.getElementById("txmsg-button");
const txMsgChannelsEl = document.getElementById("txmsg-channels");
let txMsgOpen = false;
// ALC meter (LED bar, like the browser-mic one): raw 0-70, 35 = end of the "OK"
// range. The radio is only asked for ALC readings (RM1) while some client has
// that meter mode selected, so the overlay asks for it while open (without
// changing the meter's own mode) and restores the meter's mode on close.
const TXMSG_ALC_SEGMENTS = 24;
const TXMSG_ALC_MAX_RAW = 70;
const txMsgAlcSegs = [];
{
  const el = document.getElementById("txmsg-alc-meter");
  for (let i = 0; i < TXMSG_ALC_SEGMENTS; i++) {
    const raw = ((i + 1) * TXMSG_ALC_MAX_RAW) / TXMSG_ALC_SEGMENTS; // upper edge of the segment
    const seg = document.createElement("span");
    seg.className = raw <= ANALOG_ALC_OK_RAW ? "g" : raw <= ANALOG_ALC_OK_RAW + 10 ? "y" : "r";
    el.appendChild(seg);
    txMsgAlcSegs.push(seg);
  }
}
let txMsgAlcHoldIdx = -1;
let txMsgAlcHoldUntil = 0;
function updateTxMsgAlcMeter(raw) {
  const lit = Math.min(TXMSG_ALC_SEGMENTS, Math.max(0, Math.round((raw / TXMSG_ALC_MAX_RAW) * TXMSG_ALC_SEGMENTS)));
  const now = performance.now();
  if (lit - 1 >= txMsgAlcHoldIdx || now > txMsgAlcHoldUntil) {
    txMsgAlcHoldIdx = lit - 1;
    txMsgAlcHoldUntil = now + 1200;
  }
  txMsgAlcSegs.forEach((s, i) => {
    s.classList.toggle("on", i < lit);
    s.classList.toggle("hold", i === txMsgAlcHoldIdx && i >= lit);
  });
}
function openTxMsgOverlay() {
  if (txMsgOpen) return;
  txMsgOpen = true;
  // Ask the server for ALC readings WITHOUT touching analogMeterMode, so the
  // meter's own mode button and needle keep showing what the user picked.
  send({ type: "setMeterMode", mode: "alc" });
  send({ type: "voiceMsgOverlay", enabled: true });
  txMsgOverlay.hidden = false;
}
function closeTxMsgOverlay() {
  if (!txMsgOpen) return;
  txMsgOpen = false;
  send({ type: "setMeterMode", mode: analogMeterMode }); // back to what the meter itself shows
  updateTxMsgAlcMeter(0);
  send({ type: "voiceMsgOverlay", enabled: false });
  txMsgOverlay.hidden = true;
}
// Short click sends the selected channel; a second short click while it's
// still active (playing/sending) stops it instead (Nutzer-Wunsch 2026-10-28:
// "einfacher klick: senden... wenn aktiv und nun erneut ein klick kommt,
// STOP") — same "short press does the thing, long press configures it"
// pattern as PROC/TX EQ/RX EQ/the noise blankers below, via onLongPress —
// long press still opens the overlay to pick which channel, rename it,
// record, etc. txMsgSelectedChannel defaults to 1 and otherwise keeps
// whatever was last picked in the overlay, even after it's closed.
txMsgButton.addEventListener("click", () => {
  if (!window.matchMedia("(min-width: 800px)").matches) return; // belt and braces: the button is already phone-hidden
  // Not .disabled like the overlay's own per-row SEND buttons (txAllowed,
  // see updateTxMsgOverlay) — this button's long press still has to work
  // for a listen-only user (opening the overlay to preview/rename/record
  // doesn't transmit), so only the click's own action is skipped here; the
  // server refuses the command either way (defense in depth).
  if (!txAllowed) return;
  if (isTxMsgActive(txMsgLastState)) {
    send({ type: "voiceMsgControl", channel: txMsgSelectedChannel, value: 0 });
  } else if (!selectedTxMsgHasContent()) {
    // Nutzer-Wunsch 2026-10-28: nothing to send on this channel (never
    // queried yet, or queried and empty) — open the overlay to pick/record
    // one instead of firing PB15 at an empty channel (which the radio
    // answered with a "TS890 DSP error" pop-up, Nutzer-Report).
    openTxMsgOverlay();
  } else {
    send({ type: "voiceMsgQuickSend", channel: txMsgSelectedChannel });
  }
});
document.getElementById("txmsg-overlay-close").addEventListener("click", closeTxMsgOverlay);
txMsgOverlay.addEventListener("click", (e) => {
  if (e.target === txMsgOverlay) closeTxMsgOverlay();
});

// Plain seconds, not min:sec — the reference caps every one of these values
// at 100 (channel length, playback/recording elapsed, remaining recording
// time). Shown as e.g. "4s" (Nutzer-Wunsch 2026-10-30; the radio's own
// display says "83sec").
function formatTxMsgTime(sec) {
  return `${sec || 0}s`;
}
function txMsgOpLabel(op) {
  switch (op) {
    case 1:
      return "spielt";
    case 2:
      return "pausiert";
    case 3:
      return "spult vor";
    case 4:
      return "spult zurück";
    case 5:
      return "sendet";
    default:
      return "";
  }
}
// Recording (LM, see cat.EncodeVoiceMsgRecordStart/Stop) + source (PB5,
// sent on start only) + remaining time (PB6, Nutzer-Wunsch 2026-10-27) —
// recording targets whichever channel is currently selected (same row
// selection PLAY/STOP/SEND/DELETE already act on), so REC itself sits above
// the channel list once, not duplicated per row.
const txMsgRecButton = document.getElementById("txmsg-rec-button");
// recordings made here always use the LAN source (PB5 3), see prepareVoiceMsgRecording
const TXMSG_REC_SOURCE_LAN = 3;
const txMsgRemainingEl = document.getElementById("txmsg-remaining");
// Recording level: fixed 10% (tenths of a percent), found by listening
// (Nutzer-Wunsch 2026-10-30) - the TX default of 1% is far too quiet here.
const TXMSG_REC_LEVEL_TENTHS_PERCENT = 100;
txMsgRecButton.addEventListener("click", async () => {
  const recording = !txMsgRecButton.classList.contains("active");
  const source = TXMSG_REC_SOURCE_LAN;
  txMsgRecSeenActive = false;
  txMsgRecDeadline = performance.now() + 15000; // covers a slow mic start
  if (recording) {
    // Order (Nutzer-Wunsch 2026-10-30): "ready" first, then the source (LAN),
    // then the mic streams so the radio's ALC settles, then (400 ms later)
    // the start.
    send({ type: "prepareVoiceMsgRecording", channel: txMsgSelectedChannel, value: source });
    // recording needs far more level than the 1% a real TX uses; the server
    // resets it to the default when the recording stops
    send({ type: "setTxAtten", value: TXMSG_REC_LEVEL_TENTHS_PERCENT });
    txMsgRecMic = true;
    try {
      await syncMicNow();
    } catch {
      // a failed mic start is reported by audio.js itself
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    txMsgRecDeadline = performance.now() + 5000;
  } else {
    txMsgRecMic = false;
    syncMicNow();
  }
  send({ type: "setVoiceMsgRecording", channel: txMsgSelectedChannel, enabled: recording, value: source });
});

// Built once (6 near-identical rows, same reasoning as the EQ effect/NB
// type buttons elsewhere in this file), then just updated on every state
// broadcast in updateTxMsgOverlay below. SEND and Repeat stay in each row
// (every channel sends/repeats independently — there's nothing to "select"
// for those two). One channel is "selected" (a radio button per row, like a
// normal selection list) and PLAY/STOP/DELETE below the list act on
// whichever one that is — previously those three had their own copy per
// row too, the same buttons six times over for actions where only one
// channel at a time makes sense (Nutzer-Wunsch 2026-10-27/2026-10-28).
let txMsgSelectedChannel = 1;
let txMsgLastState = null; // so selecting a different row can refresh the
// shared controls immediately, without waiting for the next broadcast
const txMsgRows = [];
for (let ch = 1; ch <= 6; ch++) {
  const row = document.createElement("div");
  row.className = "txmsg-row";

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "txmsg-ch-select";
  radio.className = "txmsg-row-radio";
  radio.value = String(ch);
  radio.checked = ch === txMsgSelectedChannel;
  radio.addEventListener("change", () => {
    txMsgSelectedChannel = ch;
    if (txMsgLastState) updateTxMsgOverlay(txMsgLastState);
  });

  const info = document.createElement("div");
  info.className = "txmsg-row-info";
  const header = document.createElement("div");
  header.className = "txmsg-row-header";
  const chLabel = document.createElement("span");
  chLabel.className = "txmsg-row-chlabel";
  chLabel.textContent = `CH${ch}`;
  // A real <input>, not just a label (Nutzer-Wunsch 2026-10-27: Kanäle
  // umbenennbar machen, PB4 set) — commits on blur or Enter, only if the
  // text actually changed, same "don't fight what the user is typing"
  // guard the frequency digits use (pendingHz) via lastSentName below.
  const name = document.createElement("input");
  name.type = "text";
  name.className = "txmsg-row-name";
  name.maxLength = 30;
  name.placeholder = "(unbenannt)";
  let lastSentName = "";
  function commitName() {
    if (name.disabled || name.value === lastSentName) return;
    lastSentName = name.value;
    send({ type: "setVoiceMsgName", channel: ch, name: name.value });
  }
  name.addEventListener("blur", commitName);
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") name.blur();
  });
  const length = document.createElement("span");
  length.className = "txmsg-row-length";
  header.appendChild(chLabel);
  header.appendChild(name);
  header.appendChild(length);
  const status = document.createElement("div");
  status.className = "txmsg-row-status";
  info.appendChild(header);
  info.appendChild(status);

  // Only "Wiederholen" stays per row (Nutzer-Wunsch 2026-10-28: the per-row
  // SEND button is gone again — sending now happens via the shared SEND
  // button below the list, or the TX MSG button itself, both acting on
  // whichever row is selected).
  const mini = document.createElement("div");
  mini.className = "txmsg-row-mini-controls";
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "txmsg-row-repeat";
  const repeatCheck = document.createElement("input");
  repeatCheck.type = "checkbox";
  repeatCheck.addEventListener("change", () => send({ type: "setVoiceMsgRepeat", channel: ch, enabled: repeatCheck.checked }));
  repeatLabel.appendChild(repeatCheck);
  repeatLabel.appendChild(document.createTextNode("Wiederholen"));
  mini.appendChild(repeatLabel);

  // Clicking anywhere in the row selects it too (not just the small radio
  // dot) — except the name input, which needs plain clicks for editing/
  // caret placement, not a side effect of also selecting the row.
  row.addEventListener("click", (e) => {
    if (e.target === name || e.target === radio) return;
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change"));
    }
  });

  row.appendChild(radio);
  row.appendChild(info);
  row.appendChild(mini);
  txMsgChannelsEl.appendChild(row);
  txMsgRows.push({
    channel: ch,
    row,
    radio,
    name,
    getLastSentName: () => lastSentName,
    setLastSentName: (v) => (lastSentName = v),
    length,
    status,
    repeatCheck,
  });
}
// Shared PLAY/STOP/SEND/DELETE row below the channel list, acting on
// txMsgSelectedChannel.
const txMsgPlayBtn = document.getElementById("txmsg-play");
const txMsgStopBtn = document.getElementById("txmsg-stop");
const txMsgSendBtn = document.getElementById("txmsg-send");
const txMsgDeleteBtn = document.getElementById("txmsg-delete");
txMsgPlayBtn.addEventListener("click", () => send({ type: "voiceMsgControl", channel: txMsgSelectedChannel, value: 1 }));
txMsgStopBtn.addEventListener("click", () => send({ type: "voiceMsgControl", channel: txMsgSelectedChannel, value: 0 }));
txMsgSendBtn.addEventListener("click", () => send({ type: "voiceMsgControl", channel: txMsgSelectedChannel, value: 5 }));
txMsgDeleteBtn.addEventListener("click", async () => {
  const ch = txMsgSelectedChannel;
  if (!(await showConfirmDialog(`Aufnahme auf CH${ch} wirklich löschen?`))) return;
  send({ type: "deleteVoiceMsg", channel: ch });
});

// Whether the selected channel is currently doing anything at all (playing,
// sending, paused, winding) — used for the TX MSG button's click-to-stop,
// the ESC shortcut and the red "sending" LED below. Works whether or not
// the overlay is open, since txMsgLastState is kept live regardless (see
// updateTxMsgOverlay).
function isTxMsgActive(state) {
  return !!state && state.voiceMsgChannel === txMsgSelectedChannel && state.voiceMsgOp !== 0;
}
// Whether the selected channel is known to actually have a recording on it
// (Nutzer-Wunsch 2026-10-28, see the TX MSG click handler above) — "known"
// because voiceMsgChannels is only ever populated once the Voice Message
// List display has been queried at least once this session (overlay opened,
// or a previous quick-send turned it on); before that, txMsgLastState has
// no channel data at all and this conservatively returns false, same as an
// explicitly empty channel — both cases should open the overlay rather than
// guess.
function selectedTxMsgHasContent() {
  const chState = txMsgLastState && txMsgLastState.voiceMsgChannels ? txMsgLastState.voiceMsgChannels[txMsgSelectedChannel - 1] : null;
  return !!(chState && chState.registered);
}
// Red LED only while actually transmitting (op 5), not while just locally
// previewing (op 1) — matches the "wenn er sendet" wording.
function updateTxMsgButtonLED(state) {
  txMsgButton.classList.toggle("active", isTxMsgActive(state) && state.voiceMsgOp === 5);
}
// Shared by the ESC key and a TX press (Nutzer-Wunsch 2026-10-28: "ESC
// taste und druck auf TX stoppen ebenfalls eine aktive TX MSG") — stops
// whatever the selected channel is currently doing. Deliberately not
// restricted to op===5 (actually transmitting): stopping a local PLAY
// preview this way is just as reasonable and costs nothing extra to allow.
function stopActiveTxMsg() {
  if (isTxMsgActive(txMsgLastState)) {
    send({ type: "voiceMsgControl", channel: txMsgSelectedChannel, value: 0 });
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopActiveTxMsg();
});

// Only the per-row/per-channel-list parts below do real work while the
// overlay is actually open (txMsgOpen) — the channel data itself is stale/
// zeroed once PB0 goes off anyway, same "only refresh what's visible"
// spirit as the meter overlay. txMsgLastState/updateTxMsgButtonLED above
// stay live regardless, so the TX MSG button's LED/click-to-stop and ESC
// keep working with the overlay closed.
function updateTxMsgOverlay(state) {
  if (state.voiceMsgChannels) txMsgLastState = state;
  updateTxMsgButtonLED(state);
  if (!txMsgOpen || !state.voiceMsgChannels) return;
  // LM's op values (0 stop, 1 ready - response only, 2 recording), not
  // RE's — recording is per-channel now, so this only lights up while the
  // channel LM last reported is the one currently selected.
  const recording = state.voiceMsgRecChannel === txMsgSelectedChannel && state.voiceMsgRecOp !== 0;
  txMsgRecButton.classList.toggle("active", recording);
  txMsgRemainingEl.textContent = recording
    ? `Aufnahme läuft: ${formatTxMsgTime(state.voiceMsgRecProgressSec)}`
    : `frei: ${formatTxMsgTime(state.voiceMsgRemainingSec)}`;
  let selectedState = null;
  for (const r of txMsgRows) {
    const chState = state.voiceMsgChannels[r.channel - 1];
    if (!chState) continue;
    if (r.channel === txMsgSelectedChannel) selectedState = chState;
    const isActive = state.voiceMsgChannel === r.channel && state.voiceMsgOp !== 0;
    r.row.classList.toggle("active", isActive);
    r.row.classList.toggle("unregistered", !chState.registered);
    // Never overwrite what the user is actively typing — same guard the
    // frequency digits use for an in-flight optimistic edit, just simpler
    // (no server round-trip to wait out, only "don't clobber focus").
    if (document.activeElement !== r.name) {
      r.name.value = chState.name;
      r.setLastSentName(chState.name);
    }
    r.name.disabled = !chState.registered;
    r.length.textContent = chState.registered ? formatTxMsgTime(chState.lengthSec) : "leer";
    r.status.textContent = isActive ? `${txMsgOpLabel(state.voiceMsgOp)} ${formatTxMsgTime(state.voiceMsgElapsedSec)}` : "";
    r.repeatCheck.disabled = !chState.registered;
    r.repeatCheck.checked = chState.repeat;
  }
  const isSelectedActive = state.voiceMsgChannel === txMsgSelectedChannel && state.voiceMsgOp !== 0;
  const selectedRegistered = !!(selectedState && selectedState.registered);
  txMsgPlayBtn.disabled = !selectedRegistered;
  txMsgPlayBtn.classList.toggle("active", isSelectedActive && state.voiceMsgOp === 1);
  txMsgStopBtn.disabled = !selectedRegistered;
  txMsgSendBtn.disabled = !selectedRegistered || !txAllowed;
  txMsgSendBtn.classList.toggle("active", isSelectedActive && state.voiceMsgOp === 5);
  txMsgDeleteBtn.disabled = !selectedRegistered;
}
// Long press (about half a second) on the button opens the effect choice; the
// click that follows the release is swallowed so it does not toggle the
// equalizer as well. Works with mouse, touch and pen (pointer events).
function onLongPress(button, handler, ms = 500) {
  let timer = null;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  button.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    fired = false;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      handler();
    }, ms);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(ev, cancel);
  button.addEventListener(
    "click",
    (e) => {
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  button.addEventListener("contextmenu", (e) => e.preventDefault()); // touch devices: no context menu on long press
}
onLongPress(document.getElementById("txeq-button"), () => openEqOverlay("tx"));
onLongPress(document.getElementById("rxeq-button"), () => openEqOverlay("rx"));
document.getElementById("eq-overlay-close").addEventListener("click", closeEqOverlay);
onLongPress(txMsgButton, openTxMsgOverlay);
// long press on the audio scope opens the filter settings (a short click switches its look, see cycleAscopeStyle)
onLongPress(ascopeSvg, openFilterSettingsOverlay);

// Equalizer curve editor ("UT"/"UR": 18 bands, 0..5100 Hz in 300 Hz steps, raw value
// 0 = +6 dB ... 30 = -24 dB, 1 dB per step). The radio takes the whole curve with
// every set, so the 18 values are kept here and all sent together. Vertical sliders
// are plain divs (pointer events), a rotated <input type=range> is unreliable on iOS.
const EQ_BAND_COUNT = 18;
const EQ_RAW_MAX = 30;
const eqEditOverlay = document.getElementById("eqedit-overlay");
const eqEditBandsEl = document.getElementById("eqedit-bands");
let eqEditKind = null; // "tx" | "rx" while open
let eqEditRaw = null; // 18 raw values being shown
let eqEditActive = 0; // sliders currently held; the radio's answer must not move them meanwhile
let eqEditTimer = null;
const eqEditBandEls = [];
function eqBandHz(i) {
  return i * 300;
}
function eqBandDb(raw) {
  return 6 - raw;
}
function eqBandDbText(raw) {
  const db = eqBandDb(raw);
  return (db > 0 ? "+" : "") + db + " dB";
}
function eqEditPaint(i) {
  const el = eqEditBandEls[i];
  const frac = eqEditRaw[i] / EQ_RAW_MAX; // 0 = top (+6 dB)
  el.thumb.style.top = `${frac * 100}%`;
  el.fill.style.height = `${(1 - frac) * 100}%`; // orange from the bottom up to the thumb, like the NR sliders
  const db = eqBandDb(eqEditRaw[i]);
  el.db.textContent = db > 0 ? `+${db}` : String(db);
  el.track.setAttribute("aria-valuenow", String(eqBandDb(eqEditRaw[i])));
  el.track.setAttribute("aria-valuetext", eqBandDbText(eqEditRaw[i]));
}
function eqEditSend() {
  eqEditTimer = null;
  if (!eqEditKind || !eqEditRaw) return;
  send({ type: eqEditKind === "tx" ? "setTxEqBands" : "setRxEqBands", values: eqEditRaw.slice() });
}
function eqEditQueueSend() {
  if (!eqEditTimer) eqEditTimer = setTimeout(eqEditSend, 150);
}
function eqEditSet(i, raw, { final = false } = {}) {
  raw = Math.max(0, Math.min(EQ_RAW_MAX, raw));
  if (raw !== eqEditRaw[i]) {
    eqEditRaw[i] = raw;
    eqEditPaint(i);
    eqEditQueueSend();
  }
  if (final && eqEditTimer) {
    clearTimeout(eqEditTimer);
    eqEditSend();
  }
}
function buildEqEditBands() {
  eqEditBandsEl.replaceChildren();
  eqEditBandEls.length = 0;
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const col = document.createElement("div");
    col.className = "eqedit-band";
    const track = document.createElement("div");
    track.className = "eqedit-track";
    track.tabIndex = 0;
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", `${eqBandHz(i)} Hz`);
    track.setAttribute("aria-valuemin", "-24");
    track.setAttribute("aria-valuemax", "6");
    const fill = document.createElement("div");
    fill.className = "eqedit-fill";
    const thumb = document.createElement("div");
    thumb.className = "eqedit-thumb";
    track.append(fill, thumb);
    const label = document.createElement("div");
    label.className = "eqedit-freq";
    label.textContent = i === 0 ? "0" : String(eqBandHz(i) / 1000).replace(/^0\./, ".");
    const db = document.createElement("div");
    db.className = "eqedit-db";
    col.append(label, track, db);
    eqEditBandsEl.append(col);
    eqEditBandEls.push({ track, thumb, fill, db });
    const fromPointer = (e) => {
      const r = track.getBoundingClientRect();
      return Math.round(((e.clientY - r.top) / r.height) * EQ_RAW_MAX);
    };
    track.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      track.setPointerCapture(e.pointerId);
      eqEditActive++;
      track.dataset.held = "1";
      eqEditSet(i, fromPointer(e));
    });
    track.addEventListener("pointermove", (e) => {
      if (track.dataset.held) eqEditSet(i, fromPointer(e));
    });
    const release = (e) => {
      if (!track.dataset.held) return;
      delete track.dataset.held;
      eqEditActive = Math.max(0, eqEditActive - 1);
      eqEditSet(i, fromPointer(e), { final: true });
    };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    // double click / double tap: this band back to 0 dB
    track.addEventListener("dblclick", () => eqEditSet(i, 6, { final: true }));
    track.addEventListener("keydown", (e) => {
      const step = { ArrowUp: -1, ArrowRight: -1, ArrowDown: 1, ArrowLeft: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      eqEditSet(i, eqEditRaw[i] + step, { final: true });
    });
  }
}
function refreshEqEdit() {
  if (!eqEditKind || !lastState || eqEditActive || eqEditTimer) return;
  const bands = eqEditKind === "tx" ? lastState.txEqBands : lastState.rxEqBands;
  if (!Array.isArray(bands) || bands.length !== EQ_BAND_COUNT) return;
  eqEditRaw = bands.slice();
  for (let i = 0; i < EQ_BAND_COUNT; i++) eqEditPaint(i);
}
function openEqEdit(kind) {
  eqEditKind = kind;
  document.getElementById("eqedit-title").textContent = (kind === "tx" ? "TX Equalizer - " : "RX Equalizer - ") + eqEffectName(kind);
  if (!eqEditBandEls.length) buildEqEditBands();
  // until the radio has answered, show a flat curve rather than stale numbers
  eqEditRaw = new Array(EQ_BAND_COUNT).fill(6);
  for (let i = 0; i < EQ_BAND_COUNT; i++) eqEditPaint(i);
  refreshEqEdit();
  send({ type: kind === "tx" ? "queryTxEqBands" : "queryRxEqBands" });
  eqEditOverlay.hidden = false;
}
function eqEffectName(kind) {
  const names = kind === "tx" ? EQ_EFFECTS_TX : EQ_EFFECTS_RX;
  const cur = lastState ? (kind === "tx" ? lastState.txEqEffect : lastState.rxEqEffect) : 0;
  return names[cur] || "";
}
function closeEqEdit() {
  if (eqEditTimer) {
    clearTimeout(eqEditTimer);
    eqEditSend();
  }
  eqEditOverlay.hidden = true;
  eqEditKind = null;
  eqEditActive = 0;
}
document.getElementById("eq-overlay-adjust").addEventListener("click", () => {
  const kind = eqOverlayKind;
  closeEqOverlay();
  if (kind) openEqEdit(kind);
});
document.getElementById("eqedit-ok").addEventListener("click", () => {
  const kind = eqEditKind;
  closeEqEdit();
  if (kind) openEqOverlay(kind); // back to the effect choice
});
document.getElementById("eqedit-reset").addEventListener("click", () => {
  if (!eqEditKind) return;
  clearTimeout(eqEditTimer);
  eqEditTimer = null;
  // 99 = "initial value" for every band; the radio's answer then shows the real curve
  send({ type: eqEditKind === "tx" ? "setTxEqBands" : "setRxEqBands", values: new Array(EQ_BAND_COUNT).fill(99) });
});
eqEditOverlay.addEventListener("click", (e) => {
  if (e.target === eqEditOverlay) closeEqEdit();
});
eqOverlay.addEventListener("click", (e) => {
  if (e.target === eqOverlay) closeEqOverlay();
});
function applyEqState(state) {
  const txAvailable = !["CW", "CW-R", "FSK", "FSK-R", "PSK", "PSK-R"].includes(state.mode);
  const txOn = txAvailable && state.txEq;
  document.getElementById("txeq-button").disabled = !txAvailable;
  txEqCycle.setCurrent(txOn);
  rxEqCycle.setCurrent(state.rxEq);
  if (eqOverlayKind === "tx" && !txAvailable) closeEqOverlay();
  refreshEqOverlay();
}

// TX Monitor ("MO0" on/off, "ML" level 0-20, 2026-10-14 user request, desktop
// only — see .desktop-only-group/txmon-button's own CSS/HTML comments): an
// on/off button (same toggle pattern as TX EQ/RX EQ/PROC above) with a long
// press opening a level-only overlay, same simple single-slider shape as the
// NB1 overlay (no type/depth/width extras — TX Monitor is just one value).
const txMonCycle = makeCycleButton(
  "txmon-button",
  [
    { value: false, label: "TX MON", title: "Ein/Aus - lange drücken für Einstellungen" },
    { value: true, label: "TX MON", title: "Ein/Aus - lange drücken für Einstellungen" },
  ],
  (value) => send({ type: "setTxMonitor", enabled: value })
);
const txMonOverlay = document.getElementById("txmon-overlay");
const txMonLevelSlider = document.getElementById("txmon-level-slider");
const txMonLevelValueEl = document.getElementById("txmon-level-value");
const txMonLevelSender = makeLiveSender("setTxMonitorLevel");
let txMonOverlayOpen = false;
txMonLevelSlider.addEventListener("pointerdown", () => {
  filterWidthDragging = true;
});
txMonLevelSlider.addEventListener("input", () => {
  txMonLevelValueEl.textContent = txMonLevelSlider.value;
  txMonLevelSender.live(Number(txMonLevelSlider.value));
});
txMonLevelSlider.addEventListener("change", () => {
  filterWidthDragging = false;
  txMonLevelSender.final(Number(txMonLevelSlider.value));
});
function refreshTxMonOverlay() {
  if (!txMonOverlayOpen || !lastState || filterWidthDragging) return;
  txMonLevelSlider.value = lastState.txMonitorLevel;
  txMonLevelValueEl.textContent = lastState.txMonitorLevel;
}
function openTxMonOverlay() {
  txMonOverlayOpen = true;
  refreshTxMonOverlay();
  txMonOverlay.hidden = false;
}
function closeTxMonOverlay() {
  txMonOverlay.hidden = true;
  txMonOverlayOpen = false;
}
onLongPress(document.getElementById("txmon-button"), openTxMonOverlay);
document.getElementById("txmon-overlay-close").addEventListener("click", closeTxMonOverlay);
txMonOverlay.addEventListener("click", (e) => {
  if (e.target === txMonOverlay) closeTxMonOverlay();
});
function applyTxMonState(state) {
  txMonCycle.setCurrent(state.txMonitor);
  refreshTxMonOverlay();
}

// RIT/XIT knobs (desktop only, 2026-10-13 user request: draggable controls
// that look like a physical rotary encoder, placed under the Filter
// dropdown — see their relocation in relocateRitXitKnobsForLayout above).
// The radio has no "set the exact offset" command (internal/cat/rit.go) —
// RU/RD are bare up/down steps, same as a real encoder knob's own rotary
// pulses, and RIT/XIT share that ONE offset: RT0/RT1 and XT0/XT1 each just
// toggle whether it's routed to RX or TX. So turning either knob fires the
// same step commands a physical knob would, proportional to how far it's
// dragged; it keeps whatever rotation that leaves it at (Nutzer-Wunsch,
// 2026-10-13: "nur nach auslösen von clr soll er zurückspringen") until a
// long press sends RC (clear, shared by both — there's only one offset to
// clear) and springs the knob back to neutral. Long press can't reuse the
// generic onLongPress helper here (used elsewhere for TX EQ/RX EQ/PROC/
// NB1/NB2): that attaches its own independent pointerdown/up pair, which
// would race the drag handlers below and fire the long-press even for a
// slow DRAG, since it only cancels on pointerup/cancel/leave, never on
// movement. The timer here instead lives in the same state machine as the
// drag and is cancelled the moment dragMoved flips true.
//
// RIT and XIT are the same control end to end (same markup, same CSS
// classes, same interaction) — only the on/off message type and the state
// flag that drives the active-glow differ, so one factory builds both
// instead of duplicating ~150 lines per knob.
function makeRitXitKnob(wrapId, knobId, rotatingId, toggleType, isOn) {
  const wrap = document.getElementById(wrapId);
  const knob = document.getElementById(knobId);
  const rotating = document.getElementById(rotatingId);
  if (!wrap || !knob || !rotating) return function () {};

  const DEG_PER_STEP = 6; // sensitivity: degrees of drag per RU/RD step
  const STEP_THROTTLE_MS = 90; // radio-friendly pacing while dragging fast
  const LONG_PRESS_MS = 500; // matches onLongPress's own default elsewhere
  // Click-vs-drag distinction uses straight-line pixel distance from the
  // press point, NOT the rotation angle (Nutzer-Report, 2026-10-13: clicks
  // sporadically failed to toggle RIT after the knob was shrunk to 1.8rem —
  // angle is atan2(dy,dx) around the center, so on a now-small ~14px-radius
  // knob even a sub-pixel jitter between mousedown/mouseup swings the angle
  // several degrees, past the old 0.5° threshold, so an ordinary click kept
  // getting misread as a turn. A pixel threshold doesn't have that problem
  // — it means the same thing regardless of how big the knob is drawn.
  const DRAG_THRESHOLD_PX = 4;

  let dragging = false;
  let dragMoved = false;
  let lastAngle = 0;
  let startX = 0;
  let startY = 0;
  let visualDeg = 0;
  let stepRemainder = 0;
  let pendingSteps = 0;
  let stepTimer = null;
  let clearTimer = null;
  let cleared = false; // long press already fired this press — click must not also toggle

  function angleAt(clientX, clientY) {
    const rect = knob.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
  }
  function setVisual(deg) {
    rotating.style.transform = `rotate(${deg}deg)`;
  }
  function flushSteps() {
    stepTimer = null;
    if (pendingSteps === 0) return;
    const up = pendingSteps > 0;
    const n = Math.min(Math.abs(pendingSteps), 8); // cap a burst; the radio steps one at a time anyway
    pendingSteps = 0;
    for (let i = 0; i < n; i++) send({ type: "ritStep", enabled: up });
  }
  function queueSteps(n) {
    pendingSteps += n;
    if (!stepTimer) stepTimer = setTimeout(flushSteps, STEP_THROTTLE_MS);
  }

  knob.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    dragging = true;
    dragMoved = false;
    cleared = false;
    // visualDeg is NOT reset here — the knob keeps whatever rotation
    // earlier drags/wheel ticks left it at, across separate presses, until
    // a long-press clear resets it. Only stepRemainder (the not-yet-a-
    // whole-step fractional part) starts fresh each press; carrying that
    // over wouldn't mean anything.
    stepRemainder = 0;
    lastAngle = angleAt(e.clientX, e.clientY);
    startX = e.clientX;
    startY = e.clientY;
    rotating.classList.remove("rit-knob-returning");
    try {
      knob.setPointerCapture(e.pointerId);
    } catch {
      // unsupported in this environment, drag still works via plain mousemove
    }
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (!dragMoved) {
        cleared = true;
        send({ type: "ritClear" });
        // The one case that DOES spring back to neutral — see the comment
        // above.
        rotating.classList.add("rit-knob-returning");
        visualDeg = 0;
        setVisual(0);
      }
    }, LONG_PRESS_MS);
    e.preventDefault();
  });
  knob.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const angle = angleAt(e.clientX, e.clientY);
    let delta = angle - lastAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    lastAngle = angle;
    if (!dragMoved) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= DRAG_THRESHOLD_PX) return; // still within click jitter — ignore, don't rotate at all
      dragMoved = true;
      clearTimeout(clearTimer); // this is a turn, not a press — no clear
    }
    // Off: turning has no effect (Nutzer-Wunsch, 2026-10-13 — "wird vom
    // Radio eh nicht bemerkt im RIT,XIT off Zustand") — still counts as a
    // drag (dragMoved is already set above, so the trailing click won't
    // also toggle it on), just doesn't rotate the knob or send RU/RD.
    if (!(lastState && isOn(lastState))) return;
    visualDeg += delta;
    setVisual(visualDeg);
    stepRemainder += delta;
    while (stepRemainder >= DEG_PER_STEP) {
      stepRemainder -= DEG_PER_STEP;
      queueSteps(1);
    }
    while (stepRemainder <= -DEG_PER_STEP) {
      stepRemainder += DEG_PER_STEP;
      queueSteps(-1);
    }
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    clearTimeout(clearTimer);
    try {
      knob.releasePointerCapture(e.pointerId);
    } catch {
      // already released / unsupported
    }
    // Stays wherever it was turned to — no spring-back here, only a clear
    // (the long-press timer above) resets the visual rotation.
  }
  knob.addEventListener("pointerup", endDrag);
  knob.addEventListener("pointercancel", endDrag);
  knob.addEventListener("click", (e) => {
    if (dragMoved || cleared) {
      // A drag ending over the button fires a trailing click (that's a
      // turn, not a press), and so does a long press that already sent the
      // clear — neither should also toggle on/off.
      e.preventDefault();
      return;
    }
    send({ type: toggleType, enabled: !(lastState && isOn(lastState)) });
  });
  knob.addEventListener("contextmenu", (e) => e.preventDefault()); // touch: no context menu on long press
  knob.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!(lastState && isOn(lastState))) return; // off: no effect, same as a drag
      const dir = e.deltaY < 0 ? 1 : -1;
      queueSteps(dir);
      // Same visual turn as a drag — stays at the new rotation afterward,
      // same as a drag does, no auto spring-back here either.
      rotating.classList.remove("rit-knob-returning");
      visualDeg += dir * DEG_PER_STEP;
      setVisual(visualDeg);
    },
    { passive: false }
  );

  // The value itself shows on the filter-info line instead of under the
  // knob (see filterInfoText), so this is just the active-glow toggle — plus
  // snapping the knob back to neutral while off (Nutzer-Wunsch, 2026-10-13:
  // "Regler auf Ausgangsposition stellen"), since turning no longer does
  // anything there, so a leftover rotation from before it was switched off
  // would be misleading. Skipped while a drag is in progress so a state
  // broadcast mid-gesture can't yank the knob out from under it.
  return function (state) {
    const on = !!isOn(state);
    wrap.classList.toggle("active", on);
    if (!on && !dragging && visualDeg !== 0) {
      rotating.classList.add("rit-knob-returning");
      visualDeg = 0;
      setVisual(0);
    }
  };
}
const applyRitState = makeRitXitKnob("rit-knob-wrap", "rit-knob", "rit-knob-rotating", "setRit", (s) => s.ritOn);
const applyXitState = makeRitXitKnob("xit-knob-wrap", "xit-knob", "xit-knob-rotating", "setXit", (s) => s.xitOn);

// Noise blanker settings: a long press on NB1 / NB2 opens them (NL1/NL2 level;
// NB2 also type A/B and, for type B, depth and width). Same live-slider pattern
// as the PROC window.
const nbOverlay = document.getElementById("nb-overlay");
const nbLevelSlider = document.getElementById("nb-level-slider");
const nbLevelValueEl = document.getElementById("nb-level-value");
const nbDepthSlider = document.getElementById("nb-depth-slider");
const nbDepthValueEl = document.getElementById("nb-depth-value");
const nbWidthSlider = document.getElementById("nb-width-slider");
const nbWidthValueEl = document.getElementById("nb-width-value");
const nbLevel1Sender = makeLiveSender("setNb1Level");
const nbLevel2Sender = makeLiveSender("setNb2Level");
const nbDepthSender = makeLiveSender("setNbDepth");
const nbWidthSender = makeLiveSender("setNbWidth");
const nbTypeGroup = makeButtonGroup("nb-type-buttons", [
  { value: "A", label: "Type A" },
  { value: "B", label: "Type B" },
]);
nbTypeGroup.onClick((value) => send({ type: "setNbType", enabled: value === "B" }));
let nbOverlayKind = 0; // 1 | 2 while open
function wireNbSlider(slider, valueEl, liveSender) {
  slider.addEventListener("pointerdown", () => {
    filterWidthDragging = true;
  });
  slider.addEventListener("input", () => {
    valueEl.textContent = slider.value;
    liveSender().live(Number(slider.value));
  });
  slider.addEventListener("change", () => {
    filterWidthDragging = false;
    liveSender().final(Number(slider.value));
  });
}
wireNbSlider(nbLevelSlider, nbLevelValueEl, () => (nbOverlayKind === 2 ? nbLevel2Sender : nbLevel1Sender));
wireNbSlider(nbDepthSlider, nbDepthValueEl, () => nbDepthSender);
wireNbSlider(nbWidthSlider, nbWidthValueEl, () => nbWidthSender);
function refreshNbOverlay() {
  if (!nbOverlayKind || !lastState) return;
  const two = nbOverlayKind === 2;
  document.getElementById("nb-overlay-title").textContent = `Noise Blanker ${nbOverlayKind}`;
  nbLevelSlider.max = two ? 10 : 20;
  const level = two ? lastState.nb2Level : lastState.nb1Level;
  nbLevelSlider.value = level;
  nbLevelValueEl.textContent = level;
  document.getElementById("nb2-extra").hidden = !two;
  document.getElementById("nb-typeb-extra").hidden = !(two && lastState.nb2TypeB);
  nbTypeGroup.setActive([lastState.nb2TypeB ? "B" : "A"]);
  nbDepthSlider.value = lastState.nb2Depth;
  nbDepthValueEl.textContent = lastState.nb2Depth;
  nbWidthSlider.value = lastState.nb2Width;
  nbWidthValueEl.textContent = lastState.nb2Width;
}
function openNbOverlay(which) {
  nbOverlayKind = which;
  refreshNbOverlay();
  nbOverlay.hidden = false;
}
function closeNbOverlay() {
  nbOverlay.hidden = true;
  nbOverlayKind = 0;
}
document.getElementById("nb-overlay-close").addEventListener("click", closeNbOverlay);
nbOverlay.addEventListener("click", (e) => {
  if (e.target === nbOverlay) closeNbOverlay();
});
{
  const nbButtons = document.querySelectorAll("#nb-buttons button");
  nbButtons.forEach((btn, i) => {
    btn.classList.add("longpress");
    btn.title = "Ein/Aus - lange drücken für Einstellungen";
    onLongPress(btn, () => openNbOverlay(i + 1));
  });
}

// Noise reduction settings: a long press on NR opens them (RL1 = NR1 level 1-10,
// RL2 = NR2 time constant 0-9 = 2-20 ms). Same live-slider pattern as the NB window.
const nrOverlay = document.getElementById("nr-overlay");
const nr1Slider = document.getElementById("nr1-level-slider");
const nr1ValueEl = document.getElementById("nr1-level-value");
const nr2Slider = document.getElementById("nr2-tc-slider");
const nr2ValueEl = document.getElementById("nr2-tc-value");
const nr1Sender = makeLiveSender("setNr1Level");
const nr2Sender = makeLiveSender("setNr2Tc");
const nr2Text = (v) => `${v} (${(v + 1) * 2} ms)`;
wireNbSlider(nr1Slider, nr1ValueEl, () => nr1Sender);
wireNbSlider(nr2Slider, nr2ValueEl, () => nr2Sender);
nr2Slider.addEventListener("input", () => {
  nr2ValueEl.textContent = nr2Text(Number(nr2Slider.value));
});
let nrOverlayOpen = false;
function refreshNrOverlay() {
  if (!nrOverlayOpen || !lastState) return;
  nr1Slider.value = lastState.nr1Level;
  nr1ValueEl.textContent = lastState.nr1Level;
  nr2Slider.value = lastState.nr2Tc;
  nr2ValueEl.textContent = nr2Text(lastState.nr2Tc);
}
function closeNrOverlay() {
  nrOverlay.hidden = true;
  nrOverlayOpen = false;
}
document.getElementById("nr-overlay-close").addEventListener("click", closeNrOverlay);
nrOverlay.addEventListener("click", (e) => {
  if (e.target === nrOverlay) closeNrOverlay();
});
{
  const nrBtn = document.getElementById("nr-button");
  nrBtn.classList.add("longpress");
  onLongPress(nrBtn, () => {
    nrOverlayOpen = true;
    refreshNrOverlay();
    nrOverlay.hidden = false;
  });
}

// Analog needle settings (Trägheit/Abfallzeit): long press on the gauge
// itself opens this — purely browser-local display tuning (see
// meterInertiaPct/meterFallMs up at animateAnalogNeedle), no WS round trip,
// so plain makeSlider + localStorage like the mic gain/limiter sliders
// rather than the live-sender pattern the NB/PROC overlays above use.
const meterOverlay = document.getElementById("meter-overlay");
const meterOverlayGauge = document.getElementById("meter-overlay-gauge");
// A live COPY of the gauge is shown while the overlay is open (Nutzer-Wunsch
// 2026-10-18: "das meter soll nicht aus der gui herausspringen beim öffnen
// des overlay. wir zeigen eine kopie an" — an earlier version relocated the
// real node into the overlay instead, which this replaces). The clone is
// added to analogGaugeRoots (see updateAnalogNeedle above) so the very same
// animation loop keeps it in sync frame by frame, no separate update path.
// Duplicate ids inside the clone (gradient/filter defs, the needle itself)
// are harmless — updateAnalogNeedle looks elements up by class within each
// root, never by id, and the one remaining id-based lookup in this file
// (the long-press binding below) ran once at load, on the original only.
let meterOverlayClone = null;
function openMeterOverlay() {
  if (!meterOverlayClone) {
    const original = document.getElementById("meter-analog");
    meterOverlayClone = original.cloneNode(true);
    meterOverlayClone.removeAttribute("id"); // avoid a second #meter-analog in the document
    meterOverlayClone.classList.remove("longpress"); // the copy isn't itself a long-press target (no cursor:pointer, no cloned listener anyway)
    meterOverlayClone.querySelector(":scope > title")?.remove(); // ditto for the hover tooltip — misleading on a copy that doesn't respond to long press
    meterOverlayGauge.appendChild(meterOverlayClone);
    analogGaugeRoots.push(meterOverlayClone);
    updateAnalogNeedle(analogNeedleDisplayed); // paint it immediately, not just on the next rAF tick
    // The original stays in the layout (same box, nothing else in the page
    // reflows/reshuffles) but renders empty while its live copy is shown in
    // the overlay — two visible needles for the one value would just be
    // confusing (Nutzer-Wunsch 2026-10-18: "an seiner Stelle ... leeren
    // Hintergrund anzeigen ... keine Elemente resizen"). visibility:hidden
    // rather than display:none/removing it: it keeps its exact layout box
    // (size/position), only the rendered content disappears — no reflow.
    original.classList.add("meter-overlay-source-hidden");
  }
  meterOverlay.hidden = false;
}
function closeMeterOverlay() {
  meterOverlay.hidden = true;
  if (meterOverlayClone) {
    analogGaugeRoots.splice(analogGaugeRoots.indexOf(meterOverlayClone), 1);
    meterOverlayClone.remove();
    meterOverlayClone = null;
    document.getElementById("meter-analog").classList.remove("meter-overlay-source-hidden");
  }
}
document.getElementById("meter-overlay-close").addEventListener("click", closeMeterOverlay);
meterOverlay.addEventListener("click", (e) => {
  if (e.target === meterOverlay) closeMeterOverlay();
});
const meterInertiaSlider = makeSlider(
  "meter-inertia-slider",
  (value) => {
    meterInertiaPct = value;
    try {
      localStorage.setItem("open890rc.meterInertiaPct", String(value));
    } catch (e) {
      // localStorage unavailable — setting just won't persist across reloads.
    }
  },
  300,
  "meter-inertia-value",
  (v) => `${v}%`,
  "meter-inertia-fill"
);
meterInertiaSlider.applyValue(meterInertiaPct);
const meterFallSlider = makeSlider(
  "meter-fall-slider",
  (value) => {
    meterFallMs = value;
    try {
      localStorage.setItem("open890rc.meterFallMs", String(value));
    } catch (e) {
      // localStorage unavailable — setting just won't persist across reloads.
    }
  },
  1000,
  "meter-fall-value",
  (v) => `${(v / 1000).toFixed(1)} s`,
  "meter-fall-fill"
);
meterFallSlider.applyValue(meterFallMs);
const meterReleaseSlider = makeSlider(
  "meter-release-slider",
  (value) => {
    meterReleasePct = value;
    try {
      localStorage.setItem("open890rc.meterReleasePct", String(value));
    } catch (e) {
      // localStorage unavailable — setting just won't persist across reloads.
    }
  },
  500,
  "meter-release-value",
  (v) => `${v}%`,
  "meter-release-fill"
);
meterReleaseSlider.applyValue(meterReleasePct);
document.getElementById("meter-overlay-reset").addEventListener("click", () => {
  meterInertiaPct = METER_INERTIA_DEFAULT;
  meterFallMs = METER_FALL_MS_DEFAULT;
  meterReleasePct = METER_RELEASE_DEFAULT;
  try {
    localStorage.setItem("open890rc.meterInertiaPct", String(meterInertiaPct));
    localStorage.setItem("open890rc.meterFallMs", String(meterFallMs));
    localStorage.setItem("open890rc.meterReleasePct", String(meterReleasePct));
  } catch (e) {
    // localStorage unavailable — reset is still applied, just won't persist.
  }
  meterInertiaSlider.applyValue(meterInertiaPct);
  meterFallSlider.applyValue(meterFallMs);
  meterReleaseSlider.applyValue(meterReleasePct);
});
// #meter-analog sits inside .meter-block, which setControlsDisabled
// deliberately never marks [inert] (the needle must stay legible — readable
// at 0 — even with the radio off, same reasoning as .waterfall-wrap's own
// exemption there). But that exemption also left this long-press live:
// Nutzer-Report 2026-10-23, the needle-feel settings overlay could still be
// opened while showing "OFF". Nothing to adjust on a meter that is not
// moving, so gated here on controlsDisabled directly (same pattern
// waterfall.js's own scopeEnabled gating uses for its click-to-tune, since
// the generic inert mechanism can't reach an exempt element either).
onLongPress(document.getElementById("meter-analog"), () => {
  if (!controlsDisabled) openMeterOverlay();
});

// Desktop bars-view toggle (Nutzer-Wunsch 2026-10-26): a plain click on the
// analog gauge (not a long press — that's swallowed by onLongPress above
// before it ever bubbles here, same mechanism already relied on for the
// txeq/rxeq buttons) switches the whole meter column over to the phone's own
// bar meters (plus a third ALC bar, see index.html), instead of the needle.
// Clicking the bars switches back. Phone-only media query guard: on phone
// the bars are the only view anyway (no needle to switch away from), and the
// class this sets has no effect there regardless (see style.css).
const DESKTOP_METER_VIEW_KEY = "open890rc.desktopMeterView";
let desktopMeterView = "analog"; // "analog" | "bars"
try {
  if (localStorage.getItem(DESKTOP_METER_VIEW_KEY) === "bars") desktopMeterView = "bars";
} catch (_) {
  // default
}
// The ALC bar needs the server to actually be streaming ALC (RM1) readings,
// which (same as the needle's own ALC mode) only happens while some client
// has asked for it (Nutzer-Report 2026-10-26: "ALC bekommt keine Daten,
// Balken reagiert nicht" — switching to bars-view alone never asked). The
// needle itself is hidden in bars-view, so forcing analogMeterMode to "alc"
// here is free to do — but its own last choice (PWR/SWR/ALC/IC) is saved in
// preBarsNeedleMode and restored on the way back out, so leaving bars-view
// doesn't leave the needle on a mode the user never actually picked there.
let preBarsNeedleMode = null;
function applyDesktopMeterView() {
  document.querySelector(".meter-block").classList.toggle("desktop-bars-view", desktopMeterView === "bars");
}
function setDesktopMeterView(view) {
  if (view === desktopMeterView) return;
  if (view === "bars") {
    preBarsNeedleMode = analogMeterMode;
    setAnalogMeterMode("alc", false);
  } else if (preBarsNeedleMode !== null) {
    setAnalogMeterMode(preBarsNeedleMode);
    preBarsNeedleMode = null;
  }
  desktopMeterView = view;
  try {
    localStorage.setItem(DESKTOP_METER_VIEW_KEY, desktopMeterView);
  } catch (_) {
    // the toggle still works, just won't persist across reloads
  }
  applyDesktopMeterView();
}
applyDesktopMeterView();
if (desktopMeterView === "bars") {
  // page loaded straight into bars-view: the stored choice is still the needle's own, remember it
  preBarsNeedleMode = analogMeterMode;
  setAnalogMeterMode("alc", false);
}
meterTxToggle.addEventListener("click", (e) => {
  if (!window.matchMedia("(min-width: 800px)").matches) return;
  if (e.target.closest(".meter-mode-row")) return; // those buttons have their own click handler
  setDesktopMeterView(desktopMeterView === "bars" ? "analog" : "bars");
});

// Setup overlay: lets the browser tell the server which radio to dial,
// instead of that being fixed by CLI flags at server startup. Opened by the
// gear icon; closes itself once a connection actually comes up.
const CONNECT_CONFIG_KEY = "hamrc.connectConfig";
const DEFAULT_PORT = 60000;
const DEFAULT_VOIP_PORT = 60001;

function loadConnectConfig() {
  try {
    const raw = localStorage.getItem(CONNECT_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // localStorage unavailable or holds garbage — fall through to defaults.
  }
  return { host: "", port: DEFAULT_PORT, voipPort: DEFAULT_VOIP_PORT, user: "", pass: "", admin: false };
}

function saveConnectConfig(config) {
  try {
    localStorage.setItem(CONNECT_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable — the fields just won't be remembered.
  }
}

const connectOverlay = document.getElementById("connect-overlay");
const connectHostInput = document.getElementById("connect-host");
const connectPortInput = document.getElementById("connect-port");
const connectVoipPortInput = document.getElementById("connect-voipport");
const connectUserInput = document.getElementById("connect-user");
const connectPassInput = document.getElementById("connect-pass");
const connectAdminInput = document.getElementById("connect-admin");
const connectMacInput = document.getElementById("connect-mac");
connectMacInput.addEventListener("change", () => {
  send({ type: "setKnsMac", mac: connectMacInput.value.trim() });
});
const connectAutoInput = document.getElementById("connect-auto");
connectAutoInput.addEventListener("change", () => {
  // Only meaningful once the server knows a config (saved on a successful
  // connect); the flag is also sent along with every connect request.
  send({ type: "setKnsAuto", enabled: connectAutoInput.checked });
});
const connectStatusEl = document.getElementById("connect-status");
const connectDisconnectButton = document.getElementById("connect-disconnect");
// One button for both directions: "Trenne ..." while connected, "Verbinde ..."
// (connects with the values entered in the form, like OK) while not.
function updateConnectToggle(connected) {
  connectDisconnectButton.textContent = connected ? "Trenne WebServer <-> TS890" : "Verbinde WebServer <-> TS890";
  connectDisconnectButton.title = connected
    ? "Trennt die Verbindung zwischen Web-Server und TS890 (wirkt für alle Clients)"
    : "Verbindet den Web-Server mit dem TS890 (mit den eingetragenen Werten, wie OK)";
  connectDisconnectButton.classList.toggle("danger", connected);
  connectDisconnectButton.classList.toggle("connect-action", !connected);
}
updateConnectToggle(false);

// --- SPE Expert PA -------------------------------------------------------
const ampPortInput = document.getElementById("amp-port");
const ampStatusEl = document.getElementById("amp-status");
const ampConnectButton = document.getElementById("amp-connect");
const paRow = document.getElementById("pa-row");
const paPowerButton = document.getElementById("pa-power-button");
const paOperButton = document.getElementById("pa-oper-button");
const paLevelButton = document.getElementById("pa-level-button");
const PA_LEVEL_LABELS = { L: "500W", M: "1000W", H: "1500W" };
let paOn = false;
// Synced from state.ampMaxPowerW on every broadcast (see applyAmpState) —
// used to be a hardcoded constant that had to be kept in sync by hand with
// main.go's own fixed value; now server-configurable (Nutzer-Wunsch,
// 2026-10-14: "Eingabefeld Max PWR bei aktiver PA"), so the client just
// mirrors whatever the server currently has. 15 here is only the placeholder
// until the first state broadcast arrives (matches the server's own default).
let PA_MAX_POWER_W = 15;

function setAmpStatus(text, isError) {
  ampStatusEl.textContent = text;
  ampStatusEl.classList.toggle("error", !!isError);
}

async function loadSerialPorts() {
  try {
    const ports = await (await fetch("serial-ports")).json();
    document.getElementById("amp-port-list").replaceChildren(
      ...ports.map((p) => Object.assign(document.createElement("option"), { value: p }))
    );
  } catch (e) {
    // Port suggestions are a convenience only; the field still accepts typing.
  }
}

// One button: "PA verbinden" while no port is open, "PA trennen" while one is.
// The server acks BOTH directions with the same {type:"ampOk"} (connectAmp
// with an empty port disconnects, same handler as connecting one) — so the
// ampOk handler below can't tell success-at-connecting from
// success-at-disconnecting apart on its own and used to always print
// "verbunden", even right after a successful Trennen (Nutzer-Report,
// 2026-11-02, screenshot: button already back to "verbinden", "verbunden"
// stuck behind it anyway). This flag records which direction is in flight
// so the ack can be read correctly.
let ampDisconnecting = false;
ampConnectButton.addEventListener("click", () => {
  if (lastState && lastState.ampPort) {
    ampDisconnecting = true;
    setAmpStatus("trenne …", false);
    send({ type: "connectAmp", serialPort: "" });
    return;
  }
  const port = ampPortInput.value.trim();
  if (!port) {
    setAmpStatus("Serial port angeben.", true);
    return;
  }
  ampDisconnecting = false;
  setAmpStatus("verbinde …", false);
  send({ type: "connectAmp", serialPort: port });
});

const ampTxTimeoutInput = document.getElementById("amp-tx-timeout");
ampTxTimeoutInput.addEventListener("change", () => {
  const v = Math.max(0, Math.min(999, Math.round(Number(ampTxTimeoutInput.value) || 0)));
  ampTxTimeoutInput.value = v;
  send({ type: "setAmpTxTimeout", value: v });
});
const ampMaxPowerInput = document.getElementById("amp-max-power");
ampMaxPowerInput.addEventListener("change", () => {
  const v = Math.max(5, Math.min(100, Math.round(Number(ampMaxPowerInput.value) || 15)));
  ampMaxPowerInput.value = v;
  send({ type: "setAmpMaxPower", value: v });
});
const ampAutoInput = document.getElementById("amp-auto");
ampAutoInput.addEventListener("change", () => {
  send({ type: "setAmpAuto", serialPort: ampPortInput.value.trim(), enabled: ampAutoInput.checked });
});

// The PA row only exists while a serial port is open. The amp itself can be
// switched off (it then never answers): power button = "PA OFF", click turns
// it on via the serial control lines; operate/level are only meaningful while
// it answers.
paPowerButton.addEventListener("click", () => {
  if (!paOn) {
    // shown right at the click (the PA needs a few seconds to answer); the "PA is on"
    // message follows from the transition in updatePaInfo
    paInfoMessage = "PA wird eingeschaltet...";
    if (lastState) applyState(lastState);
    send({ type: "ampPowerOn" });
  } else {
    // Shown right at the click: the PA only counts as off a few seconds later
    // (status polling), the message follows that transition from updatePaInfo.
    clearTimeout(paCmdErrorTimer);
    paCmdError = ""; // an older failure must not hide the new attempt
    showPaOffMessage();
    clearTimeout(paOffWatchTimer);
    paOffWatchTimer = setTimeout(() => {
      if (!(lastState && lastState.ampOn)) return;
      if (paInfoMessage === PA_OFF_MESSAGE) paInfoMessage = "";
      showPaCmdError("AUS-Befehl ohne Wirkung");
    }, PA_OFF_WATCH_MS);
    send({ type: "ampPowerOff" });
  }
});
paOperButton.addEventListener("click", () => send({ type: "ampToggleOperate" }));
paLevelButton.addEventListener("click", () => send({ type: "ampCycleLevel" }));
const paTuneButton = document.getElementById("pa-tune-button");
paTuneButton.addEventListener("click", () => send({ type: "ampTune" }));

// Event messages for the status line ("PA wird eingeschaltet...", "PA OPER aktiviert Verstärkung" etc.):
// derived from PA state TRANSITIONS seen by this browser and kept until
// something newer replaces them (statusMessageFor ranks them below errors).
let paInfoMessage = "";
const PA_OFF_MESSAGE = "PA wird ausgeschaltet...";
let paOffMessageTimer = null;
let paOffWatchTimer = null;
// Shown as "⚠ PA: <text> ⚠" (same look as the PA's own warnings) when a PA
// command failed or had no effect; goes away by itself after a while.
let paCmdError = "";
let paCmdErrorTimer = null;
function showPaCmdError(text, ms = 10000) {
  clearTimeout(paCmdErrorTimer);
  paCmdError = text;
  if (lastState) applyState(lastState);
  paCmdErrorTimer = setTimeout(() => {
    paCmdError = "";
    if (lastState) applyState(lastState);
  }, ms);
}
const PA_OFF_WATCH_MS = 8000; // PA still on this long after PA OFF = no effect
// "PA wird ausgeschaltet..." — set immediately when PA OFF is clicked, and
// again (restarting the timer) when the PA is seen going off. Disappears
// after ms (the click case only has a longer safety timeout, in case the PA
// never turns off).
function showPaOffMessage(ms = 15000, redraw = true) {
  clearTimeout(paOffMessageTimer);
  paInfoMessage = PA_OFF_MESSAGE;
  if (redraw && lastState) applyState(lastState); // not from inside applyState itself
  paOffMessageTimer = setTimeout(() => {
    if (paInfoMessage !== PA_OFF_MESSAGE) return;
    paInfoMessage = "";
    if (lastState) applyState(lastState);
  }, ms);
}
let prevAmp = null; // null until the first state arrives: no message on page load
let prevRxLost = 0;
function updatePaInfo(state) {
  const cur = { on: !!state.ampOn, oper: !!state.ampOperate, tuning: !!state.ampTuning, level: state.ampLevel };
  const level = PA_LEVEL_LABELS[state.ampLevel];
  const operMsg = level ? `PA Leistungsstufe = ${level}` : "PA - OPERATING";
  const standbyMsg = "PA - STANDBY";
  if (prevAmp) {
    if (cur.on && !prevAmp.on) paInfoMessage = cur.oper ? operMsg : "PA OPER aktiviert Verstärkung";
    else if (!cur.on && prevAmp.on) {
      clearTimeout(paOffWatchTimer);
      showPaOffMessage(5000, false);
    }
    else if (cur.on && cur.tuning && !prevAmp.tuning) paInfoMessage = "PA Tuner Anpassversuch läuft...";
    else if (cur.on && !cur.tuning && prevAmp.tuning) paInfoMessage = cur.oper ? operMsg : standbyMsg;
    else if (cur.on && cur.oper && !prevAmp.oper) paInfoMessage = operMsg;
    else if (cur.on && !cur.oper && prevAmp.oper) paInfoMessage = standbyMsg;
    else if (cur.on && cur.oper && cur.level !== prevAmp.level && level) paInfoMessage = operMsg;
  }
  // New VoIP packet loss is a newer message: let it through.
  if (state.rxAudioLost > prevRxLost) paInfoMessage = "";
  prevRxLost = state.rxAudioLost || 0;
  prevAmp = cur;
}

function applyAmpState(state) {
  updatePaInfo(state);
  const present = !!state.ampPort;
  paRow.hidden = !present;
  // phone: without the PA row the page is shorter, the waterfall takes that room (style.css)
  document.querySelector("main").classList.toggle("pa-row-hidden", !present);
  ampConnectButton.textContent = present ? "trennen" : "verbinden";
  ampAutoInput.checked = !!state.ampAuto;
  if (document.activeElement !== ampTxTimeoutInput) ampTxTimeoutInput.value = state.ampTxTimeout || 0;
  PA_MAX_POWER_W = state.ampMaxPowerW || 15;
  if (document.activeElement !== ampMaxPowerInput) ampMaxPowerInput.value = PA_MAX_POWER_W;
  paOn = !!state.ampOn;
  document.body.dataset.paOn = paOn ? "1" : "0"; // read by the PWR slider's label
  document.getElementById("at-button").disabled = paOn; // PA has its own tuner
  // internal TUNE unavailable while the PA has its own tuner running (a
  // running tune can still be stopped), and for anyone without TX access
  // at all — but a tune genuinely in progress must stay stoppable even
  // then (it was presumably started before TX was revoked mid-session).
  tuneButton.disabled = (paOn && !state.tuning) || (!txAllowed && !state.tuning);
  pwrSlider.setMax(paOn ? PA_MAX_POWER_W : 100); // server-configurable cap while the PA is on, see setAmpMaxPower
  paPowerButton.textContent = "PA ON";
  paPowerButton.classList.toggle("active", paOn);
  paOperButton.classList.toggle("active", paOn && state.ampOperate);
  // Both conditions, not just TX: the stronger glow is meant to mean "PA is
  // actively amplifying right now", which needs OPERATE too — otherwise it
  // lit during TX whenever PA was merely on (still in STANDBY, not actually
  // operating), confusingly implying the PA was amplifying when it wasn't
  // (2026-10-12 user report).
  paOperButton.classList.toggle("tx-active", paOn && state.ampOperate && state.ampTX);
  paOperButton.disabled = !paOn;
  paLevelButton.textContent = PA_LEVEL_LABELS[state.ampLevel] || "—";
  paLevelButton.disabled = !paOn;
  paTuneButton.disabled = !paOn || (!!state.ampOperate && !state.ampTuning); // PA tunes in STANDBY only (while running, a click cancels)
  paTuneButton.classList.toggle("tuning", !!state.ampTuning); // blinks while tuning; click again cancels
}

// --- TX meter scales ---------------------------------------------------
// While transmitting the top "S-meter" shows output power instead of signal
// strength, with a 0..max W legend. Without a PA the radio's own meter value
// is used, assumed linear over its 0-70 range = 0-100W (not verified against
// the TS-890). With the PA on, the PA's reported output power is used, scaled
// to LOW/MID/HIGH.
// The amp is a 1.5K-FA (confirmed by the operator): 500/1000/1500W. Not keyed
// on the CSV's model id, since the 1.3K/1.5K may report the same id.
const PA_SCALE_W = { L: 1000, M: 1000, H: 1500 }; // LOW and MID share the 1000 W scale (Nutzer-Wunsch 2026-10-11)
// In STANDBY the PA is a pass-through, so the radio's own power is what goes out.
function ampInOperate(state) {
  return state.ampOn && state.ampOperate;
}
function powerScaleMax(state) {
  if (!ampInOperate(state) || state.ampTuning) return 100;
  return PA_SCALE_W[state.ampLevel] || PA_SCALE_W.H;
}

let sLegendMode = "rx";
let sLegendMax = 0;
function setSMeterLegend(mode, maxW) {
  if (mode === sLegendMode && maxW === sLegendMax) return;
  sLegendMode = mode;
  sLegendMax = maxW;
  const tx = mode === "tx";
  sRedSplit = tx ? 56 : 35;
  const lowLine = document.getElementById("s-leg-low");
  const highLine = document.getElementById("s-leg-high");
  lowLine.setAttribute("x2", sRedSplit * 5 - 3);
  highLine.setAttribute("x1", sRedSplit * 5);
  const show = (id, on) => document.getElementById(id).setAttribute("display", on ? "inline" : "none");
  show("s-pips-rx", !tx);
  show("s-texts-rx", !tx);
  show("s-pips-tx", tx);
  show("s-texts-tx", tx);
  if (!tx) return;
  const svgNS = "http://www.w3.org/2000/svg";
  const pips = document.getElementById("s-pips-tx");
  const texts = document.getElementById("s-texts-tx");
  pips.replaceChildren();
  texts.replaceChildren();
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 346 + 2;
    const cls = i / steps >= 0.8 ? "high" : "low";
    const pip = document.createElementNS(svgNS, "line");
    pip.setAttribute("class", `pip ${cls}`);
    for (const [k, v] of [["x1", x], ["x2", x], ["y1", 0], ["y2", 5]]) pip.setAttribute(k, v);
    pips.appendChild(pip);
    const t = document.createElementNS(svgNS, "text");
    t.setAttribute("class", `leg-text ${cls}`);
    t.setAttribute("x", x);
    t.setAttribute("y", 0);
    t.setAttribute("text-anchor", i === 0 ? "start" : i === steps ? "end" : "middle");
    t.textContent = Math.round((i / steps) * maxW) + (i === steps ? "W" : "");
    texts.appendChild(t);
  }
}

// SWR (1..inf) to bar position in the same 0-70 raw units the meter uses
// (x px / 5), interpolated through the legend's own tick positions.
const SWR_POINTS = [[1, 0], [1.5, 28], [2, 90], [3, 170], [5, 260], [10, 335]];
function swrToRaw(swr) {
  if (!(swr > 1)) return 0;
  for (let i = 1; i < SWR_POINTS.length; i++) {
    const [v1, x1] = SWR_POINTS[i];
    if (swr <= v1) {
      const [v0, x0] = SWR_POINTS[i - 1];
      return (x0 + ((swr - v0) / (v1 - v0)) * (x1 - x0)) / 5;
    }
  }
  return 70;
}

// Raw 0-70 values for the two meters given the current state.
function meterValues(state) {
  let s = state.sMeter;
  let swr = state.swrMeter;
  if (state.tx) {
    const max = powerScaleMax(state);
    setSMeterLegend("tx", max);
    const watts = ampInOperate(state) || state.ampTuning ? state.ampPowerW : (state.sMeter / 70) * 100;
    s = Math.min(1, watts / max) * 70;
  } else {
    setSMeterLegend("rx", 0);
  }
  if (state.ampOn) swr = swrToRaw(state.ampSWR);
  return { s, swr };
}

function setConnectStatus(text, isError) {
  connectStatusEl.textContent = text;
  connectStatusEl.classList.toggle("error", !!isError);
}

// RX audio buffer trimming (see pcm-player-processor.js): two small sliders in
// the Setup window — the backlog at which the browser cuts, and the backlog it
// is cut back to. Kept per browser by audio.js; the target is held at least
// 0.1 s below the trigger.
const trimTriggerSlider = document.getElementById("trim-trigger-slider");
const trimTargetSlider = document.getElementById("trim-target-slider");
const trimTriggerFillEl = document.getElementById("trim-trigger-fill");
const trimTargetFillEl = document.getElementById("trim-target-fill");
const TRIM_MIN_GAP_S = 0.1;
function updateTrimLabels() {
  document.getElementById("trim-trigger-value").textContent = `${Number(trimTriggerSlider.value).toFixed(1)} s`;
  document.getElementById("trim-target-value").textContent = `${Number(trimTargetSlider.value).toFixed(2)} s`;
  setLevelFill(trimTriggerFillEl, trimTriggerSlider);
  setLevelFill(trimTargetFillEl, trimTargetSlider);
}
function keepTrimGap(movedTrigger) {
  const trigger = Number(trimTriggerSlider.value);
  if (Number(trimTargetSlider.value) > trigger - TRIM_MIN_GAP_S) {
    trimTargetSlider.value = Math.max(Number(trimTargetSlider.min), trigger - TRIM_MIN_GAP_S);
    if (Number(trimTargetSlider.value) > trigger - TRIM_MIN_GAP_S) {
      // target already at its minimum: the trigger cannot go lower
      trimTriggerSlider.value = Number(trimTargetSlider.value) + TRIM_MIN_GAP_S;
    }
  }
}
trimTriggerSlider.addEventListener("input", () => {
  keepTrimGap(true);
  updateTrimLabels();
});
trimTargetSlider.addEventListener("input", () => {
  keepTrimGap(false);
  updateTrimLabels();
});
for (const slider of [trimTriggerSlider, trimTargetSlider]) {
  slider.addEventListener("change", () => {
    if (window.hamrcSetRxTrim) window.hamrcSetRxTrim(Number(trimTriggerSlider.value), Number(trimTargetSlider.value));
  });
}
const rxServoSlipInput = document.getElementById("rx-servo-slip");
rxServoSlipInput.addEventListener("change", () => {
  if (window.hamrcSetRxServoSlip) window.hamrcSetRxServoSlip(rxServoSlipInput.checked);
});
function updateTxButtonTitle() {
  const title = txHoldMode
    ? 'Senden, solange gedrückt (Alternativ "t" auf Tastatur gedrückt halten)'
    : 'Senden/Empfangen umschalten (Alternativ "t" auf Tastatur drücken)';
  for (const b of txButtons) b.title = title;
}
const txModeSelect = document.getElementById("tx-button-mode");
txModeSelect.value = txHoldMode ? "hold" : "toggle";
txModeSelect.addEventListener("change", () => {
  if (txHoldMode) pttRelease();
  txHoldMode = txModeSelect.value === "hold";
  for (const b of txButtons) b.classList.toggle("tx-hold", txHoldMode);
  updateTxButtonTitle();
  try {
    localStorage.setItem(TX_HOLD_KEY, txHoldMode ? "1" : "0");
  } catch (_) {}
});
for (const b of txButtons) b.classList.toggle("tx-hold", txHoldMode);
updateTxButtonTitle();
const micKeepWarmInput = document.getElementById("mic-keep-warm");
micKeepWarmInput.addEventListener("change", () => {
  if (window.hamrcSetMicKeepWarm) window.hamrcSetMicKeepWarm(micKeepWarmInput.checked);
});
const micLimiterInput = document.getElementById("mic-limiter");
const micLimiterPresetSelectEl = document.getElementById("mic-limiter-preset");
function syncMicLimiterTuningEnabled() {
  micLimiterPresetSelectEl.disabled = !micLimiterInput.checked;
}
micLimiterInput.addEventListener("change", () => {
  if (window.hamrcSetMicLimiter) window.hamrcSetMicLimiter(micLimiterInput.checked);
  syncMicLimiterTuningEnabled();
});

// Limiter presets (Nutzer-Wunsch 2026-10-18): "Sanft" is the original
// shipped default (barely audible, only catches genuine peaks); "Stark" is
// a deliberately harder setting (lower threshold, higher ratio, faster
// attack) for whoever wants more aggressive levelling and accepts some
// audible pumping for it. Picking one applies its three values immediately,
// also mid-transmission (the former free sliders were removed, 2026-10-21).
const MIC_LIMITER_PRESETS = {
  soft: { threshold: -1, ratio: 6, attack: 10 },
  hard: { threshold: -8, ratio: 12, attack: 3 },
};
const micLimiterPresetSelect = document.getElementById("mic-limiter-preset");
micLimiterPresetSelect.addEventListener("change", () => {
  const p = MIC_LIMITER_PRESETS[micLimiterPresetSelect.value];
  if (!p) return;
  if (window.hamrcSetMicLimiterThreshold) window.hamrcSetMicLimiterThreshold(p.threshold);
  if (window.hamrcSetMicLimiterRatio) window.hamrcSetMicLimiterRatio(p.ratio);
  if (window.hamrcSetMicLimiterAttack) window.hamrcSetMicLimiterAttack(p.attack);
});
function syncMicLimiterPreset() {
  const t = window.hamrcGetMicLimiterThreshold ? window.hamrcGetMicLimiterThreshold() : MIC_LIMITER_PRESETS.soft.threshold;
  const r = window.hamrcGetMicLimiterRatio ? window.hamrcGetMicLimiterRatio() : MIC_LIMITER_PRESETS.soft.ratio;
  const a = window.hamrcGetMicLimiterAttack ? window.hamrcGetMicLimiterAttack() : MIC_LIMITER_PRESETS.soft.attack;
  for (const [name, p] of Object.entries(MIC_LIMITER_PRESETS)) {
    if (p.threshold === t && p.ratio === r && p.attack === a) {
      micLimiterPresetSelect.value = name;
      return;
    }
  }
}

// Browser-local volume for mithören another client's TX relay (Nutzer-
// Wunsch, 2026-10-15) — see audio.js's hamrcSetTxRelayVolume for why this is
// independent of the AF slider rather than a multiplier on it.
const txRelayVolumeSlider = makeSlider(
  "tx-relay-volume-slider",
  (value) => {
    if (window.hamrcSetTxRelayVolume) window.hamrcSetTxRelayVolume(value);
  },
  100,
  null,
  undefined,
  "tx-relay-volume-fill"
);

function loadTrimSliders() {
  if (window.hamrcGetRxServoSlip) rxServoSlipInput.checked = window.hamrcGetRxServoSlip();
  if (window.hamrcGetMicKeepWarm) micKeepWarmInput.checked = window.hamrcGetMicKeepWarm();
  if (window.hamrcGetMicLimiter) micLimiterInput.checked = window.hamrcGetMicLimiter();
  syncMicLimiterTuningEnabled();
  syncMicLimiterPreset();
  if (window.hamrcGetTxRelayVolume) txRelayVolumeSlider.applyValue(window.hamrcGetTxRelayVolume());
  const t = window.hamrcGetRxTrim && window.hamrcGetRxTrim();
  if (t) {
    trimTriggerSlider.value = t.trigger;
    trimTargetSlider.value = t.target;
  }
  updateTrimLabels();
}

function openConnectOverlay(tab) {
  showOverlayTab(tab || "net");
  const config = loadConnectConfig();
  // A browser that never saved its own config yet (e.g. first time opening
  // this on a new phone) would otherwise show blank fields even though the
  // server is already connected — typically because it was started with
  // -host/-user/-admin CLI flags on the Pi. Fall back to what the server
  // itself reports it's currently connected with (state.go's
  // SetRadioConnection) for any field this browser hasn't saved locally.
  // The password is deliberately never part of that server-reported state
  // (see SetRadioConnection's comment), so it can only ever come from this
  // browser's own local storage.
  const serverHost = lastState && lastState.radioHost;
  const serverPort = lastState && lastState.radioPort;
  const serverVoipPort = lastState && lastState.radioVoipPort;
  const serverUser = lastState && lastState.radioUser;
  const serverAdmin = lastState && lastState.radioAdmin;
  // While actually connected, prefer the server's live-reported values over
  // this browser's saved copy for every field but the password. Found live
  // (2026-09-28): the saved copy can silently disagree with what's actually
  // connected — e.g. it predates a later-added field so it's stuck on an old
  // default (port/voipPort), or the "KNS Admin" checkbox was saved unchecked
  // before the user discovered their account requires -knsadm (see the KNS
  // login note above) — and the OLD `config.x || serverX` fallback let that
  // stale local value silently win, because a wrong-but-non-empty value is
  // just as truthy as a correct one. That mismatch then defeated the
  // "nothing changed" guard below on the very next "Verbinden" click,
  // sending a real, unwanted second connect attempt — which the radio's
  // single-session KNS then answered by dropping the working first one.
  // Showing the true values here keeps what's on screen honest AND keeps
  // the guard's comparison meaningful.
  const connected = lastState && lastState.connected;
  connectHostInput.value = connected ? serverHost : config.host || serverHost || "";
  connectPortInput.value = connected ? serverPort : config.port || serverPort || DEFAULT_PORT;
  connectVoipPortInput.value = connected ? serverVoipPort : config.voipPort || serverVoipPort || DEFAULT_VOIP_PORT;
  connectUserInput.value = connected ? serverUser : config.user || serverUser || "";
  connectPassInput.value = config.pass || "";
  connectAdminInput.checked = connected ? !!serverAdmin : config.host ? !!config.admin : !!serverAdmin;
  connectAutoInput.checked = !!(lastState && lastState.knsAuto);
  connectMacInput.value = (lastState && lastState.knsMac) || "";
  updateConnectToggle(connected);
  ampPortInput.value = (lastState && (lastState.ampPort || lastState.ampSavedPort)) || "";
  setAmpStatus("", false);
  loadSerialPorts();
  setConnectStatus("", false);
  connectOverlay.hidden = false;
  connectConfigAtOpen = JSON.stringify(readConnectConfig());
  syncMicMeter();
}

function closeConnectOverlay() {
  connectOverlay.hidden = true;
  stopDebugLog();
  syncMicMeter();
}

// Audio (VOIP) settings overlay, opened by the small gear next to the AUDIO
// button (Nutzer-Wunsch 2026-10-11; formerly the VOIP tab of the settings).
// Split into RX / TX (Mic) tabs (Nutzer-Wunsch, 2026-10-12): same
// tab-switching pattern as the Settings overlay's showOverlayTab, scoped to
// #audio-overlay instead since the two overlays are independent.
const audioOverlay = document.getElementById("audio-overlay");
const audioOverlayTabs = document.querySelectorAll("#audio-overlay .overlay-tab");
function showAudioOverlayTab(name) {
  for (const t of audioOverlayTabs) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll("#audio-overlay .overlay-tabpanel")) p.hidden = p.dataset.tab !== name;
  syncMicMeter();
}
for (const t of audioOverlayTabs) t.addEventListener("click", () => showAudioOverlayTab(t.dataset.tab));
const uiLanguageSelect = document.getElementById("ui-language");
uiLanguageSelect.addEventListener("change", () => window.hamrcSetLanguage(uiLanguageSelect.value));
function openAudioOverlay() {
  uiLanguageSelect.value = window.hamrcGetLanguage();
  loadTrimSliders(); // show the real values (checkboxes/sliders have no HTML defaults)
  audioOverlay.hidden = false;
  showAudioOverlayTab("rx");
  refreshOutputDevices();
}
function closeAudioOverlay() {
  audioOverlay.hidden = true;
  syncMicMeter();
}
document.getElementById("audio-settings-button").addEventListener("click", openAudioOverlay);
document.getElementById("audio-overlay-close").addEventListener("click", closeAudioOverlay);
audioOverlay.addEventListener("click", (e) => {
  if (e.target === audioOverlay) closeAudioOverlay();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !audioOverlay.hidden) closeAudioOverlay();
});

const powerButton = document.getElementById("power-button");
const powerOverlay = document.getElementById("power-overlay");
document.getElementById("power-cancel").addEventListener("click", () => (powerOverlay.hidden = true));
document.getElementById("power-confirm").addEventListener("click", async () => {
  powerOverlay.hidden = true;
  if (!(lastState && lastState.connected)) {
    setPowerOnPending(true);
    send({ type: "radioPower", enabled: true });
    return;
  }
  // Other browsers still connected: ask first (Nutzer-Wunsch 2026-11-04), no question when we are alone.
  if (clientList.some((c) => c.id !== myClientId) && !(await showConfirmDialog("Es sind noch andere Benutzer aktiv, Station wirklich ausschalten?", "Ausschalten"))) return;
  // Server switches a running PA off first (2s), then the radio.
  const paFirst = !!(lastState && lastState.ampOn);
  showPowerOffMessage(paFirst ? "PA wird ausgeschalten" : "TS890 wird ausgeschalten", paFirst ? 2000 : 3000, paFirst);
  send({ type: "radioPower", enabled: false });
  playShutdownAnimation();
});
powerOverlay.addEventListener("click", (e) => {
  if (e.target === powerOverlay) powerOverlay.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") powerOverlay.hidden = true;
});
// Connected, the power button opens the choice: end this browser's session, or
// switch the TS890 off — Nutzer-Wunsch 2026-10-11.
// Without a connection the button simply connects (the server tries the radio and,
// if it is not reachable, wakes it with wake-on-lan); with one it opens the choice.
powerButton.addEventListener("click", () => {
  if (lastState && lastState.connected && !lastState.radioStandby) {
    powerOverlay.hidden = false;
  } else {
    setPowerOnPending(true);
    send({ type: "radioPower", enabled: true });
  }
});

// "Session beenden": stop audio, close the WebSocket for good (no reconnect),
// log a remote login out, then close the window. A browser only lets script close
// windows it opened itself, so otherwise a "Session beendet" screen stays (no
// reconnect button: reloading the page connects again).
let sessionEnded = false;
const sessionEndedOverlay = document.getElementById("session-ended-overlay");
document.getElementById("power-session").addEventListener("click", async () => {
  powerOverlay.hidden = true;
  sessionEnded = true;
  // Same slider-to-zero/waterfall-fade animation as powering off the TS890
  // or just disconnecting the session (Nutzer-Wunsch, 2026-10-14) — ending
  // the browser session is its own kind of "going away", reads the same way.
  // The "Sitzung beendet" cover below is delayed to match, so there's
  // actually time to see it play before it's covered (most browsers refuse
  // to let a script close a tab it didn't itself open, so that cover is
  // what the user is left looking at in practice, not a closed tab).
  playShutdownAnimation();
  if (window.hamrcSetMicStreaming) window.hamrcSetMicStreaming(false);
  if (window.hamrcStopAudioForRadioOff) window.hamrcStopAudioForRadioOff();
  if (ws) ws.close();
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch (e) {}
  window.close();
  // playShutdownAnimation's own setTimeout (same SHUTDOWN_ANIM_MS) already
  // forces the real "off" look — waterfall cleared/hint shown, page dim
  // settled, frequency/dropdowns on their placeholders — by the time this
  // fires; the cover just needs to wait long enough to not clip that.
  setTimeout(() => {
    sessionEndedOverlay.hidden = false;
  }, SHUTDOWN_ANIM_MS);
});

const setupButton = document.getElementById("setup-button");
setupButton.addEventListener("click", () => openConnectOverlay("net"));
document.getElementById("connect-cancel").addEventListener("click", closeConnectOverlay);

// Manual disconnect (Nutzer-Wunsch, 2026-09-28) — lets the operator free up
// the radio's single KNS slot for another client, or deliberately reconnect
// with different credentials, without closing the browser tab. Only shown
// while actually connected (openConnectOverlay above); the resulting
// connected:false broadcast is what makes the rest of the UI (status
// message, setup button glow) catch up, same as any other disconnect.
connectDisconnectButton.addEventListener("click", () => {
  if (lastState && lastState.connected) {
    send({ type: "disconnect" });
    // Same slider-to-zero/waterfall-fade animation as a full TS890 power-off
    // (Nutzer-Wunsch, 2026-10-14: "auch machen wenn nur die Session getrennt
    // wird") — this only drops the CAT session, the radio itself stays on,
    // but from the UI's own perspective it's the same connected->disconnected
    // transition, so it reads the same way visually.
    playShutdownAnimation();
    // Optimistic, like the frequency digits elsewhere in this app:
    // lastState.connected only flips once the next state broadcast confirming the disconnect arrives,
    // which takes a real WS round trip. Updating the toggle label right here
    // (instead of waiting for that broadcast) means it reads "Verbinde ..."
    // immediately regardless of broadcast timing — the real broadcast still
    // arrives afterwards and simply confirms/overwrites lastState as always.
    // The dialog itself stays open (Nutzer-Wunsch, 2026-10-14: "Trenne ...
    // wählen ... soll im Overlay bleiben" — it used to close here, dropping
    // the operator onto the plain "Radio OFF" screen behind it).
    if (lastState) lastState.connected = false;
    updateConnectToggle(false);
    // The submit handler's "nothing changed since the dialog opened" shortcut
    // below (connectConfigAtOpen) otherwise silently swallows the very next
    // "Verbinde ..." click: this dialog instance never closed/reopened, so
    // that snapshot still reflects the CONNECTED state from before this
    // Trennen — reconnecting with those exact same, unedited values then
    // compared equal and returned without ever sending anything (live bug,
    // 2026-10-14: "verbindet er nicht mehr ... es passiert einfach nichts").
    // Clearing it here means the next submit always actually attempts the
    // connect, exactly as it must right after a deliberate disconnect.
    connectConfigAtOpen = null;
  } else {
    document.getElementById("connect-form").requestSubmit(); // same as OK
  }
});

// Manual workaround for RX audio dropouts that follow real packet loss
// (see the VoIP UDP packet-loss indicator above). History: re-binding the
// server's own RX UDP socket + re-sending a bare "##VP1" on the existing
// CAT session (2026-09-28) was confirmed live as insufficient. A full CAT
// reconnect (fresh login, via a "disconnect" then "connect" pair —
// see the removed comment block this replaced)
// DID reliably work, matching the user's own manual Trennen+Verbinden
// workaround — but a full relogin isn't risk-free (it depends on strict
// sequencing to avoid the KNS single-session rejection, see the same
// history) and briefly drops CAT control every time it's used.
//
// Nutzer-Wunsch (2026-09-29): try a lower-risk option first that never
// touches the CAT session at all. Server now toggles the radio's own RTP
// sender off and back on ("##VP0" then "##VP1" on the SAME, already
// logged-in session) instead of reconnecting — genuinely different from
// the earlier insufficient attempt, which only ever repeated "##VP1"
// without ever turning it off first. Not yet confirmed against real
// hardware whether this actually clears a stuck dropout the way the full
// reconnect does — that's the next thing to find out in practice.
// The reset button now lives in the audio (VOIP) overlay (2026-10-11).
document.getElementById("reset-rx-audio-button").addEventListener("click", () => {
  send({ type: "resetRxAudio" });
  if (window.hamrcRestartRxAudio) window.hamrcRestartRxAudio();
});

// Recording (2026-10-12 user request): RX always, this browser's own TX
// audio too while actually transmitting — audio.js owns the Web Audio
// graph/MediaRecorder, this just drives the button (elapsed time, blinking
// LED via the .recording class) and builds the download filename, the one
// piece of radio state (frequency/mode) audio.js has no reason to know
// about.
const recordButton = document.getElementById("record-button");
const recordLabel = document.getElementById("record-label");
let recording = false;
let recordStartMs = 0;
let recordTimerId = null;
function pad2(n) {
  return String(n).padStart(2, "0");
}
function updateRecordLabel() {
  const elapsed = Math.floor((Date.now() - recordStartMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  recordLabel.textContent = `${m}:${pad2(s)}`;
}
function recordingFilenameBase() {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const hz = lastState ? (lastState.activeReceiver === "B" ? lastState.vfoBHz : lastState.vfoAHz) : 0;
  const freq = hz ? `${(hz / 1e6).toFixed(3)}MHz` : "unknown";
  const mode = (lastState && lastState.mode) || "unknown";
  return `${date}_${time}_${freq}_${mode}`;
}
// discard=true (Esc, see below) throws the recording away instead of saving
// it — same button/timer cleanup either way, only which audio.js call runs
// at the end differs.
function stopRecording(discard) {
  recording = false;
  clearInterval(recordTimerId);
  recordTimerId = null;
  recordButton.classList.remove("recording");
  recordLabel.textContent = "REC";
  if (discard) {
    if (window.hamrcCancelRecording) window.hamrcCancelRecording();
  } else {
    if (window.hamrcStopRecording) window.hamrcStopRecording(recordingFilenameBase());
  }
}
// Esc aborts and discards a running recording (Nutzer-Wunsch, 2026-10-16) —
// a quick "no, don't keep that" without having to wait for the save-file
// dialog Stop would otherwise trigger.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && recording) stopRecording(true);
});
recordButton.addEventListener("click", async () => {
  if (!recording) {
    if (!window.hamrcStartRecording) return;
    const ok = await window.hamrcStartRecording();
    if (!ok) return;
    recording = true;
    recordStartMs = Date.now();
    recordButton.classList.add("recording");
    updateRecordLabel();
    recordTimerId = setInterval(updateRecordLabel, 1000);
  } else {
    stopRecording();
  }
});
// Recording without RX audio makes no sense (2026-10-12 user request): grey
// out REC whenever audio is off, and if it stops WHILE recording (TON
// clicked off, or the connection just died — see the audio-recovery fix
// above), stop and download the partial recording rather than leaving the
// button stuck in a "recording" state that's silently capturing nothing.
window.hamrcOnAudioActiveChanged = function (active) {
  if (!active && recording) stopRecording();
  recordButton.disabled = !active && !recording;
};
recordButton.disabled = true;

connectOverlay.addEventListener("click", (e) => {
  if (e.target === connectOverlay) closeConnectOverlay();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !connectOverlay.hidden) closeConnectOverlay();
});

function readConnectConfig() {
  return {
    host: connectHostInput.value.trim(),
    port: Number(connectPortInput.value) || DEFAULT_PORT,
    voipPort: Number(connectVoipPortInput.value) || DEFAULT_VOIP_PORT,
    user: connectUserInput.value.trim(),
    pass: connectPassInput.value,
    admin: connectAdminInput.checked,
    auto: connectAutoInput.checked,
  };
}
// The network fields as they were when the dialog opened: OK without any change
// to them (e.g. after only looking at the VOIP tab or moving Mic Gain) must not
// try to connect to a radio that is off — it would just fail, so this closes
// the dialog instead of attempting it (Nutzer-Wunsch, 2026-10-14: OK must
// still be a way OUT of the dialog when there's genuinely nothing to submit —
// only the Trennen button and connectOk/alreadyConnected below, cases where
// something ACTUALLY changed, keep the dialog open). Reset to null by the
// Trennen handler above so a deliberate disconnect-then-reconnect with
// otherwise-unedited fields is never mistaken for "nothing changed" (that was
// a real bug: this snapshot still reflected the connected state from before
// the Trennen, so the next submit compared equal and silently did nothing).
let connectConfigAtOpen = null;

document.getElementById("connect-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const config = readConnectConfig();
  if (!(lastState && lastState.connected) && connectConfigAtOpen !== null && JSON.stringify(config) === connectConfigAtOpen) {
    closeConnectOverlay();
    return;
  }
  if (!config.host || !config.user) {
    setConnectStatus("IP und User sind Pflichtfelder.", true);
    return;
  }
  saveConnectConfig(config);

  // This overlay is also where Browser Mic Gain lives (a purely local,
  // already-applied-live setting, nothing to do with the radio connection)
  // — "Verbinden" used to be the only way out of the dialog, so adjusting
  // just that and clicking it re-sent a full connect request for an
  // already-active connection. The radio's KNS server only tolerates one
  // TCP session at a time and appears to drop the EXISTING one as soon as a
  // second connection attempt arrives, even before that second attempt's
  // own login gets rejected — so this was dropping a perfectly good
  // connection and then showing "Keine Verbindung" (live-reported bug).
  // If every field that actually identifies a connection already matches
  // what the server reports it's connected with, there's nothing to
  // (re)connect — just close the dialog instead of resubmitting the same
  // request (Nutzer-Wunsch, 2026-10-14: "wenn die Verbindung nicht getrennt
  // wurde muss man mit OK auch wieder rauskommen" — still connected and
  // nothing to do means OK is just a way out, same as the no-op case above).
  // (Password isn't part of that comparison: the server never reports it
  // back — see SetRadioConnection's comment — so there's no way to tell
  // whether it changed; an already-connected match skips resending it as
  // before.)
  const alreadyConnected =
    lastState &&
    lastState.connected &&
    lastState.radioHost === config.host &&
    lastState.radioPort === config.port &&
    lastState.radioVoipPort === config.voipPort &&
    lastState.radioUser === config.user &&
    !!lastState.radioAdmin === config.admin;
  if (alreadyConnected) {
    closeConnectOverlay();
    return;
  }

  setConnectStatus("Verbinde …", false);
  send({ type: "connect", ...config });
});

// Band scope (waterfall) controls. The server enables the "high" rate at
// connect (initialQueries in cmd/open890rc/main.go); the speed key below
// follows state.scopeRate. Spectrum off is purely client-side: it closes the
// browser's own /waterfall-ws connection (the radio has no stop command, see
// waterfall.js) and sends nothing to the server.
let scopeRateOff = false; // spectrum off is client-only, the server never hears about it
// With the spectrum off there is nothing to adjust: span and level handles
// are made unavailable (the Auto checkbox deliberately stays usable) (inert + dimmed; "inert" instead of "disabled",
// because waterfall.js manages the disabled state of the level sliders itself
// for its Auto mode). The rate button stays usable, it is how to switch back on.
// Direct frequency entry in the spectrum's free area (while the spectrum is
// off): digits and a comma (MHz), ENT tunes, CLR clears. What is typed shows
// on the big frequency display (blinking caret) until ENT/CLR bring the real
// frequency back. Also reacts to the real keyboard while the keypad is shown.
// The TS-890 covers 30 kHz - 60 MHz.
const freqKeypad = document.getElementById("freq-keypad");
const KP_MIN_HZ = 30000;
const KP_MAX_HZ = 60000000;
let kpEntry = "";
let kpFlashTimer = null;
const KP_INT_SLOTS = 2; // MHz digits before the comma
const KP_DEC_SLOTS = 6; // digits after the comma (kHz and Hz), in the usual 3 + 3 groups
function kpSlot(char) {
  const span = document.createElement("span");
  span.className = "digit kp-digit";
  span.textContent = char === "" ? "\u00A0" : char;
  return span;
}
function kpSep() {
  const span = document.createElement("span");
  span.className = "sep";
  span.textContent = ".";
  return span;
}
function kpRender() {
  freqEl.style.transform = ""; // an error message may have squeezed it to fit
  if (kpEntry === "") {
    freqEntering = false;
    freqEl.classList.remove("entering");
    renderFreq(currentHz); // back to the real frequency
    return;
  }
  freqEntering = true;
  freqEl.classList.add("entering");
  // Same layout as the real frequency display, so nothing moves while typing:
  // integer digits right-aligned against the comma, decimals filling in from
  // the left, every place not typed yet showing only its ghost segments.
  const [intPart, decPart = ""] = kpEntry.split(".");
  freqEl.innerHTML = "";
  for (let i = intPart.length; i < KP_INT_SLOTS; i++) freqEl.appendChild(kpSlot(""));
  for (const ch of intPart) freqEl.appendChild(kpSlot(ch));
  freqEl.appendChild(kpSep());
  for (let i = 0; i < KP_DEC_SLOTS; i++) {
    if (i === 3) freqEl.appendChild(kpSep());
    freqEl.appendChild(kpSlot(decPart[i] || ""));
  }
}
const KP_RANGE_TEXT = "0.03-60MHz"; // 10 characters, as wide as a frequency, so it fits at the full digit height
function kpError() {
  // The possible range, in red, as large as fits on the display.
  clearTimeout(kpFlashTimer);
  freqKeypad.classList.add("kp-error");
  freqEl.classList.add("entry-error");
  freqEl.textContent = KP_RANGE_TEXT;
  freqEl.style.transform = "";
  // Same digit height as the real frequency. Should it ever be wider than the
  // window (measured against the window width minus main's side padding, since
  // the display and even <main> grow with their content), only the width is
  // squeezed, not the height.
  const mainStyle = getComputedStyle(document.querySelector("main"));
  const available = document.documentElement.clientWidth - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight);
  if (freqEl.scrollWidth > available) {
    freqEl.style.transform = `scaleX(${available / freqEl.scrollWidth})`;
  }
  kpFlashTimer = setTimeout(() => {
    freqKeypad.classList.remove("kp-error");
    freqEl.classList.remove("entry-error");
    kpEntry = "";
    kpRender();
  }, 1500);
}
function kpPress(key) {
  if (freqKeypad.hidden) return;
  if (freqKeypad.classList.contains("kp-error")) return; // error message still showing
  if (key === "CLR") {
    kpEntry = "";
  } else if (key === "BACK") {
    kpEntry = kpEntry.slice(0, -1);
  } else if (key === "ENT") {
    if (!kpEntry) return;
    const mhz = parseFloat(kpEntry.replace(",", "."));
    const hz = Math.round(mhz * 1e6);
    if (!(hz >= KP_MIN_HZ && hz <= KP_MAX_HZ)) {
      kpError();
      return;
    }
    window.hamrcTuneToFreq(hz); // sets currentHz (its own render is skipped while entering)
    kpEntry = "";
  } else if (key === "," || key === ".") {
    if (kpEntry.includes(".")) return;
    kpEntry = (kpEntry || "0") + ".";
  } else if (/^[0-9]$/.test(key)) {
    const [intPart, decPart] = kpEntry.split(".");
    if (decPart === undefined ? intPart.length >= 2 : decPart.length >= 6) return;
    kpEntry += key;
  }
  kpRender();
}
for (const btn of freqKeypad.querySelectorAll(".kp-key")) {
  btn.addEventListener("click", () => kpPress(btn.dataset.key));
}
document.addEventListener("keydown", (e) => {
  if (freqKeypad.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector(".overlay:not([hidden])")) return; // a dialog is open
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const map = { Enter: "ENT", Backspace: "BACK", Escape: "CLR", ",": ",", ".": "," };
  const key = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
  if (!key) return;
  e.preventDefault();
  kpPress(key);
});

// Simple Mode (phone only, Nutzer-Wunsch 2026-10-24): one big overlay with
// the frequency on top, the analog gauge + its mode keys below that, and the
// big TX button at the bottom, replacing the earlier separate "Analog"/"TX"
// spectrum-area swaps. #freq, the gauge and the mode keys all live in their
// normal spot (#freq always in the main layout; the gauge/keys in the
// phone-hidden desktop markup); while shown, those very nodes are moved into
// their own container here (ids, needle animation, digit tap-to-set and key
// handlers all keep working, since they're the SAME elements, just
// relocated) and put back when it closes — same relocate-don't-clone trick
// those swaps already used. Unlike those, this is a real modal overlay (see
// #simple-mode-overlay), so it does NOT touch scopeRateOff/freqKeypad/SPEC
// at all — the spectrum and the keypad just keep doing whatever they were
// doing underneath.
const simpleModeOverlay = document.getElementById("simple-mode-overlay");
const simpleModeFreq = document.getElementById("simple-mode-freq");
const simpleModeGauge = document.getElementById("simple-mode-gauge");
const simpleModeButton = document.getElementById("simple-mode-button");
let simpleModeOn = false;
let simpleModeHome = null; // [{node, dest, parent, next}]
function setSimpleMode(on) {
  if (on === simpleModeOn) return;
  simpleModeOn = on;
  if (on) {
    simpleModeHome = [
      { node: freqEl, dest: simpleModeFreq },
      { node: document.getElementById("meter-analog"), dest: simpleModeGauge },
      { node: document.querySelector(".meter-mode-row"), dest: simpleModeGauge },
    ].map(({ node, dest }) => ({ node, dest, parent: node.parentNode, next: node.nextSibling }));
    for (const h of simpleModeHome) h.dest.appendChild(h.node);
  } else {
    // reverse order so each node's remembered "next" sibling is already in place
    for (const h of [...simpleModeHome].reverse()) h.parent.insertBefore(h.node, h.next);
    simpleModeHome = null;
  }
  simpleModeOverlay.hidden = !on;
}
simpleModeButton.addEventListener("click", () => setSimpleMode(true));
document.getElementById("simple-mode-exit").addEventListener("click", () => setSimpleMode(false));
simpleModeOverlay.addEventListener("click", (e) => {
  if (e.target === simpleModeOverlay) setSimpleMode(false); // backdrop click
});
window.matchMedia("(max-width: 799px)").addEventListener("change", (e) => {
  if (!e.matches) setSimpleMode(false);
});

// Easy Mode tuning wheel (Nutzer-Wunsch 2026-11-02): a knurled thumbwheel seen from its edge. Dragging turns it
// (finger speed = surface speed at the centre), letting go while moving lets it coast and slow down by friction.
// One ridge = TUNE_WHEEL_HZ_PER_RIDGE; the frequency moves in whole ridges through adjustFreq (same throttled,
// optimistic send path as the digit wheel).
// Feel of the wheel (Nutzer-Wunsch 2026-11-03). Hz per click, coasting time and heaviness are adjustable (double click
// on a wheel -> #tunewheel-overlay, per browser in localStorage); detent pull/lag are fixed at the values settled on.
const TUNE_WHEEL_RIDGES = 40;
const TUNE_WHEEL_HZ_STEPS = [10, 50, 100, 250, 500, 1000];
const TUNE_WHEEL_DEFAULTS = {
  hzIdx: 2, // index into TUNE_WHEEL_HZ_STEPS: Hz per ridge (one click)
  tauCs: 5, // coasting friction time constant in 1/100 s: velocity decays e^(-t/tau) (smaller = stiffer bearing), max 30
  dry: 30, // dry friction in ridges/s^2: constant braking, stops the wheel decisively (0 = only the smooth viscous decay)
};
const tuneWheelCfg = { ...TUNE_WHEEL_DEFAULTS, pull: 50, drag: 20 }; // pull: detent pull in ridges/s^2; drag: % lag while dragging
try {
  const saved = JSON.parse(localStorage.getItem("open890rc.tuneWheel") || "{}");
  for (const k of Object.keys(TUNE_WHEEL_DEFAULTS)) if (Number.isFinite(saved[k])) tuneWheelCfg[k] = saved[k];
  tuneWheelCfg.tauCs = Math.min(30, tuneWheelCfg.tauCs);
} catch (e) {
  // unreadable/unavailable: defaults
}
function saveTuneWheelCfg() {
  try {
    const { hzIdx, tauCs, dry } = tuneWheelCfg;
    localStorage.setItem("open890rc.tuneWheel", JSON.stringify({ hzIdx, tauCs, dry }));
  } catch (e) {
    // setting just won't persist
  }
}
function initTuneWheel(cv, preview = false, onDoubleTap = null) {
  const ctx = cv.getContext("2d");
  const STEP = (2 * Math.PI) / TUNE_WHEEL_RIDGES;
  let rot = 0; // radians; rot/STEP = ridges turned
  let applied = 0; // whole ridges already sent to the radio
  let vel = 0; // rad/s
  let dragging = false;
  let lastX = 0;
  let lastT = 0;
  let raf = 0;
  // double tap/click detection of our own: on touch screens a wheel with touch-action:none never gets a dblclick
  let downX = 0;
  let downT = 0;
  let moved = false;
  let lastTap = 0;
  const shade = (c, k) => `rgb(${c.map((x) => Math.round(x * k)).join(",")})`;
  function draw() {
    const W = cv.width;
    const H = cv.height;
    if (!W || !H) return;
    for (let i = 0; i < W; i++) {
      const t = (i / W - 0.5) * Math.PI * 0.98;
      ctx.fillStyle = shade([30, 31, 34], 0.35 + 0.65 * Math.cos(t) ** 1.5);
      ctx.fillRect(i, 0, 1, H);
    }
    const first = Math.floor((-rot - Math.PI / 2) / STEP);
    const last = Math.ceil((-rot + Math.PI / 2) / STEP);
    for (let j = first; j <= last; j++) {
      const a = j * STEP + rot;
      if (Math.abs(a) > (Math.PI / 2) * 0.98) continue;
      const x = W / 2 + Math.sin(a) * (W / 2) * 0.98;
      const cs = Math.cos(a);
      const w = Math.max(1, 0.38 * STEP * (W / 2) * cs);
      const mark = ((j % TUNE_WHEEL_RIDGES) + TUNE_WHEEL_RIDGES) % TUNE_WHEEL_RIDGES === 0;
      ctx.fillStyle = mark ? shade([255, 140, 30], 0.4 + 0.6 * cs) : shade([8, 8, 10], 0.5 + 0.5 * cs);
      ctx.fillRect(x - w / 2 - 0.5, 0, w + 1, H);
      ctx.fillStyle = mark ? shade([255, 190, 90], 0.4 + 0.6 * cs) : shade([78, 80, 86], 0.35 + 0.65 * cs);
      ctx.fillRect(x - w * 0.5, 0, Math.max(1, w * 0.45), H);
    }
    ctx.fillStyle = "rgba(0,0,0,.75)";
    ctx.fillRect(0, H * 0.45, W, H * 0.1);
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.fillRect(0, H * 0.55, W, Math.max(1, H * 0.04));
    const e = ctx.createLinearGradient(0, 0, W, 0);
    e.addColorStop(0, "rgba(0,0,0,.65)");
    e.addColorStop(0.12, "rgba(0,0,0,0)");
    e.addColorStop(0.88, "rgba(0,0,0,0)");
    e.addColorStop(1, "rgba(0,0,0,.65)");
    ctx.fillStyle = e;
    ctx.fillRect(0, 0, W, H);
    const v = ctx.createLinearGradient(0, 0, 0, H);
    v.addColorStop(0, "rgba(255,255,255,.1)");
    v.addColorStop(0.15, "rgba(0,0,0,0)");
    v.addColorStop(0.85, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,.35)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
  function turn(dr) {
    rot += dr;
    // the frequency steps when the wheel tips over the crest between two clicks
    const whole = Math.round(rot / STEP);
    if (whole !== applied) {
      if (!preview && !controlsDisabled) adjustFreq((whole - applied) * TUNE_WHEEL_HZ_STEPS[tuneWheelCfg.hzIdx]);
      applied = whole;
    }
    draw();
  }
  // sitting in a detent and (almost) not moving: snap exactly into place
  function settled() {
    if (tuneWheelCfg.pull <= 0) return Math.abs(vel) < 0.08;
    return Math.abs(vel / STEP) < 0.4 && Math.abs(Math.sin((2 * Math.PI * rot) / STEP)) < 0.03;
  }
  function coast(now) {
    raf = 0;
    if (dragging || cv.offsetParent === null) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    // integrate in small steps (ridges, ridges/s): pawl pull + bearing friction
    const tau = tuneWheelCfg.tauCs / 100;
    let x = rot / STEP;
    let v = vel / STEP;
    const n = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      v -= tuneWheelCfg.pull * Math.sin(2 * Math.PI * x) * h;
      v *= Math.exp(-h / tau);
      // dry friction: constant deceleration against the direction of motion, never reversing it
      const brake = tuneWheelCfg.dry * h;
      v = Math.abs(v) <= brake ? 0 : v - Math.sign(v) * brake;
      x += v * h;
    }
    vel = v * STEP;
    const dr = x * STEP - rot;
    if (settled()) {
      vel = 0;
      if (tuneWheelCfg.pull > 0) turn(Math.round(x) * STEP - rot);
      else turn(dr);
      return;
    }
    turn(dr);
    raf = requestAnimationFrame(coast);
  }
  function startCoast() {
    if (raf) return;
    if (settled()) {
      vel = 0;
      return;
    }
    lastT = performance.now();
    raf = requestAnimationFrame(coast);
  }
  cv.addEventListener("pointerdown", (e) => {
    if (controlsDisabled && !preview) return;
    cv.setPointerCapture(e.pointerId);
    dragging = true;
    vel = 0;
    lastX = e.clientX;
    lastT = performance.now();
    downX = e.clientX;
    downT = lastT;
    moved = false;
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const now = performance.now();
    if (Math.abs(e.clientX - downX) > 6) moved = true;
    const dt = Math.max(0.001, (now - lastT) / 1000);
    const dr = (e.clientX - lastX) / (cv.clientWidth / 2);
    // smoothed finger velocity, so one jittery sample doesn't decide how long it coasts
    vel = vel * 0.6 + (dr / dt) * 0.4;
    lastX = e.clientX;
    lastT = now;
    // sticky over the detent: slow at the click position, faster on the way to the next one (net 1:1 per ridge)
    turn(dr * (1 - (tuneWheelCfg.drag / 100) * Math.cos((2 * Math.PI * rot) / STEP)));
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    // a finger that stopped before lifting must not fling the wheel
    if (performance.now() - lastT > 80) vel = 0;
    startCoast();
  };
  cv.addEventListener("pointerup", () => {
    if (dragging && onDoubleTap && !moved && performance.now() - downT < 300) {
      const now = performance.now();
      if (now - lastTap < 450) {
        lastTap = 0;
        onDoubleTap();
      } else {
        lastTap = now;
      }
    }
    release();
  });
  cv.addEventListener("pointercancel", release);
  cv.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (controlsDisabled && !preview) return;
      vel += -(e.deltaY || e.deltaX) * 0.02;
      startCoast();
    },
    { passive: false }
  );
  // follows the CSS size (also when the overlay opens: 0 -> real size); sharp on high-DPI screens
  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    draw();
  }).observe(cv);
}
// one wheel in the Easy Mode overlay, one on desktop under RIT/XIT (each keeps its own angle; the frequency moves by
// whole ridges either way)
function openTuneWheelOverlay() {
  if (controlsDisabled) return;
  tuneWheelOverlay.hidden = false;
}
for (const id of ["tune-wheel", "tune-wheel-desktop"]) initTuneWheel(document.getElementById(id), false, openTuneWheelOverlay);

// Tuning wheel settings overlay (double click on a wheel, Nutzer-Wunsch 2026-11-03): live preview wheel (turns like the
// real one but never tunes the radio) plus the three adjustable values. Browser-local only.
const tuneWheelOverlay = document.getElementById("tunewheel-overlay");
initTuneWheel(document.getElementById("tunewheel-preview"), true);
function tuneWheelSlider(id, key, max, valueId, fillId, fmt) {
  return makeSlider(
    id,
    (value) => {
      tuneWheelCfg[key] = value;
      saveTuneWheelCfg();
    },
    max,
    valueId,
    fmt,
    fillId
  );
}
const tuneWheelSliders = {
  hzIdx: tuneWheelSlider("tunewheel-hz-slider", "hzIdx", TUNE_WHEEL_HZ_STEPS.length - 1, "tunewheel-hz-value", "tunewheel-hz-fill", (v) => `${TUNE_WHEEL_HZ_STEPS[v]} Hz`),
  tauCs: tuneWheelSlider("tunewheel-tau-slider", "tauCs", 30, "tunewheel-tau-value", "tunewheel-tau-fill", (v) => `${(v / 100).toFixed(2)} s`),
  dry: tuneWheelSlider("tunewheel-dry-slider", "dry", 100, "tunewheel-dry-value", "tunewheel-dry-fill", (v) => (v ? `${v}` : "aus")),
};
function syncTuneWheelSliders() {
  for (const k of Object.keys(tuneWheelSliders)) tuneWheelSliders[k].applyValue(tuneWheelCfg[k]);
}
syncTuneWheelSliders();
function closeTuneWheelOverlay() {
  tuneWheelOverlay.hidden = true;
}
document.getElementById("tunewheel-overlay-close").addEventListener("click", closeTuneWheelOverlay);
tuneWheelOverlay.addEventListener("click", (e) => {
  if (e.target === tuneWheelOverlay) closeTuneWheelOverlay();
});
document.getElementById("tunewheel-overlay-reset").addEventListener("click", () => {
  Object.assign(tuneWheelCfg, TUNE_WHEEL_DEFAULTS);
  saveTuneWheelCfg();
  syncTuneWheelSliders();
});


// ANALOG key (phone, spectrum off): the analog meter (+ its PWR/SWR/ALC/IC keys) takes the place of the frequency
// keypad in the spectrum area. Same relocate-don't-clone trick as the Simple Mode overlay (Nutzer-Wunsch 2026-11-02).
const analogArea = document.getElementById("analog-area");
const analogModeButton = document.getElementById("analog-mode-button");
let analogOn = false;
let analogHome = null;
function setAnalogMode(on) {
  if (on === analogOn || (on && simpleModeOn)) return;
  analogOn = on;
  if (on) {
    analogHome = [document.getElementById("meter-analog"), document.querySelector(".meter-mode-row")].map((node) => ({
      node,
      parent: node.parentNode,
      next: node.nextSibling,
    }));
    for (const h of analogHome) analogArea.appendChild(h.node);
  } else if (analogHome) {
    for (const h of [...analogHome].reverse()) if (h.node.parentNode === analogArea) h.parent.insertBefore(h.node, h.next);
    analogHome = null;
  }
  analogArea.hidden = !on;
  analogModeButton.classList.toggle("active", on);
  freqKeypad.hidden = on || !scopeRateOff;
}
analogModeButton.addEventListener("click", () => setAnalogMode(!analogOn));
window.matchMedia("(min-width: 800px)").addEventListener("change", (e) => {
  if (e.matches) setAnalogMode(false);
});

function setScopeControlsAvailable(available) {
  if (available) setAnalogMode(false);
  freqKeypad.hidden = available || analogOn;
  document.querySelector(".waterfall-row").classList.toggle("scope-is-off", !available);
  if (available) {
    kpEntry = "";
    kpRender();
  }
  for (const el of document.querySelectorAll("#scope-span-select, #scope-color-select, .scope-level-slider")) {
    el.inert = !available;
    el.classList.toggle("scope-off", !available);
  }
}
// SPEC: ONE toggle key, green while the spectrum is on, plain grey while it is
// off (the rate is not offered here any more). Off closes the browser's own
// /waterfall-ws connection (there's no stop command for the radio's scope data
// anyway, see waterfall.js), dims the span/level controls and shows the
// frequency keypad in the free area; the radio itself is not touched.
const scopeToggleButton = document.getElementById("scope-toggle-button");
scopeToggleButton.classList.add("active");
function setScopeOn(on) {
  scopeRateOff = !on;
  scopeToggleButton.classList.toggle("active", on);
  setScopeControlsAvailable(on);
  if (window.hamrcSetWaterfallEnabled) window.hamrcSetWaterfallEnabled(on);
}
scopeToggleButton.addEventListener("click", () => {
  // Phone: the chat covers the waterfall area and has switched the spectrum off; SPEC takes the chat away again and
  // switches the spectrum on (see chatLeave). Should the spectrum nevertheless be on, SPEC only closes the chat.
  if (chatPhoneMQ.matches && chatOpen) {
    chatOpen = false;
    chatSpecRestore = false;
    chatApplyOpen();
    if (!scopeRateOff) return;
  }
  setScopeOn(scopeRateOff);
});

// Speed key next to SPEC: cycles the radio's scope update rate (DD01/02/03).
const SCOPE_RATE_LABELS = { high: "Hi", medium: "Mid", low: "Lo" };
const SCOPE_RATE_NEXT = { high: "medium", medium: "low", low: "high" };
let scopeRateCurrent = "high";
const scopeRateButton = document.getElementById("scope-rate-button");
scopeRateButton.addEventListener("click", () => {
  scopeRateCurrent = SCOPE_RATE_NEXT[scopeRateCurrent] || "high";
  scopeRateButton.textContent = SCOPE_RATE_LABELS[scopeRateCurrent];
  send({ type: "setScopeRate", rate: scopeRateCurrent });
});
function syncScopeRate(rate) {
  if (!SCOPE_RATE_LABELS[rate]) return;
  scopeRateCurrent = rate;
  scopeRateButton.textContent = SCOPE_RATE_LABELS[rate];
}

// Matches cat.go's bandScopeSpans (BS4 index -> Hz) exactly.
const SCOPE_SPANS_HZ = [5000, 10000, 20000, 30000, 50000, 100000, 200000, 500000];
const scopeSpanSelect = document.getElementById("scope-span-select");
for (const hz of SCOPE_SPANS_HZ) {
  const opt = document.createElement("option");
  opt.value = String(hz);
  opt.textContent = hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`;
  scopeSpanSelect.appendChild(opt);
}
scopeSpanSelect.addEventListener("change", () => {
  send({ type: "setScopeSpan", value: Number(scopeSpanSelect.value) });
});

// #status-info/#status-info-desktop (statusEls) are a general-purpose
// status/message line, shared
// by whatever currently has something worth telling the operator — not
// connected, the WS itself reconnecting (set directly in ws.onclose, since
// there's no state broadcast to react to while it's down), real RX audio
// packet loss, etc. Only one shows at a time, most-actionable first: "not
// connected" always wins (it's the reason nothing else works either), then
// real RTP loss (internal/audio's Receiver, via its sequence-number gap
// counter — added live 2026-09-28 after a "RX klingt kratzig" report, to
// tell genuine network/radio-side loss apart from purely client-side
// playback artifacts like the AudioWorklet ring buffer's own jitter
// trimming in pcm-player-processor.js). Empty when there's nothing to say.
// True from the click on power-on until the server reports the outcome
// (powerOk/powerError), shown blinking in the status line.
let powerOnPending = false;
let powerOnPendingTimer = null;
function setPowerOnPending(pending) {
  const wasPending = powerOnPending;
  powerOnPending = pending;
  clearTimeout(powerOnPendingTimer);
  if (pending) powerOnPendingTimer = setTimeout(() => setPowerOnPending(false), 120000); // safety net
  setStatusClass("blink", pending);
  if (lastState) applyState(lastState);
  else setStatusText(pending ? POWER_ON_MESSAGE : "");
  // Audio auto start was held back while powering on (the connection gets
  // redialed once) — do it now that it's done.
  if (wasPending && !pending && lastState && lastState.connected) onConnectedChange(true);
}
// Power-off messages: "PA wird ausgeschalten" (only if the PA was on), then
// "TS890 wird ausgeschalten" for 3s, then the normal status line again.
let powerOffMessage = "";
let powerOffTimer = null;
function showPowerOffMessage(text, ms, thenRadio) {
  clearTimeout(powerOffTimer);
  powerOffMessage = text;
  if (lastState) applyState(lastState);
  powerOffTimer = setTimeout(() => {
    if (thenRadio) showPowerOffMessage("TS890 wird ausgeschalten", 3000, false);
    else {
      powerOffMessage = "";
      if (lastState) applyState(lastState);
    }
  }, ms);
}
const POWER_ON_MESSAGE = "WakeOnLAN"; // Nutzer-Wunsch, 2026-10-14: nur das Wort soll blinken, nicht ein ganzer Satz

// Non-error PA info messages are shown for 5s at most (otherwise they would
// cover the SWR scale for as long as the PA stays on).
const INFO_MESSAGE_MS = 5000;
let infoWatchText = "";
let infoWatchTimer = null;
function watchInfoExpiry() {
  if (paInfoMessage === infoWatchText) return;
  infoWatchText = paInfoMessage;
  clearTimeout(infoWatchTimer);
  if (!paInfoMessage) return;
  const text = paInfoMessage;
  infoWatchTimer = setTimeout(() => {
    if (paInfoMessage === text) {
      paInfoMessage = "";
      if (lastState) applyState(lastState);
    }
  }, INFO_MESSAGE_MS);
}

// VoIP packet-loss notice: same 5s cap as the other info-style messages
// above (Nutzer-Wunsch, 2026-10-12: "sind informal und kein problem") —
// used to stay on screen indefinitely for as long as state.rxAudioLost
// (the server's running counter) stayed non-zero, which could be a long
// time after just a brief burst of loss. Only how long it's DISPLAYED is
// capped here; the counter itself (and the reset button that zeroes it)
// are untouched. Keyed off the counter actually growing, not just being
// non-zero, so an old already-expired loss count doesn't resurrect the
// message on every unrelated broadcast (which arrive constantly, e.g. the
// S-meter).
let rxLostWatchValue = 0;
let rxLostMessageUntil = 0;
function watchRxLostExpiry(state) {
  const lost = state.rxAudioLost || 0;
  if (lost > rxLostWatchValue) {
    rxLostMessageUntil = Date.now() + INFO_MESSAGE_MS;
    setTimeout(() => {
      if (lastState) applyState(lastState);
    }, INFO_MESSAGE_MS + 50);
  }
  rxLostWatchValue = lost;
}

const RADIO_OFF_MESSAGE = "OFF - Station Einschalten mit PowerON"; // Nutzer-Wunsch, 2026-10-14

// Clients currently connected to the server (Traffic window, "Verbundene Clients").
let clientList = [];
let myClientId = null;
function renderClientList() {
  const el = document.getElementById("client-list");
  if (!el) return;
  el.replaceChildren(
    ...clientList.map((c) => {
      const row = document.createElement("div");
      const t = new Date(c.since);
      const time = document.createElement("span");
      time.className = "cl-time";
      time.textContent = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const who = document.createElement("span");
      who.className = "cl-who";
      who.textContent = `${c.user ? `${c.user} · ` : ""}${c.name ? `${c.name} · ` : ""}${c.host ? `${c.host} · ` : ""}${c.ip}${c.codec ? ` · ${c.codec.toUpperCase()}` : ""}${c.id === myClientId ? "  (Du)" : ""}`;
      if (c.id === myClientId) who.classList.add("cl-me");
      row.append(time, who);
      return row;
    })
  );
}

// Notice that another client connected (same short display time as the PA info
// messages, INFO_MESSAGE_MS). Ranks above the PA info, below errors/warnings.
let clientInfoMessage = "";
let clientInfoTimer = null;
function showClientInfo(text) {
  clientInfoMessage = text;
  clearTimeout(clientInfoTimer);
  clientInfoTimer = setTimeout(() => {
    clientInfoMessage = "";
    if (lastState) applyState(lastState);
  }, INFO_MESSAGE_MS);
  if (lastState) applyState(lastState);
}

function statusMessageFor(state) {
  if (powerOnPending) return POWER_ON_MESSAGE;
  if (powerOffMessage) return powerOffMessage;
  if (!state.connected || state.radioStandby) return RADIO_OFF_MESSAGE;
  // Radio pop-up messages (ME0/ME1: temperature, DSP, hardware errors ...).
  if (state.radioMessage) return `⚠ TS890: ${state.radioMessage} ⚠`;
  // PA problems first (alarm before warning), flanked by warning symbols.
  if (state.ampAlarm) return `⚠ PA: ${state.ampAlarm} ⚠`;
  if (state.ampWarning) return `⚠ PA: ${state.ampWarning} ⚠`;
  if (paCmdError) return `⚠ PA: ${paCmdError} ⚠`;
  // A TX Message is actually transmitting (op 5, cat.VoiceMsgOpSend) — shown
  // regardless of who/what triggered it (another client's TX MSG button, or
  // the front panel itself: state.voiceMsgChannel is the radio's own PB1
  // readback, not tied to this browser's txMsgSelectedChannel), same as the
  // red LED on the TX MSG button isn't limited to "this browser sent it"
  // either (Nutzer-Wunsch, 2026-10-29: "beim senden einer TX message oben
  // einblenden 'TX : NAME DER MESSAGE'"). Ranked above the plain info
  // messages below — an actual transmission in progress is as attention-
  // worthy as the PA/error states above it, not a passing notice.
  if (state.voiceMsgOp === 5 && state.voiceMsgChannel) {
    const ch = state.voiceMsgChannels && state.voiceMsgChannels[state.voiceMsgChannel - 1];
    const name = ch && ch.name ? ch.name : `CH${state.voiceMsgChannel}`;
    return `TX: ${name}`;
  }
  if (clientInfoMessage) return clientInfoMessage;
  if (paInfoMessage) return paInfoMessage;
  if (state.rxAudioLost && Date.now() < rxLostMessageUntil) return `⚠ VoIP UDP Paketverluste: ${state.rxAudioLost} !`;
  return "";
}

let freqShowsOff = false;

// RX audio stops when the connection goes away (radio powered off) and starts
// again by itself ("Mobil", Opus) when the radio is up — with the browser's
// autoplay rule in mind: if playback is blocked it begins on the first click or
// tap on the page. PCM/Mobil still switch it by hand.
let prevConnected = null;
function onConnectedChange(connected) {
  if (powerOnPending) return;
  if (!connected && window.hamrcStopAudioForRadioOff) {
    window.hamrcStopAudioForRadioOff();
  }
  if (connected && window.hamrcAutoStartAudio) {
    window.hamrcAutoStartAudio();
  }
  if (connected) {
    // Mirrors playShutdownAnimation's dim-out: tweens everything back to
    // full opacity over the same SHUTDOWN_ANIM_MS — matters both if
    // reconnecting lands WITHIN the 900ms shutdown window (the dim was still
    // animating) and for the normal case (shutdown already completed,
    // shutdownDimElements sitting at their deliberately-left 0.4, see
    // playShutdownAnimation/finishShutdownFade's own comments on why nothing
    // else would ever put that back). The slider side runs in applyState —
    // a WINDOW rather than a single broadcast, because the very first
    // "connected" broadcast isn't guaranteed to already carry the radio's
    // real rfGain/squelch/power (those may still be mid-query); a window
    // lets a later, corrected broadcast retarget the same tween instead of
    // the slider first animating to a stale/zero value and then snapping to
    // the real one once reconnectAnimationPending had already been
    // (wrongly) consumed by that first broadcast.
    const wrap = document.querySelector(".waterfall-wrap");
    if (wrap) tweenOpacityTo(wrap, 1, SHUTDOWN_ANIM_MS);
    for (const el of shutdownDimElements) tweenOpacityTo(el, 1, SHUTDOWN_ANIM_MS);
    shutdownDimElements = [];
    forceRadioOffDisplay = false;
    sliderReconnectAnimationUntil = performance.now() + 2000;
  }
}

// Without a radio connection every control below the top bar is made inert
// (no clicks, no focus, dimmed) — the top bar (setup, power, audio) and the
// status line stay usable, the frequency display shows "RADIO OFF".
let controlsDisabled = null;
// Elements marked inert/off-blur by the last pass. Which elements are "real
// boxes" depends on the layout (display:contents differs between desktop and
// phone), so after a breakpoint change the old marks must be undone and the
// pass redone, otherwise buttons keep stale/missing blur (Nutzer-Report 2026-11-02).
let lastDimTargets = [];
function setControlsDisabled(disabled) {
  if (disabled === controlsDisabled) return;
  controlsDisabled = disabled;
  applyControlsDisabled(disabled);
}
window.matchMedia("(min-width: 800px)").addEventListener("change", () => {
  // let the relocate*ForLayout handlers move their buttons first
  setTimeout(() => {
    for (const el of lastDimTargets) {
      el.inert = false;
      el.classList.remove("off-blur");
    }
    lastDimTargets = [];
    if (controlsDisabled !== null) applyControlsDisabled(controlsDisabled);
  }, 0);
});
function applyControlsDisabled(disabled) {
  lastDimTargets = [];
  // CSS hook: unlit keys and a dimmed meter while the radio is off/disconnected (desktop)
  document.querySelector("main").classList.toggle("controls-off", disabled);
  // collectDimTargets (not a plain "main > *") because .controls is
  // display:contents on desktop (a pure CSS-Grid pass-through, no box of its
  // own) — setting .inert directly on it, like this used to, doesn't reach
  // its button children on this engine (verified live: el.inert stayed
  // false on #at-button even with .controls marked inert, so AT/PRE/ATT/...
  // stayed fully lit AND clickable with no radio connected, Nutzer-Report
  // 2026-10-15 "Buttons sollten ausgegraut sein"). Same trap, same fix as
  // playShutdownAnimation's dim loop above.
  for (const el of collectDimTargets(document.querySelector("main"))) {
    // The meter block holds the status message, which must stay readable.
    // .waterfall-wrap is skipped too (Nutzer-Report, 2026-10-14): it has its
    // own fully-visible "Spektrum aus" end state (playShutdownAnimation/
    // finishShutdownFade) and its own click-to-tune gating via
    // waterfall.js's scopeEnabled, so the generic main [inert] 0.4 dim
    // would only fight the former and the generic inert the latter already
    // covers — without this, the waterfall-wrap ended up stuck at 0.4
    // instead of snapping back to fully visible once "Spektrum aus" showed.
    if (el.matches(".status-row, .meter-block, #freq, .status-message-desktop, .waterfall-wrap")) {
      // Blur has a WIDER scope than the inert-exemption above (Nutzer-Wunsch
      // 2026-10-23: "alles unter der ersten Zeile" — really everything,
      // including the meter and the "OFF" frequency display, unlike their
      // inert-exemption which only exists to keep them clickable/legible as
      // static content). Only .status-row itself and its message line
      // (effectively still "the first line") stay sharp.
      //
      // .meter-block itself is a special case (Nutzer-Report 2026-10-23: on
      // phone, the WakeOnLan "bitte warten" message was unreadable while
      // powering on): blurring .meter-block as a whole also blurs #status-
      // info, its own direct child and the ONLY place that message shows on
      // phone (the desktop echo, #status-info-desktop, is a separate element
      // already excluded above) — filter has no way to exempt a descendant
      // from its ancestor's blur. So the meter proper (#meter-tx-toggle,
      // .meter-block's OTHER direct child — holds the S/SWR bars, the
      // desktop analog gauge and .meter-mode-row) gets blurred directly
      // instead of .meter-block, leaving #status-info untouched.
      if (el.matches(".meter-block")) {
        document.getElementById("meter-tx-toggle")?.classList.toggle("off-blur", disabled);
      } else {
        el.classList.toggle("off-blur", disabled && !el.matches(".status-row, .status-message-desktop"));
      }
      continue;
    }
    el.inert = disabled;
    el.classList.toggle("off-blur", disabled);
    lastDimTargets.push(el);
  }
  // The meter-mode keys sit inside .meter-block (skipped above for the status message).
  for (const el of document.querySelectorAll(".meter-mode-row")) el.inert = disabled;
  // AF/SQL sit under the meter on desktop (inside .meter-block, like the keys above)
  document.getElementById("left-sliders").inert = disabled;
  // Desktop: #left-sliders is a real box inside .meter-block and gets its own blur
  // (on phone it is display:contents, its rows are blurred by the loop above).
  document.getElementById("left-sliders").classList.toggle("off-blur", disabled);
  // #audio-button sits inside .status-row itself, so the loop above never
  // reaches it (the whole top bar — setup, power, audio — is deliberately
  // left usable, see this function's own opening comment). But starting the
  // RX audio stream makes no sense with no radio connected, and leaving it
  // clickable let you open it while "OFF" was showing (Nutzer-Wunsch
  // 2026-10-23) — so it alone, not the rest of that row, is explicitly
  // disabled/re-enabled here via the native disabled attribute (a real
  // <button>, so this also blocks the click without touching audio.js at
  // all — .audio-btn:disabled already has the usual dimmed/no-pointer look).
  document.getElementById("audio-button").disabled = disabled;
  // #tx-area-button (the big TX button in #simple-mode-overlay, 2026-10-24)
  // lives in an overlay, a sibling of <main> entirely outside it — the
  // generic loop above only ever walks <main>'s own children, so it never
  // reaches ANY overlay's content (by design: a trigger button inside
  // <main>, e.g. #simple-mode-button itself, already goes inert normally,
  // which is enough to stop a NEW overlay from opening; this only matters if
  // the radio drops while one is already open). Unlike #audio-button this
  // button already has its OWN disabled attribute for a different reason
  // (txAllowed, see applyAdminUi) — inert instead of disabled here keeps the
  // two reasons independent, same split #tx-button itself has (inert from
  // the generic loop, disabled from applyAdminUi) since it IS reached by
  // that loop, living inside <main> itself.
  document.getElementById("tx-area-button").inert = disabled;
  document.getElementById("tune-wheel").inert = disabled;
  document.getElementById("tune-wheel-desktop").inert = disabled;
}

// PA access (LAN, admins, users with the PA flag): everybody else gets the PA
// stripped from the state, so no PA row, meter scale, message or setting shows.
// The server also drops their PA commands.
let paAllowed = false;
// TX access (LAN, admins, any logged-in user NOT explicitly denied it) —
// opposite default from paAllowed, see hasTX's own comment (auth.go): most
// users may transmit, so this starts true (same default initAuth/applyAdminUi
// will confirm from /auth/status before the TX button can realistically be
// used anyway). Gates the TX/TUNE buttons, PTT, and ever opening the
// microphone — the server also drops setTX/setTune and refuses
// /audio-tx-ws for anyone without it (Nutzer-Wunsch 2026-10-18).
let txAllowed = true;
const AMP_STATE_OFF = {
  ampPort: "",
  ampSavedPort: "",
  ampAuto: false,
  ampTxTimeout: 0,
  ampOn: false,
  ampOperate: false,
  ampTX: false,
  ampLevel: "",
  ampWarning: "",
  ampAlarm: "",
  ampTuning: false,
  ampModel: "",
  ampPowerW: 0,
  ampSWR: 0,
};
function applyState(state) {
  revealMain();
  if (!paAllowed) state = { ...state, ...AMP_STATE_OFF };
  updateTxMsgOverlay(state);
  // While powering on, the radio is treated as still off (the connection is
  // redialed once after it came up) — no "RADIO OFF", no half-working UI.
  // forceRadioOffDisplay: the shutdown animation's 900ms are up (see
  // playShutdownAnimation) — show the real "off" look even if the server
  // hasn't actually confirmed the disconnect yet (TS890 ausschalten/Trennen
  // can still take a few more seconds).
  const radioOff = !state.connected || state.radioStandby || powerOnPending || forceRadioOffDisplay;
  if (radioOff) {
    // Radio off / not connected: clear the live radio values instead of
    // showing the last reading. Mode/band/filter included (Nutzer-Wunsch,
    // 2026-10-14: "die Frequenzanzeigen und Dropdowns darunter sollen ---
    // zeigen") — modeDropdown/bandDropdown/filterDropdown.setCurrent all
    // already fall back to "--" for an empty value on their own.
    state = {
      ...state,
      sMeter: 0,
      swrMeter: 0,
      tx: false,
      busy: false,
      tuning: false,
      vfoAHz: 0,
      vfoBHz: 0,
      mode: "",
      band: "",
      ifFilter: "",
    };
  }
  applyAmpState(state);
  syncJitterBuffer(state);
  syncVoipLevels(state);
  lastState = state;
  watchInfoExpiry();
  watchRxLostExpiry(state);
  const statusText = statusMessageFor(state);
  setStatusText(statusText);
  // Same text, same on/off timing as the status line above, mirrored onto the
  // lock-screen "now playing" album field (Nutzer-Wunsch, 2026-10-12).
  if (window.hamrcSetStatusAlbum && statusText !== lastNowPlayingAlbum) {
    lastNowPlayingAlbum = statusText;
    window.hamrcSetStatusAlbum(statusText);
  }
  setStatusClass("radio-off", statusText === RADIO_OFF_MESSAGE);
  // Highlighted only for actual errors/alarms (⚠ PA: .../⚠ TS890: ...) —
  // plain PA status/info text (e.g. "PA ON - standby...", "PA - STANDBY")
  // used to get the same orange treatment via a broader "PA "/"SPE " prefix
  // match, which the operator found overdone for routine status (2026-10-12:
  // "Pa status messages normal darstellen, ausser ERRORs die sollen
  // hervorgehoben bleiben").
  setStatusClass("pa-warning", /^⚠ (PA|TS890):/.test(statusText));
  syncScopeRate(state.scopeRate);
  if (state.scopeSpanHz && document.activeElement !== scopeSpanSelect) {
    scopeSpanSelect.value = String(state.scopeSpanHz);
  }
  updateConnectToggle(state.connected);

  // The server broadcasts the full state on every change, including the
  // S-meter (which updates several times a second even when idle). Only
  // rebuild the frequency digits when the frequency itself actually moved,
  // otherwise the constant DOM replacement makes the digit under the mouse
  // flicker in and out of its hover state.
  const newHz = state.activeReceiver === "B" ? state.vfoBHz : state.vfoAHz;
  applyVfoIndicator(state.activeReceiver === "B" ? "B" : "A");
  applyVfoOtherFreq(state);
  setControlsDisabled(radioOff);
  // The keypad lives inside .waterfall-wrap (index.html), which is
  // deliberately exempt from both the inert-dim above and the
  // playShutdownAnimation dim-and-stay (see setControlsDisabled's own
  // comment) so it can show its own fully-visible "Spektrum aus" end
  // state. Bug (Nutzer-Report, 2026-10-21): if the keypad happened to be
  // showing (spectrum off, analog off) when the radio went off, it rode
  // along with the wrap's opacity — faded out with it during the
  // animation, then popped back to full visibility, fully clickable, the
  // moment finishShutdownFade snapped the wrap's opacity back to 1,
  // because nothing had ever set `hidden` on it. Entering a frequency
  // makes no sense with the radio off anyway (same reasoning as the
  // frequency digits going to "OFF" and the dropdowns to "--" above), so
  // it is force-hidden here independently of the wrap's own opacity —
  // recomputed every call (not just when radioOff just became true) so it
  // also correctly un-hides again on reconnect, same formula
  // setScopeControlsAvailable already uses for the non-off case.
  freqKeypad.hidden = radioOff || !scopeRateOff || analogOn;
  // Power button: red while the radio is off (also while powering on), the
  // usual active color once it's on.
  powerButton.classList.toggle("power-off", radioOff);
  powerButton.classList.toggle("power-on", !radioOff);
  if (window.hamrcSetWaterfallRadioOff) window.hamrcSetWaterfallRadioOff(radioOff);
  // The radio actually going off/disconnected (TS890 ausschalten, Trennen)
  // is what clears the waterfall and shows "Spektrum aus" — finishShutdownFade
  // is a no-op unless a shutdown fade is actually in progress, see its own
  // comment for why this has to be the moment the fade class comes off.
  if (radioOff) finishShutdownFade();
  if (state.connected !== prevConnected) {
    const was = prevConnected;
    prevConnected = state.connected;
    // Not on the very first state of a page load while disconnected.
    if (was !== null || state.connected) onConnectedChange(state.connected);
  }
  if (radioOff) {
    // No radio connection (e.g. switched off): show "RADIO OFF" instead of
    // a stale frequency; a neutral placeholder while powering on.
    // "OFF" sits on the three kHz digits (middle group, Nutzer-Wunsch
    // 2026-10-14 \u2014 was on the Hz digits before), the rest stays blank.
    const text = powerOnPending ? "--.---.---" : "\u00a0\u00a0.OFF.\u00a0\u00a0\u00a0";
    if (freqShowsOff !== text) {
      freqShowsOff = text;
      freqEl.classList.add("radio-off");
      // Same markup as the real digits (digit spans with the separators
      // between them), so it looks exactly like a frequency: __.OFF.___
      freqEl.innerHTML = "";
      for (const ch of text) {
        const span = document.createElement("span");
        span.textContent = ch;
        span.className = ch === "." ? "sep" : "digit";
        if (ch !== ".") span.style.cursor = "default";
        // OFF message: keep the separators' width (OFF stays on the kHz digits) but hide the dots.
        if (ch === "." && !powerOnPending) span.style.visibility = "hidden";
        freqEl.appendChild(span);
      }
    }
  } else {
    if (freqShowsOff) {
      freqShowsOff = false;
      freqEl.classList.remove("radio-off");
      currentHz = -1; // force the digits to be rebuilt below
    }
    if (pendingHz !== null) {
      if (newHz === pendingHz || performance.now() - pendingSince > PENDING_TIMEOUT_MS) {
        pendingHz = null;
      }
    }
    // RX: VFO + RIT offset; TX: VFO + XIT offset (one shared offset value).
    const txOffset = (state.tx ? state.xitOn : state.ritOn) ? state.ritOffsetHz || 0 : 0;
    const offsetChanged = txOffset !== freqTxOffsetHz;
    freqTxOffsetHz = txOffset;
    if (pendingHz === null && (newHz !== currentHz || offsetChanged)) {
      currentHz = newHz;
      renderFreq(currentHz);
    }
  }

  if (window.hamrcSetNowPlaying && state.mode) {
    // Nutzer-Wunsch, 2026-09-29: Frequenz+Mode jetzt zusammen als Titel
    // ("7.134 MHz CW"); Artist-Zeile zeigt stattdessen Filter+Breite
    // ("FILA 3kHz") — audio.js hängt daran noch den Stream-Typ (PCM/OPUS) an,
    // da nur audio.js weiss, welcher Codec gerade aktiv ist.
    const title = `${(currentHz / 1e6).toFixed(3)} MHz ${state.mode}`;
    const filterLabel = { A: "FIL1", B: "FIL2", C: "FIL3" }[state.ifFilter] || "";
    const widthText = state.audioWidthHz ? formatKHzCompact(state.audioWidthHz) : "";
    const artist = filterLabel && widthText ? `${filterLabel} ${widthText}` : filterLabel;
    // Same NR/AI-NR derivation as nrCycle's own display sync further below —
    // empty when neither is active, so it's simply left out (Nutzer-Wunsch,
    // 2026-10-07: no NR mode shown at all when NR is off).
    const nrLabel =
      state.nr === 0 && window.hamrcGetRNNoise && window.hamrcGetRNNoise()
        ? "AI NR"
        : state.nr === 1
          ? "NR1"
          : state.nr === 2
            ? "NR2"
            : "";
    // applyState runs on every broadcast, including the S-meter (several
    // times a second even when idle) — calling hamrcSetNowPlaying that often
    // rebuilds the OS MediaMetadata every time, which some Now Playing
    // displays (e.g. a car head unit) show as a brief flicker/refresh even
    // when the text is identical. Only call it when the text actually
    // changed (Nutzer-Wunsch, 2026-09-29).
    if (title !== lastNowPlayingTitle || artist !== lastNowPlayingArtist || nrLabel !== lastNowPlayingNR) {
      lastNowPlayingTitle = title;
      lastNowPlayingArtist = artist;
      lastNowPlayingNR = nrLabel;
      window.hamrcSetNowPlaying(title, artist, nrLabel);
    }
  }

  // The scope is centred on the RX line (VFO + RIT) while receiving and on the TX line
  // (VFO + XIT) while transmitting, like the radio's own display. R/T markers are
  // placed relative to that centre.
  const scopeOff = !radioOff ? freqTxOffsetHz : 0;
  const markOff = state.ritOffsetHz || 0;
  // As soon as RIT or XIT is on, show BOTH markers: R at VFO (+ RIT offset if RIT on),
  // T at VFO (+ XIT offset if XIT on), so e.g. RIT alone still shows where we transmit.
  const showRT = (state.ritOn || state.xitOn) && !radioOff;
  if (window.hamrcSetWaterfallRIT) window.hamrcSetWaterfallRIT(showRT ? (state.ritOn ? markOff : 0) - scopeOff : null);
  if (window.hamrcSetWaterfallXIT) window.hamrcSetWaterfallXIT(showRT ? (state.xitOn ? markOff : 0) - scopeOff : null);
  if (window.hamrcSetWaterfallVFO && state.scopeSpanHz) {
    window.hamrcSetWaterfallVFO(currentHz + scopeOff, state.scopeSpanHz, (state.activeReceiver === "B" ? state.vfoBHz : state.vfoAHz) + scopeOff);
  }

  modeDropdown.setCurrent(state.mode);
  bandDropdown.setCurrent(state.band);
  filterDropdown.setCurrent(state.ifFilter);
  roofingGroup.setActive([state.ifFilter]);
  if (!filterSettingsOverlay.hidden && !filterWidthDragging) {
    refreshFilterSettingsOverlay();
  }
  updateAudioFilterInfo(state);
  for (const el of busyIndicators) {
    el.classList.toggle("tx", state.tx);
    el.classList.toggle("busy", !state.tx && state.busy);
  }

  // Mic capture/streaming is driven off the CONFIRMED tx state, not the
  // click itself: that way it only ever runs while the radio has actually
  // acknowledged transmitting (never fires uselessly if setTX failed, e.g.
  // no radio connected), and also stops correctly if TX ends any other way
  // (radio's own TOT timeout, another client, a dropped connection).
  // Nutzer-Report, 2026-09-29: TUNE also asked for mic access and, after a
  // couple of tune cycles, threw an AudioWorkletNode error — the radio
  // really does key the transmitter for a tune cycle, so state.tx goes true
  // then, exactly like a real PTT, even though tuning uses the radio's own
  // internal test signal and never touches mic audio at all. state.tuning
  // alone wasn't a reliable exclusion (see tuneSuppressMic above for why) —
  // combined with it here as an extra safety net for a tune cycle started
  // from the radio's own front panel, which tuneSuppressMic can't know about.
  if (tuneSuppressMic) {
    if (state.tx) {
      tuneSuppressSeenTxHigh = true;
    } else if (tuneSuppressSeenTxHigh || performance.now() >= tuneSuppressDeadline) {
      // Either the tune cycle's own TX pulse has actually ended (radio is
      // receiving again — Nutzer-Wunsch, 2026-09-29: lift the suppression
      // right then, not after a guessed fixed delay), or the safety cap
      // above was hit without ever seeing that pulse at all.
      tuneSuppressMic = false;
    }
  }
  // CW needs no microphone: TX is keyed over CAT, so no mic access, no TX audio path, and
  // RX stays audible (fast keying matters there; Nutzer-Wunsch 2026-10-10)
  if (myTX) {
    if (state.tx) myTXSeenHigh = true;
    else if (myTXSeenHigh || performance.now() >= myTXDeadline) myTX = false;
  }
  // stop streaming for a recording once the radio reports it ended (or never
  // started within 5 s, e.g. refused with "?")
  if (txMsgRecMic) {
    // op 2 = recording (1 = ready, which is reported before the start)
    if (state.voiceMsgRecOp === 2) txMsgRecSeenActive = true;
    else if (txMsgRecSeenActive || performance.now() >= txMsgRecDeadline) txMsgRecMic = false;
  }
  const micShouldStream = micWantedNow(state);
  if (micShouldStream !== currentMicStreaming && window.hamrcSetMicStreaming) {
    window.hamrcSetMicStreaming(micShouldStream);
  }
  currentMicStreaming = micShouldStream;
  // Someone ELSE transmitting (state.tx true, but not via this client's own
  // myTX) is exactly when the audio on /audio-ws is their relayed mic audio
  // rather than real RX (the server skips real RX broadcast during TX, see
  // onPCM in main.go) — tells audio.js's pushSamples to use the separate
  // "TX anderer Clients mithören" volume instead of the normal AF gain
  // for just that audio (Nutzer-Wunsch, 2026-10-15).
  if (window.hamrcSetRemoteTxActive) window.hamrcSetRemoteTxActive(state.tx && !myTX);
  currentTX = state.tx;
  paintTxButton();
  syncAscopeStream();
  scheduleAscope();

  atCycle.setCurrent(state.tunerOn);
  tuneButton.classList.toggle("active", state.tuning);

  if (performance.now() < shutdownAnimationUntil) {
    // Mid shutdown animation (see playShutdownAnimation): the connection can
    // still be up for a few more seconds (TS890 ausschalten/Trennen), so
    // real broadcasts keep arriving — pin the meter to 0 instead of letting
    // one of them put a live reading back on the needle mid-animation.
    meterTarget.s = 0;
    meterTarget.swr = 0;
    meterTarget.alc = 0;
    meterTarget.id = 0;
  } else {
    const meters = meterValues(state);
    meterTarget.s = Number(meters.s) || 0; // never NaN: it would stick in the smoothing
    meterTarget.swr = Number(meters.swr) || 0;
    meterTarget.alc = Number(state.alcMeter) || 0;
    meterTarget.id = Number(state.idMeter) || 0;
  }

  agcCycle.setCurrent(state.agc);
  // No AGC in FM, and while the radio has not reported one at all (it stays
  // silent about it in some modes): keep the key, greyed out and unusable,
  // instead of an empty label.
  const agcButton = document.getElementById("agc-button");
  const agcAvailable = !!state.agc && state.mode !== "FM" && state.mode !== "FM-D";
  // RF gain does not apply in FM/FM-D (assumed radio behaviour): grey out + inert.
  const rfAvailable = state.mode !== "FM" && state.mode !== "FM-D";
  const rfSliderEl = document.getElementById("rf-slider");
  rfSliderEl.disabled = !rfAvailable;
  rfSliderEl.closest(".ctrl-row").classList.toggle("unavailable", !rfAvailable);
  agcButton.disabled = !agcAvailable;
  if (!agcAvailable) {
    agcButton.textContent = "AGC";
    agcButton.classList.remove("active");
  }
  // FM has only NR1 on the radio: cycle OFF -> NR1 -> AI NR (client-side
  // RNNoise works in any mode), never NR2.
  nrCycle.setAllowed(state.mode === "FM" || state.mode === "FM-D" ? [0, 1, "ai"] : null);
  // The radio never reports our client-side RNNoise flag, so "AI NR" has to
  // be derived here: radio NR off AND RNNoise on. If the radio's own NR got
  // switched to 1/2 some other way (front panel, another client) while AI NR
  // was active, force RNNoise back off instead of leaving both "running" at
  // once with the button unable to show that — keeps the four states
  // genuinely mutually exclusive regardless of how radio NR changed.
  if (state.nr === 0) aiNrPendingUntil = 0;
  const aiPending = performance.now() < aiNrPendingUntil;
  if (state.nr !== 0 && !aiPending && window.hamrcGetRNNoise && window.hamrcGetRNNoise()) {
    window.hamrcSetRNNoise(false);
  }
  const nrDisplay =
    (state.nr === 0 || aiPending) && window.hamrcGetRNNoise && window.hamrcGetRNNoise() ? "ai" : state.nr;
  nrCycle.setCurrent(nrDisplay);
  bcCycle.setCurrent(state.bc);
  // the label never changes (the LED shows on/off, the width is shown in the audio scope)
  nchButton.textContent = "NOTCH";
  const notchOk = notchAvailable(state.mode);
  nchButton.disabled = !notchOk;
  notchSlider.disabled = !(notchOk && state.notchOn);
  nchButton.classList.toggle("active", !!state.notchOn && notchOk);
  if (!notchDragging) notchSlider.value = String(state.notchPos);
  attCycle.setCurrent(state.att);
  preCycle.setCurrent(state.pre);

  currentNB1 = state.nb1;
  currentNB2 = state.nb2;
  nbGroup.setActive([...(state.nb1 ? ["1"] : []), ...(state.nb2 ? ["2"] : [])]);

  currentProc = state.proc;
  procCycle.setCurrent(state.proc);
  // Adjusting PROC's levels/mode makes no sense while PROC itself is off —
  // invisible via CSS (.proc-off), not the hidden attribute, so the row
  // keeps its height (see that rule's own comment for why).
  document.querySelector(".mic-proc-row").classList.toggle("proc-off", !state.proc);
  if (!procSettingsOverlay.hidden && !filterWidthDragging) {
    refreshProcSettingsOverlay();
  }

  antCycle.setCurrent(state.ant);
  applyEqState(state);
  applyTxMonState(state);
  applyRitState(state);
  applyXitState(state);
  if (nbOverlayKind && !filterWidthDragging) refreshNbOverlay();
  if (nrOverlayOpen && !filterWidthDragging) refreshNrOverlay();

  if (radioOff) {
    // Off (or still shutting down). While an active shutdown tween is
    // running (playShutdownAnimation, triggered by the power-off/disconnect
    // buttons), leave it alone — any broadcast that still arrives meanwhile
    // (the connection can stay up a few more seconds for TS890
    // ausschalten/Trennen, and the server never clears rfGain/squelch/power
    // to 0 on disconnect) would otherwise fall through to the plain
    // instant-apply below and snap the slider back to that stale real value
    // mid-animation (Nutzer-Report, 2026-10-15: "fahren erst auf
    // Nullstellung, springen dann aber wieder auf einen Wert").
    //
    // Outside that window — a fresh page load that never connected, or the
    // radio dropping off some other way than our own buttons (front-panel
    // power off, network loss) — playShutdownAnimation was never called, so
    // nothing has driven these to minimum yet; do that here instead
    // (idempotent: a no-op once they're already there), so AF/RF/SQL/PWR
    // read "off" even without ever having gone through a user-triggered
    // shutdown (Nutzer-Wunsch, 2026-10-15: "AF Regler sollte auch auf
    // Nullstellung fahren wenn OFF oder keine Verbindung besteht").
    if (performance.now() >= shutdownAnimationUntil) {
      rfSlider.applyValue(Number(document.getElementById("rf-slider").min));
      sqlSlider.applyValue(Number(document.getElementById("sql-slider").min));
      pwrSlider.applyValue(Number(document.getElementById("pwr-slider").min));
      if (window.hamrcSetAFVolumeDisplay) {
        window.hamrcSetAFVolumeDisplay(Number(document.getElementById("af-slider").min));
      }
    }
  } else if (state.connected && performance.now() < sliderReconnectAnimationUntil) {
    // Within the window after a reconnect (power-on, or any other reconnect)
    // — drive the sliders smoothly toward this broadcast's values instead of
    // snapping, mirroring playShutdownAnimation. tweenSliderTo cancels any
    // tween already running on the same element before starting the new
    // one, so if an earlier broadcast in this window still had a stale/zero
    // rfGain/squelch/power (the radio hadn't reported yet), a later,
    // corrected broadcast just smoothly retargets instead of causing a
    // visible double-motion. Once the window closes, back to the plain
    // instant apply below, same as always (a live radio-side change should
    // show immediately, not lag behind a tween).
    tweenSliderTo(rfSlider, document.getElementById("rf-slider"), state.rfGain, SHUTDOWN_ANIM_MS);
    tweenSliderTo(sqlSlider, document.getElementById("sql-slider"), state.squelch, SHUTDOWN_ANIM_MS);
    tweenSliderTo(pwrSlider, document.getElementById("pwr-slider"), state.power, SHUTDOWN_ANIM_MS);
    if (window.hamrcSetAFVolumeDisplay && window.hamrcGetAFVolumeDisplay) {
      tweenSliderTo(
        { applyValue: window.hamrcSetAFVolumeDisplay },
        document.getElementById("af-slider"),
        window.hamrcGetAFVolumeDisplay(),
        SHUTDOWN_ANIM_MS
      );
    }
  } else {
    rfSlider.applyValue(state.rfGain);
    sqlSlider.applyValue(state.squelch);
    pwrSlider.applyValue(state.power);
  }
}

buildSegmentMask("segMask");
buildSegmentMask("segMaskSwr");
buildSegmentMask("segMaskAlc");
for (const btn of document.querySelectorAll(".meter-mode-btn")) {
  btn.classList.toggle("active", btn.dataset.mode === analogMeterMode);
  btn.addEventListener("click", () => setAnalogMeterMode(btn.dataset.mode));
}
updateAnalogNeedle(0);
requestAnimationFrame(animateAnalogNeedle);

function connect() {
  if (sessionEnded) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onclose = () => {
    if (sessionEnded) return;
    setStatusText("Keine Verbindung zum Web-Server...");
    // a session that ran out (or a server restart) shows as a refused WebSocket:
    // ask a protected URL whether that is a login problem before just retrying
    setTimeout(async () => {
      try {
        const r = await fetch("/serial-ports", { cache: "no-store" });
        if (r.status === 401) {
          showLogin();
          return;
        }
      } catch (e) {
        // server not reachable: plain retry below
      }
      connect();
    }, 2000);
  };

  ws.onerror = () => ws.close();

  // The server only asks the radio for ALC readings while a browser has the
  // ALC mode selected, so (re)announce the stored mode on every connect.
  ws.onopen = () => {
    ascopeWanted = false; // the server forgets a client's scope request when its WebSocket goes away
    send({ type: "setMeterMode", mode: analogMeterMode });
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "pong") {
      // Latency probe every 2s: not counted as traffic (it made the kB/s
      // readout flash "1 kB/s" with the radio off, since it rounds up).
      window.hamrcOnPong(data.t);
      return;
    }
    window.hamrcReportTraffic(event.data.length, "ctrl"); // text frame — length is close enough to bytes (JSON is ASCII) for this rough readout
    if (data.type === "powerOk") {
      setPowerOnPending(false);
      return;
    }
    if (data.type === "powerError") {
      setPowerOnPending(false);
      window.alert(`Power: ${data.message}`);
      return;
    }
    if (data.type === "connectError") {
      setConnectStatus(data.message, true);
      return;
    }
    if (data.type === "ampCmdError") {
      clearTimeout(paOffWatchTimer);
      if (paInfoMessage === PA_OFF_MESSAGE) paInfoMessage = "";
      showPaCmdError(data.message);
      return;
    }
    if (data.type === "ampError") {
      setAmpStatus(data.message, true);
      return;
    }
    if (data.type === "ampOk") {
      setAmpStatus(ampDisconnecting ? "getrennt" : "verbunden", false);
      return;
    }
    if (data.type === "connectOk") {
      // Stays open (Nutzer-Wunsch, 2026-10-14, same request as the Trennen
      // button above: the dialog used to close itself here, which was the
      // other half of "closes and I see the Radio OFF screen behind it" —
      // closing happened on BOTH the disconnect click and here, on a
      // successful reconnect). Toggle/status just reflect the new state
      // directly instead of waiting for the next broadcast to arrive.
      if (lastState) lastState.connected = true;
      updateConnectToggle(true);
      setConnectStatus("Verbunden.", false);
      return;
    }
    if (data.type === "clientId") {
      myClientId = data.id;
      renderClientList();
      return;
    }
    if (data.type === "clients") {
      clientList = data.list || [];
      renderClientList();
      chatUpdateOnline();
      return;
    }
    if (data.type === "chatCleared") {
      chatLogEl.textContent = ""; // chatLastSeq stays: numbering goes on
      return;
    }
    if (data.type === "chatDeleted") {
      chatRemove(data.seq);
      return;
    }
    if (data.type === "chatConfig") {
      chatApplyEnabled(!!data.enabled);
      return;
    }
    if (data.type === "chatHistory") {
      chatHistory(data.list || []);
      return;
    }
    if (data.type === "chat") {
      chatAdd(data);
      return;
    }
    if (data.type === "clientConnected") {
      // another browser opened the page: short notice in the status line
      showClientInfo(
        data.user
          ? `Login ${data.user}${data.name ? ` / ${data.name}` : ""} von ${data.ip}${data.host ? ` (${data.host})` : ""}`
          : `Client von ${data.ip}${data.host ? ` (${data.host})` : ""} connected`
      );
      return;
    }
    // The radio state snapshot has no "type"; any other typed message this script does not know (a newer server than
    // this page, e.g. before a reload) must not be applied as state: that blanked the UI ("OFF", black) for a moment.
    if (data.type) return;
    applyState(data);
  };
}

// ---- Chat (desktop only; chat.go) ---------------------------------------
// Messages and "NAME hat sich verbunden" lines come from the server (name always set there). The history is sent on
// every (re)connect, entries carry a sequence number so a line that arrives both ways is shown once.
const chatEl = document.getElementById("chat");
const chatPill = document.getElementById("chat-pill");
const chatPanel = document.getElementById("chat-panel");
const chatLogEl = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatCountEl = document.getElementById("chat-count");
const chatOnlineEl = document.getElementById("chat-online");
const CHAT_POS_KEY = "open890rc.chatPos";
let chatAdmin = false; // set by applyAdminUi: admins can delete lines
let chatLastSeq = 0;
let chatEnabledByServer = true; // an admin can switch the chat off for everybody ("chatConfig" from the server)
// Desktop: open whenever the chat is on. Phone: closed until a message from somebody else comes in or the CHAT key is
// pressed (the chat then replaces the whole waterfall area). Minimising lasts only until the next message.
const chatPhoneMQ = window.matchMedia("(max-width: 799px)");
let chatOpen = !chatPhoneMQ.matches;

function chatRender(e) {
  const line = document.createElement("div");
  line.className = `chat-line ${e.kind}`;
  line.dataset.seq = e.seq;
  // admins get a small x on hover to delete the line (hidden for everybody else, see .chat-log.admin)
  const del = document.createElement("button");
  del.type = "button";
  del.className = "chat-del";
  del.title = "Nachricht löschen";
  del.textContent = "\u00d7";
  del.addEventListener("click", () => send({ type: "chatDelete", seq: e.seq }));
  line.appendChild(del);
  const t = document.createElement("span");
  t.className = "chat-time";
  // date and time always at the very front, in the browser's own short formats ("03.11.26 20:22" in German,
  // "11/3/26 8:22 PM" in US English), joined by a blank instead of the comma the combined format would put in
  const d = new Date(e.t);
  t.textContent = `${d.toLocaleDateString(undefined, { dateStyle: "short" })} ${d.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
  line.appendChild(t);
  if (e.kind === "join" || e.kind === "leave") {
    line.appendChild(document.createTextNode(`${e.name} ${e.kind === "join" ? "hat sich verbunden" : "hat die Station verlassen"}`));
  } else {
    const n = document.createElement("span");
    n.className = "chat-name";
    n.textContent = e.name;
    line.appendChild(n);
    line.appendChild(document.createTextNode(e.text)); // text node: no HTML from other users
  }
  chatLogEl.appendChild(line);
  while (chatLogEl.childElementCount > 100) chatLogEl.firstElementChild.remove();
}
function chatApplyAdmin(isAdmin) {
  chatAdmin = !!isAdmin;
  chatLogEl.classList.toggle("admin", chatAdmin);
  document.getElementById("chat-clear").hidden = !chatAdmin; // admins only
}
function chatRemove(seq) {
  const line = chatLogEl.querySelector(`.chat-line[data-seq="${seq}"]`);
  if (line) line.remove();
}
// Phone: the Easy Mode window covers the whole page, so a message would stay unseen behind it. Leave it for the chat,
// but never while this phone is transmitting (the big TX key would vanish under the finger and the release would be
// lost): wait until TX is over.
let chatLeaveEasyTimer = 0;
function chatLeaveEasyMode() {
  if (!chatPhoneMQ.matches || !simpleModeOn || chatLeaveEasyTimer) return;
  const tryLeave = () => {
    chatLeaveEasyTimer = 0;
    if (!simpleModeOn) return;
    if (myTX || currentTX) {
      chatLeaveEasyTimer = setTimeout(tryLeave, 400);
      return;
    }
    setSimpleMode(false);
  };
  tryLeave();
}
function chatScrollEnd() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}
function chatHistory(list) {
  chatLogEl.textContent = "";
  chatLastSeq = 0;
  for (const e of list) {
    chatRender(e);
    chatLastSeq = Math.max(chatLastSeq, e.seq);
  }
  chatScrollEnd();
}
function chatAdd(e) {
  if (e.seq <= chatLastSeq) return;
  chatLastSeq = e.seq;
  chatRender(e);
  chatScrollEnd();
  // a minimised chat opens again for a message (not for join lines, those are only informative), so none is overlooked
  if (!chatOpen && e.kind === "msg") {
    // phone: the chat takes the waterfall's place, so SPEC goes off (and comes back when the chat is closed)
    if (chatPhoneMQ.matches && !scopeRateOff) {
      chatSpecRestore = true;
      setScopeOn(false);
    }
    chatOpen = true;
    chatApplyOpen();
  }
  if (e.kind === "msg") chatLeaveEasyMode();
}
// who is online: from the client list the server already sends (see renderClientList)
function chatUpdateOnline() {
  const names = clientList.map((c) => {
    if (c.user) return c.name ? `${c.name} (${c.user})` : c.user;
    if (c.host) return c.host.split(".")[0];
    return c.ip;
  });
  chatCountEl.textContent = names.length ? `· ${names.length}` : "";
  chatOnlineEl.textContent = names.join(", ");
  chatOnlineEl.title = names.join(", ");
}
function chatApplyEnabled(enabled) {
  chatEnabledByServer = enabled;
  chatEl.hidden = !enabled; // beats the CSS display of .chat
  document.getElementById("chat-mode-group").hidden = !enabled;
  const box = document.getElementById("chat-enabled");
  if (box) box.checked = enabled;
}
function chatApplyOpen() {
  chatPanel.hidden = !chatOpen;
  if (!chatOpen && document.activeElement === chatInput) chatInput.blur();
  chatPill.hidden = chatOpen;
  chatEl.classList.toggle("chat-closed", chatPhoneMQ.matches && !chatOpen); // phone: nothing left over the waterfall
  document.getElementById("chat-mode-button").classList.toggle("active", chatOpen);
  if (chatOpen) {
    chatScrollEnd();
    chatClamp();
  }
}
// keep the chat inside the waterfall area (window resized, panel opened near the edge)
function chatClamp() {
  if (chatPhoneMQ.matches) return; // phone: the chat fills the area
  const wrap = chatEl.parentElement;
  if (!chatEl.style.left) return;
  const maxX = Math.max(0, wrap.clientWidth - chatEl.offsetWidth);
  const maxY = Math.max(0, wrap.clientHeight - chatEl.offsetHeight);
  chatEl.style.left = `${Math.min(maxX, Math.max(0, parseFloat(chatEl.style.left)))}px`;
  chatEl.style.top = `${Math.min(maxY, Math.max(0, parseFloat(chatEl.style.top)))}px`;
}
function chatPlace(x, y) {
  chatEl.style.left = `${x}px`;
  chatEl.style.top = `${y}px`;
  chatEl.style.bottom = "auto";
  chatClamp();
}
try {
  const p = JSON.parse(localStorage.getItem(CHAT_POS_KEY) || "null");
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) chatPlace(p.x, p.y);
} catch (e) {}
// drag by the pill or the panel header (not by its buttons/input); a click without moving opens/closes
function chatDragHandle(el, onClick) {
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  let moved = false;
  let down = false;
  el.addEventListener("pointerdown", (e) => {
    if (chatPhoneMQ.matches || e.target.closest(".chat-min, .chat-clear")) return;
    down = true;
    moved = false;
    sx = e.clientX;
    sy = e.clientY;
    const r = chatEl.getBoundingClientRect();
    const w = chatEl.parentElement.getBoundingClientRect();
    ox = r.left - w.left;
    oy = r.top - w.top;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
    moved = true;
    chatPlace(ox + e.clientX - sx, oy + e.clientY - sy);
  });
  el.addEventListener("pointerup", () => {
    if (!down) return;
    down = false;
    if (moved) {
      try {
        localStorage.setItem(CHAT_POS_KEY, JSON.stringify({ x: parseFloat(chatEl.style.left), y: parseFloat(chatEl.style.top) }));
      } catch (e) {}
    } else if (onClick) {
      onClick();
    }
  });
}
chatDragHandle(chatPill, () => {
  chatOpen = true;
  chatApplyOpen();
  chatInput.focus({ preventScroll: true });
});
chatDragHandle(document.getElementById("chat-head"), null);
chatPill.addEventListener("click", (e) => {
  if (e.detail !== 0) return; // a real mouse click is handled by the drag handle; this is Enter/Space on the focused pill
  chatOpen = true;
  chatApplyOpen();
  chatInput.focus({ preventScroll: true });
});
document.getElementById("chat-clear").addEventListener("click", async () => {
  if (await showConfirmDialog("Gesamten Chat für alle löschen?", "Löschen")) send({ type: "chatClear" });
});
// Closing the chat. On the phone, SPEC comes back if the chat itself had switched it off.
let chatSpecRestore = false;
function chatLeave() {
  chatOpen = false;
  chatApplyOpen();
  if (chatPhoneMQ.matches && chatSpecRestore) {
    chatSpecRestore = false;
    if (scopeRateOff) setScopeOn(true);
  }
}
document.getElementById("chat-min").addEventListener("click", chatLeave);
document.getElementById("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatInput.value = "";
});
// Phone (iOS Safari): a focused input gets the browser's own bar above the keyboard with up/down arrows (jump to the
// previous/next form field of the page) and a check mark. The arrows only have somewhere to go if the page has other
// form fields, so while the chat input has focus the rest of the page is made inert (only what we marked ourselves is
// released again, anything that was inert before stays so). The bar itself cannot be hidden.
let chatInertMarked = [];
function chatFocusMode(on) {
  for (const el of chatInertMarked) el.inert = false;
  chatInertMarked = [];
  if (!on || !chatPhoneMQ.matches) return;
  for (let el = chatEl; el && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (sib === el || sib.inert || sib.tagName === "SCRIPT") continue;
      sib.inert = true;
      chatInertMarked.push(sib);
    }
  }
}
chatInput.addEventListener("focus", () => chatFocusMode(true));
chatInput.addEventListener("blur", () => chatFocusMode(false));
chatInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // typing must not trigger shortcuts
  if (e.key === "Escape") chatInput.blur();
});
const CHAT_SIZE_KEY = "open890rc.chatSize";
try {
  const sz = JSON.parse(localStorage.getItem(CHAT_SIZE_KEY) || "null");
  if (sz && Number.isFinite(sz.w) && Number.isFinite(sz.h)) {
    chatPanel.style.width = `${sz.w}px`;
    chatPanel.style.height = `${sz.h}px`;
  }
} catch (e) {}
// the browser's resize handle (bottom right corner of the panel) sets inline width/height; remember them, keep the
// panel inside the waterfall and the newest line in view
let chatSizeTimer = 0;
new ResizeObserver(() => {
  if (chatPanel.hidden || chatPhoneMQ.matches) return;
  chatClamp();
  clearTimeout(chatSizeTimer);
  chatSizeTimer = setTimeout(() => {
    if (!chatPanel.style.width && !chatPanel.style.height) return; // never resized by the user
    try {
      localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({ w: chatPanel.offsetWidth, h: chatPanel.offsetHeight }));
    } catch (e) {}
    chatScrollEnd();
  }, 300);
}).observe(chatPanel);
window.addEventListener("resize", chatClamp);
// CHAT key (phone, next to EASY MODE): shows/hides the chat in place of the waterfall
document.getElementById("chat-mode-button").addEventListener("click", () => {
  if (chatOpen) {
    chatLeave();
    return;
  }
  chatOpen = true;
  chatApplyOpen();
});
// rotating/resizing across the phone/desktop breakpoint: back to that layout's starting state
chatPhoneMQ.addEventListener("change", (e) => {
  chatSpecRestore = false;
  chatOpen = !e.matches;
  chatApplyOpen();
});
// focusing the input must not scroll the (overflow:hidden) waterfall area underneath, which would shift the canvases
chatEl.parentElement.addEventListener("scroll", () => {
  const w = chatEl.parentElement;
  if (w.scrollTop || w.scrollLeft) {
    w.scrollTop = 0;
    w.scrollLeft = 0;
  }
});
chatApplyOpen();

// ---- Access control ------------------------------------------------------
// Browsers on the local network need no login and are admins (USER button for the
// user management); everybody else gets the login mask first (shown on every
// visit, prefilled by the browser's password manager / the remembered user name)
// and the page only connects to the server after a successful login.
const loginOverlay = document.getElementById("login-overlay");
const loginForm = document.getElementById("login-form");
const loginUserInput = document.getElementById("login-user");
const loginPassInput = document.getElementById("login-pass");
const loginStatus = document.getElementById("login-status");
const loginSubmit = document.getElementById("login-submit");
const LOGIN_USER_KEY = "open890rc.loginUser";
let loginActive = false;

function showLogin() {
  if (loginActive) return;
  loginActive = true;
  try {
    loginUserInput.value = localStorage.getItem(LOGIN_USER_KEY) || loginUserInput.value;
  } catch (e) {}
  loginStatus.textContent = "";
  loginOverlay.hidden = false;
  (loginUserInput.value ? loginPassInput : loginUserInput).focus();
}
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginSubmit.disabled = true;
  loginStatus.classList.remove("error");
  loginStatus.textContent = "Anmelden …";
  try {
    const r = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: loginUserInput.value.trim(), pass: loginPassInput.value }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      try {
        localStorage.setItem(LOGIN_USER_KEY, loginUserInput.value.trim());
      } catch (err) {}
      loginOverlay.hidden = true;
      loginActive = false;
      loginPassInput.value = "";
      // the admin flag only counts after the login: ask again
      try {
        const st = await (await fetch("/auth/status", { cache: "no-store" })).json();
        applyAdminUi(st.admin, st.pa, st.tx);
      } catch (err) {}
      startWaterfallAfterAuth();
      connect();
    } else {
      loginStatus.classList.add("error");
      loginStatus.textContent = data.retryAfter ? `${data.error} – bitte ${data.retryAfter} s warten` : data.error || "Anmeldung fehlgeschlagen";
    }
  } catch (err) {
    loginStatus.classList.add("error");
    loginStatus.textContent = "Server nicht erreichbar";
  }
  loginSubmit.disabled = false;
});

// Text above the login fields: one line per div, the first one bold. The
// built-in default stays until an admin saves their own message.
const loginIntro = document.getElementById("login-intro");
const DEFAULT_LOGIN_MESSAGE = Array.from(loginIntro.children, (d) => d.textContent).join("\n");
function setLoginIntro(text) {
  loginIntro.replaceChildren(
    ...text.split("\n").map((line) => Object.assign(document.createElement("div"), { textContent: line }))
  );
}

// User management (admin = local network)
const usersList = document.getElementById("users-list");
const usersStatus = document.getElementById("users-status");
const USER_API = "/api/users";
const USER_HEADERS = { "Content-Type": "application/json", "X-Requested-With": "open890rc" };
function setUsersStatus(text, isError) {
  usersStatus.textContent = text;
  usersStatus.classList.toggle("error", !!isError);
}
async function usersCall(method, url, body) {
  const r = await fetch(url, { method, headers: USER_HEADERS, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}
// The list shows login, name and an Admin mark; the edit button opens the
// "edit user" window (LOGIN and NAME, password, admin flag, delete) — and the
// same window with "Neuer Benutzer" for a new one.
async function refreshUsers() {
  try {
    const { users } = await usersCall("GET", USER_API);
    usersList.replaceChildren(
      ...(users.length
        ? users.map((u) => {
            const row = document.createElement("div");
            row.className = "users-row";
            const label = document.createElement("span");
            label.className = "users-name";
            label.textContent = u.name;
            const display = document.createElement("span");
            display.className = "users-display";
            display.textContent = u.displayName || "";
            const admin = document.createElement("span");
            admin.className = "users-admin-mark";
            admin.textContent = [u.tx ? "TX" : "kein TX", u.pa ? "PA" : "", u.admin ? "Admin" : ""].filter(Boolean).join(", ");
            const edit = document.createElement("button");
            edit.type = "button";
            edit.textContent = "Edit";
            edit.title = "Benutzer bearbeiten";
            edit.addEventListener("click", () => openUserEdit(u));
            row.append(label, display, admin, edit);
            return row;
          })
        : [Object.assign(document.createElement("div"), { className: "users-empty", textContent: "Noch kein Benutzer angelegt" })])
    );
  } catch (err) {
    setUsersStatus(err.message, true);
  }
}

const loginMsgInput = document.getElementById("login-msg-input");
const loginMsgStatus = document.getElementById("login-msg-status");
function setLoginMsgStatus(text, isError) {
  loginMsgStatus.textContent = text;
  loginMsgStatus.classList.toggle("error", !!isError);
}
async function loadLoginMessage() {
  try {
    const { message } = await usersCall("GET", "/api/login-message");
    loginMsgInput.value = message || DEFAULT_LOGIN_MESSAGE;
  } catch (err) {
    setUsersStatus(err.message, true);
  }
}
document.getElementById("login-msg-save").addEventListener("click", async () => {
  try {
    const text = loginMsgInput.value.trim();
    await usersCall("POST", "/api/login-message", { message: text === DEFAULT_LOGIN_MESSAGE ? "" : text });
    setLoginMsgStatus("gespeichert", false);
  } catch (err) {
    setLoginMsgStatus(err.message, true);
  }
});
loginMsgInput.addEventListener("input", () => setLoginMsgStatus("", false));
// "Chatfunktion aktivieren": saved at once, the server tells every browser (chatConfig)
document.getElementById("chat-enabled").addEventListener("change", async (e) => {
  try {
    await usersCall("POST", "/api/chat-enabled", { enabled: e.target.checked });
    setLoginMsgStatus("gespeichert", false);
  } catch (err) {
    e.target.checked = !e.target.checked;
    setLoginMsgStatus(err.message, true);
  }
});

const userEditOverlay = document.getElementById("useredit-overlay");
const userEditLogin = document.getElementById("useredit-login");
const userEditName = document.getElementById("useredit-name");
const userEditPass = document.getElementById("useredit-pass");
const userEditAdmin = document.getElementById("useredit-admin");
const userEditPA = document.getElementById("useredit-pa");
const userEditTX = document.getElementById("useredit-tx");
const userEditStatus = document.getElementById("useredit-status");
const userEditDelete = document.getElementById("useredit-delete");
let userEditTarget = null; // null = new user, else the user being edited
function openUserEdit(user) {
  userEditTarget = user || null;
  document.getElementById("useredit-title").textContent = user ? "Benutzer bearbeiten" : "Neuer Benutzer";
  document.getElementById("useredit-pass-hint").textContent = user ? "(leer = unverändert)" : "(mindestens 6 Zeichen)";
  userEditLogin.value = user ? user.name : "";
  userEditName.value = (user && user.displayName) || "";
  userEditPass.value = "";
  userEditAdmin.checked = !!(user && user.admin);
  userEditPA.checked = !!(user && user.pa);
  userEditTX.checked = user ? !!user.tx : true; // new user: TX allowed by default, see hasTX (auth.go)
  userEditDelete.hidden = !user;
  userEditStatus.textContent = "";
  userEditStatus.classList.remove("error");
  userEditOverlay.hidden = false;
  (user ? userEditName : userEditLogin).focus();
}
function closeUserEdit() {
  userEditOverlay.hidden = true;
  userEditPass.value = "";
  userEditTarget = null;
}
function userEditError(message) {
  userEditStatus.textContent = message;
  userEditStatus.classList.add("error");
}
document.getElementById("useredit-cancel").addEventListener("click", closeUserEdit);
userEditOverlay.addEventListener("click", (e) => {
  if (e.target === userEditOverlay) closeUserEdit();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !userEditOverlay.hidden) closeUserEdit();
});
document.getElementById("users-new-button").addEventListener("click", () => openUserEdit(null));
document.getElementById("useredit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const target = userEditTarget;
  const login = userEditLogin.value.trim();
  try {
    await usersCall("POST", USER_API, {
      name: login,
      oldName: target ? target.name : "",
      create: !target,
      displayName: userEditName.value.trim(),
      password: userEditPass.value,
      admin: userEditAdmin.checked,
      pa: userEditPA.checked,
      tx: userEditTX.checked,
    });
    closeUserEdit();
    setUsersStatus(target ? `${login}: gespeichert` : `${login} angelegt`, false);
    refreshUsers();
  } catch (err) {
    userEditError(err.message);
  }
});
userEditDelete.addEventListener("click", async () => {
  const target = userEditTarget;
  if (!target) return;
  if (!(await showConfirmDialog(`Benutzer ${target.name} löschen?`))) return;
  try {
    await usersCall("DELETE", `${USER_API}?name=${encodeURIComponent(target.name)}`);
    closeUserEdit();
    setUsersStatus(`${target.name} gelöscht`, false);
    refreshUsers();
  } catch (err) {
    userEditError(err.message);
  }
});

// Debug tab: the server's log output (same lines as on its console), last 1000.
const debugLogEl = document.getElementById("debug-log");
const debugFilterEl = document.getElementById("debug-filter");
const debugFollowEl = document.getElementById("debug-follow");
const DEBUG_KEEP = 1000;
let debugLines = [];
let debugSocket = null;
function renderDebugLog() {
  const f = debugFilterEl.value.trim().toLowerCase();
  const shown = f ? debugLines.filter((l) => l.toLowerCase().includes(f)) : debugLines;
  debugLogEl.textContent = shown.join("\n");
  if (debugFollowEl.checked) debugLogEl.scrollTop = debugLogEl.scrollHeight;
}
function startDebugLog() {
  if (debugSocket) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/debug-ws`);
  debugSocket = sock;
  sock.onmessage = (e) => {
    const { lines } = JSON.parse(e.data);
    debugLines = debugLines.concat(lines).slice(-DEBUG_KEEP);
    renderDebugLog();
  };
  sock.onclose = () => {
    if (debugSocket === sock) debugSocket = null;
  };
}
function stopDebugLog() {
  if (debugSocket) {
    const s = debugSocket;
    debugSocket = null;
    s.close();
  }
  debugLines = []; // the server sends its kept lines again on the next start
}
debugFilterEl.addEventListener("input", renderDebugLog);
// the filter sits inside the settings form: Enter must not submit (reconnect) it
debugFilterEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

// User management lives in the settings overlay as its own "Benutzer" tab
// (2026-10-12 user request: "die benutzerverwaltung in den settings bereich
// schieben zw PA und Debug"); the standalone top-bar button that used to open
// straight to it was removed right after (2026-10-12, same day: "ich sehe sie
// immer noch rechts neben dem settings button" — it was meant to disappear
// once merged in, not keep sitting next to the gear) — the gear is now the
// only entry point, same as PA/Debug.
// Settings (gear) only for admins: LAN clients and users carrying the admin
// flag (Nutzer-Wunsch 2026-10-11).
function applyAdminUi(isAdmin, hasPa, hasTx) {
  paAllowed = !!hasPa;
  txAllowed = !!hasTx;
  for (const b of txButtons) b.disabled = !txAllowed;
  if (lastState) applyState(lastState);
  setupButton.hidden = !isAdmin;
  chatApplyAdmin(isAdmin);
}
async function initAuth() {
  let status = { loginRequired: false, admin: false };
  try {
    status = await (await fetch("/auth/status", { cache: "no-store" })).json();
  } catch (e) {
    // no answer: behave as before (connect and let the retry logic handle it)
  }
  applyAdminUi(status.admin, status.pa, status.tx);
  if (status.loginMessage) setLoginIntro(status.loginMessage);
  if (status.loginRequired) showLogin();
  else {
    startWaterfallAfterAuth();
    connect();
  }
}
// The spectrum stream (waterfall.js) only starts once the page may talk to the server: it needs the login, too.
function startWaterfallAfterAuth() {
  window.hamrcAuthOk = true;
  if (window.hamrcWaterfallStart) window.hamrcWaterfallStart();
}
initAuth();

// Tabs of the settings overlay.
const overlayTabs = document.querySelectorAll("#connect-overlay .overlay-tab");
function showOverlayTab(name) {
  // The status lines sit below all tabs: each one belongs to its own tab and goes when another is shown
  // (a "verbunden" from the PA tab used to stay at the bottom of every tab, Nutzer-Frage 2026-10-30).
  if (name !== "pa") setAmpStatus("", false);
  if (name !== "net") setConnectStatus("", false);
  for (const t of overlayTabs) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll("#connect-overlay .overlay-tabpanel")) p.hidden = p.dataset.tab !== name;
  // Debug tab: the server's log output, live, only while that tab is showing
  if (name === "debug" && !connectOverlay.hidden) startDebugLog();
  else stopDebugLog();
  // Users tab: load the list on demand, same as the removed standalone user
  // button used to (2026-10-12: that button is gone, "Benutzer" is now just
  // another tab here — nothing else triggered this fetch for it before).
  if (name === "users") {
    setUsersStatus("", false);
    refreshUsers();
    setLoginMsgStatus("", false);
    loadLoginMessage();
  }
  syncMicMeter();
}
for (const t of overlayTabs) t.addEventListener("click", () => showOverlayTab(t.dataset.tab));
// A required field on a hidden tab would block the submit without any visible
// reason: switch to that tab.
document.getElementById("connect-form").addEventListener(
  "invalid",
  (e) => {
    const p = e.target.closest(".overlay-tabpanel");
    if (p) showOverlayTab(p.dataset.tab);
  },
  true
);


// Fader scale: tick marks sit on the slider groove and turn orange up to the
// handle. Values also change programmatically (radio state), so a cheap rAF
// loop re-reads all sliders instead of listening for input events.
(function () {
  function paint() {
    document.querySelectorAll("input.slider").forEach((el) => {
      const HANDLE = parseFloat(getComputedStyle(el).getPropertyValue("--knob")) || 24;
      const w = el.offsetWidth;
      if (!w) return;
      const min = +el.min || 0;
      const max = el.max === "" ? 100 : +el.max;
      const f = max > min ? (el.value - min) / (max - min) : 0;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round((HANDLE / 2 + f * (w - HANDLE)) * dpr) / dpr;
      if (el._pw === pw && el._w === w && el._dpr === dpr) return;
      el._pw = pw;
      el._w = w;
      el._dpr = dpr;
      el.style.setProperty("--pw", pw + "px");
      // Tick width and period in whole DEVICE pixels (also at fractional browser
      // zoom): otherwise some 1px ticks land across two device pixels and look thicker.
      el.style.setProperty("--tw", 1 / dpr + "px");
      el.style.setProperty("--tick", Math.max(3, Math.round((w * dpr) / 40)) / dpr + "px");
    });
  }
  function loop() {
    paint();
    requestAnimationFrame(loop);
  }
  // Paint once synchronously (before the first frame is drawn) so the scale
  // doesn't flash its CSS fallbacks on load, then keep re-reading.
  loop();
})();

// "Smooth" (waterfall row checkbox): smooth (browser interpolation, default) or
// crisp blocks when the 640 bins are stretched over the screen width. Display only.
(() => {
  const box = document.getElementById("scope-smooth-checkbox");
  const wrap = document.querySelector(".waterfall-wrap");
  try {
    box.checked = localStorage.getItem("open890rc.scopeSmooth") !== "0";
  } catch (e) {}
  const apply = () => wrap.classList.toggle("scope-crisp", !box.checked);
  box.addEventListener("change", () => {
    try {
      localStorage.setItem("open890rc.scopeSmooth", box.checked ? "1" : "0");
    } catch (e) {}
    apply();
    if (window.hamrcSetWaterfallSmooth) window.hamrcSetWaterfallSmooth(box.checked);
  });
  apply();
})();

// "Max Hold" (waterfall row checkbox, desktop only): keeps the loudest value
// seen per frequency bin, drawn behind the live spectrum trace (2026-10-12
// user request). Persisted the same way as Smooth/Auto (Nutzer-Report,
// 2026-10-14: "merkt sich nicht ... smooth und auto wird gemerkt") — an
// earlier version deliberately left this out, reasoning a restored "on" from
// a previous session would show a misleading stale hold; that doesn't
// actually hold up, since hamrcSetWaterfallMaxHold always resets the hold
// buffer to empty when turned on (see resetMaxHold in waterfall.js),
// identically whether that happens via a fresh manual click or via this
// restored checkbox state — either way it just starts collecting from zero.
(() => {
  const box = document.getElementById("scope-maxhold-checkbox");
  if (!box) return;
  try {
    box.checked = localStorage.getItem("open890rc.scopeMaxHold") !== "0";
  } catch (e) {}
  box.addEventListener("change", () => {
    try {
      localStorage.setItem("open890rc.scopeMaxHold", box.checked ? "1" : "0");
    } catch (e) {}
    if (window.hamrcSetWaterfallMaxHold) window.hamrcSetWaterfallMaxHold(box.checked);
  });
  // The initial restored state itself is picked up by waterfall.js directly
  // reading this checkbox's .checked when IT loads (see its own comment) —
  // calling hamrcSetWaterfallMaxHold here would be a no-op, since app.js
  // runs before waterfall.js defines it.
})();

// Browser-mic level meter (Setup window, VOIP tab): 24 LED segments over
// -48..-6 dBFS (1.75 dB each), green up to -36 dBFS, yellow (good level) up to
// -18, red above. Scale shifted down (Nutzer-Report 2026-10-11): the TS-890's ALC
// was already overdriven when the old meter (red only above -6 dBFS) reached
// yellow, so red now starts where the ALC starts to overload.
// Runs only while that tab is visible (see hamrcStartMicMeter in audio.js).
const MIC_METER_SEGMENTS = 24;
const MIC_METER_MIN_DB = -48;
const MIC_METER_MAX_DB = -6;
const MIC_METER_GREEN_DB = -36;
const MIC_METER_YELLOW_DB = -18;
const MIC_METER_RANGE = MIC_METER_MAX_DB - MIC_METER_MIN_DB;
const micMeterEl = document.getElementById("mic-meter");
const micMeterValueEl = document.getElementById("mic-meter-value");
const micMeterSegs = [];
for (let i = 0; i < MIC_METER_SEGMENTS; i++) {
  const db = MIC_METER_MIN_DB + ((i + 1) * MIC_METER_RANGE) / MIC_METER_SEGMENTS; // upper edge of the segment
  const seg = document.createElement("span");
  seg.className = db <= MIC_METER_GREEN_DB ? "g" : db <= MIC_METER_YELLOW_DB ? "y" : "r";
  micMeterEl.appendChild(seg);
  micMeterSegs.push(seg);
}
let micMeterShown = MIC_METER_MIN_DB;
let micMeterHoldIdx = -1;
let micMeterHoldUntil = 0;
function micMeterUpdate(db) {
  if (db === null) {
    micMeterValueEl.textContent = "kein Mikro";
    for (const s of micMeterSegs) s.className = s.className.replace(/ on| hold/g, "");
    return;
  }
  // instant rise, slow fall
  micMeterShown = Math.max(db, micMeterShown - 0.8);
  const lit = Math.min(
    MIC_METER_SEGMENTS,
    Math.max(0, Math.floor(((micMeterShown - MIC_METER_MIN_DB) / MIC_METER_RANGE) * MIC_METER_SEGMENTS))
  );
  const now = performance.now();
  if (lit - 1 >= micMeterHoldIdx || now > micMeterHoldUntil) {
    micMeterHoldIdx = lit - 1;
    micMeterHoldUntil = now + 1200;
  }
  micMeterSegs.forEach((s, i) => {
    s.classList.toggle("on", i < lit);
    s.classList.toggle("hold", i === micMeterHoldIdx && i >= lit);
  });
  micMeterValueEl.textContent = "";
}
// Only runs while the TX (Mic) tab is actually the visible one (2026-10-12,
// once the mic meter moved there with the rest of the TX section) — no point
// polling the mic while the RX tab, or a wholly different overlay, is shown.
function audioTxTabVisible() {
  if (audioOverlay.hidden) return false;
  const txPanel = document.querySelector('#audio-overlay .overlay-tabpanel[data-tab="tx"]');
  return !!txPanel && !txPanel.hidden;
}
// Microphone dropdown (TX tab): lists the input devices, "Standard" = system
// default. Labels appear once mic permission exists, so the list is refreshed
// after the level meter has asked for it and whenever devices come or go.
const micDeviceSelect = document.getElementById("mic-device");
async function refreshMicDevices() {
  if (!window.hamrcListMics) return;
  const { devices, selected } = await window.hamrcListMics();
  const options = [new Option("Standard (System)", "")];
  for (const d of devices) options.push(new Option(d.label, d.id));
  // a stored device that is not plugged in right now stays visible
  if (selected && !devices.some((d) => d.id === selected)) options.push(new Option("(nicht verfügbar)", selected));
  micDeviceSelect.replaceChildren(...options);
  micDeviceSelect.value = selected;
}
micDeviceSelect.addEventListener("change", () => {
  if (window.hamrcSetMicDevice) window.hamrcSetMicDevice(micDeviceSelect.value).then(refreshMicDevices);
});
window.hamrcOnMicDevicesChanged = () => {
  if (audioTxTabVisible()) refreshMicDevices();
};
// Output device dropdown (RX tab): hidden where setSinkId() is missing (iOS).
const audioOutputRow = document.getElementById("audio-output-row");
const audioOutputSelect = document.getElementById("audio-output");
async function refreshOutputDevices() {
  if (!window.hamrcListOutputs || !window.hamrcOutputSelectable) return;
  audioOutputRow.hidden = false;
  const { devices, selected } = await window.hamrcListOutputs();
  const options = [new Option("Standard (System)", "")];
  for (const d of devices) options.push(new Option(d.label, d.id));
  if (selected && !devices.some((d) => d.id === selected)) options.push(new Option("(nicht verfügbar)", selected));
  audioOutputSelect.replaceChildren(...options);
  audioOutputSelect.value = selected;
}
audioOutputSelect.addEventListener("change", () => {
  if (window.hamrcSetOutputDevice) window.hamrcSetOutputDevice(audioOutputSelect.value).then(refreshOutputDevices);
});
window.hamrcOnOutputDevicesChanged = () => {
  if (!audioOverlay.hidden) refreshOutputDevices();
};
function syncMicMeter() {
  if (audioTxTabVisible()) {
    refreshMicDevices();
    if (window.hamrcStartMicMeter) Promise.resolve(window.hamrcStartMicMeter(micMeterUpdate)).then(refreshMicDevices);
  } else if (window.hamrcStopMicMeter) {
    window.hamrcStopMicMeter();
    micMeterShown = MIC_METER_MIN_DB;
    micMeterUpdate(MIC_METER_MIN_DB);
    micMeterValueEl.textContent = "";
  }
}

// Start dimmed, as for a radio that is off: the real state arrives over the
// WebSocket a moment later, and showing everything lit until then looked like
// a flash on page load. (index.html already carries main.controls-off for the
// pure-CSS part, so this only has to mark the boxes inert/dimmed.)
setControlsDisabled(true);

// Everything below the top bar stays hidden (main.booting) until the first
// state arrives, so the sliders/keys don't visibly switch from the dimmed
// "off" look to the lit one right after load. The timeout keeps the page
// usable if the server never answers.
let firstStateSeen = false;
let fontsReady = false;
function revealMain(force) {
  if (force !== true) {
    firstStateSeen = true;
    if (!fontsReady) return;
  }
  document.querySelector("main").classList.remove("booting");
}
// The frequency display uses the Digital-7 web font: wait for it too, or the
// digits first show in a fallback font and jump to their design.
(document.fonts && document.fonts.load ? document.fonts.load('1em "Digital-7 Mono"') : Promise.resolve())
  .catch(() => {})
  .then(() => {
    fontsReady = true;
    if (firstStateSeen) revealMain();
  });
setTimeout(() => revealMain(true), 2500);
