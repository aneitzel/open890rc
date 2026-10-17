// Minimal ring-buffer playback: main thread pushes resampled Float32 chunks
// (already at this context's sample rate), process() drains them into the
// output a render-quantum at a time and pads with silence on underrun
// instead of glitching.
//
// TRIM_TRIGGER_SECONDS/TRIM_TARGET_SECONDS cap how much unplayed backlog
// this buffer will ever hold. Root-caused live (2026-09-28): this buffer
// previously had no upper bound at all — onmessage just kept appending,
// forever, regardless of how much unplayed audio was already queued. If
// network delivery is ever even slightly faster than real-time playback
// (bursty WS delivery, a brief main-thread stall during TX, etc.), nothing
// ever trimmed the backlog, so it could only ever grow — never shrink —
// across a whole session. Reported symptom matched exactly: RX audio ended
// up several seconds behind after a while, worst after TX phases, and
// switching to TX still played 2-3s of (already stale) queued RX audio in
// the background — that's this backlog draining, not live audio.
//
// First fix used a single threshold (trim back down to it the moment it was
// crossed) — reported live (2026-09-28) as making RX sound "leicht
// kratzig": dropping samples mid-waveform is an abrupt discontinuity
// (a click), and with only one threshold, any time the backlog naturally
// hovered right around it (ordinary jitter, not a real runaway), nearly
// EVERY incoming chunk re-triggered a trim — many small clicks in a row,
// heard as a scratchy texture. Fix: hysteresis, same technique as any
// jitter buffer — trimming only triggers once the backlog clearly runs away
// (TRIM_TRIGGER_SECONDS), and when it does, it cuts back down further
// (TRIM_TARGET_SECONDS) so normal jitter can't immediately re-trigger it.
// One bigger, rare skip instead of many small constant ones.
// Defaults; the Setup window sets the real values per browser (see the "config"
// message below and hamrcSetRxTrim in audio.js).
const TRIM_TRIGGER_SECONDS = 0.7;
const TRIM_TARGET_SECONDS = 0.1;

// Drift servo: radio and browser run on separate crystals, so the backlog
// slowly shrinks (or grows). With no pre-buffer it eventually hits zero and the
// output clicks at a constant interval. Instead of adding latency, nudge the
// read position by "sample slips": the buffer is read at the exact rate
// (integer steps, so no interpolation filter and no change of timbre), and once
// the accumulated drift correction reaches a whole sample, one sample is skipped
// or repeated, cross-faded over SLIP_FADE_SAMPLES. (A first version resampled
// continuously with linear interpolation; the fractional phase sweeping through
// 0..1 modulated the high frequencies and made voices sound metallic.)
// SERVO_TARGET_SECONDS is the target for the smoothed backlog. The packets
// already produce a 0..20ms sawtooth, so it adds no extra delay on top of that.
const SERVO_TARGET_SECONDS = 0.03;
const MAX_RATE_ADJUST = 0.002;
// Far above target (e.g. after the tab was throttled with the screen off and the
// backlog ballooned), drain faster: 0.5% is one slip per 200 samples (12 ms).
const CATCHUP_ERROR_SECONDS = 0.1;
const CATCHUP_RATE_ADJUST = 0.005;
const SERVO_GAIN = 0.2; // rate adjust per second of level error
const FADE_SAMPLES = 48; // declick ramp length on underrun/resume
const SLIP_FADE_SAMPLES = 32; // 2 ms cross-fade around a slipped sample
const RING_SECONDS = 8; // preallocated ring capacity
// A trim jumps the read position forward by hundreds of ms, a hard
// discontinuity (a click). Instead cross-fade from the old position to the new
// one over this many samples (20 ms at 16 kHz).
const TRIM_FADE_SAMPLES = 320;

