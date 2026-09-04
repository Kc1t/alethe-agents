// Shrinks a profile picture (`Preferences.profileImageUrl`, a `data:` URI up to 2MB — see
// `ImageInput.tsx`'s `MAX_IMAGE_BYTES`) down to a small thumbnail before it's ever transmitted —
// both the pairing code (a pasteable string) and the live `avatar_update` relay envelope (16KB
// ciphertext ceiling, see `sync_security.rs`) need something far smaller than the source image.

const THUMBNAIL_MAX_DIMENSION = 96
const THUMBNAIL_JPEG_QUALITY = 0.72

/** Downscales a `data:` image URI to a small square-fit JPEG thumbnail, returned as its own
 * `data:image/jpeg;base64,...` URI. Resolves to `null` if `imageDataUrl` is empty/blank (no
 * picture set) or decoding fails — callers treat that the same as "no thumbnail". */
export async function downscaleAvatar(
  imageDataUrl: string | null | undefined,
): Promise<string | null> {
  const trimmed = imageDataUrl?.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null
  try {
    const image = await loadImage(trimmed)
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', THUMBNAIL_JPEG_QUALITY)
  } catch (cause) {
    console.error('[downscaleAvatar] failed', cause)
    return null
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image_load_failed'))
    image.src = src
  })
}
