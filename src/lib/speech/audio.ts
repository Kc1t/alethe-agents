/** Target sample rate for Parakeet / sherpa-onnx offline models. */
export const SPEECH_TARGET_SAMPLE_RATE = 16_000

export const DEFAULT_SPEECH_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

/** Linear resample Float32 PCM to `targetRate`. */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  targetRate: number,
): Float32Array {
  if (inputRate === targetRate || input.length === 0) {
    return input
  }
  const ratio = inputRate / targetRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = src - i0
    output[i] = input[i0]! * (1 - t) + input[i1]! * t
  }
  return output
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
