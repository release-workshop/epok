#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Domain product vocabulary and private-repo paths must not appear in public content
# (allowlisted files may mention them only as explicit "do not add" guidance).
ALLOW='(^|/)(AGENTS\.md|scripts/check-no-saas-leak\.sh|\.github/workflows/leak-guard\.yml)$'
PATTERN='(\bOutcome\b|\bNotification\b|04-saas-spec|epok-saas|workspace Outcome|Outcome policy)'

hits="$(rg -n --glob '!**/.git/**' --glob '!LICENSE' -e "$PATTERN" . || true)"
if [[ -z "$hits" ]]; then
  echo "leak-guard: ok"
  exit 0
fi

bad=0
while IFS= read -r line; do
  file="${line%%:*}"
  if echo "$file" | rg -q "$ALLOW"; then
    continue
  fi
  # CONTEXT avoid-line mentioning SaaS as synonym is OK; Outcome/Notification are not
  echo "$line"
  bad=1
done <<< "$hits"

if [[ "$bad" -eq 1 ]]; then
  echo "leak-guard: blocked SaaS/product vocabulary in public tree" >&2
  exit 1
fi
echo "leak-guard: ok"
