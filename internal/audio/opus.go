package audio

import (
	"fmt"

	"github.com/thesyncim/gopus"
)

// OpusBitrate is the target bitrate for the low-bandwidth ("mobile") stream.
// Tuned for narrowband voice, not music: intelligible SSB/CW audio doesn't
// need much more than this over a mobile connection.
const OpusBitrate = 16000

// OpusEncoder wraps a gopus encoder configured for the radio's mono 16kHz
// PCM. It is not safe for concurrent use — callers must serialize calls to
// Encode, same as the underlying gopus.Encoder requires.
type OpusEncoder struct {
	enc *gopus.Encoder
	buf []byte
}

// NewOpusEncoder creates an encoder tuned for low-bitrate speech.
func NewOpusEncoder() (*OpusEncoder, error) {
	enc, err := gopus.NewEncoder(gopus.EncoderConfig{
		SampleRate:  SampleRate,
		Channels:    1,
		Application: gopus.ApplicationVoIP,
	})
	if err != nil {
		return nil, fmt.Errorf("creating opus encoder: %w", err)
	}
	if err := enc.SetBitrate(OpusBitrate); err != nil {
		return nil, fmt.Errorf("setting opus bitrate: %w", err)
	}
	return &OpusEncoder{enc: enc, buf: make([]byte, 4000)}, nil
}

// Encode takes one frame of raw little-endian 16-bit PCM (as received from
// the radio) and returns an Opus packet. Opus only accepts specific frame
// durations (2.5/5/10/20/40/60ms); a payload that doesn't line up with one
// of those at 16kHz returns an error instead of a packet, so the caller can
// just skip that frame for the Opus stream while the raw PCM stream keeps
// working unaffected.
func (o *OpusEncoder) Encode(pcmLE []byte) ([]byte, error) {
	samples := make([]int16, len(pcmLE)/2)
	for i := range samples {
		samples[i] = int16(pcmLE[i*2]) | int16(pcmLE[i*2+1])<<8
	}

	n, err := o.enc.EncodeInt16(samples, o.buf)
	if err != nil {
		return nil, fmt.Errorf("opus encode: %w", err)
	}

	out := make([]byte, n)
	copy(out, o.buf[:n])
	return out, nil
}

// maxOpusFrameSamples is sized for the largest frame Opus can produce at
// 16kHz (120ms), well above the 20ms frames the browser actually sends —
// erring large avoids a buffer-too-small error if the encoder ever picks a
// different frame duration.
const maxOpusFrameSamples = 16000 / 1000 * 120

// OpusDecoder wraps a gopus decoder for decoding the browser's mic-audio
// Opus stream back to raw PCM before relaying it to the radio. Not safe for
// concurrent use — each TX connection needs its own instance, since the
// decoder keeps state across packets.
type OpusDecoder struct {
	dec *gopus.Decoder
	pcm []int16
}

// NewOpusDecoder creates a decoder matching the mono 16kHz stream the
// browser's WebCodecs AudioEncoder produces for mic audio.
func NewOpusDecoder() (*OpusDecoder, error) {
	dec, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, 1))
	if err != nil {
		return nil, fmt.Errorf("creating opus decoder: %w", err)
	}
	return &OpusDecoder{dec: dec, pcm: make([]int16, maxOpusFrameSamples)}, nil
}

// Decode takes one Opus packet and returns the decoded 16-bit PCM samples.
// The returned slice is only valid until the next call — copy it if the
// caller needs to hold onto it.
func (o *OpusDecoder) Decode(packet []byte) ([]int16, error) {
	n, err := o.dec.DecodeInt16(packet, o.pcm)
	if err != nil {
		return nil, fmt.Errorf("opus decode: %w", err)
	}
	return o.pcm[:n], nil
}
