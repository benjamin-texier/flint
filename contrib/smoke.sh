#!/usr/bin/env bash
# Every endpoint, against a running Flint.
#
# Flint's recurring bug class is SQL semantics — an alias that shadows the
# column it aggregates, a `!=` that yields UInt8 where the wire wants a boolean.
# Unit tests cannot see any of it: the query has to reach a real ClickHouse.
# This is that check, in a form you can run rather than remember.
#
#   contrib/smoke.sh [base-url] [database]
#
# Exits non-zero on the first endpoint that does not answer 200 with the shape
# its caller expects.
set -uo pipefail

BASE="${1:-http://localhost:8096}"
DB="${2:-}"
fails=0

# `expect` is `list`, `object`, or empty for "200 is enough".
check() {
  local label="$1" path="$2" expect="${3:-}" method="${4:-GET}" body="${5:-}"
  local out code
  if [ "$method" = "POST" ]; then
    out=$(curl -sS -X POST "$BASE$path" -H 'Content-Type: application/json' \
              -d "$body" -w '\n%{http_code}' 2>&1)
  else
    out=$(curl -sS "$BASE$path" -w '\n%{http_code}' 2>&1)
  fi
  code=$(printf '%s' "$out" | tail -n1)
  local payload
  payload=$(printf '%s' "$out" | sed '$d')

  # Running without a workspace is a supported configuration, not a fault: the
  # endpoints that need one say so, and a smoke check must not read Flint's
  # stateless mode as a broken deployment.
  if [ "$code" = "400" ] && printf '%s' "$payload" | grep -q 'without a workspace'; then
    printf '  --   %-34s stateless: no workspace configured\n' "$label"
    return
  fi
  if [ "$code" != "200" ]; then
    printf '  FAIL %-34s HTTP %s  %s\n' "$label" "$code" "$(printf '%s' "$payload" | head -c 150)"
    fails=$((fails + 1))
    return
  fi
  if [ -n "$expect" ]; then
    # A 200 carrying an error object, or a list that came back as one, is still
    # a failure — that is exactly how the alias bugs presented.
    if ! printf '%s' "$payload" | python3 -c "
import json, sys
want = '$expect'
d = json.load(sys.stdin)
if isinstance(d, dict) and 'error' in d:
    sys.exit('carried an error: ' + str(d['error'])[:120])
if want == 'list' and not isinstance(d, list):
    sys.exit('expected a list, got ' + type(d).__name__)
if want == 'object' and not isinstance(d, dict):
    sys.exit('expected an object, got ' + type(d).__name__)
" 2>&1 >/dev/null; then
      printf '  FAIL %-34s %s\n' "$label" "$(printf '%s' "$payload" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(str(d.get('error', d))[:130] if isinstance(d, dict) else type(d).__name__)" 2>/dev/null)"
      fails=$((fails + 1))
      return
    fi
  fi
  printf '  ok   %-34s\n' "$label"
}

# Pick a database to exercise the per-database endpoints against: the first one
# that is not ClickHouse's own, so this works on any server.
if [ -z "$DB" ]; then
  DB=$(curl -sS "$BASE/api/databases" | python3 -c "
import json, sys
internal = {'system', 'INFORMATION_SCHEMA', 'information_schema'}
for d in json.load(sys.stdin):
    if d['name'] not in internal:
        print(d['name']); break
" 2>/dev/null)
fi
if [ -z "$DB" ]; then
  echo "could not find a database to test against; pass one as the second argument" >&2
  exit 2
fi
TABLE=$(curl -sS "$BASE/api/databases/$DB/tables" | python3 -c "
import json, sys
for t in json.load(sys.stdin):
    if t.get('kind') == 'table':
        print(t['name']); break
" 2>/dev/null)

echo "Flint at $BASE, exercising \`$DB\`${TABLE:+ / $TABLE}"

check "health"            "/api/health"                          object
check "config"            "/api/config"                          object
check "server"            "/api/server"                          object
check "databases"         "/api/databases"                       list
check "tables"            "/api/databases/$DB/tables"            list
check "graph"             "/api/databases/$DB/graph"             object
check "schema"            "/api/schema"                          list
check "history"           "/api/history?limit=5"                 object
check "diagnostics load"  "/api/diagnostics/queries?days=1"      object
check "diagnostics tables" "/api/diagnostics/traffic?days=1"     object
check "diagnostics disk"  "/api/diagnostics/storage"             object
check "diagnostics now"   "/api/diagnostics/activity"            object
check "pipelines"         "/api/diagnostics/pipelines?days=1"    object
check "access"            "/api/diagnostics/access"              object
check "replication"       "/api/diagnostics/replication"         object
# A kill on an id that cannot exist: the route answers, and says it matched
# nothing rather than reporting success.
check "kill (no match)"   "/api/diagnostics/kill"                object POST '{"query_id":"smoke-no-such-query"}'
check "saved queries"     "/api/saved-queries"                   list
check "dashboards"        "/api/dashboards"                      list
check "alerts"            "/api/alerts"                          list
check "alert events"      "/api/alert-events?limit=5"            list
check "reports"           "/api/reports"                         list
check "report runs"       "/api/report-runs?limit=5"             list
check "published"         "/api/published"                       list
check "api usage"         "/api/diagnostics/api-usage?days=1"    object
check "query"             "/api/query"                           object POST '{"sql":"SELECT 1 AS one"}'
check "format"            "/api/format"                          object POST '{"sql":"select 1"}'
check "check"             "/api/check"                           object POST '{"sql":"SELECT 1 AS one"}'

if [ -n "$TABLE" ]; then
  check "table detail"    "/api/databases/$DB/tables/$TABLE"         object
  check "table preview"   "/api/databases/$DB/tables/$TABLE/preview" object
  check "table profile"   "/api/databases/$DB/tables/$TABLE/profile" object
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails endpoint(s) failed"
  exit 1
fi
echo "every endpoint answered"
