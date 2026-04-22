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
      'transcript',
      'srt-url',
      'transcript-type',
      'sentence-gap-seconds',
      'scroll-behavior',
      'start-text',
      'src',
      'video-src',
      'audio-src',
      'audio-only',
      'poster',
      'controls',
      'disable-download',
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
    this._pendingDetectionSrc = ''

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
    this.audioEl = null
    this.mediaEl = null

    // autoscroll state
    this._autoScrollEnabled = true
    this._programmaticScroll = 0
    this._userIntentUntil = 0

    // modular scroller
    this._scroller = createScroller()

    this._onTimeUpdate = this._onTimeUpdate.bind(this)
    this._onLoadedMetadata = this._onLoadedMetadata.bind(this)
    this._onMediaError = this._onMediaError.bind(this)
    this._onVideoContextMenu = this._onVideoContextMenu.bind(this)
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

        audio {
          display: none;
        }

        .root[data-media-kind="pending"] video,
        .root[data-media-kind="pending"] audio {
          display: none;
        }

        .root[data-media-kind="audio"] {
          overflow: hidden;
        }

        .root[data-media-kind="audio-fallback"] {
          overflow: hidden;
        }

        .root[data-media-kind="audio"] video {
          display: none;
        }

        .root[data-media-kind="audio-fallback"] audio {
          display: none;
        }

        .root[data-media-kind="audio"] audio {
          display: block;
          order: 2;
          flex: 0 0 auto;
          width: calc(100% - 32px);
          margin: 12px 16px 16px;
        }

        .root[data-media-kind="audio-fallback"] video {
          display: block;
          order: 2;
          flex: 0 0 auto;
          width: calc(100% - 32px);
          height: 54px;
          margin: 12px 16px 16px;
          aspect-ratio: auto;
          background: transparent;
        }

        .root[data-media-kind="audio"] .captions-wrap {
          order: 1;
          min-height: 0;
        }

        .root[data-media-kind="audio-fallback"] .captions-wrap {
          order: 1;
          min-height: 0;
        }

        .root[data-media-kind="audio"] .captions-scroll-inner {
          max-width: 760px;
          padding: 24px clamp(18px, 8%, 72px) 18px;
        }

        .root[data-media-kind="audio-fallback"] .captions-scroll-inner {
          max-width: 760px;
          padding: 24px clamp(18px, 8%, 72px) 18px;
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

        .timestamp {
          margin: 10px 8px 0;
          font-size: 12px;
          line-height: 1.2;
          opacity: 0.65;
          user-select: none;
        }

        .sentence.active {
          background: rgba(0, 0, 0, 0.04);
        }

        .w {
          scroll-margin-top: 24px;
          cursor: pointer;
        }
        .w.inactive { opacity: 0.8; }
        .w.before { opacity: 0.55; }
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
        <audio part="audio"></audio>

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
    this.audioEl = this.shadowRoot.querySelector('audio')
    this.mediaEl = this.videoEl
  }

  // ---- Public API ----

  get srtUrl() {
    return this.getAttribute('srt-url') || ''
  }
  set srtUrl(v) {
    if (v == null) this.removeAttribute('srt-url')
    else this.setAttribute('srt-url', String(v))
  }

  get transcript() {
    return this.getAttribute('transcript') || ''
  }
  set transcript(v) {
    if (v == null) this.removeAttribute('transcript')
    else this.setAttribute('transcript', String(v))
  }

  get transcriptType() {
    return (this.getAttribute('transcript-type') || '').toLowerCase()
  }
  set transcriptType(v) {
    if (v == null) this.removeAttribute('transcript-type')
    else this.setAttribute('transcript-type', String(v))
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

  get src() {
    return this.getAttribute('src') || ''
  }
  set src(v) {
    if (v == null) this.removeAttribute('src')
    else this.setAttribute('src', String(v))
  }

  get audioSrc() {
    return this.getAttribute('audio-src') || ''
  }
  set audioSrc(v) {
    if (v == null) this.removeAttribute('audio-src')
    else this.setAttribute('audio-src', String(v))
  }

  get audioOnly() {
    return this.hasAttribute('audio-only')
  }
  set audioOnly(v) {
    this.toggleAttribute('audio-only', Boolean(v))
  }

  get disableDownload() {
    return this.hasAttribute('disable-download')
  }
  set disableDownload(v) {
    this.toggleAttribute('disable-download', Boolean(v))
  }

  // ---- Lifecycle ----

  connectedCallback() {
    this._applyVideoAttributes()
    this._bindVideo()

    this._loadTranscript(this._transcriptSrc()).catch(() => this._reset())

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

    const v = this.mediaEl
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
    const v = this.mediaEl
    if (v) {
      try { v.pause() } catch {}
      v.removeAttribute('src')
      v.load?.()
    }
    for (const media of [this.videoEl, this.audioEl]) {
      if (!media || media === v) continue
      media.removeAttribute('src')
      media.load?.()
    }

    this._scroller.cancel()
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return

    if (name === 'transcript' || name === 'srt-url' || name === 'transcript-type') {
      this._loadTranscript(this._transcriptSrc())
        .then(() => {
          const v = this.mediaEl
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
      name === 'src' ||
      name === 'audio-src' ||
      name === 'audio-only' ||
      name === 'poster' ||
      name === 'controls' ||
      name === 'disable-download' ||
      name === 'muted' ||
      name === 'loop' ||
      name === 'playsinline' ||
      name === 'preload'
    ) {
      this._applyVideoAttributes()
      this._bindVideo()
      const v = this.mediaEl
      if (v) this._updateActiveFromTime(v.currentTime || 0)
    }
  }

  _applyVideoAttributes() {
    const root = this.shadowRoot.querySelector('.root')
    const src = this._mediaSrc()
    const kind = this._mediaKind(src)
    const v = kind === 'audio' ? this.audioEl : this.videoEl
    const inactive = kind === 'audio' ? this.videoEl : this.audioEl
    if (!v) return

    this.mediaEl = v
    if (root) root.dataset.mediaKind = kind

    if (src) v.src = src
    else v.removeAttribute('src')

    this._pendingDetectionSrc = kind === 'pending' ? src : ''

    if (inactive) {
      inactive.removeAttribute('src')
      inactive.load?.()
    }

    const poster = this.getAttribute('poster')
    if (this.videoEl) {
      if (poster != null && kind !== 'audio') this.videoEl.setAttribute('poster', poster)
      else this.videoEl.removeAttribute('poster')
    }

    this._applyPassthroughAttributes(v, kind)
  }

  _mediaSrc() {
    return this.src || this.audioSrc || this.videoSrc
  }

  _mediaKind(src = this._mediaSrc()) {
    if (!src) return 'video'
    if (this.audioOnly || (this.audioSrc && !this.src)) return 'audio'
    if (this._looksLikeAudioSrc(src)) return 'audio'
    if (this._looksLikeVideoSrc(src)) return 'video'
    return 'pending'
  }

  _looksLikeAudioSrc(src) {
    const path = String(src || '').split(/[?#]/, 1)[0].toLowerCase()
    return /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aif|aiff|wma)$/.test(path)
  }

  _looksLikeVideoSrc(src) {
    const path = String(src || '').split(/[?#]/, 1)[0].toLowerCase()
    return /\.(mp4|m4v|mov|webm|ogv|avi|mkv)$/.test(path)
  }

  _setMediaKind(kind) {
    const root = this.shadowRoot.querySelector('.root')
    if (root) root.dataset.mediaKind = kind
  }

  _switchMediaElement(kind, src = this._mediaSrc(), displayKind = kind) {
    const next = kind === 'audio' ? this.audioEl : this.videoEl
    const prev = this.mediaEl
    if (!next || next === prev) {
      this._setMediaKind(displayKind)
      return
    }

    const wasPaused = !prev || prev.paused
    const currentTime = prev?.currentTime || 0

    try { prev?.pause() } catch {}
    prev?.removeAttribute('src')
    prev?.load?.()

    this.mediaEl = next
    this._setMediaKind(displayKind)
    if (src) next.src = src
    else next.removeAttribute('src')
    this._applyPassthroughAttributes(next, displayKind)
    this._bindVideo()

    const applyTime = () => {
      if (Number.isFinite(currentTime) && currentTime > 0) next.currentTime = currentTime
      this._updateActiveFromTime(next.currentTime || currentTime || 0)
      if (!wasPaused) {
        const p = next.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      }
    }

    if (Number.isFinite(next.duration) && next.duration > 0) applyTime()
    else next.addEventListener('loadedmetadata', applyTime, { once: true, passive: true })
  }

  _applyPassthroughAttributes(v, kind) {
    const boolAttr = (attr, onByDefault = false) => {
      const has = this.hasAttribute(attr)
      if (has || onByDefault) v.toggleAttribute(attr, has || onByDefault)
      else v.removeAttribute(attr)
    }

    boolAttr('controls', true)
    boolAttr('muted', false)
    boolAttr('loop', false)
    if (kind !== 'audio' && kind !== 'audio-fallback') boolAttr('playsinline', true)
    else v.removeAttribute('playsinline')

    if (this.disableDownload) {
      v.setAttribute('controlslist', 'nodownload')
      v.controlsList?.add?.('nodownload')
    } else {
      v.removeAttribute('controlslist')
      v.controlsList?.remove?.('nodownload')
    }

    const preload = this.getAttribute('preload')
    if (preload != null) v.setAttribute('preload', preload)
    else v.setAttribute('preload', 'metadata')
  }

  // ---- Video binding ----

  _bindVideo() {
    const v = this.mediaEl
    if (v === this._boundVideo) return

    this._unbindVideo()
    this._boundVideo = v

    if (this._boundVideo) {
      this._boundVideo.addEventListener('timeupdate', this._onTimeUpdate, { passive: true })
      this._boundVideo.addEventListener('seeking', this._onTimeUpdate, { passive: true })
      this._boundVideo.addEventListener('loadedmetadata', this._onLoadedMetadata, { passive: true })
      this._boundVideo.addEventListener('error', this._onMediaError)
      this._boundVideo.addEventListener('contextmenu', this._onVideoContextMenu)
      this._startLoop()
    } else {
      this._stopLoop()
    }
  }

  _unbindVideo() {
    if (!this._boundVideo) return
    this._boundVideo.removeEventListener('timeupdate', this._onTimeUpdate)
    this._boundVideo.removeEventListener('seeking', this._onTimeUpdate)
    this._boundVideo.removeEventListener('loadedmetadata', this._onLoadedMetadata)
    this._boundVideo.removeEventListener('error', this._onMediaError)
    this._boundVideo.removeEventListener('contextmenu', this._onVideoContextMenu)
    this._boundVideo = null
  }

  _onTimeUpdate() {
    const v = this.mediaEl
    if (!v) return
    this._updateActiveFromTime(v.currentTime)
  }

  _onLoadedMetadata() {
    const v = this.mediaEl
    if (!v) return

    const src = this._mediaSrc()
    if (
      v === this.videoEl &&
      !this.audioOnly &&
      !(this.audioSrc && !this.src)
    ) {
      const hasVideo = v.videoWidth > 0 && v.videoHeight > 0
      this._pendingDetectionSrc = ''
      if (!hasVideo) {
        this._switchMediaElement('audio', src)
        return
      }
      this._setMediaKind('video')
    }

    this._updateActiveFromTime(v.currentTime || 0)
  }

  _onMediaError() {
    const src = this._mediaSrc()
    if (
      this.mediaEl === this.audioEl &&
      this.audioOnly &&
      src &&
      !this._looksLikeAudioSrc(src)
    ) {
      this._switchMediaElement('video', src, 'audio-fallback')
    }
  }

  _onVideoContextMenu(event) {
    if (!this.disableDownload) return
    event.preventDefault()
  }

  _startLoop() {
    this._stopLoop()
    const tick = () => {
      const v = this.mediaEl
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
    const v = this.mediaEl

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
    const v = this.mediaEl
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

  // ---- Transcript loading ----

  _transcriptSrc() {
    return this.transcript || this.srtUrl
  }

  async _loadTranscript(url) {
    if (!url) {
      this._reset()
      return
    }

    if (this._abortCtrl) this._abortCtrl.abort()
    this._abortCtrl = new AbortController()

    const res = await fetch(url, { signal: this._abortCtrl.signal })
    if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`)
    const txt = await res.text()
    const type = this._detectTranscriptType(url, res.headers.get('content-type'), txt)
    const cues = this._parseTranscript(txt, type)

    this._cues = cues
    this._sentences = buildSentencesFromWordCues(this._cues, this.sentenceGapSeconds)

    this._activeCueIndex = -1
    this._activeSentenceIndex = -1
    this._lastFollowCueIndex = -1

    this._render()
    this._updateFollowIndicators()

    // apply start-text after we have cues rendered
    this._maybeStartFromText()
  }

  _detectTranscriptType(url, contentType, text) {
    const declared = this.transcriptType
    if (declared) return declared

    const ct = String(contentType || '').toLowerCase()
    if (ct.includes('json')) return 'json'
    if (ct.includes('srt') || ct.includes('subrip')) return 'srt'
    if (ct.includes('vtt')) return 'vtt'

    const path = String(url || '').split(/[?#]/, 1)[0].toLowerCase()
    if (path.endsWith('.json')) return 'json'
    if (path.endsWith('.srt')) return 'srt'
    if (path.endsWith('.vtt')) return 'vtt'

    const trimmed = String(text || '').trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
    if (trimmed.startsWith('WEBVTT')) return 'vtt'
    if (/^\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(trimmed)) return 'srt'
    if (/\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(trimmed)) return 'srt'

    return 'srt'
  }

  _parseTranscript(text, type) {
    if (type === 'srt') return parseSrtToCues(text)
    if (type === 'vtt') return this._parseVttToCues(text)
    if (type === 'json') return this._parseJsonTranscript(text)
    throw new Error(`Unsupported transcript type: ${type}`)
  }

  _parseVttToCues(text) {
    const srtLike = String(text || '')
      .replace(/\r/g, '')
      .replace(/^WEBVTT[^\n]*(\n|$)/, '')
      .replace(/^\s*(NOTE|STYLE|REGION)[\s\S]*?(?=\n\s*\n|$)/gm, '')
      .trim()

    return parseSrtToCues(srtLike)
  }

  _parseJsonTranscript(text) {
    const data = JSON.parse(text)
    const candidates = []

    if (Array.isArray(data)) candidates.push(data)
    if (Array.isArray(data?.word_segments)) candidates.push(data.word_segments)
    if (Array.isArray(data?.words)) candidates.push(data.words)
    if (Array.isArray(data?.segments)) {
      const segmentWords = []
      for (const segment of data.segments) {
        if (Array.isArray(segment?.words)) segmentWords.push(...segment.words)
      }
      if (segmentWords.length) candidates.push(segmentWords)
      candidates.push(data.segments)
    }

    for (const candidate of candidates) {
      const cues = this._jsonItemsToCues(candidate)
      if (cues.length) return cues
    }

    return []
  }

  _jsonItemsToCues(items) {
    const cues = []

    for (const item of items) {
      if (!item || typeof item !== 'object') continue

      const start = Number(item.start ?? item.start_time ?? item.startTime)
      const end = Number(item.end ?? item.end_time ?? item.endTime)
      const text = String(item.word ?? item.text ?? item.caption ?? '').replace(/\s+/g, ' ').trim()

      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
      cues.push({ cueIndex: cues.length, start, end, text })
    }

    cues.sort((a, b) => a.start - b.start)
    for (let i = 0; i < cues.length; i++) cues[i].cueIndex = i
    return cues
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

  _wordClassName(cueIdx, followCueIdx) {
    if (cueIdx === followCueIdx) return 'w current'
    if (followCueIdx >= 0 && cueIdx < followCueIdx) return 'w before'
    return 'w inactive'
  }

  _render() {
    const ce = this._captionsEl
    if (!ce) return

    const followCueIdx = this._getFollowCueIndex()

    ce.textContent = ''
    this._sentenceEls = []
    this._wordElsByCue = new Map()

    for (let si = 0; si < this._sentences.length; si++) {
      const s = this._sentences[si]

      if (si > 0) {
        const timestamp = document.createElement('div')
        timestamp.className = 'timestamp'
        timestamp.textContent = formatSecondsToTimecode(s.start)
        ce.appendChild(timestamp)
      }

      const div = document.createElement('div')
      div.className = 'sentence' + (si === this._activeSentenceIndex ? ' active' : '')
      div.dataset.sentenceIndex = String(si)

      for (let wi = 0; wi < s.words.length; wi++) {
        const w = s.words[wi]
        const span = document.createElement('span')
        span.className = this._wordClassName(w.cueIndex, followCueIdx)
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
    const followCueIdx = this._getFollowCueIndex()
    for (let si = 0; si < this._sentenceEls.length; si++) {
      const el = this._sentenceEls[si]
      const sentence = this._sentences[si]
      if (!el || !sentence) continue

      el.className = 'sentence' + (si === this._activeSentenceIndex ? ' active' : '')

      const spans = el.querySelectorAll('span.w')
      for (let i = 0; i < spans.length; i++) {
        const cueIdx = sentence.words[i]?.cueIndex
        spans[i].className = this._wordClassName(cueIdx, followCueIdx)

        const w = sentence.words[i]
        if (w) spans[i].title = formatSecondsToTimecode(w.start)
      }
    }

    this._updateFollowIndicators()
  }
}

if (!customElements.get('transcript-player')) {
  customElements.define('transcript-player', TranscriptPlayer)
}

export { TranscriptPlayer }
export { VueTranscriptPlayer } from './transcript-player-vue.js'
