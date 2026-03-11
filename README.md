# `<transcript-player>`

A tiny Web Component that plays a video and renders an interactive transcript from an SRT file.

- Highlights the current word as the video plays  
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
  video-src="/media/example.mp4"
  srt-url="/captions/example.srt"
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
    video-src="/media/example.mp4"
    srt-url="/captions/example.srt"
  />
</template>
```

---

## Attributes

### Transcript / Behavior

#### `srt-url` (string)

URL to an `.srt` file.  
When changed, the transcript reloads.

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

### Video Attributes (Passthrough)

These map directly to the internal `<video>` element:

- `video-src` → `video.src`
- `poster`
- `controls` (boolean, default: on)
- `muted`
- `loop`
- `playsinline` (boolean, default: on)
- `preload` (default: `metadata`)

Boolean attributes follow normal HTML rules:  
present = enabled, absent = disabled.

---

## Interaction

- **Seek:** click any word to jump to its timestamp and play  
- **Toggle play/pause:** click the currently active word  
- **Auto-follow:** remains enabled until the user scrolls away  
- **Jump to current:** appears when auto-follow is disabled  

---

## Styling

The component uses Shadow DOM. Two parts are exposed:

- `part="video"`
- `part="scroll"`

Example:

```css
transcript-player::part(scroll) {
  border-top: 1px solid rgba(0,0,0,0.1);
}
```

---

## Notes

- SRT files are loaded via `fetch()` (CORS rules apply).
- Active cue detection uses a linear scan over cues.
- Each word tooltip shows its start time as a formatted timecode.
- Timestamps are rendered between sentence blocks using the next block's start time.

---
