#!/usr/bin/env bash
# This script is kept LF-only by .gitattributes for native Windows Bash.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
SESSION_NAME="agentcode-smoke-$$"
TMUX_SOCKET="agentcode-smoke-$$"
MOCK_STDOUT="$TMP_DIR/mock-sse.stdout"
MOCK_STDERR="$TMP_DIR/mock-sse.stderr"
MOCK_URL_FILE="$TMP_DIR/mock-sse.url"
PANE_LOG="$TMP_DIR/tmux-pane.log"
PACK_OUTPUT="$TMP_DIR/npm-pack.out"
MOCK_PID=""
SENTINEL_API_KEY="sk-agentcode-e2e-secret-should-not-appear"
SENTINEL_PREFIX="sk-agentcode"
SENTINEL_SUFFIX="should-not-appear"

run_tmux() {
  tmux -L "$TMUX_SOCKET" "$@"
}

cleanup() {
  if run_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    run_tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  fi

  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi

  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'E2E smoke failed: %s\n' "$1" >&2

  if run_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    printf '\n--- tmux pane ---\n' >&2
    capture_pane | redact_output >&2 || true
  fi

  if [[ -s "$PANE_LOG" ]]; then
    printf '\n--- tmux pane log ---\n' >&2
    redact_output < "$PANE_LOG" >&2 || true
  fi

  if [[ -s "$MOCK_STDERR" ]]; then
    printf '\n--- mock SSE stderr ---\n' >&2
    sed 's/^/mock: /' "$MOCK_STDERR" | redact_output >&2 || true
  fi

  exit 1
}

redact_output() {
  sed "s/${SENTINEL_API_KEY}/<redacted-api-key>/g; s/${SENTINEL_PREFIX}/<redacted-api-key-prefix>/g; s/${SENTINEL_SUFFIX}/<redacted-api-key-suffix>/g"
}

has_sentinel_leak() {
  local text="$1"
  [[ "$text" == *"$SENTINEL_API_KEY"* || "$text" == *"$SENTINEL_PREFIX"* || "$text" == *"$SENTINEL_SUFFIX"* ]]
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'E2E smoke blocked: required command not found: %s\n' "$name" >&2
    exit 2
  fi
}

capture_pane() {
  run_tmux capture-pane -p -t "$SESSION_NAME" -S -200
}

append_pane_snapshot() {
  local pane_content="$1"

  {
    printf '\n--- pane snapshot ---\n'
    printf '%s\n' "$pane_content" | redact_output
  } >> "$PANE_LOG"
}

wait_for_pane_text() {
  local expected="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    local pane_content
    pane_content="$(capture_pane)"
    if has_sentinel_leak "$pane_content"; then
      append_pane_snapshot "$pane_content"
      fail 'sentinel API key leaked into tmux pane snapshot'
    fi

    append_pane_snapshot "$pane_content"
    if [[ "$pane_content" == *"$expected"* ]]; then
      return 0
    fi
    sleep 0.2
  done

  fail "timed out waiting for pane text: $expected"
}

wait_for_pane_ready() {
  local timeout_seconds="$1"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    local pane_content
    pane_content="$(capture_pane)"
    append_pane_snapshot "$pane_content"
    if [[ -n "${pane_content//[[:space:]]/}" ]]; then
      return 0
    fi
    sleep 0.2
  done

  fail 'timed out waiting for tmux shell to become ready'
}

send_prompt() {
  local text="$1"

  run_tmux send-keys -t "$SESSION_NAME" -l "$text"
  run_tmux send-keys -t "$SESSION_NAME" C-m
}

