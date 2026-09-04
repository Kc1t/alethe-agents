import { useEffect, useRef, useState } from 'react'

/** Tracks whether the element `ref` should be attached to is near the viewport, using
 * `IntersectionObserver` with generous margins so content is ready slightly before it's actually
 * scrolled into view. Once true, stays true — an attachment that has already started/finished
 * downloading must not be torn down and re-fetched just because it scrolled back out of view. */
export function useInView<T extends Element>(rootMargin = '800px') {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return { ref, inView }
}
