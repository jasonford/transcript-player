#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-whisperx-local}"
MODEL="${MODEL:-large-v3}"
DEVICE="${DEVICE:-auto}"              # auto, cuda, cpu
CACHE_DIR="${CACHE_DIR:-$PWD/.whisperx-cache}"
BUILD_DIR="${BUILD_DIR:-$PWD/.whisperx-build}"
NO_NETWORK="${NO_NETWORK:-0}"
DOCKER_USER="${DOCKER_USER:-1}"
REBUILD_IMAGE="${REBUILD_IMAGE:-0}"

INPUT_PATH="${1:-}"
if [[ -z "$INPUT_PATH" ]]; then
  echo "usage: $0 /path/to/input.(wav|mp3|m4a|mp4|mkv|...)" >&2
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need_cmd docker
need_cmd python3

INPUT_ABS="$(python3 - <<'PY' "$INPUT_PATH"
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)"

if [[ ! -f "$INPUT_ABS" ]]; then
  echo "input file not found: $INPUT_ABS" >&2
  exit 1
fi

INPUT_DIR="$(dirname "$INPUT_ABS")"
INPUT_FILE="$(basename "$INPUT_ABS")"
INPUT_STEM="${INPUT_FILE%.*}"

mkdir -p "$CACHE_DIR" "$BUILD_DIR"

CACHE_ABS="$(python3 - <<'PY' "$CACHE_DIR"
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)"

BUILD_ABS="$(python3 - <<'PY' "$BUILD_DIR"
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)"

DOCKERFILE_PATH="$BUILD_ABS/Dockerfile.whisperx"

JSON_PATH="$PWD/$INPUT_STEM.json"
SRT_PATH="$PWD/$INPUT_STEM.oneword.srt"

normalize_language() {
  local raw="${1:-}"

  if [[ -z "$raw" ]]; then
    echo ""
    return
  fi

  raw="${raw%%:*}"
  raw="${raw%%,*}"
  raw="${raw,,}"
  raw="${raw%%.*}"
  raw="${raw%%_*}"
  raw="${raw%%-*}"

  echo "$raw"
}

RAW_LANGUAGE="${WHISPER_LANGUAGE:-${LANGUAGE:-}}"
WHISPER_LANG="$(normalize_language "$RAW_LANGUAGE")"

GPU_FLAG=()
RESOLVED_DEVICE="$DEVICE"

if [[ "$DEVICE" == "auto" ]]; then
  if docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
    RESOLVED_DEVICE="cuda"
    GPU_FLAG=(--gpus all)
  else
    RESOLVED_DEVICE="cpu"
  fi
elif [[ "$DEVICE" == "cuda" ]]; then
  GPU_FLAG=(--gpus all)
elif [[ "$DEVICE" == "cpu" ]]; then
  :
else
  echo "DEVICE must be one of: auto, cuda, cpu" >&2
  exit 1
fi

if [[ "$RESOLVED_DEVICE" == "cpu" && "$MODEL" == "large-v3" ]]; then
  MODEL="medium"
fi

if [[ "$RESOLVED_DEVICE" == "cpu" ]]; then
  COMPUTE_TYPE="${COMPUTE_TYPE:-int8}"
else
  COMPUTE_TYPE="${COMPUTE_TYPE:-float16}"
fi

if [[ "$REBUILD_IMAGE" == "1" ]]; then
  docker image rm -f "$IMAGE_NAME" >/dev/null 2>&1 || true
fi

if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  cat > "$DOCKERFILE_PATH" <<'DOCKERFILE'
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_NO_CACHE_DIR=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    git \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --upgrade pip

RUN pip3 install --index-url https://download.pytorch.org/whl/cu121 \
    torch torchaudio

RUN pip3 install whisperx

RUN pip3 uninstall -y torchvision || true

WORKDIR /work
ENTRYPOINT ["whisperx"]
DOCKERFILE

  echo "building Docker image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" -f "$DOCKERFILE_PATH" "$BUILD_ABS"
fi

DOCKER_ARGS=(
  run
  --rm
  --init
  --cap-drop=ALL
  --security-opt=no-new-privileges:true
  --pids-limit=256
  --tmpfs /tmp:rw,noexec,nosuid,size=2g
  -v "$INPUT_DIR:/input:ro"
  -v "$PWD:/output:rw"
  -v "$CACHE_ABS:/cache:rw"
  -e HF_HOME=/cache
  -e XDG_CACHE_HOME=/cache
  -e HOME=/tmp
  -e XDG_CONFIG_HOME=/tmp/.config
  -e MPLCONFIGDIR=/tmp/matplotlib
  -e NUMBA_CACHE_DIR=/tmp/numba
  -e PYTHONUNBUFFERED=1
  -e PYTHONWARNINGS=ignore::ResourceWarning
  -e TRANSFORMERS_NO_TORCHVISION=1
)

if [[ -n "${HF_TOKEN:-}" ]]; then
  DOCKER_ARGS+=(-e "HF_TOKEN=$HF_TOKEN")
fi

if [[ "$NO_NETWORK" == "1" ]]; then
  DOCKER_ARGS+=(--network none)
fi

if [[ "$DOCKER_USER" == "1" ]]; then
  DOCKER_ARGS+=(--user "$(id -u):$(id -g)")
fi

if [[ "${#GPU_FLAG[@]}" -gt 0 ]]; then
  DOCKER_ARGS+=("${GPU_FLAG[@]}")
