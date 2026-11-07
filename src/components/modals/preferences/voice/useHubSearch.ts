import { useCallback, useEffect, useRef, useState } from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import {
  HUB_ERROR,
  type HubSearchResult,
  speechHubResolve,
  speechHubSearch,
  type SpeechModelManifest,
} from '../../../../lib/tauri'
import { hubErrorKey } from '../../../../lib/voice/hubModels'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'

const DEBOUNCE_MS = 400
const MIN_QUERY = 2

const RESOLVE_CONCURRENCY = 2

const EAGER_RESOLVE = 10

type ResolveJob = { id: string; repo: string; generation: number }

type Params = {
  use: 'stt' | 'tts' | null
  query: string
  language: string | null
  sort: 'likes' | 'recent'

  enabled: boolean
}

export type HubSearchStatus = 'idle' | 'loading' | 'ready' | 'error'

function toManifest(result: HubSearchResult): SpeechModelManifest {
  return {
    id: result.id,
    label: result.label,
    description: '',
    language: result.hub.languages.join(','),
    sampleRate: 0,
    sizeBytes: result.hub.totalBytes ?? 0,
    recommended: false,
    kind: 'download',
    capability: result.use,
    source: 'huggingface',
    hub: result.hub,
  }
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function useHubSearch({ enabled, use, query: rawQuery, language, sort }: Params) {
  const query = rawQuery.trim().length >= MIN_QUERY ? rawQuery.trim() : ''
  const [results, setResults] = useState<SpeechModelManifest[]>([])
  const [status, setStatus] = useState<HubSearchStatus>(enabled ? 'loading' : 'idle')
  const [error, setError] = useState<MessageKey | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [resolving, setResolving] = useState<ReadonlySet<string>>(() => new Set())
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)

  const fetched = useRef(0)
  const loadingMore = useRef(false)

  const queue = useRef<ResolveJob[]>([])

  const inFlight = useRef(0)

  const claimed = useRef(new Set<string>())

  const unchecked = useRef(new Map<string, string>())

  const resolveJob = useCallback(async ({ id, repo, generation: current }: ResolveJob) => {
    try {
      const found = await speechHubResolve(repo)
      if (generation.current !== current) return
      const manifest = toManifest(found)
      rememberHubModels([manifest])
      setResults((all) => all.map((entry) => (entry.id === manifest.id ? manifest : entry)))
    } catch (cause) {
      if (generation.current !== current) return
      const message = reason(cause)
      if (
        message === HUB_ERROR.incompatible ||
        message === HUB_ERROR.tooLarge ||
        message === HUB_ERROR.gated
      ) {
        setResults((all) => all.filter((entry) => entry.id !== id))
      }
    } finally {
      if (generation.current === current) {
        setResolving((all) => {
          const rest = new Set(all)
          rest.delete(id)
          return rest
        })
      }
    }
  }, [])

  const pump = useCallback(
    function pump() {
      while (inFlight.current < RESOLVE_CONCURRENCY && queue.current.length > 0) {
        const job = queue.current.shift()!
        inFlight.current++
        void resolveJob(job).finally(() => {
          inFlight.current--
          pump()
        })
      }
    },
    [resolveJob],
  )

  const enqueue = useCallback(
    (rows: { id: string; repo: string }[], first = false) => {
      const fresh = rows.filter((row) => !claimed.current.has(row.id))
      if (fresh.length === 0) return
      const jobs = fresh.map((row) => {
        claimed.current.add(row.id)
        unchecked.current.delete(row.id)
        return { ...row, generation: generation.current }
      })
      queue.current = first ? [...jobs, ...queue.current] : [...queue.current, ...jobs]
      setResolving((all) => new Set([...all, ...jobs.map((job) => job.id)]))
      pump()
    },
    [pump],
  )

  const run = useCallback(
    async (offset: number, current: number) => {
      setStatus('loading')
      setError(null)
      try {
        const page = await speechHubSearch({ use, query, language, sort, offset })
        if (generation.current !== current) return
        const manifests = page.results.map(toManifest)
        rememberHubModels(manifests)
        fetched.current = offset + page.results.length
        setResults((all) => {
          if (offset === 0) return manifests
          const seen = new Set(all.map((entry) => entry.id))
          return [...all, ...manifests.filter((entry) => !seen.has(entry.id))]
        })
        setHasMore(page.hasMore)
        setStatus('ready')
        const pending = manifests.flatMap((model) =>
          model.hub && model.hub.commit === null ? [{ id: model.id, repo: model.hub.repo }] : [],
        )
        for (const row of pending) {
          if (!claimed.current.has(row.id)) unchecked.current.set(row.id, row.repo)
        }
        const eager = new Set(manifests.slice(0, EAGER_RESOLVE).map((model) => model.id))
        enqueue(pending.filter((row) => eager.has(row.id)))
      } catch (cause) {
        if (generation.current !== current) return
        setError(hubErrorKey(reason(cause)) ?? 'prefs.voiceHubFailed')
        setStatus('error')
      } finally {
        if (generation.current === current) loadingMore.current = false
      }
    },
    [use, query, language, sort, enqueue],
  )

  useEffect(() => {
    const current = ++generation.current
    setResults([])
    setResolving(new Set())
    setHasMore(false)
    queue.current = []
    claimed.current = new Set()
    unchecked.current = new Map()
    fetched.current = 0
    loadingMore.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (enabled) {
      setStatus('loading')
      timer = setTimeout(() => void run(0, current), DEBOUNCE_MS)
    } else {
      setStatus('idle')
    }
    return () => {
      clearTimeout(timer)
      queue.current = []
      generation.current = current + 1
    }
  }, [run, attempt, enabled])

  return {
    results,
    status,
    error,
    hasMore,
    resolving,
    loadMore: () => {
      if (loadingMore.current || status !== 'ready' || !hasMore) return
      loadingMore.current = true
      void run(fetched.current, generation.current)
    },
    retry: () => setAttempt((n) => n + 1),

    resolve: (id: string) => {
      const repo = unchecked.current.get(id)
      if (repo !== undefined) enqueue([{ id, repo }], true)
    },
  }
}
