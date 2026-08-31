#!/usr/bin/env bash
# Every endpoint, against a running Flint.
#
# Flint's recurring bug class is SQL semantics — an alias that shadows the
# column it aggregates, a `!=` that yields UInt8 where the wire wants a boolean.
# Unit tests cannot see any of it: the query has to reach a real ClickHouse.
# This is that check, in a form you can run rather than remember.
#
#   contrib/smoke.sh [base-url] [database] [user] [password] [endpoint]
#
# The user and password are needed where the deployment signs people in — which
# is most of what this script asks for: nearly every route runs as whoever is
# asking, so without a session thirty of them answer 401 and the run says
# nothing about whether they work.
#
# The endpoint is needed only where the deployment has none of its own —
# FLINT_CLICKHOUSE_URL unset, so the *caller* names the ClickHouse. Passed
# anywhere else it would be refused, which is why this reads /api/config rather
# than sending it always.
#
# Exits non-zero on the first endpoint that does not answer 200 with the shape
# its caller expects.
set -uo pipefail

BASE="${1:-http://localhost:8096}"
DB="${2:-}"
USER_NAME="${3:-${FLINT_USER:-}}"
PASSWORD="${4:-${FLINT_PASSWORD:-}}"
ENDPOINT="${5:-${FLINT_ENDPOINT:-}}"
fails=0
AUTH=()

# A session, where this Flint wants one. The bearer is the same session a
# browser holds in its cookie — `/api/login` hands it back in the body when
# asked, which is what makes a shell script able to hold one at all.
sign_in() {
  local required pinned
  required=$(curl -sS "$BASE/api/session" | grep -o '"required":[a-z]*' | cut -d: -f2)
  [ "$required" = "true" ] || return 0
  if [ -z "$USER_NAME" ]; then
    echo "this Flint signs people in, and most of these routes run as whoever is asking."
    echo "Pass credentials:  contrib/smoke.sh $BASE ${DB:-<db>} <user> <password>"
    exit 2
  fi
  # Whether the deployment names its own server. Asked rather than inferred from
  # the sign-in being required: those are two different facts, and an unpinned
  # Flint is only one of the two deployments that ask for a session.
  pinned=$(curl -sS "$BASE/api/config" | grep -o '"pinned":[a-z]*' | cut -d: -f2)
  local payload where
  payload="{\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\",\"bearer\":true}"
  where=""
  if [ "$pinned" = "false" ]; then
    if [ -z "$ENDPOINT" ]; then
      echo "this Flint has no ClickHouse of its own — the caller names one at sign-in."
      echo "Pass one too:  contrib/smoke.sh $BASE ${DB:-<db>} $USER_NAME <password> http://localhost:8123"
      exit 2
    fi
    payload="{\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\",\"endpoint\":\"$ENDPOINT\",\"bearer\":true}"
    where=" on $ENDPOINT"
  fi
  local answer token
  answer=$(curl -sS -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
                -d "$payload")
  token=$(printf '%s' "$answer" | grep -o '"bearer":"[^"]*"' | cut -d'"' -f4)
  if [ -z "$token" ]; then
    echo "sign-in refused: $(printf '%s' "$answer" | head -c 200)"
    exit 2
  fi
  AUTH=(-H "Authorization: Bearer $token")
  echo "signed in as $USER_NAME$where"
}