fi

WHISPER_ARGS=(
  "/input/$INPUT_FILE"
  --model "$MODEL"
  --device "$RESOLVED_DEVICE"
  --compute_type "$COMPUTE_TYPE"
  --vad_method silero
  --print_progress True
  --verbose True
  --output_dir /output
  --output_format json
)

if [[ -n "$WHISPER_LANG" ]]; then
  WHISPER_ARGS+=(--language "$WHISPER_LANG")
fi

echo "running WhisperX on: $INPUT_ABS"
echo "device:   $RESOLVED_DEVICE"
echo "model:    $MODEL"
if [[ -n "$WHISPER_LANG" ]]; then
  echo "language: $WHISPER_LANG"
else
  echo "language: auto"
fi
echo "compute:  $COMPUTE_TYPE"
echo "vad:      silero"
echo
echo "---- transcription + alignment in Docker ----"

docker "${DOCKER_ARGS[@]}" \
  --entrypoint /bin/bash \
  "$IMAGE_NAME" \
  -lc '
set -euo pipefail

input_stem="$1"
shift

whisperx "$@"

json_path="/output/${input_stem}.json"
srt_path="/output/${input_stem}.oneword.srt"

if [[ ! -f "$json_path" ]]; then
  echo "expected WhisperX JSON was not created: $json_path" >&2
  exit 1
fi

echo
echo "---- JSON -> one-word SRT in Docker ----"

python3 - <<'"'"'PY'"'"' "$json_path" "$srt_path"
import json
import re
import sys
from pathlib import Path

json_path = Path(sys.argv[1])
srt_path = Path(sys.argv[2])

with json_path.open("r", encoding="utf-8") as f:
    data = json.load(f)

def to_srt_time(seconds):
    if seconds is None:
        seconds = 0.0
    if seconds < 0:
        seconds = 0.0
    ms = int(round(float(seconds) * 1000))
    h = ms // 3600000
    ms %= 3600000
    m = ms // 60000
    ms %= 60000
    s = ms // 1000
    ms %= 1000
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

def clean_word(word):
    if word is None:
        return ""
    word = str(word).strip()
    word = re.sub(r"\s+", " ", word)
    return word

def collect_words(payload):
    words = []

    if isinstance(payload.get("word_segments"), list):
        for w in payload["word_segments"]:
            words.append({
                "word": clean_word(w.get("word")),
                "start": w.get("start"),
                "end": w.get("end")
            })

    segments = payload.get("segments")
    if isinstance(segments, list):
        for seg in segments:
            if isinstance(seg.get("words"), list):
                for w in seg["words"]:
                    words.append({
                        "word": clean_word(w.get("word")),
                        "start": w.get("start"),
                        "end": w.get("end")
                    })

    out = []
    seen = set()
    for w in words:
        key = (w["word"], w["start"], w["end"])
        if key in seen:
            continue
        seen.add(key)
        out.append(w)
    return out

words = collect_words(data)
words = [w for w in words if w["word"] and (w["start"] is not None or w["end"] is not None)]

if not words:
    raise SystemExit("no word-level timestamps found in WhisperX JSON")

for i, w in enumerate(words):
    if w["start"] is None:
        if i > 0 and words[i - 1]["end"] is not None:
            w["start"] = words[i - 1]["end"]
        elif i > 0 and words[i - 1]["start"] is not None:
            w["start"] = words[i - 1]["start"]
        else:
            w["start"] = 0.0

    if w["end"] is None:
        if i + 1 < len(words) and words[i + 1]["start"] is not None:
            w["end"] = words[i + 1]["start"]
        else:
            w["end"] = float(w["start"]) + 0.35

MIN_DUR = 0.05
MAX_DUR = 2.0

for i, w in enumerate(words):
    start = float(w["start"])
    end = float(w["end"])

    if end <= start:
        end = start + 0.2

    dur = end - start
    if dur < MIN_DUR:
        end = start + MIN_DUR
    elif dur > MAX_DUR:
        end = start + MAX_DUR

    if i + 1 < len(words):
        nxt_start = words[i + 1]["start"]
        if nxt_start is not None:
            nxt_start = float(nxt_start)
            if end > nxt_start:
                end = max(start + MIN_DUR, nxt_start)

    w["start"] = start
    w["end"] = end

filtered = []
for w in words:
    token = w["word"].strip()
    if not token:
        continue
    if re.fullmatch(r"[^\w]+", token, flags=re.UNICODE):
        continue
    filtered.append(w)

if not filtered:
    raise SystemExit("word timestamps were present, but no spoken-word tokens remained after filtering")

with srt_path.open("w", encoding="utf-8") as f:
    out_index = 1
    for w in filtered:
        f.write(f"{out_index}\n")
        f.write(f"{to_srt_time(w['start'])} --> {to_srt_time(w['end'])}\n")
        f.write(f"{w['word']}\n\n")
        out_index += 1

print(srt_path)
PY
' _ "$INPUT_STEM" "${WHISPER_ARGS[@]}"

if [[ ! -f "$JSON_PATH" ]]; then
  echo "missing output JSON: $JSON_PATH" >&2
  exit 1
fi

if [[ ! -f "$SRT_PATH" ]]; then
  echo "missing output SRT: $SRT_PATH" >&2
  exit 1
fi

echo
echo "done"
echo "raw WhisperX JSON: $JSON_PATH"
echo "one-word SRT:      $SRT_PATH"
