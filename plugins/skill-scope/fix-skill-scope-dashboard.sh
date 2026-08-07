#!/usr/bin/env bash
# Fallback fix: re-apply the global [hidden] rule to skill-scope's dashboard.css.
# The durable fix lives in the plugin source (web/dashboard.css). Run this script
# after a plugin update if the installed cache was ever patched manually and lost
# the rule again.
set -euo pipefail

RULE='[hidden] { display: none !important; }'

if [[ $# -gt 0 ]]; then
  CSS_FILE="$1"
else
  CACHE_ROOT="$HOME/.codex/plugins/cache/backtthefuture/skill-scope"
  LATEST=$(ls -d "$CACHE_ROOT"/*/ 2>/dev/null | sort -V | tail -n 1 || true)
  if [[ -z "$LATEST" || ! -d "$LATEST" ]]; then
    echo "error: cannot find an installed skill-scope cache under $CACHE_ROOT" >&2
    echo "usage: $0 [path/to/dashboard.css]" >&2
    exit 1
  fi
  CSS_FILE="$LATEST/web/dashboard.css"
fi

if [[ ! -f "$CSS_FILE" ]]; then
  echo "error: dashboard.css not found at $CSS_FILE" >&2
  exit 1
fi

if grep -q '^\s*\[hidden\]' "$CSS_FILE"; then
  echo "ok: [hidden] rule already present in $CSS_FILE"
  exit 0
fi

python3 - "$CSS_FILE" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    css = fh.read()

rule = "[hidden] { display: none !important; }"
if "[hidden]" in css:
    sys.exit(0)

anchor = re.compile(r"^a \{ color: inherit; text-decoration: none; \}$", re.M)
fallback = re.compile(r"^\* \{ box-sizing: border-box; \}$", re.M)
insert_after = None
match = anchor.search(css)
if match:
    insert_after = match.end()
else:
    match = fallback.search(css)
    if match:
        insert_after = match.end()

comment = (
    "/* Global hidden override: display rules below (modal/toast/field/…) must never\n"
    "   defeat the HTML `hidden` attribute. Keep this rule after the base reset. */\n"
)
if insert_after is not None:
    css = css[:insert_after] + "\n" + comment + rule + "\n" + css[insert_after:]
else:
    css = comment + rule + "\n" + css

with open(path, "w", encoding="utf-8") as fh:
    fh.write(css)
print(f"ok: inserted [hidden] rule into {path}")
PY
