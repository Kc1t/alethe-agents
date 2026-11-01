import table from '../../../src-tauri/assets/skills/alethe/prices.json'

export type ModelPrice = { input: number; output: number }

const PRICES: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(table.models as Record<string, { input?: unknown; output?: unknown }>)
    .filter(([, entry]) => typeof entry.input === 'number' && typeof entry.output === 'number')
    .map(([key, entry]) => [key, { input: entry.input as number, output: entry.output as number }]),
)

export function modelPrice(provider: string, model: string | null | undefined): ModelPrice | null {
  return model ? (PRICES[`${provider}/${model}`] ?? null) : null
}

export const formatUsd = (value: number) =>
  Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2).replace(/0$/, '')}`