wait_for_mock_url() {
  local deadline=$((SECONDS + 10))
  local url=""

  while (( SECONDS < deadline )); do
    if [[ -s "$MOCK_URL_FILE" ]]; then
      IFS= read -r url < "$MOCK_URL_FILE"
      if [[ "$url" == http://127.0.0.1:* ]]; then
        printf '%s\n' "$url"
        return 0
      fi
    fi

    if [[ -n "$MOCK_PID" ]] && ! kill -0 "$MOCK_PID" 2>/dev/null; then
      fail 'mock SSE server exited before printing its URL'
    fi

    sleep 0.1
  done

  fail 'timed out waiting for mock SSE server URL'
}

write_project_config() {
  local project_dir="$1"
  local mock_url="$2"

  mkdir -p "$project_dir/.agentcode"
  cat > "$project_dir/.agentcode/config.yaml" <<YAML
protocol: openai
model: e2e-openai-model
base_url: $mock_url/v1
api_key: $SENTINEL_API_KEY
permission_mode: yolo
request:
  timeout_ms: 10000
ui:
  show_thinking: false
YAML
}

write_tool_fixture() {
  local project_dir="$1"

  cat > "$project_dir/tool-fixture.txt" <<'TEXT'
fixture says tool loop works
TEXT
}

write_launcher() {
  local project_dir="$1"

  if [[ "${OS:-}" == "Windows_NT" ]]; then
    local launcher="$project_dir/start-agentcode.cmd"
    local project_dir_windows
    project_dir_windows="$(cygpath -w "$project_dir")"

    {
      printf '@echo off\r\n'
      printf 'cd /d "%s"\r\n' "$project_dir_windows"
      printf 'call node_modules\\.bin\\agentcode.cmd\r\n'
    } > "$launcher"
    cygpath -w "$launcher"
    return
  fi

  local launcher="$project_dir/start-agentcode.sh"

  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'export PATH=%q\n' "$PATH"
    printf 'cd %q\n' "$project_dir"
    printf 'exec ./node_modules/.bin/agentcode\n'
  } > "$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$launcher"
}

require_command tmux
require_command node
require_command npm

if [[ ! -f "$ROOT_DIR/dist/cli/main.js" ]]; then
  printf 'E2E smoke blocked: build output missing. Run `npm run build` first.\n' >&2
  exit 2
fi

cd "$ROOT_DIR"
AGENTCODE_MOCK_SSE_DELAY_MS=3000 AGENTCODE_MOCK_SSE_URL_FILE="$MOCK_URL_FILE" node --import tsx/esm tests/helpers/mockSseCli.ts > "$MOCK_STDOUT" 2> "$MOCK_STDERR" &
MOCK_PID="$!"
MOCK_URL="$(wait_for_mock_url)"

PACKAGE_TARBALL="$(npm pack --pack-destination "$TMP_DIR" --silent > "$PACK_OUTPUT" && tail -n 1 "$PACK_OUTPUT")"
PACKAGE_TARBALL_PATH="$TMP_DIR/$PACKAGE_TARBALL"

PROJECT_DIR="$TMP_DIR/project"
mkdir -p "$PROJECT_DIR"
npm install --prefix "$PROJECT_DIR" --no-save --ignore-scripts --no-audit --no-fund --prefer-offline "$PACKAGE_TARBALL_PATH" >/dev/null
write_project_config "$PROJECT_DIR" "$MOCK_URL"
write_tool_fixture "$PROJECT_DIR"
LAUNCHER="$(write_launcher "$PROJECT_DIR")"

if [[ ! -x "$PROJECT_DIR/node_modules/.bin/agentcode" ]]; then
  fail 'installed package did not expose an executable agentcode bin'
fi

if [[ ! -f "$PROJECT_DIR/node_modules/agentcode/dist/cli/main.js" ]]; then
  fail 'installed package did not include dist/cli/main.js'
fi

if ! run_tmux new-session -d -s "$SESSION_NAME" -x 100 -y 30; then
  printf 'E2E smoke blocked: tmux/psmux command is present but cannot create an interactive shell session.\n' >&2
  exit 2
fi

TMUX_PATH="$PATH"
if [[ "${OS:-}" == "Windows_NT" ]]; then
  TMUX_PATH="$(cygpath -wp "$PATH")"
fi
run_tmux set-environment -t "$SESSION_NAME" PATH "$TMUX_PATH"
run_tmux set-option -t "$SESSION_NAME" history-limit 2000 >/dev/null
wait_for_pane_ready 10
run_tmux send-keys -t "$SESSION_NAME" -l "\"$LAUNCHER\""
run_tmux send-keys -t "$SESSION_NAME" C-m

wait_for_pane_text 'Ask AgentCode' 10
wait_for_pane_text 'ready' 5
wait_for_pane_text 'model: e2e-openai-model' 5
wait_for_pane_text 'provider: openai' 5
wait_for_pane_text 'config: project' 5

send_prompt 'hello from tmux'
if [[ "${OS:-}" == "Windows_NT" ]]; then
  # psmux exposes the final Ink frame but not reliable intermediate redraws.
  wait_for_pane_text 'streammarker first answer' 12
else
  wait_for_pane_text 'generating' 5
  wait_for_pane_text 'Waiting for model response' 5
  wait_for_pane_text 'streammarker' 5

  PARTIAL_PANE="$(capture_pane)"
  if [[ "$PARTIAL_PANE" == *'streammarker first answer'* ]]; then
    fail 'first response appeared all at once; expected a visible partial streaming state'
  fi

  wait_for_pane_text 'streammarker first answer' 8
fi
sleep 1

send_prompt 'second question'
wait_for_pane_text 'I remember first answer.' 10

send_prompt 'please read the fixture file'
wait_for_pane_text 'Tool summary: fixture says tool loop works.' 15

FINAL_PANE="$(capture_pane)"
if has_sentinel_leak "$FINAL_PANE"; then
  fail 'sentinel API key leaked into terminal output'
fi

if [[ -s "$PANE_LOG" ]] && has_sentinel_leak "$(<"$PANE_LOG")"; then
  fail 'sentinel API key leaked into tmux pane log'
fi

if [[ -s "$MOCK_STDOUT" ]] && has_sentinel_leak "$(<"$MOCK_STDOUT")"; then
  fail 'sentinel API key leaked into mock SSE stdout'
fi

if [[ -s "$MOCK_STDERR" ]] && has_sentinel_leak "$(<"$MOCK_STDERR")"; then
  fail 'sentinel API key leaked into mock SSE stderr'
fi

printf 'tmux E2E smoke passed.\n'
