
export function parseTimeToSeconds(t) {
  const m = String(t).trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/)
  if (!m) return 0
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = Number(m[3])
  const ms = Number(m[4].padEnd(3, '0').slice(0, 3))
  return hh * 3600 + mm * 60 + ss + ms / 1000
}

export function formatSecondsToTimecode(t) {
  const sec = Math.max(0, Number(t) || 0)
  const hh = Math.floor(sec / 3600)
  const mm = Math.floor((sec % 3600) / 60)
  const ss = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  const pad2 = n => String(n).padStart(2, '0')
  const pad3 = n => String(n).padStart(3, '0')
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`
}

export function parseSrtToCues(srt) {
  const blocks = String(srt).replace(/\r/g, '').trim().split(/\n\s*\n/)
  const out = []
  let cueIndex = 0

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd())
    if (lines.length < 2) continue

    let li = 0
    if (/^\d+$/.test(lines[0].trim())) li = 1

    const timeLine = lines[li]
    const m = timeLine.match(/(.+?)\s*-->\s*(.+?)(\s+.*)?$/)
    if (!m) continue

    const start = parseTimeToSeconds(m[1])
    const end = parseTimeToSeconds(m[2])

    const text = lines.slice(li + 1).join('\n').trim()
    if (!text) continue

    out.push({
      cueIndex,
      start,
      end,
      text: text.replace(/\s+/g, ' ').trim()
    })
    cueIndex++
  }

  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length; i++) out[i].cueIndex = i
  return out
}

export function isTerminalWord(word) {
  return /[.!?]["')\]]*$/.test(word)
}

export function buildSentencesFromWordCues(wordCues, sentenceGapSeconds = 0.6) {
  const sents = []
  let cur = null
  let sid = 1

  for (let i = 0; i < wordCues.length; i++) {
    const c = wordCues[i]
    const prev = i > 0 ? wordCues[i - 1] : null
    const gap = prev ? (c.start - prev.end) : 0

    const shouldBreak =
      !cur ||
      gap >= sentenceGapSeconds ||
      (cur && cur.words.length > 0 && isTerminalWord(cur.words[cur.words.length - 1].text))

    if (shouldBreak) {
      if (cur && cur.words.length) sents.push(cur)
      cur = { id: sid++, start: c.start, end: c.end, words: [] }
    }

    cur.words.push({ cueIndex: c.cueIndex, start: c.start, end: c.end, text: c.text })
    cur.end = c.end
  }

  if (cur && cur.words.length) sents.push(cur)
  return sents
}

/* -------- start-text matching -------- */

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// returns the first cueIndex where phrase begins, or -1
export function findCueIndexForText(cues, phrase) {
  const needle = normalize(phrase).split(' ').filter(Boolean)
  if (!needle.length) return -1

  const hay = cues.map(c => normalize(c.text))

  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return cues[i]?.cueIndex ?? i
  }

  return -1
}
