/** Mic capture via MediaRecorder, converted to the 16 kHz mono 16-bit WAV whisper.cpp expects. */
const SAMPLE_RATE = 16_000

export interface VoiceRecording {
  /** Stop recording and return the WAV as base64. */
  readonly stop: () => Promise<string>
  /** Stop and discard. */
  readonly cancel: () => void
}

export const encodeWav = (samples: Float32Array): Uint8Array => {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => out.setUint8(offset + i, c.charCodeAt(0)))
  tag(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVEfmt ")
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, SAMPLE_RATE, true); out.setUint32(28, SAMPLE_RATE * 2, true)
  out.setUint16(32, 2, true); out.setUint16(34, 16, true); tag(36, "data"); out.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true))
  return new Uint8Array(out.buffer)
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const blobToWavBase64 = async (blob: Blob): Promise<string> => {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  return toBase64(encodeWav((await offline.startRendering()).getChannelData(0)))
}

export const startRecording = async (): Promise<VoiceRecording> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => chunks.push(event.data)
  const release = () => stream.getTracks().forEach((track) => track.stop())
  recorder.start()
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = () => {
          release()
          blobToWavBase64(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject)
        }
        recorder.stop()
      }),
    cancel: () => {
      recorder.onstop = release
      if (recorder.state !== "inactive") recorder.stop()
      else release()
    }
  }
}
