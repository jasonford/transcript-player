import {
  parseSrtToCues,
  buildSentencesFromWordCues,
  formatSecondsToTimecode,
  findCueIndexForText
} from './utils/srt.js'

import { createScroller, targetScrollTop } from './utils/scroll.js'

class TranscriptPlayer extends HTMLElement {
  static get observedAttributes() {
    return [
      'srt-url',
      'sentence-gap-seconds',
      'scroll-behavior',
      'start-text',
      'video-src',
      'poster',
      'controls',
      'muted',
      'loop',
      'playsinline',
      'preload'
    ]
  }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })

    this._abortCtrl = null
    this._rafId = 0
    this._boundVideo = null

    this._cues = []
    this._sentences = []
    this._activeCueIndex = -1
    this._activeSentenceIndex = -1

    // remember last real cue so follow/indicator works during gaps
    this._lastFollowCueIndex = -1

    // start-text state
    this._lastStartTextApplied = ''

    this._sentenceEls = []
    this._wordElsByCue = new Map()

    this.videoEl = null

    // autoscroll state
    this._autoScrollEnabled = true
    this._programmaticScroll = 0
    this._userIntentUntil = 0

    // modular scroller
    this._scroller = createScroller()

    this._onTimeUpdate = this._onTimeUpdate.bind(this)
    this._onCaptionsClick = this._onCaptionsClick.bind(this)
    this._onScroll = this._onScroll.bind(this)
    this._onUserScrollIntent = this._onUserScrollIntent.bind(this)
    this._onIndicatorClick = this._onIndicatorClick.bind(this)

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          min-height: 0;
        }

        .root {
          height: 100%;
          width: 100%;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        video {
          width: 100%;
          height: auto;
          display: block;
          background: #000;
          aspect-ratio: 16 / 9;
          max-height: 60vh;
        }

        .captions-wrap {
          position: relative;
          flex: 1 1 auto;
          min-height: 140px;
        }

        .captions-scroll {
          height: 100%;
          overflow-y: auto;
          box-sizing: border-box;
        }

        .captions-scroll-inner {
          margin: auto;
          max-width: 512px;
          padding: 8px 10%;
        }

        .sentence {
          padding: 10px 8px;
          border-radius: 8px;
          line-height: 1.6;
          white-space: pre-wrap;
        }

        .sentence.active {
          background: rgba(0, 0, 0, 0.04);
        }

        .w {
          scroll-margin-top: 24px;
          cursor: pointer;
        }
        .w.inactive { opacity: 0.8; }
        .w.current {
          opacity: 1;
          font-weight: inherit;
          -webkit-text-stroke: 0;

          text-shadow:
            0.5px 0   0 currentColor,
           -0.5px 0   0 currentColor,
            0   0.5px 0 currentColor,
            0  -0.5px 0 currentColor;
        }

        .follow-indicator {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          z-index: 5;
          display: none;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(0,0,0,0.12);
          background: rgba(255,255,255,0.92);
          box-shadow: 0 6px 18px rgba(0,0,0,0.12);
          cursor: pointer;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
          font: inherit;
        }

        .follow-indicator[data-show="1"] { display: inline-flex; }

        .follow-indicator.top { top: 8px; }
        .follow-indicator.bottom { bottom: 8px; }

        .follow-indicator .arrow {
          font-size: 14px;
          line-height: 1;
        }

        .follow-indicator .label {
          font-size: 12px;
          opacity: 0.9;
          white-space: nowrap;
        }

        .sentence.active { text-decoration: underline; }
      </style>

      <div class="root">
        <video part="video"></video>

        <div class="captions-wrap">
          <button class="follow-indicator top" data-pos="top" data-show="0" type="button">
            <span class="arrow">↑</span>
            <span class="label">Jump to current</span>
          </button>

          <button class="follow-indicator bottom" data-pos="bottom" data-show="0" type="button">
            <span class="label">Jump to current</span>
            <span class="arrow">↓</span>
          </button>

          <div class="captions-scroll" part="scroll">
            <div class="captions-scroll-inner"></div>
          </div>
        </div>
      </div>
    `

    this._scrollEl = this.shadowRoot.querySelector('.captions-scroll')
    this._captionsEl = this.shadowRoot.querySelector('.captions-scroll-inner')
    this._indTop = this.shadowRoot.querySelector('.follow-indicator.top')
    this._indBottom = this.shadowRoot.querySelector('.follow-indicator.bottom')
    this.videoEl = this.shadowRoot.querySelector('video')
  }

  // ---- Public API ----

  get srtUrl() {
    return this.getAttribute('srt-url') || ''
  }
  set srtUrl(v) {
    if (v == null) this.removeAttribute('srt-url')
    else this.setAttribute('srt-url', String(v))
  }

  get sentenceGapSeconds() {
    const v = this.getAttribute('sentence-gap-seconds')
    const n = v == null ? 0.6 : Number(v)
    return Number.isFinite(n) ? n : 0.6
  }
  set sentenceGapSeconds(v) {
    if (v == null) this.removeAttribute('sentence-gap-seconds')
    else this.setAttribute('sentence-gap-seconds', String(v))
  }

  get scrollBehavior() {
    // 'off' | 'auto' | 'smooth'
    return (this.getAttribute('scroll-behavior') || 'smooth').toLowerCase()
  }
  set scrollBehavior(v) {
    if (v == null) this.removeAttribute('scroll-behavior')
    else this.setAttribute('scroll-behavior', String(v))
  }

  get startText() {
    return this.getAttribute('start-text') || ''
  }
  set startText(v) {
    if (v == null) this.removeAttribute('start-text')
    else this.setAttribute('start-text', String(v))
  }

  get videoSrc() {
    return this.getAttribute('video-src') || ''
  }
  set videoSrc(v) {
    if (v == null) this.removeAttribute('video-src')
    else this.setAttribute('video-src', String(v))
  }

  // ---- Lifecycle ----

  connectedCallback() {
    this._applyVideoAttributes()
    this._bindVideo()

    this._loadSrt(this.srtUrl).catch(() => this._reset())

    this._captionsEl?.addEventListener('click', this._onCaptionsClick)

    // user intent + scroll lock
    const sc = this._scrollEl
    sc?.addEventListener('scroll', this._onScroll, { passive: true })
    sc?.addEventListener('wheel', this._onUserScrollIntent, { passive: true })
    sc?.addEventListener('touchstart', this._onUserScrollIntent, { passive: true })
    sc?.addEventListener('pointerdown', this._onUserScrollIntent, { passive: true })
    sc?.addEventListener('keydown', this._onUserScrollIntent)

    this._indTop?.addEventListener('click', this._onIndicatorClick)
    this._indBottom?.addEventListener('click', this._onIndicatorClick)

    const v = this.videoEl
    if (v) this._updateActiveFromTime(v.currentTime || 0)
  }

  disconnectedCallback() {
    this._stopLoop()
    if (this._abortCtrl) this._abortCtrl.abort()
    this._unbindVideo()
    this._captionsEl?.removeEventListener('click', this._onCaptionsClick)

    const sc = this._scrollEl
    sc?.removeEventListener('scroll', this._onScroll)
    sc?.removeEventListener('wheel', this._onUserScrollIntent)
    sc?.removeEventListener('touchstart', this._onUserScrollIntent)
    sc?.removeEventListener('pointerdown', this._onUserScrollIntent)
    sc?.removeEventListener('keydown', this._onUserScrollIntent)

    this._indTop?.removeEventListener('click', this._onIndicatorClick)
    this._indBottom?.removeEventListener('click', this._onIndicatorClick)

    // hard stop media
    const v = this.videoEl
    if (v) {
      try { v.pause() } catch {}
      v.removeAttribute('src')
      v.load?.()
    }

    this._scroller.cancel()
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return

    if (name === 'srt-url') {
      this._loadSrt(this.srtUrl)
        .then(() => {
          const v = this.videoEl
          if (v) this._updateActiveFromTime(v.currentTime || 0)
        })
        .catch(() => this._reset())
      return
    }

    if (name === 'start-text') {
      this._maybeStartFromText(true)
      return
    }

    if (name === 'scroll-behavior') {
      this._updateFollowIndicators()
      return
    }

    if (name === 'sentence-gap-seconds') {
      this._sentences = buildSentencesFromWordCues(this._cues, this.sentenceGapSeconds)
      this._activeSentenceIndex = this._findSentenceIndexForCue(
        this._activeCueIndex >= 0 ? this._activeCueIndex : this._lastFollowCueIndex
      )
      this._render()
      this._updateFollowIndicators()
      return
    }

    if (
      name === 'video-src' ||
      name === 'poster' ||
      name === 'controls' ||
      name === 'muted' ||
      name === 'loop' ||
      name === 'playsinline' ||
      name === 'preload'
    ) {
      this._applyVideoAttributes()
      const v = this.videoEl
      if (v) this._updateActiveFromTime(v.currentTime || 0)
    }
  }

  _applyVideoAttributes() {
    const v = this.videoEl
    if (!v) return

    const src = this.videoSrc
    if (src) v.src = src
    else v.removeAttribute('src')

    const poster = this.getAttribute('poster')
    if (poster != null) v.setAttribute('poster', poster)
    else v.removeAttribute('poster')

    const boolAttr = (attr, onByDefault = false) => {
      const has = this.hasAttribute(attr)
      if (has || onByDefault) v.toggleAttribute(attr, has || onByDefault)
      else v.removeAttribute(attr)
    }

    boolAttr('controls', true)
    boolAttr('muted', false)
    boolAttr('loop', false)
    boolAttr('playsinline', true)

    const preload = this.getAttribute('preload')
    if (preload != null) v.setAttribute('preload', preload)
    else v.setAttribute('preload', 'metadata')
  }

  // ---- Video binding ----

  _bindVideo() {
    const v = this.videoEl
    if (v === this._boundVideo) return

    this._unbindVideo()
    this._boundVideo = v

    if (this._boundVideo) {
      this._boundVideo.addEventListener('timeupdate', this._onTimeUpdate, { passive: true })
      this._boundVideo.addEventListener('seeking', this._onTimeUpdate, { passive: true })
      this._boundVideo.addEventListener('loadedmetadata', this._onTimeUpdate, { passive: true })
      this._startLoop()
    } else {
      this._stopLoop()
    }
  }

  _unbindVideo() {
    if (!this._boundVideo) return
    this._boundVideo.removeEventListener('timeupdate', this._onTimeUpdate)
    this._boundVideo.removeEventListener('seeking', this._onTimeUpdate)
    this._boundVideo.removeEventListener('loadedmetadata', this._onTimeUpdate)
    this._boundVideo = null
  }

  _onTimeUpdate() {
    const v = this.videoEl
    if (!v) return
    this._updateActiveFromTime(v.currentTime)
  }

  _startLoop() {
    this._stopLoop()
    const tick = () => {
      const v = this.videoEl
      if (v && typeof v.currentTime === 'number') this._updateActiveFromTime(v.currentTime)
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }

  _stopLoop() {
    if (this._rafId) cancelAnimationFrame(this._rafId)
    this._rafId = 0
  }

  // ---- Follow target helpers ----

  _getFollowCueIndex() {
    return this._activeCueIndex >= 0 ? this._activeCueIndex : this._lastFollowCueIndex
  }

  // ---- Purposeful scrolling + indicators ----

  _onUserScrollIntent() {
    this._userIntentUntil = performance.now() + 1200
  }

  _onScroll() {
    if (this._programmaticScroll > 0) return
    if (!this._autoScrollEnabled) {
      this._updateFollowIndicators()
      return
    }

    if (performance.now() > this._userIntentUntil) return

    const sc = this._scrollEl
    const el = this._wordElsByCue.get(this._getFollowCueIndex())
    if (!sc || !el) return

    if (this._isOutOfView(sc, el)) {
      this._autoScrollEnabled = false
      this._updateFollowIndicators()
    }
  }

  _onIndicatorClick(e) {
    e.preventDefault()
    e.stopPropagation()

    this._autoScrollEnabled = true
    this._updateFollowIndicators()
    requestAnimationFrame(() => this._scrollActiveWordIntoView(true))
  }

  _setIndicator(el, show) {
    if (!el) return
    el.dataset.show = show ? '1' : '0'
  }

  _updateFollowIndicators() {
    const sc = this._scrollEl
    const el = this._wordElsByCue.get(this._getFollowCueIndex())

    if (!sc || !el || this._autoScrollEnabled || this.scrollBehavior === 'off') {
      this._setIndicator(this._indTop, false)
      this._setIndicator(this._indBottom, false)
      return
    }

    const sr = sc.getBoundingClientRect()
    const er = el.getBoundingClientRect()

    const above = er.top < sr.top
    const below = er.bottom > sr.bottom

    this._setIndicator(this._indTop, above)
    this._setIndicator(this._indBottom, below)
  }

  // ---- Click-to-seek ----

  _onCaptionsClick(e) {
    const target = e.target
    if (!(target instanceof Element)) return

    const wordEl = target.closest('span.w')
    if (!wordEl) return

    const cueIdx = this._cueIndexForWordEl(wordEl)
    if (cueIdx < 0) return

    const followCueIdx = this._getFollowCueIndex()
    const v = this.videoEl

    // toggle play/pause if active word clicked
    if (cueIdx === followCueIdx && v) {
      if (v.paused) {
        const p = v.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } else {
        v.pause()
      }
      return
    }

    this._seekToCue(cueIdx)
  }

  _cueIndexForWordEl(el) {
    for (const [cueIdx, wordEl] of this._wordElsByCue.entries()) {
      if (wordEl === el) return cueIdx
    }
    return -1
  }

  _seekToCue(cueIdx) {
    const v = this.videoEl
    const cue = this._cues[cueIdx]
    if (!v || !cue) return

    const t = Math.max(0, cue.start + 0.001)

    const doSeek = () => {
      v.currentTime = t
      const p = v.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
      this._updateActiveFromTime(v.currentTime)
    }

    if (Number.isFinite(v.duration) && v.duration > 0) {
      doSeek()
    } else {
      v.addEventListener('loadedmetadata', doSeek, { once: true, passive: true })
      v.load?.()
    }
  }

  // ---- start-text ----

  _maybeStartFromText(force = false) {
    const text = (this.startText || '').trim()
    if (!text) return
    if (!force && text === this._lastStartTextApplied) return
    if (!this._cues.length) return

    const cueIdx = findCueIndexForText(this._cues, text)
    if (cueIdx < 0) return

    this._lastStartTextApplied = text
    this._autoScrollEnabled = true
    this._seekToCue(cueIdx)
  }

  // ---- SRT loading ----

  async _loadSrt(url) {
    if (!url) {
      this._reset()
      return
    }

    if (this._abortCtrl) this._abortCtrl.abort()
    this._abortCtrl = new AbortController()

    const res = await fetch(url, { signal: this._abortCtrl.signal })
    if (!res.ok) throw new Error(`Failed to fetch SRT: ${res.status}`)
    const txt = await res.text()

    this._cues = parseSrtToCues(txt)
    this._sentences = buildSentencesFromWordCues(this._cues, this.sentenceGapSeconds)

    this._activeCueIndex = -1
    this._activeSentenceIndex = -1
    this._lastFollowCueIndex = -1

    this._render()
    this._updateFollowIndicators()

    // apply start-text after we have cues rendered
    this._maybeStartFromText()
  }

  _reset() {
    this._cues = []
    this._sentences = []
    this._activeCueIndex = -1
    this._activeSentenceIndex = -1
    this._lastFollowCueIndex = -1
    this._render()
    this._updateFollowIndicators()
  }

  // ---- Active cue/sentence tracking ----

  _findActiveCueIndex(t) {
    const arr = this._cues
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i]
      if (t >= c.start && t <= c.end) return i
    }
    return -1
  }

  _findSentenceIndexForCue(cueIdx) {
    if (cueIdx < 0) return -1
    for (let si = 0; si < this._sentences.length; si++) {
      const s = this._sentences[si]
      const first = s.words[0]?.cueIndex ?? -1
      const last = s.words[s.words.length - 1]?.cueIndex ?? -1
      if (cueIdx >= first && cueIdx <= last) return si
    }
    return -1
  }

  _updateActiveFromTime(t) {
    const ci = this._findActiveCueIndex(t)

    // keep a follow target during silent gaps
    if (ci >= 0) this._lastFollowCueIndex = ci

    if (ci !== this._activeCueIndex) {
      this._activeCueIndex = ci

      const followCue = this._getFollowCueIndex()
      const si = this._findSentenceIndexForCue(followCue)

      if (si !== this._activeSentenceIndex) {
        this._activeSentenceIndex = si
        this._render()
        requestAnimationFrame(() => this._scrollActiveWordIntoView())
      } else {
        this._updateWordClasses()
        requestAnimationFrame(() => this._scrollActiveWordIntoView())
      }
    } else {
      this._updateFollowIndicators()
    }
  }

  _isOutOfView(sc, el) {
    const sr = sc.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    return er.top < sr.top || er.bottom > sr.bottom
  }

  _scrollActiveWordIntoView(force = false) {
    const behaviorAttr = this.scrollBehavior
    if (behaviorAttr === 'off') return
    if (!this._autoScrollEnabled && !force) {
      this._updateFollowIndicators()
      return
    }

    const sc = this._scrollEl
    const el = this._wordElsByCue.get(this._getFollowCueIndex())
    if (!sc || !el) return

    if (!this._isOutOfView(sc, el) && !force) {
      this._updateFollowIndicators()
      return
    }

    const to = targetScrollTop(sc, el)
    const behavior = behaviorAttr === 'smooth' ? 'smooth' : 'auto'

    this._scroller.scrollTo(sc, to, {
      behavior,
      onStart: () => {
        this._programmaticScroll++
      },
      onEnd: () => {
        this._programmaticScroll = Math.max(0, this._programmaticScroll - 1)
        this._updateFollowIndicators()
      }
    })
  }

  // ---- Rendering ----

  _render() {
    const ce = this._captionsEl
    if (!ce) return

    const followCueIdx = this._getFollowCueIndex()

    ce.textContent = ''
    this._sentenceEls = []
    this._wordElsByCue = new Map()

    for (let si = 0; si < this._sentences.length; si++) {
      const s = this._sentences[si]
      const div = document.createElement('div')
      div.className = 'sentence' + (si === this._activeSentenceIndex ? ' active' : '')
      div.dataset.sentenceIndex = String(si)

      for (let wi = 0; wi < s.words.length; wi++) {
        const w = s.words[wi]
        const span = document.createElement('span')
        span.className = 'w ' + (w.cueIndex === followCueIdx ? 'current' : 'inactive')
        span.textContent = w.text + (wi !== s.words.length - 1 ? ' ' : '')
        span.title = formatSecondsToTimecode(w.start)

        div.appendChild(span)
        this._wordElsByCue.set(w.cueIndex, span)
      }

      ce.appendChild(div)
      this._sentenceEls[si] = div
    }
  }

  _updateWordClasses() {
    const si = this._activeSentenceIndex
    if (si < 0) return
    const el = this._sentenceEls[si]
    if (!el) return

    const followCueIdx = this._getFollowCueIndex()
    const spans = el.querySelectorAll('span.w')
    const sentence = this._sentences[si]

    for (let i = 0; i < spans.length; i++) {
      const cueIdx = sentence.words[i]?.cueIndex
      spans[i].className = 'w ' + (cueIdx === followCueIdx ? 'current' : 'inactive')

      const w = sentence.words[i]
      if (w) spans[i].title = formatSecondsToTimecode(w.start)
    }

    this._updateFollowIndicators()
  }
}

customElements.define('transcript-player', TranscriptPlayer)
