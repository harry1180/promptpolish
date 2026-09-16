#!/usr/bin/env bash
# Live E2E against the running server on :8787 using a scratch DB.
set -e
B=http://127.0.0.1:8787
J='content-type: application/json'
PASS='sup3r-s3cret-pw'

echo "== signup 5 users with cost_center=10 (3 also team=payments), 1 user with cost_center=20 =="
declare -a COOKIES
for i in 1 2 3 4 5; do
  TEAM=$([ $i -le 3 ] && echo payments || echo search)
  C=$(curl -s -D - -o /dev/null -X POST $B/api/signup -H "$J" \
    -d "{\"email\":\"e2e_u${i}@corp.com\",\"password\":\"$PASS\",\"name\":\"User $i\",\"tags\":{\"cost_center\":\"10\",\"team\":\"$TEAM\"}}" \
    | grep -i '^set-cookie' | sed 's/.*pp_session=\([^;]*\).*/pp_session=\1/')
  COOKIES+=("$C")
  echo "  u$i cookie: ${C:0:22}…"
done
C6=$(curl -s -D - -o /dev/null -X POST $B/api/signup -H "$J" \
  -d "{\"email\":\"e2e_u6@corp.com\",\"password\":\"$PASS\",\"tags\":{\"cost_center\":\"20\"}}" \
  | grep -i '^set-cookie' | sed 's/.*pp_session=\([^;]*\).*/pp_session=\1/')

echo "== each cc10 user records an optimization run =="
i=0
for T in 2000 4000 6000 8000 10000; do
  i=$((i+1))
  O=$((T*60/100))
  curl -s -o /dev/null -X POST $B/api/events -H "$J" -H "${COOKIES[$((i-1))]}" \
    -d "{\"modelId\":\"gpt-5.4\",\"level\":\"balanced\",\"originalTokens\":$T,\"optimizedTokens\":$O,\"fromCache\":false}"
done
curl -s -o /dev/null -X POST $B/api/events -H "$J" -H "$C6" \
  -d '{"modelId":"gpt-5.4","level":"balanced","originalTokens":50000,"optimizedTokens":40000,"fromCache":false}'
echo "  done"

echo
echo "== aggregate: filter cost_center=10 (expect users=5, requests=5, orig=30000, opt=18000) =="
curl -s -X POST $B/api/aggregate -H "$J" -H "${COOKIES[0]}" \
  -d '{"filters":[{"key":"cost_center","value":"10"}]}' | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(JSON.stringify(d.totals,null,1)); console.log("projectedAnnualUsd:",d.projectedAnnualUsd.toFixed(4),"windowDays:",d.windowDays);'

echo
echo "== aggregate: filter cost_center=10 AND team=payments (expect users=3, orig=12000) =="
curl -s -X POST $B/api/aggregate -H "$J" -H "${COOKIES[0]}" \
  -d '{"filters":[{"key":"cost_center","value":"10"},{"key":"team","value":"payments"}]}' | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("users:",d.totals.users,"requests:",d.totals.requests,"orig:",d.totals.originalTokens,"opt:",d.totals.optimizedTokens);'

echo
echo "== group by cost_center (expect 10 and 20 buckets; totals reconcile) =="
curl -s -X POST $B/api/aggregate -H "$J" -H "${COOKIES[0]}" \
  -d '{"groupBy":["cost_center"]}' | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for(const b of d.buckets) console.log(`${b.label.padEnd(4)} users=${b.users} req=${b.requests} savedUsd=${b.savingsUsd.toFixed(4)} red=${b.reductionPercent.toFixed(1)}%`);'

echo
echo "== facets =="
curl -s $B/api/tags/facets -H "${COOKIES[0]}" | head -c 400; echo
echo
echo "== unauthenticated aggregate must 401 =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/aggregate -H "$J" -d '{}'
echo "E2E-DONE"
