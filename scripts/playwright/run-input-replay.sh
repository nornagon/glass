#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECORDING_PATH="${1:-$HOME/Downloads/glass_events.json}"
TEMPLATE_PATH="$ROOT_DIR/scripts/playwright/input-replay-template.js"
GENERATED_DIR="$ROOT_DIR/.playwright-cli"
GENERATED_PATH="$GENERATED_DIR/input-replay.generated.js"

if [[ ! -f "$RECORDING_PATH" ]]; then
  echo "Recording file not found: $RECORDING_PATH" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Replay template not found: $TEMPLATE_PATH" >&2
  exit 1
fi

ROOM_HREF="$(jq -r '.initialState.href // empty' "$RECORDING_PATH")"
if [[ -z "$ROOM_HREF" ]]; then
  echo "Recording is missing initialState.href: $RECORDING_PATH" >&2
  exit 1
fi

PRIME_RUNS="${GLASS_REPLAY_PRIME_RUNS:-0}"
MEASURE_RUNS="${GLASS_REPLAY_MEASURE_RUNS:-1}"
HEADED="${GLASS_REPLAY_HEADED:-1}"
SKIP_OPEN="${GLASS_REPLAY_SKIP_OPEN:-0}"
CAPTURE_TRACE="${GLASS_REPLAY_CAPTURE_TRACE:-0}"
CAPTURE_FRAME_TRACE="${GLASS_REPLAY_CAPTURE_FRAME_TRACE:-1}"

mkdir -p "$GENERATED_DIR"

python3 - "$TEMPLATE_PATH" "$GENERATED_PATH" "$RECORDING_PATH" "$PRIME_RUNS" "$MEASURE_RUNS" "$CAPTURE_TRACE" "$CAPTURE_FRAME_TRACE" <<'PY'
import json
import pathlib
import sys

template_path = pathlib.Path(sys.argv[1])
generated_path = pathlib.Path(sys.argv[2])
recording_path = pathlib.Path(sys.argv[3])
prime_runs = int(sys.argv[4])
measure_runs = int(sys.argv[5])
capture_trace = sys.argv[6] == "1"
capture_frame_trace = sys.argv[7] == "1"

template = template_path.read_text()
recording = json.loads(recording_path.read_text())
config = {
    "primeRuns": prime_runs,
    "measureRuns": measure_runs,
    "captureTrace": capture_trace,
    "captureFrameTrace": capture_frame_trace,
}

output = (
    template
    .replace("__GLASS_RECORDING__", json.dumps(recording, separators=(",", ":")))
    .replace("__GLASS_REPLAY_CONFIG__", json.dumps(config, separators=(",", ":")))
)
generated_path.write_text(output)
PY

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"

if [[ "$SKIP_OPEN" != "1" ]]; then
  OPEN_ARGS=("$ROOM_HREF")
  if [[ "$HEADED" != "0" ]]; then
    OPEN_ARGS+=(--headed)
  fi

  "$PWCLI" open "${OPEN_ARGS[@]}"
fi
"$PWCLI" run-code --filename "$GENERATED_PATH"
