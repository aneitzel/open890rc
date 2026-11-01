// Band scope waterfall: connects to /waterfall-ws (binary frames, one per
// scope line, see cat.ParseBandScopeLine/cat.BandScopeLineBytes) and paints
// a scrolling top-down waterfall — new line at the top, everything else
// shifts down by one row, same convention open890's own canvas waterfall
// uses. Reconnects on its own if the connection drops (radio reset, server
// restart), unless explicitly turned off (see hamrcSetWaterfallEnabled).
(function () {
  const LINE_BYTES = 640; // cat.BandScopeLineBytes
  const RECONNECT_DELAY_MS = 2000;

  // The radio itself has no known DD0x "stop" command — once enabled it just keeps
  // sending scope lines to the server for as long as the CAT connection is
  // up, regardless of what any browser wants. What we CAN control from here
  // is whether the SERVER forwards that data to THIS browser at all: with
  // no open /waterfall-ws connection, hub.Broadcast has zero subscribers for
  // it (already cheap/no-op per the server-side comment), so simply not
  // holding a connection open is the actual traffic saving for the
  // browser<->server leg, which is what matters most on a phone.
  let scopeEnabled = true;
  let ws = null;
  let reconnectTimer = null;

  const canvas = document.getElementById("waterfall-canvas");
  const overlay = document.getElementById("waterfall-overlay");
  // Desktop: one canvas row per CSS pixel (266 rows) instead of the phone's 176
  // stretched over more pixels — crisp lines and more history. The overlay spans
  // spectrum (70) + waterfall. Re-applied below on a live breakpoint change too,
  // not just at load (see desktopQuery.addEventListener near the end of this file).
  const desktopQuery = window.matchMedia("(min-width: 800px)");
  function waterfallRowsFor(desktop) {
    return desktop ? 266 : 176;
  }
  canvas.height = waterfallRowsFor(desktopQuery.matches);
  overlay.height = 70 + canvas.height;

  const ctx = canvas.getContext("2d", { alpha: false });
  const width = canvas.width;
  let height = canvas.height;

  const overlayCtx = overlay.getContext("2d");
  const overlayWidth = overlay.width;
  let overlayHeight = overlay.height;

  const spectrum = document.getElementById("spectrum-canvas");
  const spectrumCtx = spectrum.getContext("2d");
  const spectrumWidth = spectrum.width;
  const spectrumHeight = spectrum.height;
  // Same 140 "practical full scale" open890 uses for the SVG spectrum
  // line's height (RadioViewHelpers.scope_data_to_svg, max_value: 140) —
  // NOT the same thing as the waterfall's color range (that one really is
  // the full 0-255, see the color mapping notes below). Values above this
  // just peg at the top of the trace instead of going off-canvas.
  const SPECTRUM_MAX = 140;

  // Exact port of open890's own color mapping (assets/js/colormap.js
  // ColorMap.hslBlack/hsl, assets/js/interpolate.js Interpolate.linear,
  // assets/js/color_utils.js ColorUtils.hsl2rgb) — a first attempt here
  // guessed a narrower "practical full-scale" range (7-140) based on a
  // paraphrased secondhand description, which was wrong and made real
  // signals and noise both crowd into the red/yellow end of the scale.
  // Reading open890's actual source directly: hue is interpolated over the
  // FULL 0-255 byte range (240=blue at 0, 0=red at 255), and only values
  // below 7 are forced to black. Precomputed into a lookup table here
  // instead of running this per pixel on every incoming line.
  //
  // Verified the formula itself is right by hand (v=7 -> deep blue, v=127
  // -> pure green, both match open890's own math), yet a background that
  // should read as noise came out green/warm instead of dark. Turned out
  // to be a wrong assumption about what the raw byte means, not the color
  // formula: confirmed directly against open890 that the convention is
  // INVERTED from a first guess — a LOW raw byte is a STRONG signal, a
  // HIGH raw byte is weak/noise floor, the opposite of treating the byte
  // as a direct power reading. remapValue below inverts (255-raw) before
  // anything else touches the value.
  //
  // Floor/Ceiling: the radio's own front-panel scope display looks fine
  // as-is and isn't to be touched — it's a separate, differently-
  // calibrated rendering path from these raw LAN scope bytes anyway — so
  // this compensates entirely on OUR side instead of touching any radio-
  // side reference level/attenuation. Floor is the noise-floor pedestal
  // (raise it until typical noise reads near black); Ceiling is the value
  // that maps to full-scale/brightest color (lower it to make weaker
  // signals stand out more — effectively a contrast/gain control). A
  // single dual-handle slider drives both, sharing one 0-255 axis (same
  // technique as the LC/HC filter dual-slider elsewhere in this project).
  const FLOOR_KEY = "hamrc.scopeFloor";
  const CEILING_KEY = "hamrc.scopeCeiling";

  // The lowest ~35% of the 0-255 axis (inverted signal value) is useless
  // because the radio's signal minimum sits far above it: the sliders only
  // cover LEVEL_MIN..255 (Nutzer-Wunsch, 2026-10-05).
  const LEVEL_MIN = 90;

  function loadLevel(key, fallback) {
    try {
      const v = parseInt(localStorage.getItem(key), 10);
      if (Number.isFinite(v) && v >= 0 && v <= 255) return Math.max(LEVEL_MIN, v);
    } catch {
      // localStorage unavailable — fall through to the default.
    }
    return fallback;
  }

  let floor = loadLevel(FLOOR_KEY, LEVEL_MIN);
  let ceiling = loadLevel(CEILING_KEY, 255);

  function remapValue(raw) {
    const v = 255 - raw;
    if (ceiling <= floor) return v; // degenerate slider state — pass through
    if (v <= floor) return 0;
    if (v >= ceiling) return 255;
    return Math.round(((v - floor) * 255) / (ceiling - floor));
  }

  // Spectrum trace height: depends on Floor only. The Ceiling slider is a
  // colour-contrast control for the waterfall (see remapValue) and should not
  // stretch the trace, so the full 255 range is used as the top here.
  function remapSpectrum(raw) {
    const v = 255 - raw;
    if (v <= floor) return 0;
    if (floor >= 255) return 255;
    return Math.round(((v - floor) * 255) / (255 - floor));
  }

  // Auto-headroom for strong signals (Nutzer-Wunsch 2026-10-25): once Floor
  // auto-tracks up near the noise median (see updateAutoLevel below), the
  // remaining [floor, 255] span above it is narrow, so even a moderately
  // strong signal's remapSpectrum() result already clears SPECTRUM_MAX and
  // pegs flat against the top (intentional in itself, see SPECTRUM_MAX's own
  // comment — open890 does the same — but the operator wants real headroom
  // for genuinely strong signals instead).
  //
  // Deliberately NOT the same shape as Floor's own auto-tracking: that one
  // follows the MEDIAN of every line continuously, which is exactly why it
  // must stay separate from this — reacting to the line's average/typical
  // level would pull the trace up during plain noise too, with nothing
  // actually clipping ("wenn wir es dauerhaft machen wird das Spectrum auch
  // bei Rauschen hochgezogen"). This instead reacts only to the line's PEAK:
  // a plain multiplicative scale (<=1) that only ever moves when that peak
  // would actually clip against SPECTRUM_MAX, snapping down immediately (no
  // frame should visibly clip) and decaying back toward 1 — i.e. back to
  // today's exact fixed behaviour — once nothing needs the headroom
  // anymore. Being a flat multiplicative factor rather than a soft-knee
  // curve, it does shrink every bin in a line by the same proportion while
  // active, so a quiet bin sitting right next to a genuinely strong, clipping
  // one dips slightly too for as long as that peak lasts — a one-line,
  // self-correcting side effect of reacting per-line, not the permanent,
  // band-wide inflation of plain noise the operator was specifically ruling
  // out above (nothing happens at all on a line with no clipping peak).
  let spectrumAutoScale = 1;
  let spectrumAutoLastMs = 0;
  const SPECTRUM_AUTO_RELEASE_SECONDS = 5; // time to drift back to scale 1 once idle
  function updateSpectrumAutoScale(bytes, x0, x1) {
    let maxV = 0;
    for (let x = x0; x < x1; x++) {
      const v = remapSpectrum(bytes[x]);
      if (v > maxV) maxV = v;
    }
    const nowMs = performance.now();
    const elapsedMs = spectrumAutoLastMs ? nowMs - spectrumAutoLastMs : 0;
    spectrumAutoLastMs = nowMs;
    if (maxV > 0 && maxV * spectrumAutoScale > SPECTRUM_MAX) {
      // Snap, not ease: a peak clipping even for one frame is exactly what
      // this exists to avoid, so there is no "attack time" here.
      spectrumAutoScale = SPECTRUM_MAX / maxV;
      return;
    }
    if (spectrumAutoScale < 1 && elapsedMs > 0) {
      spectrumAutoScale = Math.min(1, spectrumAutoScale + elapsedMs / (SPECTRUM_AUTO_RELEASE_SECONDS * 1000));
    }
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hsl2rgb(h, s, l) {
    if (s === 0) {
      const v = Math.min(Math.floor(l * 256), 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.min(Math.floor(hue2rgb(p, q, h + 1 / 3) * 256), 255),
      Math.min(Math.floor(hue2rgb(p, q, h) * 256), 255),
      Math.min(Math.floor(hue2rgb(p, q, h - 1 / 3) * 256), 255),
    ];
  }

  const RED_AT = 200;

  // Colour schemes of the waterfall (Nutzer-Wunsch 2026-11-01). "Standard" is the open890 rainbow above; the
  // others are the gradient presets wfview offers (they are QCustomPlot's QCPColorGradient presets, wfview
  // default is Jet): colour stops [position 0..1, [r, g, b]] interpolated in RGB or HSV like QCustomPlot does.
  // The stop values are from memory of QCustomPlot's source (the library is not part of the wfview tree in
  // CLAUDE/wfview-2.25), so they may differ slightly from wfview's own rendering.
  const SCHEMES = [
    { id: "standard", label: "o890rc" },
    { id: "jet", label: "Jet", mode: "rgb", stops: [[0, [0, 0, 100]], [0.15, [0, 50, 255]], [0.35, [0, 255, 255]], [0.65, [255, 255, 0]], [0.85, [255, 30, 0]], [1, [100, 0, 0]]] },
    { id: "cold", label: "Cold", mode: "rgb", stops: [[0, [0, 0, 50]], [0.2, [0, 10, 180]], [0.4, [0, 50, 245]], [0.6, [10, 150, 255]], [0.8, [50, 255, 255]], [1, [255, 255, 255]]] },
    { id: "hot", label: "Hot", mode: "rgb", stops: [[0, [50, 0, 0]], [0.2, [180, 10, 0]], [0.4, [245, 50, 0]], [0.6, [255, 150, 10]], [0.8, [255, 255, 50]], [1, [255, 255, 255]]] },
    { id: "thermal", label: "Therm", mode: "rgb", stops: [[0, [0, 0, 50]], [0.15, [20, 0, 120]], [0.33, [200, 30, 140]], [0.6, [255, 100, 0]], [0.85, [255, 255, 40]], [1, [255, 255, 255]]] },
    { id: "night", label: "Night", mode: "hsv", stops: [[0, [10, 20, 30]], [1, [250, 255, 250]]] },
    { id: "ion", label: "Ion", mode: "hsv", stops: [[0, [50, 10, 10]], [0.45, [0, 0, 255]], [0.8, [0, 255, 255]], [1, [0, 255, 0]]] },
    { id: "gray", label: "Gray", mode: "rgb", stops: [[0, [0, 0, 0]], [1, [255, 255, 255]]] },
    { id: "geo", label: "Geo", mode: "rgb", stops: [[0, [70, 170, 210]], [0.2, [90, 160, 180]], [0.25, [45, 130, 175]], [0.3, [100, 140, 125]], [0.5, [100, 140, 100]], [0.6, [130, 145, 120]], [0.7, [140, 130, 120]], [0.9, [180, 190, 190]], [1, [210, 210, 230]]] },
    { id: "hues", label: "Hues", mode: "hsv", stops: [[0, [255, 0, 0]], [1 / 3, [0, 0, 255]], [2 / 3, [0, 255, 0]], [1, [255, 0, 0]]] },
    { id: "polar", label: "Polar", mode: "rgb", stops: [[0, [50, 255, 255]], [0.18, [10, 70, 255]], [0.28, [10, 10, 190]], [0.5, [0, 0, 0]], [0.72, [190, 10, 10]], [0.82, [255, 70, 10]], [1, [255, 255, 50]]] },
    { id: "spectrum", label: "Spect", mode: "hsv", stops: [[0, [50, 0, 50]], [0.15, [0, 0, 255]], [0.35, [0, 255, 0]], [0.6, [255, 255, 0]], [0.75, [255, 30, 0]], [1, [50, 0, 0]]] },
    { id: "candy", label: "Candy", mode: "hsv", stops: [[0, [0, 0, 255]], [1, [255, 250, 250]]] },
  ];
  const SCHEME_KEY = "open890rc.scopeColors";
  let scheme = SCHEMES[0];
  try {
    const saved = SCHEMES.find((s) => s.id === localStorage.getItem(SCHEME_KEY));
    if (saved) scheme = saved;
  } catch (e) {}

  function rgb2hsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsv2rgb(h, s, v) {
    const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function gradientColor(sch, t) {
    const stops = sch.stops;
    t = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    const f = p1 > p0 ? Math.max(0, Math.min(1, (t - p0) / (p1 - p0))) : 0;
    if (sch.mode === "hsv") {
      const a = rgb2hsv(c0[0], c0[1], c0[2]), b = rgb2hsv(c1[0], c1[1], c1[2]);
      let dh = b[0] - a[0];
      if (dh > 0.5) dh -= 1; // the shorter way round the hue circle
      else if (dh < -0.5) dh += 1;
      let h = a[0] + dh * f;
      if (h < 0) h += 1;
      if (h >= 1) h -= 1;
      return hsv2rgb(h, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
    }
    return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f));
  }

  function colorFor(v) {
    if (scheme.stops) return gradientColor(scheme, v / 255);
    if (v < 7) return [0, 0, 0];
    // open890 maps 0..255 to hue 240..0; we reach pure red already at RED_AT
    // so strong signals actually turn red (the top of the scale was never used).
    const hue = 240 * (1 - Math.min(1, v / RED_AT));
    return hsl2rgb(hue / 359.9, 1.0, 0.5);
  }

  // Rebuilt whenever the Floor slider moves (rare — user interaction, not
  // per frame) so drawLine's per-pixel work stays a cheap table lookup
  // either way; remapValue is baked in here instead of applied again below.
  function buildPalette() {
    const palette = new Uint8ClampedArray(256 * 3);
    for (let v = 0; v < 256; v++) {
      const rgb = colorFor(remapValue(v));
      palette[v * 3] = rgb[0];
      palette[v * 3 + 1] = rgb[1];
      palette[v * 3 + 2] = rgb[2];
    }
    return palette;
  }

  let PALETTE = buildPalette();

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // "Smooth" option (waterfall row checkbox, same localStorage key as app.js):
  // besides the browser's own interpolation when the 640 bins are stretched,
  // each line is blurred horizontally with a 9-tap binomial kernel before drawing
  // (display only; the auto-level estimate still uses the raw line). A fixed-
  // strength vertical/temporal blend (a smear/persistence effect,
  // "Schmiereffekt") comes on top — both only take effect while this checkbox
  // is on.
  let smoothOn = true;
  try {
    smoothOn = localStorage.getItem("open890rc.scopeSmooth") !== "0";
  } catch (e) {}
  window.hamrcSetWaterfallSmooth = function (on) {
    smoothOn = !!on;
    resetVerticalSmooth(); // don't blend stale history back in on re-enable
  };

  // Fixed strengths, both 0..1 (the former H/V dropdowns are gone, Nutzer-Wunsch
  // 2026-11-01): H = "Leicht" (25%), V = "Mittel" (50%).
  const hSmoothAmount = 0.25;
  const vSmoothAmount = 0.5;

  // Level-dependent smoothing: a 9-tap binomial kernel [1 8 28 56 70 56 28 8 1]/256
  // (sigma = 2 bins) is blended with the raw line by a weight that is 1 at the noise
  // floor and falls to 0 for signals SMOOTH_SPAN above it — weak crackle/noise just
  // above the floor is smoothed away fully, strong signals keep their raw shape.
  // "Floor" is the same level the colour scale uses (Auto = median of the line);
  // the raw bytes are inverted (low = strong), hence the 255 - x below. hSmoothAmount scales this blend's weight directly.
  const SMOOTH_KERNEL = [1, 8, 28, 56, 70, 56, 28, 8, 1];
  const SMOOTH_HALF = 4;
  const SMOOTH_SPAN_FRACTION = 0.3; // of the range between floor and full scale
  const SMOOTH_SPAN_MIN = 20;
  function smoothBytes(bytes) {
    const n = bytes.length;
    const out = new Uint8Array(bytes); // the outer 4 bins at each edge stay raw
    const span = Math.max(SMOOTH_SPAN_MIN, (255 - floor) * SMOOTH_SPAN_FRACTION);
    for (let x = SMOOTH_HALF; x < n - SMOOTH_HALF; x++) {
      let sum = 128;
      for (let k = 0; k < SMOOTH_KERNEL.length; k++) sum += SMOOTH_KERNEL[k] * bytes[x - SMOOTH_HALF + k];
      const smooth = sum >> 8;
      const strength = 255 - smooth; // same scale as floor
      let wgt = 1 - (strength - floor) / span;
      wgt = wgt < 0 ? 0 : wgt > 1 ? 1 : wgt;
      out[x] = Math.round(bytes[x] + wgt * hSmoothAmount * (smooth - bytes[x]));
    }
    return out;
  }

  // Vertical/temporal smoothing: each new line is blended with an
  // exponential moving average carried from the previous ones (per
  // frequency bin, in the same raw 0-255 byte domain smoothBytes works in —
  // colour mapping happens later), creating a comet-trail/smear effect as
  // the waterfall scrolls instead of each row replacing the last outright.
  // vSmoothLine is indexed by INCOMING bin position (0..639, the radio's own
  // line layout), not on-screen pixel position — unlike Max Hold it does not
  // need to track screen shifts during small in-view retunes, only a full
  // reset when the picture itself resets (same call sites as resetMaxHold;
  // blending stale content across a frequency jump would smear the wrong
  // thing). vSmoothAmount sets alpha between 1 (no history) and
  // V_SMOOTH_MIN_ALPHA (long, visible trailing persistence).
  // vSmoothLine itself stays a Float64Array (full precision carried between
  // lines) rather than the Uint8Array the rest of this pipeline otherwise
  // uses — found live: at a low alpha (strong smear), rounding the carried
  // state to whole bytes every single line lets a small residual difference
  // (e.g. 6 of 255) permanently round to a 0 step and the trail gets stuck
  // just short of the true baseline instead of continuing to fade out.
  // Rounding only happens once, at the very end, for the Uint8Array actually
  // handed to drawLine/drawSpectrum — the internal state keeps accumulating
  // fractional progress underneath even on frames where the rounded,
  // displayed value doesn't (yet) change.
  const V_SMOOTH_MIN_ALPHA = 0.08;
  let vSmoothLine = null;
  function resetVerticalSmooth() {
    vSmoothLine = null;
  }
  function verticalSmooth(bytes) {
    if (!vSmoothLine || vSmoothLine.length !== bytes.length) {
      vSmoothLine = Float64Array.from(bytes);
      return bytes;
    }
    const alpha = 1 - vSmoothAmount * (1 - V_SMOOTH_MIN_ALPHA);
    const out = new Uint8Array(bytes.length);
    for (let x = 0; x < bytes.length; x++) {
      vSmoothLine[x] += alpha * (bytes[x] - vSmoothLine[x]);
      out[x] = Math.round(vSmoothLine[x]);
    }
    return out;
  }

  // Tuning keeps the picture in place in FREQUENCY (Nutzer-Wunsch, 2026-10-10):
  // imageCenterHz is the frequency at the middle of the waterfall/spectrum as
  // drawn so far. When the displayed VFO changes (drag-tuning, digits, wheel,
  // front panel), the existing image slides sideways by the matching number of
  // pixels (shiftImages) instead of staying put, and the strip that opens up at
  // one edge stays black until new lines fill it. A new line from the radio is
  // centred on the radio's own (confirmed) VFO, which may lag behind the
  // displayed one for a moment, so it is drawn offset by the difference
  // (lineOffsetPx) — rows then line up in frequency and the gap fills in.
  let imageCenterHz = null;
  let radioHz = null; // the radio's confirmed VFO (centre of the lines it sends)
  let shiftCarry = 0; // sub-pixel remainder carried between shifts

  function lineOffsetPx() {
    if (imageCenterHz === null || radioHz === null || !spanHz) return 0;
    return Math.round(((radioHz - imageCenterHz) / spanHz) * width);
  }

  function shiftImages(dxPx) {
    if (!dxPx) return;
    const adx = Math.abs(dxPx);
    if (adx >= width) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      spectrumCtx.clearRect(0, 0, spectrumWidth, spectrumHeight);
      return;
    }
    ctx.drawImage(canvas, dxPx, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(dxPx > 0 ? 0 : width - adx, 0, adx, height);
    spectrumCtx.drawImage(spectrum, dxPx, 0);
    spectrumCtx.clearRect(dxPx > 0 ? 0 : spectrumWidth - adx, 0, adx, spectrumHeight);
  }

  function drawLine(bytes) {
    // Shift the whole image down by one row (the canvas's own bottom row
    // falls off/is discarded); row 0 is left stale until overwritten below.
    ctx.drawImage(canvas, 0, 1);

    const off = lineOffsetPx();
    const row = ctx.createImageData(width, 1);
    for (let o = 3; o < row.data.length; o += 4) row.data[o] = 255; // uncovered parts stay black
    const n = Math.min(width, bytes.length);
    for (let x = 0; x < n; x++) {
      const tx = x + off;
      if (tx < 0 || tx >= width) continue;
      const v = bytes[x];
      const o = tx * 4;
      row.data[o] = PALETTE[v * 3];
      row.data[o + 1] = PALETTE[v * 3 + 1];
      row.data[o + 2] = PALETTE[v * 3 + 2];
    }
    ctx.putImageData(row, 0, 0);
  }

  // Max Hold (desktop only, 2026-10-12 user request): the loudest value seen
  // per frequency bin, drawn behind the live trace in the same amber used
  // for a strong waterfall signal (colorFor's RED_AT end of its scale is
  // actually past red; this sits in the amber/orange part of that same
  // mapping, a deliberate visual link to "this is a peak the signal once
  // reached") at low opacity — a muted colour the live trace (light
  // blue-grey, much higher opacity) always reads as "in front of". Indexed
  // by on-screen bin position, so it's only valid while the picture isn't
  // moving underneath it: reset on every retune/span change (see
  // hamrcSetWaterfallVFO) rather than attempting to shift it in sync with
  // the frequency-locked spectrum/waterfall picture, which would need the
  // same per-line pixel-shift logic those already have — a real feature for
  // later if "hold while slowly tuning around" turns out to matter, not
  // needed for the common case of holding still and watching one range.
  // Decays linearly rather than accumulating forever (2026-10-12 follow-up:
  // "zeitbasierter decay") — a held peak fades back to 0 over
  // MAX_HOLD_DECAY_SECONDS if nothing reinforces it, so the trace reflects
  // roughly "what's been active in the last little while" instead of
  // every signal ever seen since the checkbox was turned on. 30s first,
  // then 5s ("decay 5 sek"), settled on 15s ("15 sek") — all 2026-10-12.
  // Clock-based (real elapsed ms, via performance.now()), not per-line, so
  // it decays at the same real-world rate regardless of the Hi/Mid/Lo
  // scope rate.
  const MAX_HOLD_DECAY_SECONDS = 15;
  const MAX_HOLD_DECAY_PER_MS = SPECTRUM_MAX / (MAX_HOLD_DECAY_SECONDS * 1000);
  // Read the checkbox's own .checked here rather than defaulting to false and
  // waiting for app.js to call hamrcSetWaterfallMaxHold: app.js runs BEFORE
  // this script (see index.html's <script> order) and already restored the
  // persisted checkbox state by the time this line runs, but a call it makes
  // to window.hamrcSetWaterfallMaxHold at that same point would be a no-op —
  // this function doesn't exist yet (same load-order trap documented
  // elsewhere for hamrcSetMicGain). Reading the already-correct DOM state
  // directly sidesteps the ordering problem entirely.
  let maxHoldEnabled = document.getElementById("scope-maxhold-checkbox")?.checked ?? false;
  let maxHoldValues = null;
  let maxHoldLastMs = 0;
  function resetMaxHold() {
    maxHoldValues = maxHoldEnabled ? new Float64Array(spectrumWidth) : null;
    maxHoldLastMs = 0;
  }
  window.hamrcSetWaterfallMaxHold = function (on) {
    maxHoldEnabled = !!on;
    resetMaxHold();
  };

  // Instantaneous spectrum trace, redrawn fresh each line (not scrolling,
  // unlike the waterfall below it) — a filled mountain-profile line graph,
  // same look as open890's own SVG spectrum view above its waterfall.
  function drawSpectrum(bytes) {
    spectrumCtx.clearRect(0, 0, spectrumWidth, spectrumHeight);
    const off = lineOffsetPx();
    const n = Math.min(spectrumWidth, bytes.length);
    const x0 = Math.max(0, -off); // first bin that lands on the canvas
    const x1 = Math.min(n, spectrumWidth - off); // one past the last
    if (x1 <= x0) return;
    updateSpectrumAutoScale(bytes, x0, x1);

    if (maxHoldEnabled && maxHoldValues) {
      const nowMs = performance.now();
      const decay = maxHoldLastMs ? (nowMs - maxHoldLastMs) * MAX_HOLD_DECAY_PER_MS : 0;
      maxHoldLastMs = nowMs;
      // Decay every bin (not just the ones this line touches), THEN let
      // this line's values win back out over the decayed baseline —
      // otherwise a loud peak that later goes quiet would never fade.
      if (decay > 0) {
        for (let i = 0; i < spectrumWidth; i++) {
          const d = maxHoldValues[i] - decay;
          maxHoldValues[i] = d > 0 ? d : 0;
        }
      }
      for (let x = x0; x < x1; x++) {
        const v = Math.min(remapSpectrum(bytes[x]) * spectrumAutoScale, SPECTRUM_MAX);
        const px = x + off;
        if (v > maxHoldValues[px]) maxHoldValues[px] = v;
      }
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(x0 + off, spectrumHeight);
      for (let x = x0; x < x1; x++) {
        const px = x + off;
        const y = spectrumHeight - (maxHoldValues[px] / SPECTRUM_MAX) * spectrumHeight;
        spectrumCtx.lineTo(px, y);
      }
      spectrumCtx.lineTo(x1 - 1 + off, spectrumHeight);
      spectrumCtx.closePath();
      spectrumCtx.fillStyle = "rgba(255, 190, 60, 0.22)";
      spectrumCtx.fill();
      spectrumCtx.strokeStyle = "rgba(255, 190, 60, 0.55)";
      spectrumCtx.lineWidth = 1;
      spectrumCtx.stroke();
    }

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(x0 + off, spectrumHeight);
    for (let x = x0; x < x1; x++) {
      const v = Math.min(remapSpectrum(bytes[x]) * spectrumAutoScale, SPECTRUM_MAX);
      const y = spectrumHeight - (v / SPECTRUM_MAX) * spectrumHeight;
      spectrumCtx.lineTo(x + off, y);
    }
    spectrumCtx.lineTo(x1 - 1 + off, spectrumHeight);
    spectrumCtx.closePath();
    spectrumCtx.fillStyle = "rgba(180, 190, 210, 0.55)";
    spectrumCtx.fill();
    spectrumCtx.strokeStyle = "#dfe6f0";
    spectrumCtx.lineWidth = 1;
    spectrumCtx.stroke();
  }

  function connect() {
    if (!scopeEnabled) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Handlers use their own socket, not the shared `ws`: that one may already
    // be null (spectrum switched off while connecting) or a newer connection.
    const sock = new WebSocket(`${proto}://${location.host}/waterfall-ws`);
    ws = sock;
    sock.binaryType = "arraybuffer";

    sock.onmessage = (event) => {
      const bytes = new Uint8Array(event.data);
      window.hamrcReportTraffic(bytes.length, "scope");
      if (bytes.length !== LINE_BYTES) return; // truncated/unexpected — skip rather than misrender
      if (autoEnabled) updateAutoLevel(bytes);
      const shown = smoothOn ? verticalSmooth(smoothBytes(bytes)) : bytes;
      drawLine(shown);
      drawSpectrum(shown);
    };
    sock.onclose = () => {
      if (ws !== sock) return; // a stale socket (already replaced or switched off)
      ws = null;
      if (scopeEnabled) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    sock.onerror = () => sock.close();
  }

  connect();

  const offHint = document.getElementById("waterfall-off-hint");

  // Bridge from app.js's scope-rate cycle button (Hi/Mid/Lo/Off) — mirrors
  // hamrcSetMicStreaming/hamrcSetWaterfallVFO's pattern of a plain global
  // function connecting the two otherwise-decoupled files.
  // The scope is shown only if the user didn't turn it off (cycle button's
  // "Off") AND a radio is connected — it comes back by itself once the radio
  // is back, if the user had it on.
  let userEnabled = true;
  let radioOff = false;
  window.hamrcSetWaterfallEnabled = function (enabled) {
    userEnabled = enabled;
    applyEffectiveEnabled();
  };
  window.hamrcSetWaterfallRadioOff = function (off) {
    radioOff = off;
    applyEffectiveEnabled();
  };
  function applyEffectiveEnabled() {
    const enabled = userEnabled && !radioOff;
    if (enabled === scopeEnabled) return;
    scopeEnabled = enabled;
    if (enabled) {
      offHint.hidden = true;
      overlay.style.cursor = "pointer";
      connect();
      return;
    }
    overlay.style.cursor = "default";
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    // Grey rather than plain black (Nutzer-Wunsch, 2026-09-28) — makes the
    // "off" state visually obvious at a glance instead of looking like a
    // frozen/stuck black waterfall.
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, width, height);
    spectrumCtx.fillStyle = "#141414";
    spectrumCtx.fillRect(0, 0, spectrumWidth, spectrumHeight);
    overlayCtx.clearRect(0, 0, overlayWidth, overlayHeight);
    offHint.hidden = false;
    syncScale();
  }

  // Dual-handle slider (two overlaid native range inputs sharing one visual
  // track — see the .dual-slider CSS, same technique as the LC/HC filter
  // control elsewhere in this project): left handle is Floor, right handle
  // is Ceiling, both on the same 0-255 axis so they land proportionally on
  // one shared scale.
  const floorSlider = document.getElementById("scope-floor-slider");
  const ceilingSlider = document.getElementById("scope-ceiling-slider");
  const levelFill = document.getElementById("scope-level-fill");

  function persistLevel(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage unavailable — the slider still works, just won't
      // remember the setting across reloads.
    }
  }

  function updateLevelFill() {
    const min = Number(floorSlider.min);
    const max = Number(floorSlider.max);
    const span = max - min || 1;
    const loPct = ((floor - min) / span) * 100;
    const hiPct = ((ceiling - min) / span) * 100;
    levelFill.style.left = `${loPct}%`;
    levelFill.style.right = `${100 - hiPct}%`;
  }

  floorSlider.min = LEVEL_MIN;
  ceilingSlider.min = LEVEL_MIN;
  floorSlider.value = floor;
  ceilingSlider.value = ceiling;
  updateLevelFill();

  floorSlider.addEventListener("input", () => {
    floor = Number(floorSlider.value);
    PALETTE = buildPalette();
    updateLevelFill();
    persistLevel(FLOOR_KEY, floor);
  });
  ceilingSlider.addEventListener("input", () => {
    ceiling = Number(ceilingSlider.value);
    PALETTE = buildPalette();
    updateLevelFill();
    persistLevel(CEILING_KEY, ceiling);
  });

  // Colour scheme dropdown (right of Smooth): kept per browser.
  const colorSelect = document.getElementById("scope-color-select");
  if (colorSelect) {
    for (const sch of SCHEMES) colorSelect.add(new Option(sch.label, sch.id));
    colorSelect.value = scheme.id;
    colorSelect.addEventListener("change", () => {
      scheme = SCHEMES.find((x) => x.id === colorSelect.value) || SCHEMES[0];
      PALETTE = buildPalette();
      try {
        localStorage.setItem(SCHEME_KEY, scheme.id);
      } catch (e) {}
    });
  }

  // Auto-level: continuously re-estimates the FLOOR (only — Ceiling stays
  // manual, see below) from each incoming line's own actual values, so it
  // keeps working as band conditions/noise floor change. A raw per-line
  // estimate would make the display noticeably flicker/jump, since a
  // single line's percentile wobbles a fair bit line to line even under
  // steady conditions. Smoothed with a slow exponential moving average
  // (AUTO_ALPHA close to 0) for "inertia" instead: floor drifts toward the
  // current estimate gradually rather than snapping to it.
  //
  // First attempt also auto-tracked Ceiling and used the 10th percentile
  // for Floor — too little of the band actually gets called "noise" that
  // way; on a real spectrum, MOST bins are noise and only a few are actual
  // signals, so a low percentile like 10% sits BELOW the true noise level,
  // leaving typical noise showing as a persistent low-level haze instead
  // of black. Floor now uses the MEDIAN (50th percentile) instead — a
  // sound choice specifically because signals normally occupy well under
  // half the band, so the median reliably lands on "typical noise" and
  // pushes it to black, per request ("die niedrigsten Werte sollen ja
  // durch schwarz abgebildet werden"). Ceiling is easier to set well by
  // hand once and rarely needs to move, and auto-tracking it fought with
  // Floor for the same limited color range ("zu eng") — so only Floor is
  // automatic now, Ceiling's slider is always manually adjustable.
  const AUTO_KEY = "hamrc.scopeAuto";
  const AUTO_ALPHA = 0.03;
  const AUTO_FLOOR_PERCENTILE = 0.5;
  // Extra offset on top of the median so quiet bands stay black, not blue.
  const AUTO_FLOOR_OFFSET = 5;

  function loadAuto() {
    try {
      const v = localStorage.getItem(AUTO_KEY);
      if (v !== null) return v === "true";
    } catch {
      // localStorage unavailable — fall through to the default.
    }
    return true;
  }

  let autoEnabled = loadAuto();
  let autoFloor = floor;
  const sortScratch = new Uint8Array(LINE_BYTES);

  function percentile(sorted, frac) {
    return sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
  }

  function updateAutoLevel(bytes) {
    for (let i = 0; i < bytes.length; i++) sortScratch[i] = 255 - bytes[i];
    sortScratch.sort();
    const instFloor = percentile(sortScratch, AUTO_FLOOR_PERCENTILE);

    autoFloor += (instFloor - autoFloor) * AUTO_ALPHA;

    const newFloor = Math.max(LEVEL_MIN, Math.min(ceiling - 1, Math.round(autoFloor + AUTO_FLOOR_OFFSET)));
    // Deadband: a floor that flips by one level every few lines re-colours the
    // newly drawn rows slightly differently each time (visible as flicker /
    // banding in the scrolling waterfall) and rebuilds the palette + slider each
    // time. Only follow when it has moved by at least 2 levels.
    if (Math.abs(newFloor - floor) < 2) return;

    floor = newFloor;
    PALETTE = buildPalette();
    floorSlider.value = floor;
    updateLevelFill();
  }

  function setAutoEnabled(enabled) {
    autoEnabled = enabled;
    floorSlider.disabled = enabled;
    if (!enabled) {
      // Keep whatever Auto last settled on as the new manual starting
      // point, rather than snapping back to an old stale manual value.
      autoFloor = floor;
    }
    try {
      localStorage.setItem(AUTO_KEY, enabled);
    } catch {
      // localStorage unavailable — the checkbox still works, just won't
      // remember the setting across reloads.
    }
  }

  const autoCheckbox = document.getElementById("scope-auto-level");
  autoCheckbox.checked = autoEnabled;
  setAutoEnabled(autoEnabled);
  autoCheckbox.addEventListener("change", () => setAutoEnabled(autoCheckbox.checked));

  // VFO marker + click-to-tune. Assumes the band scope is in "center" mode
  // (BS3=0, the radio's default and the only mode this project sets up so
  // far) where the VFO
  // frequency is always exactly the middle of the displayed span; in
  // "fixed"/"auto-scroll" mode this mapping would be wrong, but this
  // project doesn't read or set BS3 yet so there's no way to tell which
  // mode is actually active. app.js calls hamrcSetWaterfallVFO on every
  // state update with the current VFO frequency and span.
  let vfoHz = null;
  let spanHz = null;

  // Target CSS pixel size for the corner frequency labels below. The
  // canvas's backing resolution (640 wide) is usually squeezed into a much
  // narrower on-screen width via the CSS `width:100%` scaling (see the
  // module comment at the top), so a fixed font size in backing-pixel units
  // would render at a different (and on a phone, illegibly tiny) CSS size
  // depending on the device. Scaling the backing-pixel font size by the
  // canvas's actual current display-vs-backing ratio keeps it at a
  // consistent, readable "very small" size regardless of screen width.
  // That consistent 11px was tuned for phone — on desktop, where the same
  // waterfall renders several times wider, a flat 11px CSS pixels reads as
  // tiny relative to the much bigger canvas around it (Nutzer-Report,
  // 2026-10-09: "im desktop viel zu klein, kann man nicht erkennen"). Scale
  // up past a certain display width instead of a flat constant; the divisor
  // is tuned so phone-width canvases still land on exactly 11 (unchanged)
  // and wider desktop ones grow from there — 48 rather than the original 60
  // (2026-10-09 follow-up: still read small/cramped at 1024px) so a ~960px
  // desktop canvas lands around 20px instead of 16px.
  function cornerLabelCssPx(displayWidthPx) {
    // The text is now drawn undistorted in CSS pixels (see drawOverlay), so a plain
    // size does: 11 on a phone, 13 on the desktop (next to the clock's 11/15 px).
    return displayWidthPx >= 700 ? 13 : 11;
  }
  // Must match .waterfall-wrap's border-radius (style.css) — keeps the
  // labels from sitting where the wrap's overflow:hidden rounded corner
  // would clip them, while still letting them sit as close to the top
  // edge as that allows (the operator wants them moved up).
  const WRAP_CORNER_RADIUS_CSS_PX = 14;

  // Moves the visual VFO position (vfoHz/imageCenterHz + the picture shift)
  // — factored out of window.hamrcSetWaterfallVFO below so the drag handler
  // can call it directly with a CONTINUOUS (non-snapped) frequency on every
  // pointer movement, instead of only the 0.5 kHz-quantized value that
  // reaches hamrcSetWaterfallVFO via the normal state-broadcast path
  // (Nutzer-Report, 2026-10-14: dragging stuttered because the picture only
  // ever moved in the same 500 Hz jumps the tuning itself is quantized to —
  // a few pixels at once instead of following the pointer smoothly; the
  // underlying shiftImages/shiftCarry math was already sub-pixel accurate,
  // it just never got fed anything finer than those jumps). The actually
  // TUNED frequency (digits, what's sent to the radio) stays quantized to
  // 0.5 kHz exactly as before — only this visual position decouples from
  // that during an active drag, which lineOffsetPx's existing
  // displayed-vs-confirmed-VFO handling already tolerates by design.
  function applyVfoPosition(hz, forceReset) {
    if (!scopeEnabled || imageCenterHz === null || forceReset || Math.abs(hz - imageCenterHz) >= spanHz) {
      if (scopeEnabled && imageCenterHz !== null && (forceReset || Math.abs(hz - imageCenterHz) >= spanHz)) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        spectrumCtx.clearRect(0, 0, spectrumWidth, spectrumHeight);
      }
      imageCenterHz = scopeEnabled ? hz : null;
      shiftCarry = 0;
      resetMaxHold();
      resetVerticalSmooth();
    } else if (hz !== imageCenterHz) {
      // the picture is fixed in frequency: tuning up moves it left
      const exact = ((imageCenterHz - hz) / spanHz) * width + shiftCarry;
      const dx = Math.round(exact);
      shiftCarry = exact - dx;
      shiftImages(dx);
      imageCenterHz = hz;
      // Max Hold is indexed by on-screen bin position, not absolute
      // frequency (see its own comment) — a shift invalidates it the same
      // way a full clear does. vSmoothLine is indexed by incoming bin
      // position instead (see its own comment) so it wouldn't strictly need
      // this, but resetting here too avoids smearing bins across a
      // (however slight) frequency-mapping drift during continuous tuning.
      resetMaxHold();
      resetVerticalSmooth();
    }
    vfoHz = hz;
  }

  // Dragging the scope itself (mouse or touch): the spectrum/waterfall follows
  // the pointer like a map, i.e. dragging right lowers the frequency. The VFO
  // is tuned live in 0.5 kHz steps relative to the frequency at drag start, so
  // the (re-centering) scope moves along naturally. A press without movement
  // stays a normal click-to-tune (click handler elsewhere).
  const DRAG_THRESHOLD_CSS_PX = 4;
  let drag = null; // {startX, startHz, moved} while a press is active
  let suppressClick = false;

  overlay.addEventListener("pointerdown", (event) => {
    if (!scopeEnabled || !vfoHz || !spanHz) return;
    drag = { startX: event.clientX, startHz: vfoHz, moved: false };
    overlay.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = overlay.getBoundingClientRect();
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_CSS_PX) return;
    drag.moved = true;
    suppressClick = true;
    const rawHz = drag.startHz - (dx / rect.width) * spanHz;
    // Visual: follows the pointer continuously, every pixel.
    applyVfoPosition(rawHz, false);
    drawOverlay();
    // Actual tuning: unchanged, still quantized to 0.5 kHz steps.
    const hz = Math.round(rawHz / 500) * 500;
    if (window.hamrcTuneToFreq) window.hamrcTuneToFreq(hz);
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    // The click event that follows pointerup must not tune a second time.
    setTimeout(() => (suppressClick = false), 0);
  }
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);
  // long press / right click on the scope: no context or callout menu
  overlay.addEventListener("contextmenu", (event) => event.preventDefault());

  // A very faint grid over the spectrum trace only (the top spectrumHeight rows of the
  // overlay), not over the waterfall below: 8 horizontal and 11 vertical lines
  // INCLUDING the outer edges (so 7 and 10 fields), evenly spaced, one CSS pixel thick
  // whatever the stretch of the canvas.
  const GRID_ROWS = 8;
  const GRID_COLUMNS = 11;
  function drawSpectrumGrid() {
    const rect = overlay.getBoundingClientRect();
    const sx = (rect.width || overlayWidth) / overlayWidth;
    const sy = (rect.height || overlayHeight) / overlayHeight;
    const lw = 1 / sx;
    const lh = 1 / sy;
    // The grid must end exactly where the REAL spectrum-canvas ends on screen, not
    // at this overlay's own spectrumHeight backing rows scaled by the single sy
    // above. The waterfall-canvas's backing resolution is deliberately NOT kept
    // proportional to its (shortened on phone) CSS height (see the 2026-10-12 note
    // on .waterfall-canvas in style.css: 176 backing rows, only 120 CSS px) — so
    // this overlay's own internal ratio (spectrumHeight : height, backing) doesn't
    // match the real on-screen ratio (spectrum-canvas height : waterfall-canvas
    // height) on phone, where they differ (70:120 real vs 70:176 backing — on
    // desktop they happen to coincide, 70:266 both ways, which is why this only
    // ever showed up on phone/iPhone, with no resize involved at all). A single
    // canvas can only be stretched by one uniform factor, so instead of assuming
    // spectrumHeight backing rows is already the right extent, convert the
    // spectrum-canvas's own (always accurate, 1:1) rendered CSS height back into
    // this overlay's backing rows via the same sy — the grid then lands exactly on
    // the real spectrum-canvas's edge regardless of any backing/CSS mismatch below.
    const specCssH = spectrum.getBoundingClientRect().height || spectrumHeight;
    const specRows = specCssH / sy;
    overlayCtx.save();
    overlayCtx.fillStyle = "rgba(255, 255, 255, 0.26)"; // first 0.07: barely visible, 0.17 still subtle (2026-10-12: "leicht mehr sichtbar")
    for (let i = 0; i < GRID_COLUMNS; i++) {
      // the last line sits inside the right edge, not outside the canvas
      const x = Math.round(((overlayWidth - lw) * i) / (GRID_COLUMNS - 1) * sx) / sx;
      overlayCtx.fillRect(x, 0, lw, specRows);
    }
    for (let j = 0; j < GRID_ROWS; j++) {
      const y = Math.round(((specRows - lh) * j) / (GRID_ROWS - 1) * sy) / sy;
      overlayCtx.fillRect(0, y, overlayWidth, lh);
    }
    overlayCtx.restore();
  }

  function drawOverlay() {
    syncScale();
    overlayCtx.clearRect(0, 0, overlayWidth, overlayHeight);
    // app.js calls hamrcSetWaterfallVFO (which calls this) on every state
    // broadcast regardless of scopeEnabled, so without this check the VFO
    // line/corner labels would get redrawn right back on top of the
    // otherwise-cleared canvases the next time any state update arrives
    // after turning the scope off — visible through the off-hint div, which
    // has no background of its own (just centered text).
    if (!scopeEnabled) return;
    drawSpectrumGrid();
    if (!vfoHz || !spanHz) return;
    // center mode: VFO is always the middle of the span — except while the
    // line is being dragged, then it follows the pointer.
    const x = overlayWidth / 2;
    overlayCtx.strokeStyle = "#ffe600";
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([4, 3]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, 0);
    overlayCtx.lineTo(x, overlayHeight);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);

    // RIT / XIT on: a thin dashed line at VFO + offset, green for RIT (receive
    // frequency) and red for XIT (transmit frequency). The radio has ONE offset
    // for both, so with both on the lines coincide: their dashes are shifted by
    // half a period so both colours stay visible. Not drawn outside the span.
    const markers = [];
    if (ritOffsetHz !== null) markers.push({ hz: ritOffsetHz, color: "#34c759", phase: 0 });
    if (xitOffsetHz !== null) markers.push({ hz: xitOffsetHz, color: "#ff3b30", phase: markers.length ? 3.5 : 0 });
    for (const m of markers) {
      const mx = Math.floor((0.5 + m.hz / spanHz) * overlayWidth) + 0.5; // pixel centre: crisp 1px line
      if (mx < 0 || mx > overlayWidth) continue;
      overlayCtx.strokeStyle = m.color;
      overlayCtx.lineWidth = 1; // one backing pixel: slim, stays solid however the canvas is stretched
      overlayCtx.setLineDash([4, 3]);
      overlayCtx.lineDashOffset = m.phase;
      overlayCtx.beginPath();
      overlayCtx.moveTo(mx, 0);
      overlayCtx.lineTo(mx, overlayHeight);
      overlayCtx.stroke();
    }
    overlayCtx.setLineDash([]);
    overlayCtx.lineDashOffset = 0;

    // Edge frequencies of the displayed span, tiny labels in the spectrum
    // area's top corners, same yellow as the VFO line above.
    const rect = overlay.getBoundingClientRect();
    const displayWidthPx = rect.width || overlayWidth;
    const displayHeightPx = rect.height || overlayHeight;
    const cssPx = cornerLabelCssPx(displayWidthPx);
    // The 640-px-wide backing canvas is stretched to the display by DIFFERENT
    // factors horizontally and vertically (wide on the desktop), which made
    // text drawn in backing pixels look pulled apart ("breit gezogen"). Draw in
    // CSS pixels instead: scale the context by the inverse of the stretch, so
    // one drawing unit is one CSS pixel on screen in both directions.
    const sx = displayWidthPx / overlayWidth;
    const sy = displayHeightPx / overlayHeight;
    // Keep clear of the wrap's rounded corner (clips x<radius AND y<radius):
    // push the label out horizontally past the radius, so it can sit right at the
    // top edge.
    const padX = WRAP_CORNER_RADIUS_CSS_PX + cssPx * 0.15;
    const padY = cssPx * 0.1;
    const loMHz = ((vfoHz - spanHz / 2) / 1e6).toFixed(3);
    const hiMHz = ((vfoHz + spanHz / 2) / 1e6).toFixed(3);
    overlayCtx.save();
    overlayCtx.scale(1 / sx, 1 / sy);
    overlayCtx.fillStyle = "#2b9fcc"; // the blue of the desktop clock (was yellow, like the VFO line)
    // same face as the desktop clock
    overlayCtx.font = `500 ${cssPx}px "Helvetica Neue", Arial, system-ui, sans-serif`;
    overlayCtx.textBaseline = "top";
    overlayCtx.textAlign = "left";
    overlayCtx.fillText(loMHz, padX, padY);
    overlayCtx.textAlign = "right";
    overlayCtx.fillText(hiMHz, displayWidthPx - padX, padY);
    overlayCtx.restore();
  }

  // Offset scale under the waterfall: the distance from the centre in kHz, one value per
  // tenth of the span (500 kHz span: 50 kHz steps, 200: 20, 100: 10, 50: 5, 20: 2, 10: 1,
  // 5: 0.5), the left half negative, the right half positive. Values only. Shown with the
  // spectrum; rebuilt when the span changes.
  const scaleEl = document.getElementById("wf-scale");
  let scaleSpanBuilt = 0;
  function syncScale() {
    const show = scopeEnabled && !!spanHz;
    scaleEl.style.visibility = show ? "visible" : "hidden"; // hidden, not removed: no layout jump
    if (!show || spanHz === scaleSpanBuilt) return;
    scaleSpanBuilt = spanHz;
    const stepKHz = spanHz / 10 / 1000;
    scaleEl.replaceChildren();
    for (let k = -5; k <= 5; k++) {
      const v = k * stepKHz;
      const label = document.createElement("span");
      label.textContent = v === 0 ? "0" : (v > 0 ? "+" : "\u2212") + Number(Math.abs(v).toFixed(2));
      label.style.left = `${((k + 5) / 10) * 100}%`;
      // the outer values stay inside the strip instead of hanging over its edges
      label.style.transform = k === -5 ? "none" : k === 5 ? "translateX(-100%)" : "translateX(-50%)";
      scaleEl.appendChild(label);
    }
  }

  // RIT offset in Hz while RIT is on, null while off (set by app.js).
  let ritOffsetHz = null;
  window.hamrcSetWaterfallRIT = function (offsetHz) {
    const v = offsetHz === null || offsetHz === undefined ? null : offsetHz;
    if (v === ritOffsetHz) return;
    ritOffsetHz = v;
    drawOverlay();
  };
  // Same for XIT (the radio shares one offset between RIT and XIT).
  let xitOffsetHz = null;
  window.hamrcSetWaterfallXIT = function (offsetHz) {
    const v = offsetHz === null || offsetHz === undefined ? null : offsetHz;
    if (v === xitOffsetHz) return;
    xitOffsetHz = v;
    drawOverlay();
  };

  window.hamrcSetWaterfallVFO = function (hz, span, confirmedHz) {
    const spanChanged = spanHz !== null && span !== spanHz;
    spanHz = span;
    radioHz = confirmedHz || hz;
    // While actively dragging, the pointermove handler above is already
    // driving the visual position continuously on every pixel of movement —
    // applying this call's (0.5 kHz-quantized) hz on top of that would fight
    // it, visible as the picture snapping backward between drag-driven
    // frames. Just keep vfoHz current for when the drag ends; the position
    // itself stays drag-driven until then.
    if (drag && drag.moved) {
      vfoHz = hz;
    } else {
      applyVfoPosition(hz, spanChanged);
    }
    drawOverlay();
  };

  overlay.addEventListener("click", (event) => {
    // While off, the offHint element on top has pointer-events:none (so it
    // doesn't itself block anything) — this overlay's own listener still
    // has to check scopeEnabled explicitly, or a click would tune the VFO
    // off a stale/blank display (Nutzer-Wunsch, 2026-09-28).
    if (!scopeEnabled) return;
    if (suppressClick) return;
    if (!vfoHz || !spanHz || !window.hamrcTuneToFreq) return;
    const rect = overlay.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    const leftEdgeHz = vfoHz - spanHz / 2;
    // Rounded to the nearest 0.5kHz (Nutzer-Wunsch, 2026-09-29, revised from
    // an initial full-kHz rounding) — a raw pixel-to-Hz mapping lands on
    // essentially arbitrary Hz values, which doesn't match how a VFO is
    // normally tuned by hand.
    const targetHz = Math.round((leftEdgeHz + fraction * spanHz) / 500) * 500;
    window.hamrcTuneToFreq(targetHz);
  });

  // Live breakpoint crossing (not just a fresh page load): the CSS display
  // size already follows the media query on its own (confirmed live — the
  // .waterfall-canvas/.waterfall-overlay height rules apply correctly right
  // away), but the canvas backing pixel resolution set above only ran once
  // at load. Left unsynced, every scale factor derived from
  // getBoundingClientRect() (the grid, VFO line, corner labels — see
  // drawSpectrumGrid/drawOverlay) ends up computed against a stale
  // overlayHeight, which pulls the spectrum portion of the overlay into
  // less vertical space than the spectrum-canvas it's supposed to sit over
  // (that one's own resolution never changes) — the real spectrum trace
  // then visibly spills past where the grid/off-hint expect it to end
  // (Nutzer-Report 2026-10-14/15: "Höhe des Spectrumbereiches grösser als früher",
  // only after live-resizing to mobile without a reload). Re-applying the
  // resolution this breakpoint should have, and clearing the old scroll
  // history (meaningless once drawn at a different resolution), makes a
  // live resize behave the same as the reload the old comment here used to
  // say was required.
  // Desktop, window higher than the page (Nutzer-Wunsch 2026-10-30): the panel then fills
  // the window and the waterfall grows with it, one canvas row per CSS pixel, up to
  // WATERFALL_MAX_ROWS. A lower window keeps the 266 rows and the wrap cuts the bottom off
  // (style.css). Growing/shrinking keeps the lines already drawn (the newest are at the top).
  const WATERFALL_MAX_ROWS = 800;
  function fitWaterfallToWindow() {
    if (!desktopQuery.matches) return;
    const wrap = canvas.parentElement;
    const avail = Math.round(wrap.clientHeight - spectrum.getBoundingClientRect().height);
    const rows = Math.max(waterfallRowsFor(true), Math.min(avail, WATERFALL_MAX_ROWS));
    if (rows !== height) {
      const old = document.createElement("canvas");
      old.width = width;
      old.height = height;
      old.getContext("2d").drawImage(canvas, 0, 0);
      height = rows;
      canvas.height = height; // resizing clears the canvas
      canvas.style.height = height + "px";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(old, 0, 0);
      overlayHeight = spectrumHeight + height;
      overlay.height = overlayHeight;
      resetVerticalSmooth();
      drawOverlay();
    }
    // The overlay covers the spectrum and the waterfall at their displayed sizes (the spectrum's height can be
    // dragged, see below, while its drawing keeps its 70 rows).
    const total = Math.round(spectrum.getBoundingClientRect().height + height) + "px";
    if (overlay.style.height !== total) {
      overlay.style.height = total;
      drawOverlay();
    }
  }
  // Draggable boundary between the spectrum and the waterfall (desktop, Nutzer-Wunsch 2026-10-31): the divider
  // strip sets --spectrum-h on the wrap; the waterfall takes the rest (fitWaterfallToWindow). Double click resets.
  const SPECTRUM_H_KEY = "open890rc.spectrumHeight";
  const SPECTRUM_H_DEFAULT = 70;
  const SPECTRUM_H_MIN = 40;
  const SPECTRUM_H_MAX = 300;
  const scopeWrap = canvas.parentElement;
  const divider = document.getElementById("scope-divider");
  function setSpectrumHeight(px, save) {
    const room = Math.max(SPECTRUM_H_MIN, scopeWrap.clientHeight - 100); // always leave a piece of waterfall
    const h = Math.round(Math.max(SPECTRUM_H_MIN, Math.min(SPECTRUM_H_MAX, room, px)));
    scopeWrap.style.setProperty("--spectrum-h", `${h}px`);
    if (save) {
      try {
        localStorage.setItem(SPECTRUM_H_KEY, String(h));
      } catch (e) {}
    }
    fitWaterfallToWindow();
    drawOverlay();
  }
  if (divider) {
    try {
      const saved = Number(localStorage.getItem(SPECTRUM_H_KEY));
      if (saved) setSpectrumHeight(saved, false);
    } catch (e) {}
    let dragFrom = null;
    divider.addEventListener("pointerdown", (e) => {
      dragFrom = { y: e.clientY, h: spectrum.getBoundingClientRect().height };
      divider.setPointerCapture(e.pointerId);
      divider.classList.add("dragging");
      e.preventDefault();
    });
    divider.addEventListener("pointermove", (e) => {
      if (dragFrom) setSpectrumHeight(dragFrom.h + (e.clientY - dragFrom.y), false);
    });
    const endDrag = () => {
      if (!dragFrom) return;
      dragFrom = null;
      divider.classList.remove("dragging");
      setSpectrumHeight(spectrum.getBoundingClientRect().height, true);
    };
    divider.addEventListener("pointerup", endDrag);
    divider.addEventListener("pointercancel", endDrag);
    divider.addEventListener("dblclick", () => setSpectrumHeight(SPECTRUM_H_DEFAULT, true));
  }
  if (window.ResizeObserver) new ResizeObserver(fitWaterfallToWindow).observe(canvas.parentElement);
  desktopQuery.addEventListener("change", () => {
    const newHeight = waterfallRowsFor(desktopQuery.matches);
    canvas.style.height = "";
    overlay.style.height = "";
    if (newHeight === height) return;
    height = newHeight;
    canvas.height = height;
    overlayHeight = spectrumHeight + height;
    overlay.height = overlayHeight;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    spectrumCtx.clearRect(0, 0, spectrumWidth, spectrumHeight);
    imageCenterHz = scopeEnabled ? vfoHz : null;
    shiftCarry = 0;
    resetMaxHold();
    resetVerticalSmooth();
    drawOverlay();
    fitWaterfallToWindow();
  });
})();
