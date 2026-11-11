import { useCallback, useEffect, useRef, useState } from 'react'

/** Hash routing: #/library/<id> → { page: 'library', param: '<id>' } */
export function parseHash(hash) {
  const parts = (hash || '').replace(/^#\/?/, '').split('/').filter(Boolean)
  return { page: parts[0] || 'dashboard', param: parts[1] ? decodeURIComponent(parts[1]) : null }
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((page, param) => {
    const next = `#/${page}${param ? `/${encodeURIComponent(param)}` : ''}`
    if (window.location.hash !== next) window.location.hash = next
    setRoute(parseHash(next))
  }, [])
  return [route, navigate]
}

/**
 * Poll an async loader. `interval` may be a function of the latest data (fast while busy,
 * slow when idle, 0 = stop).
 */
export function usePoll(loader, interval, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const timer = useRef(null)
  const alive = useRef(true)
  const loaderRef = useRef(loader)
  const intervalRef = useRef(interval)
  loaderRef.current = loader
  intervalRef.current = interval

  const refresh = useCallback(async () => {
    clearTimeout(timer.current)
    let latest = null
    try {
      latest = await loaderRef.current()
      if (alive.current) {
        setData(latest)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e)
    } finally {
      if (alive.current) {
        setLoading(false)
        const next = typeof intervalRef.current === 'function' ? intervalRef.current(latest) : intervalRef.current
        if (next) timer.current = setTimeout(refresh, next)
      }
    }
    return latest
  }, [])

  useEffect(() => {
    alive.current = true
    setLoading(true)
    refresh()
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, refresh, setData }
}
