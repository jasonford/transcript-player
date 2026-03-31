const vuePropNames = [
  'srtUrl',
  'sentenceGapSeconds',
  'scrollBehavior',
  'startText',
  'videoSrc',
  'poster',
  'controls',
  'disableDownload',
  'muted',
  'loop',
  'playsinline',
  'preload'
]

const vuePropToAttr = {
  srtUrl: 'srt-url',
  sentenceGapSeconds: 'sentence-gap-seconds',
  scrollBehavior: 'scroll-behavior',
  startText: 'start-text',
  videoSrc: 'video-src',
  poster: 'poster',
  controls: 'controls',
  disableDownload: 'disable-download',
  muted: 'muted',
  loop: 'loop',
  playsinline: 'playsinline',
  preload: 'preload'
}

function buildVueWrapperAttrs(source, attrs = {}) {
  const merged = { ...attrs }

  for (const propName of vuePropNames) {
    const value = source[propName]
    if (value == null || value === false) continue

    const attrName = vuePropToAttr[propName]
    merged[attrName] = value === true ? '' : value
  }

  return merged
}

let vueRender = null
let vueRenderLoad = null
let vueRenderError = null

function ensureVueRender() {
  if (vueRender) return Promise.resolve(vueRender)
  if (vueRenderError) return Promise.reject(vueRenderError)
  if (!vueRenderLoad) {
    vueRenderLoad = import('vue')
      .then(({ h }) => {
        vueRender = h
        return h
      })
      .catch(error => {
        vueRenderError = error
        throw error
      })
  }

  return vueRenderLoad
}

export const VueTranscriptPlayer = {
  name: 'VueTranscriptPlayer',
  inheritAttrs: false,
  props: {
    srtUrl: String,
    sentenceGapSeconds: [Number, String],
    scrollBehavior: String,
    startText: String,
    videoSrc: String,
    poster: String,
    controls: Boolean,
    disableDownload: Boolean,
    muted: Boolean,
    loop: Boolean,
    playsinline: Boolean,
    preload: String
  },
  data() {
    return {
      vueReady: Boolean(vueRender)
    }
  },
  created() {
    if (this.vueReady) return

    ensureVueRender()
      .then(() => {
        this.vueReady = true
      })
      .catch(error => {
        throw error
      })
  },
  render() {
    if (vueRenderError) throw vueRenderError
    if (!vueRender) return null

    return vueRender(
      'transcript-player',
      buildVueWrapperAttrs(this, this.$attrs),
      this.$slots.default ? this.$slots.default() : undefined
    )
  }
}
