import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../__screenshots__', import.meta.url))

/** Salva um PNG em e2e/__screenshots__/<nome>.png e retorna o caminho salvo. */
export async function captureScreenshot(name: string): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, `${name}.png`)
  await browser.saveScreenshot(path)
  return path
}
