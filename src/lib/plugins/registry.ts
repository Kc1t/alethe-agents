import { useSyncExternalStore } from 'react'

import type {
  CommandContribution,
  Disposable,
  PaneContribution,
  SidebarTabContribution,
  ThemeContribution,
} from './types'

type Identified = { id: string }

/**
 * An ordered, owner-tagged collection of plugin contributions.
 *
 * The snapshot is rebuilt only on mutation so `useSyncExternalStore` sees a
 * stable reference between renders and does not loop.
 */
export class ContributionList<T extends Identified> {
  private readonly entries = new Map<string, { owner: string; value: T }>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly T[] = []

  add(owner: string, value: T): Disposable {
    if (this.entries.has(value.id)) {
      throw new Error(`contribution_id_taken:${value.id}`)
    }
    this.entries.set(value.id, { owner, value })
    this.refresh()
    return {
      dispose: () => {
        const current = this.entries.get(value.id)
        if (!current || current.owner !== owner) return
        this.entries.delete(value.id)
        this.refresh()
      },
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id)?.value
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  all(): readonly T[] {
    return this.snapshot
  }

  ownedBy(owner: string): readonly T[] {
    return [...this.entries.values()].filter((e) => e.owner === owner).map((e) => e.value)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): readonly T[] => this.snapshot

  private refresh() {
    this.snapshot = [...this.entries.values()].map((e) => e.value)
    for (const listener of this.listeners) listener()
  }
}

export const themeContributions = new ContributionList<ThemeContribution>()
export const paneContributions = new ContributionList<PaneContribution>()
export const sidebarTabContributions = new ContributionList<SidebarTabContribution>()
export const commandContributions = new ContributionList<CommandContribution>()

export function useContributions<T extends Identified>(list: ContributionList<T>): readonly T[] {
  return useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot)
}
