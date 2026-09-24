import mermaid from 'mermaid'
import { memo, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useT } from '../../lib/i18n'
import { openInBrowser } from '../../lib/tauri'
import styles from './MarkdownPane.module.css'

let mermaidTheme: 'dark' | 'default' | null = null

function ensureMermaid(dark: boolean) {
  const theme = dark ? 'dark' : 'default'
  if (mermaidTheme === theme) return
  mermaidTheme = theme
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    fontFamily: 'inherit',
  })
}

function MermaidDiagram({ code, dark }: { code: string; dark: boolean }) {
  const reactId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ensureMermaid(dark)

    const renderId = `mmd-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`
    mermaid
      .render(renderId, code)
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = svg
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [code, dark, reactId])

  if (error) {
    return (
      <pre className={styles.mermaidError}>
        <code>{error}</code>
      </pre>
    )
  }
  return <div ref={containerRef} className={styles.mermaid} />
}

export type MarkdownRendererProps = {
  content: string
  /** Tema escuro? Controla o tema do mermaid. */
  dark: boolean
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  dark,
}: MarkdownRendererProps) {
  const t = useT()
  const components: Components = {
    a({ href, children, ...props }) {
      const external = Boolean(href && /^https?:\/\//i.test(href))
      return (
        <a
          {...props}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
          title={external ? t('xterm.openInBrowser') : undefined}
          onClick={(event) => {
            if (!href || href.startsWith('#')) return
            event.preventDefault()
            if (external) void openInBrowser(href)
          }}
        >
          {children}
        </a>
      )
    },
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className ?? '')
      const lang = match?.[1]
      if (lang === 'mermaid') {
        return <MermaidDiagram code={String(children).replace(/\n$/, '')} dark={dark} />
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
  }
  return (
    <div className={styles.markdownBody}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