# `expect` is `list`, `object`, or empty for "200 is enough".
check() {
  local label="$1" path="$2" expect="${3:-}" method="${4:-GET}" body="${5:-}"
  local out code
  if [ "$method" = "POST" ]; then
    out=$(curl -sS -X POST "$BASE$path" -H 'Content-Type: application/json' \
              "${AUTH[@]}" -d "$body" -w '\n%{http_code}' 2>&1)
  else
    out=$(curl -sS "$BASE$path" "${AUTH[@]}" -w '\n%{http_code}' 2>&1)
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

sign_in
echo "Flint at $BASE, exercising \`$DB\`${TABLE:+ / $TABLE}"

check "health"            "/api/health"                          object
check "config"            "/api/config"                          object
check "server"            "/api/server"                          object
check "databases"         "/api/databases"                       list
check "tables"            "/api/databases/$DB/tables"            list
check "graph"             "/api/databases/$DB/graph"             object
# Where a database's disk is, from part metadata alone. Answers even where every
# part is Compact and there are no per-column bytes at all — with a coverage
# figure rather than an empty list pretending to be the whole truth.
check "heaviest columns"  "/api/databases/$DB/heavy?limit=5"     object
# Which of a database's tables the workload argues about. Three reads for the
# whole database, and it answers on a server nobody has queried — where the
# honest answer is an empty list rather than an error.
check "database keys"     "/api/databases/$DB/projections?days=1" object
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
check "audit"             "/api/diagnostics/audit?days=1&limit=5" object

# The dataset API: the other half of what Flint serves, and until this was
# added, four routes nothing in `contrib/` ever asked.
check "datasets"          "/api/data/list"                       object POST '{"database":"system"}'
check "dataset schema"    "/api/data/schema"                     object POST '{"dataset":"system.tables"}'
check "dataset read"      "/api/data"                            object POST '{"dataset":"system.tables","select":["name"],"limit":1}'
# The whole language in one document, and the one route of the four that is a
# GET: a slug cannot contain a dot, so no published endpoint can be called this.
check "dataset document"  "/api/data/openapi.json"               object
check "query"             "/api/query"                           object POST '{"sql":"SELECT 1 AS one"}'
check "format"            "/api/format"                          object POST '{"sql":"select 1"}'
check "check"             "/api/check"                           object POST '{"sql":"SELECT 1 AS one"}'

# The download, which every other check here cannot reach: it is the one route
# that takes a form rather than JSON, and it answers with a file rather than an
# envelope. Checked for the two things that would make it useless without
# failing — a header row, and an `attachment` disposition, without which a
# browser renders the CSV in the tab instead of saving it.
export_check() {
  local out code
  out=$(curl -sS -X POST "$BASE/api/export" "${AUTH[@]}" \
            --data-urlencode 'sql=SELECT 1 AS one, '"'"'two'"'"' AS word' \
            --data 'format=csv' --data 'name=smoke' \
            -D - -w '\n%{http_code}' 2>&1)
  code=$(printf '%s' "$out" | tail -n1)
  if [ "$code" != "200" ]; then
    printf '  FAIL %-34s HTTP %s\n' "export" "$code"
    fails=$((fails + 1))
    return
  fi
  if ! printf '%s' "$out" | grep -qi 'attachment; filename="smoke.csv"'; then
    printf '  FAIL %-34s no attachment disposition\n' "export"
    fails=$((fails + 1))
    return
  fi
  if ! printf '%s' "$out" | grep -q '"one","word"'; then
    printf '  FAIL %-34s no header row in the CSV\n' "export"
    fails=$((fails + 1))
    return
  fi
  printf '  ok   %-34s a named CSV with its header\n' "export"
}
export_check

if [ -n "$TABLE" ]; then
  check "table detail"    "/api/databases/$DB/tables/$TABLE"         object
  check "table preview"   "/api/databases/$DB/tables/$TABLE/preview" object
  check "table profile"   "/api/databases/$DB/tables/$TABLE/profile" object
  check "schema review"   "/api/databases/$DB/tables/$TABLE/review"  object
  # The verdict pass reads every row of every column it measures. On the small
  # table this picks that is nothing; it is here because the difference between
  # a hypothesis and a verdict is the whole point of that endpoint.
  check "schema verdict"  "/api/databases/$DB/tables/$TABLE/review?verify=true" object

  # The column-scoped checks need a column, and a bare identifier so the query
  # string needs no encoding — this is a smoke test, not a test of encoding.
  COLUMN=$(curl -sS "$BASE/api/databases/$DB/tables/$TABLE" | python3 -c "
import json, re, sys
for c in json.load(sys.stdin).get('columns', []):
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', c['name']):
        print(c['name']); break
" 2>/dev/null)
  # What the workload asks of this table against what it is sorted by. A read,
  # so it answers on any table — including one nothing has queried, where the
  # answer is an empty workload and not an error.
  check "projections"     "/api/databases/$DB/tables/$TABLE/projections?days=1" object

  if [ -n "$COLUMN" ]; then
    check "column readers"  "/api/databases/$DB/tables/$TABLE/readers?column=$COLUMN" object
    # Counting what a proposed key would come out at. One pass over one column,
    # and it writes nothing — unlike the two probes below it.
    check "key measurement" "/api/databases/$DB/tables/$TABLE/projections/measure" object POST \
          "{\"keys\":[{\"column\":\"$COLUMN\"}],\"columns\":[\"$COLUMN\"]}"
    # Weighing what an aggregate projection would hold. The one call in this
    # feature that writes — a scratch table in Flint's own database, dropped
    # whatever happens — so it is checked here where a leak would show up as a
    # table nobody expected.
    check "projection weight" "/api/databases/$DB/tables/$TABLE/projections/weigh" object POST \
          "{\"keys\":[{\"column\":\"$COLUMN\"}],\"aggregates\":[{\"name\":\"count\",\"params\":[],\"args\":[]}]}"
    # `String` is the one target every column can be cast to, so this exercises
    # the probe without knowing anything about the table. A hundred rows: the
    # endpoint writes a scratch table, and a smoke check should cost nothing.
    check "type probe"      "/api/databases/$DB/tables/$TABLE/probe"  object POST \
          "{\"column\":\"$COLUMN\",\"to_type\":\"String\",\"rows\":100}"
    check "codec probe"     "/api/databases/$DB/tables/$TABLE/codecs" object POST \
          "{\"column\":\"$COLUMN\",\"rows\":100}"
    # The grammar is the only thing standing between that endpoint and arbitrary
    # DDL, so the check asserts it refuses rather than that it answers.
    refused=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
              "$BASE/api/databases/$DB/tables/$TABLE/probe" \
              -H 'Content-Type: application/json' \
              -d "{\"column\":\"$COLUMN\",\"to_type\":\"String) ENGINE = Memory; --\"}")
    if [ "$refused" = "400" ]; then
      printf '  ok   %-34s\n' "probe refuses a type it cannot build"
    else
      printf '  FAIL %-34s HTTP %s, expected 400\n' "probe refuses a type it cannot build" "$refused"
      fails=$((fails + 1))
    fi

    # The same defence on the other endpoint that builds SQL from a request: a
    # bucketing function is taken from a closed list, and nothing else reaches
    # the GROUP BY however it is spelled.
    refused=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
              "$BASE/api/databases/$DB/tables/$TABLE/projections/measure" \
              -H 'Content-Type: application/json' \
              -d "{\"keys\":[{\"column\":\"$COLUMN\",\"bucket\":\"toStartOfHour(x)) ; SELECT 1 --\"}]}")
    if [ "$refused" = "400" ]; then
      printf '  ok   %-34s\n' "measure refuses a bucket off the list"
    else
      printf '  FAIL %-34s HTTP %s, expected 400\n' "measure refuses a bucket off the list" "$refused"
      fails=$((fails + 1))
    fi

    # And the same on the endpoint that builds a CREATE TABLE, where the
    # closed list of aggregates is the only defence there is.
    refused=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
              "$BASE/api/databases/$DB/tables/$TABLE/projections/weigh" \
              -H 'Content-Type: application/json' \
              -d "{\"keys\":[{\"column\":\"$COLUMN\"}],\"aggregates\":[{\"name\":\"count(), 1 AS x --\",\"params\":[],\"args\":[]}]}")
    if [ "$refused" = "400" ]; then
      printf '  ok   %-34s\n' "weigh refuses an unknown aggregate"
    else
      printf '  FAIL %-34s HTTP %s, expected 400\n' "weigh refuses an unknown aggregate" "$refused"
      fails=$((fails + 1))
    fi
  fi
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails endpoint(s) failed"
  exit 1
fi
echo "every endpoint answered"
