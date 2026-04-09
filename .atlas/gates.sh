#!/usr/bin/env bash
set -euo pipefail

CHANGED_FILES=$(git diff --name-only origin/main -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null || true)

echo "=== Cap Monorepo Gates ==="
echo "Changed files: $(echo "$CHANGED_FILES" | wc -l | tr -d ' ')"

echo "Gate 1: Type check (tsc)..."
if TSC_OUTPUT=$(npx tsc --noEmit 2>&1); then
  TSC_STATUS="pass"
  echo "  PASS"
else
  TSC_STATUS="fail"
  echo "  FAIL"
  echo "  $TSC_OUTPUT" | tail -20
fi

echo "Gate 2: Lint (biome, changed files only)..."
if [ -z "$CHANGED_FILES" ]; then
  LINT_STATUS="skip"
  echo "  SKIP (no changed TS/JS files)"
else
  if LINT_OUTPUT=$(echo "$CHANGED_FILES" | xargs npx @biomejs/biome check --no-errors-on-unmatched 2>&1); then
    LINT_STATUS="pass"
    echo "  PASS"
  else
    LINT_STATUS="fail"
    echo "  FAIL"
    echo "  $LINT_OUTPUT" | tail -20
  fi
fi

echo "Gate 3: Build... SKIP (Next.js monorepo build exceeds container memory)"
BUILD_STATUS="skip"

echo "Gate 4: Sentrux... SKIP (no baseline)"
SENTRUX_GATE_STATUS="skip"
SENTRUX_CHECK_STATUS="skip"

echo "Gate 5: Tests... SKIP (turborepo binary not available in container)"

if [ "$TSC_STATUS" = "fail" ] || [ "$LINT_STATUS" = "fail" ]; then
  echo "=== Gates FAILED ==="
  exit 1
fi

echo "=== All gates passed ==="
exit 0
