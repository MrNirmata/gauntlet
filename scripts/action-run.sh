#!/usr/bin/env bash
# Inputs arrive as environment variables. An argv array keeps those values
# out of the shell parser.
set -euo pipefail

if [[ -z "${GITHUB_ACTION_PATH:-}" ]]; then
  echo "GITHUB_ACTION_PATH is not set" >&2
  exit 2
fi

args=(run --json)

if [[ -n "${INPUT_ADAPTER:-}" ]]; then
  args+=(--adapter "$INPUT_ADAPTER")
fi
if [[ -n "${INPUT_EXEC:-}" ]]; then
  args+=(--exec "$INPUT_EXEC")
fi
if [[ -n "${INPUT_HTTP:-}" ]]; then
  args+=(--http "$INPUT_HTTP")
fi
if [[ -n "${INPUT_MCP:-}" ]]; then
  args+=(--mcp "$INPUT_MCP")
fi
if [[ -n "${INPUT_TOOL:-}" ]]; then
  # read_file=a,write_file=b becomes one --tool for each pair.
  IFS=',' read -r -a tool_pairs <<<"$INPUT_TOOL"
  for pair in "${tool_pairs[@]}"; do
    args+=(--tool "$pair")
  done
fi
if [[ "${INPUT_STRUCTURED:-}" == "true" ]]; then
  args+=(--structured)
fi
if [[ -n "${INPUT_TIER:-}" ]]; then
  args+=(--tier "$INPUT_TIER")
fi
if [[ -n "${INPUT_FAIL_ON:-}" ]]; then
  args+=(--fail-on "$INPUT_FAIL_ON")
fi
if [[ -n "${INPUT_SARIF:-}" ]]; then
  args+=(--sarif "$INPUT_SARIF")
fi
if [[ -n "${INPUT_SARIF_LOCATION:-}" ]]; then
  args+=(--sarif-location "$INPUT_SARIF_LOCATION")
fi
if [[ -n "${INPUT_NAME:-}" ]]; then
  args+=(--name "$INPUT_NAME")
fi
if [[ -n "${INPUT_TIMEOUT:-}" ]]; then
  args+=(--timeout "$INPUT_TIMEOUT")
fi
if [[ -n "${INPUT_BASELINE:-}" ]]; then
  args+=(--baseline "$INPUT_BASELINE")
fi
if [[ "${INPUT_STRICT:-}" == "true" ]]; then
  args+=(--strict)
fi
if [[ -n "${INPUT_SCENARIO:-}" ]]; then
  args+=(--scenario "$INPUT_SCENARIO")
fi
if [[ -n "${INPUT_CATEGORY:-}" ]]; then
  args+=(--category "$INPUT_CATEGORY")
fi

json_file="$(mktemp)"
stderr_file="$(mktemp)"
trap 'rm -f "$json_file" "$stderr_file"' EXIT

set +e
node "$GITHUB_ACTION_PATH/dist/cli.js" "${args[@]}" >"$json_file" 2>"$stderr_file"
code=$?
set -e

cat "$json_file"
cat "$stderr_file" >&2

set +e
GAUNTLET_JSON_PATH="$json_file" \
  GAUNTLET_STDERR_PATH="$stderr_file" \
  GAUNTLET_EXIT_CODE="$code" \
  node "$GITHUB_ACTION_PATH/dist/summary.js"
report_code=$?
set -e

if [[ "$report_code" -ne 0 && "$code" -eq 0 ]]; then
  echo "could not write the Gauntlet job summary" >&2
  exit "$report_code"
fi

exit "$code"
