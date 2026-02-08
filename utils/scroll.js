export function targetScrollTop(sc, el) {
  const sr = sc.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  return sc.scrollTop + (er.top - sr.top)
}

export function createScroller(opts = {}) {
  const prefersReducedMotion =
    opts.prefersReducedMotion ||
    (() => matchMedia('(prefers-reduced-motion: reduce)').matches)

  const minMs = Number.isFinite(opts.minMs) ? opts.minMs : 140
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 360

  // duration = 140 + sqrt(dist) * sqrtK, clamped to [minMs, maxMs]
  const sqrtK = Number.isFinite(opts.sqrtK) ? opts.sqrtK : 14

  let cancelFn = null

  function cancel() {
    if (cancelFn) cancelFn()
  }

  function scrollTo(sc, to, cfg = {}) {
    const behavior = (cfg.behavior || 'auto').toLowerCase()
    const onStart = typeof cfg.onStart === 'function' ? cfg.onStart : () => {}
    const onEnd = typeof cfg.onEnd === 'function' ? cfg.onEnd : () => {}

    // cancel any prior smooth animation
    if (cancelFn) cancelFn()
    cancelFn = null

    const from = sc.scrollTop
    const dist = Math.abs(to - from)

    // nothing to do
    if (dist < 1) {
      onStart()
      sc.scrollTop = to
      requestAnimationFrame(() => onEnd())
      return
    }

    // auto or reduced motion => jump
    if (behavior !== 'smooth' || prefersReducedMotion()) {
      onStart()
      sc.scrollTop = to
      requestAnimationFrame(() => onEnd())
      return
    }

    // smooth with sublinear duration growth => long jumps are effectively faster
    const duration = Math.max(minMs, Math.min(maxMs, 140 + Math.sqrt(dist) * sqrtK))
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3)

    let raf = 0
    let done = false
    const start = performance.now()

    onStart()

    cancelFn = () => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      cancelFn = null
      onEnd()
    }

    const tick = now => {
      if (done) return
      const t = Math.min(1, (now - start) / duration)
      const k = easeOutCubic(t)
      sc.scrollTop = from + (to - from) * k

      if (t < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        done = true
        cancelFn = null
        onEnd()
      }
    }

    raf = requestAnimationFrame(tick)
  }

  return {
    scrollTo,
    cancel,
    get isAnimating() {
      return !!cancelFn
    }
  }
}
