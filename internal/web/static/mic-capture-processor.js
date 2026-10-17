// Deliberately minimal: forwards each render quantum's raw mic input
// straight to the main thread, with no resampling, framing, or format
// conversion here at all. That work (resampling to 16kHz if needed, and
// grouping into the radio's required 320-sample frames) happens in audio.js
// on the main thread instead — reusing the same continuous-phase resampler
// already proven for RX — so this worklet has as little logic as possible
// to rule out as a source of artifacts while diagnosing TX audio quality.
class MicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0];
    if (input) {
      const copy = new Float32Array(input);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);