// The buffer is a preallocated ring: no allocation or copying per incoming
// chunk. (An earlier version built a new Float32Array for every 20ms packet,
// which at a few hundred ms backlog meant ~1.6MB/s of garbage on the audio
// thread; the resulting GC pauses were heard as regular clicks.)
// writeCount/pos are absolute integer sample counters (exact far beyond any
// session length); the ring index is the counter modulo capacity.
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.round(sampleRate * RING_SECONDS);
    this.ring = new Float32Array(this.cap);
    this.writeCount = 0;
    this.pos = 0; // integer read position
    this.framesSinceReport = 0;
    this.triggerSeconds = TRIM_TRIGGER_SECONDS;
    this.targetSeconds = TRIM_TARGET_SECONDS;
    this.smoothedLevel = -1;
    this.slipAcc = 0; // accumulated drift correction in samples (+ = skip, - = repeat)
    this.gain = 0;
    this.lastOut = 0;
    this.underruns = 0;
    this.lastUnderrunLog = 0;
    this.slips = 0;
    this.xfPos = 0; // old read position still fading out after a jump (slip or trim)
    this.xfLeft = 0;
    this.xfTotal = 1;
    this.plain = false;

    this.port.onmessage = (event) => {
      const incoming = event.data;
      if (incoming && incoming.mode) {
        const plain = incoming.mode === "plain";
        if (plain !== this.plain) {
          this.plain = plain;
          this.xfLeft = 0;
          this.slipAcc = 0;
          this.smoothedLevel = -1;
        }
        return;
      }
      if (incoming && incoming.config) {
        const trigger = Number(incoming.config.trigger);
        const target = Number(incoming.config.target);
        if (trigger >= 0.2 && target >= 0.05 && target <= trigger - 0.05) {
          this.triggerSeconds = trigger;
          this.targetSeconds = target;
        }
        return;
      }
      if (incoming && incoming.flush) {
        this.pos = this.writeCount;
        this.smoothedLevel = -1;
        this.xfLeft = 0;
        return;
      }
      const n = incoming.length;
      for (let i = 0; i < n; i++) {
        this.ring[(this.writeCount + i) % this.cap] = incoming[i];
      }
      this.writeCount += n;
      // Never let the unread part exceed the ring (oldest samples are lost).
      const maxUnread = this.cap - 2;
      if (this.writeCount - this.pos > maxUnread) {
        this.pos = this.writeCount - maxUnread;
        this.xfLeft = 0;
      }

      const triggerSamples = Math.round(sampleRate * this.triggerSeconds);
      if (this.writeCount - this.pos > triggerSamples) {
        const before = (this.writeCount - this.pos) / sampleRate;
        if (!this.plain) {
          this.xfPos = Math.floor(this.pos); // old stream keeps fading out from here
          this.xfLeft = TRIM_FADE_SAMPLES;
          this.xfTotal = TRIM_FADE_SAMPLES;
        }
        this.pos = this.writeCount - Math.round(sampleRate * this.targetSeconds);
        this.port.postMessage({ trimmed: { before, after: this.targetSeconds } });
      }
    };
  }

  // Underrun log + level report, shared by both modes.
  finishBlock(len, underrun) {
    if (underrun) {
      this.underruns++;
      if (currentTime - this.lastUnderrunLog > 5) {
        this.lastUnderrunLog = currentTime;
        console.warn("rx audio underrun #" + this.underruns + " smoothedLevel=" + (this.smoothedLevel * 1000).toFixed(1) + "ms");
      }
    }
    this.framesSinceReport += len;
    if (this.framesSinceReport >= sampleRate / 10) {
      this.framesSinceReport = 0;
      this.port.postMessage({
        bufferedSeconds: Math.max(0, this.writeCount - this.pos) / sampleRate,
        underruns: this.underruns,
      });
    }
  }

  // "plain" mode (Servo slip switched off in Setup): the original behaviour
  // before any drift handling. Integer reads 1:1, silence on underrun, hard trim.
  processPlain(output) {
    const len = output.length;
    const ring = this.ring;
    const cap = this.cap;
    let underrun = false;
    for (let i = 0; i < len; i++) {
      if (this.pos < this.writeCount) {
        output[i] = ring[this.pos % cap];
        this.pos++;
      } else {
        underrun = true;
        output[i] = 0;
      }
    }
    this.finishBlock(len, underrun);
    return true;
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (this.plain) return this.processPlain(output);
    const len = output.length;
    const ring = this.ring;
    const cap = this.cap;
    const fadeStep = 1 / FADE_SAMPLES;

    // Servo: desired correction rate from the smoothed backlog (once per block).
    const level = (this.writeCount - this.pos) / sampleRate;
    if (this.smoothedLevel < 0) this.smoothedLevel = level;
    const alpha = len / sampleRate; // ~1s time constant
    this.smoothedLevel += (level - this.smoothedLevel) * alpha;
    const err = this.smoothedLevel - SERVO_TARGET_SECONDS;
    const limit = err > CATCHUP_ERROR_SECONDS ? CATCHUP_RATE_ADJUST : MAX_RATE_ADJUST;
    const adj = Math.max(-limit, Math.min(limit, err * SERVO_GAIN * (limit / MAX_RATE_ADJUST)));

    let underrun = false;
    for (let i = 0; i < len; i++) {
      // Slip: once the accumulated correction reaches a whole sample, skip one
      // (backlog too high) or repeat one (too low), cross-faded with the old
      // read position. Not while another cross-fade is still running.
      this.slipAcc += adj;
      if (this.xfLeft === 0 && (this.slipAcc >= 1 || this.slipAcc <= -1)) {
        const dir = this.slipAcc >= 1 ? 1 : -1;
        if (dir > 0 && this.pos + 3 < this.writeCount) {
          this.xfPos = this.pos;
          this.xfLeft = SLIP_FADE_SAMPLES;
          this.xfTotal = SLIP_FADE_SAMPLES;
          this.pos += 1;
          this.slipAcc -= 1;
          this.slips++;
        } else if (dir < 0) {
          this.xfPos = this.pos;
          this.xfLeft = SLIP_FADE_SAMPLES;
          this.xfTotal = SLIP_FADE_SAMPLES;
          this.pos -= 1;
          this.slipAcc += 1;
          this.slips++;
        } else {
          this.slipAcc = 0; // nothing to skip right now
        }
      }

      if (this.pos < this.writeCount) {
        let v = ring[this.pos % cap];
        if (this.xfLeft > 0) {
          const w = this.xfLeft / this.xfTotal; // 1 -> 0: old fades out, new fades in
          v = v * (1 - w) + ring[this.xfPos % cap] * w;
          this.xfPos++;
          this.xfLeft--;
        }
        this.gain = Math.min(1, this.gain + fadeStep);
        this.lastOut = v;
        output[i] = v * this.gain;
        this.pos++;
      } else {
        // No data: fade the last value out instead of a hard cut to zero.
        underrun = true;
        this.gain = Math.max(0, this.gain - fadeStep);
        output[i] = this.lastOut * this.gain;
      }
    }
    this.finishBlock(len, underrun);
    return true;
  }
}

registerProcessor("pcm-player-processor", PCMPlayerProcessor);
