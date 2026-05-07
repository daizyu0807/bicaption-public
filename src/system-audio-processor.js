/**
 * AudioWorkletProcessor that collects system audio samples and posts
 * PCM float32 chunks to the main thread via MessagePort.
 *
 * Input: whatever sample rate the system provides (typically 48 kHz).
 * Output: float32 PCM at the original sample rate — resampling to 16 kHz
 *         is done in Python sidecar for simplicity and quality.
 */
class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    // Send chunks of ~20ms at 48 kHz = 960 samples.
    // At other rates this still works, just slightly different timing.
    this._chunkSize = 960;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    // Take first channel (mono).
    const channelData = input[0];

    // Append to buffer.
    const newBuf = new Float32Array(this._buffer.length + channelData.length);
    newBuf.set(this._buffer);
    newBuf.set(channelData, this._buffer.length);
    this._buffer = newBuf;

    // Send complete chunks.
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this.port.postMessage({ samples: chunk.buffer }, [chunk.buffer]);
      this._buffer = this._buffer.slice(this._chunkSize);
    }

    return true;
  }
}

registerProcessor('system-audio-processor', SystemAudioProcessor);
