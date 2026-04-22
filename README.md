# `<transcript-player>`

A tiny Web Component that plays video or audio and renders an interactive transcript file.

- Highlights the current word as the media plays  
- Marks all earlier words with a `before` class for distinct styling  
- Click any word to seek to that time (click the current word to toggle play/pause)  
- Auto-scrolls to keep the current word in view, with “Jump to current” indicators when you scroll away  
- Inserts a timestamp between transcript blocks  
- Optional `start-text` to jump to the first occurrence of some text in the transcript  

---

## Install / Use

This component is plain browser JavaScript (no build step required).

Install the module:

```sh
npm install transcript-player
```

Import the module once in your application:

```js
import 'transcript-player.js'
```

Then use it in HTML:

```html
<transcript-player
  src="/media/example.mp4"
  transcript="/captions/example.srt"
></transcript-player>
```

The same `src` attribute works for audio files:

```html
<transcript-player
  src="/media/example.mp3"
  transcript="/captions/example.srt"
></transcript-player>
```

To play only the audio track from a video file, add `audio-only`:

```html
<transcript-player
  src="/media/interview.mp4"
  transcript="/captions/interview.srt"
  audio-only
></transcript-player>
```

If you are using Vite/vue, you'll need to add `transcript-player` as
a custom component. If you are using a different framework search for
a similar way to add custom elements:

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: tag => {
            return tag === 'transcript-player'
          },
        }
      }
    })
  ]
})

```

You can also use the Vue wrapper export instead of rendering the custom
element directly:

```js
import { VueTranscriptPlayer } from 'transcript-player'
```

```vue
<script setup>
import { VueTranscriptPlayer } from 'transcript-player'
</script>

<template>
  <VueTranscriptPlayer
    src="/media/example.mp4"
    transcript="/captions/example.srt"
    disable-download
  />
</template>
```

---

## Attributes

### Transcript / Behavior

#### `transcript` (string)

URL to a transcript file.
When changed, the transcript reloads.

Supported transcript formats are detected in layers: explicit `transcript-type`,
response `Content-Type`, file extension, then file contents. SRT, WebVTT, and
WhisperX-style JSON transcripts are supported.

#### `transcript-type` (`srt` | `vtt` | `json`)

Optional explicit transcript type override.

#### `srt-url` (string)

Deprecated alias for `transcript`. It remains supported for compatibility.

#### `sentence-gap-seconds` (number, default: `0.6`)

Controls how word cues are grouped into sentences.  
Larger values create longer sentences.

#### `scroll-behavior` (`off` | `auto` | `smooth`, default: `smooth`)

Controls transcript auto-follow behavior.

- `off` → no automatic scrolling  
- `auto` → instant jumps  
- `smooth` → animated scrolling  

#### `start-text` (string)

When set, seeks to the first cue matching this text (via `findCueIndexForText`).  
Changing the attribute triggers a new seek.

---

### Media Attributes (Passthrough)

These map to the active internal media element:

- `src` → canonical media source for video or audio
- `video-src` → `video.src`
- `audio-src` → `audio.src`
- `audio-only` (boolean, default: off) → use audio-style controls and layout, even for video sources
- `poster`
- `controls` (boolean, default: on)
- `disable-download` (boolean, default: off)
- `muted`
- `loop`
- `playsinline` (boolean, default: on)
- `preload` (default: `metadata`)

`video-src` and `audio-src` remain supported for compatibility, but `src` is the
recommended API. When `src` is used, the component uses media metadata where
needed to distinguish video from audio. `audio-only` overrides detection.

Boolean attributes follow normal HTML rules:  
present = enabled, absent = disabled.

When `disable-download` is present, the component asks the browser to hide download
from built-in media controls where supported and blocks right-click on the active
media element. This is a UI restriction only, not DRM.

---

## Interaction

- **Seek:** click any word to jump to its timestamp and play  
- **Toggle play/pause:** click the currently active word  
- **Auto-follow:** remains enabled until the user scrolls away  
- **Jump to current:** appears when auto-follow is disabled  

---

## Styling

The component uses Shadow DOM. Three parts are exposed:

- `part="video"`
- `part="audio"`
- `part="scroll"`

Example:

```css
transcript-player::part(scroll) {
  border-top: 1px solid rgba(0,0,0,0.1);
}
```

---

## Notes

- Transcript files are loaded via `fetch()` (CORS rules apply).
- Active cue detection uses a linear scan over cues.
- Each word tooltip shows its start time as a formatted timecode.
- Timestamps are rendered between sentence blocks using the next block's start time.

---
