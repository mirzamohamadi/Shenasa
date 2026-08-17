#!/usr/bin/env bash
#
# integration.sh — brings up a REAL Kanidm container on localhost and
# verifies the operations Shenasa performs: person/group creation,
# membership, RBAC role grants, and the OAuth2 client + OIDC discovery the
# SSO flow relies on.
#
# Requires: docker, openssl, curl, jq.
# Everything happens against the live server; there are no mocks.
#
set -euo pipefail

NAME=${SHENASA_IT_CONTAINER:-shenasa-it-kanidm}
PORT=${SHENASA_IT_PORT:-18443}
IMAGE=${SHENASA_IT_IMAGE:-kanidm/server:1.11.0}   # pinned — never the drifting :latest dev channel
ORIGIN="https://localhost:$PORT"
WORK=$(mktemp -d)

log() { printf '[integration] %s\n' "$*"; }
die() { printf '[integration] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need docker
need openssl
need curl
need jq

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. Local CA + cert for localhost -----------------------------------------
log "generating local CA and localhost certificate…"
openssl req -x509 -newkey rsa:4096 -sha256 -days 2 -nodes \
  -subj "/CN=Shenasa integration CA" \
  -keyout "$WORK/ca-key.pem" -out "$WORK/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:4096 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$WORK/key.pem" -out "$WORK/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
  > "$WORK/server.ext"
openssl x509 -req -sha256 -days 1 -in "$WORK/server.csr" \
  -CA "$WORK/ca.pem" -CAkey "$WORK/ca-key.pem" -CAcreateserial \
  -extfile "$WORK/server.ext" -out "$WORK/server.pem" >/dev/null 2>&1
cat "$WORK/server.pem" "$WORK/ca.pem" > "$WORK/chain.pem"

cat > "$WORK/server.toml" <<EOF
bindaddress = "0.0.0.0:8443"
domain = "localhost"
origin = "https://localhost:8443"
db_path = "/data/kanidm.db"
tls_chain = "/data/chain.pem"
tls_key = "/data/key.pem"
log_level = "info"
EOF

# --- 2. Start a real Kanidm ----------------------------------------------------
log "starting $IMAGE as $NAME on port $PORT…"
docker run -d --name "$NAME" \
  -p "$PORT:8443" \
  -v "$WORK/server.toml:/data/server.toml:ro" \
  -v "$WORK/chain.pem:/data/chain.pem:ro" \
  -v "$WORK/key.pem:/data/key.pem:ro" \
  "$IMAGE" >/dev/null

log "waiting for readiness…"
TRIES=0
until curl -fsS --cacert "$WORK/ca.pem" -o /dev/null "$ORIGIN/" 2>/dev/null || [ $TRIES -ge 90 ]; do
  TRIES=$((TRIES + 1))
  sleep 2
done
[ $TRIES -lt 90 ] || { docker logs "$NAME" >&2 || true; die "server did not become ready"; }
log "server is ready."

# --- 3. Recover idm_admin -------------------------------------------------------
log "recovering idm_admin…"
RECOVER_OUT=$(docker exec -i "$NAME" kanidmd recover-account idm_admin 2>&1) || {
  printf '%s\n' "$RECOVER_OUT" >&2
  die "recover-account failed"
}
PW=$(printf '%s\n' "$RECOVER_OUT" | sed -n 's/.*new_password: "\([^"]*\)".*/\1/p' | head -n1)
[ -n "$PW" ] || { printf '%s\n' "$RECOVER_OUT" >&2; die "could not parse new password"; }

# --- 4. REST login ----------------------------------------------------------------
JAR="$WORK/cookies.txt"
auth_step() {
  curl -fsS --cacert "$WORK/ca.pem" -c "$JAR" -b "$JAR" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -X POST "$ORIGIN/v1/auth" -d "$1"
}
log "logging in over /v1/auth…"
auth_step '{"step":{"init":"idm_admin"}}' >/dev/null || die "auth init failed"
auth_step '{"step":{"begin":"password"}}' >/dev/null || die "auth begin failed"
RESP=$(auth_step "$(jq -nc --arg pw "$PW" '{step:{cred:{password:$pw}}}')") || die "auth cred failed"
TOKEN=$(printf '%s' "$RESP" | jq -r '.state.success // .token // .jwt // empty')
[ -n "$TOKEN" ] || { printf '%s\n' "$RESP" >&2; die "no session token"; }
log "authenticated."

api() { # method path [json]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS --cacert "$WORK/ca.pem" -H "Authorization: Bearer $TOKEN" -c "$JAR" -b "$JAR" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -X "$method" "$ORIGIN$path" -d "$body"
  else
    curl -fsS --cacert "$WORK/ca.pem" -H "Authorization: Bearer $TOKEN" -c "$JAR" -b "$JAR" \
      -H 'Accept: application/json' -X "$method" "$ORIGIN$path"
  fi
}

# --- 5. Person / group / membership / RBAC ---------------------------------------
PERSON=it_user_$$
GROUP=it_group_$$
log "creating person $PERSON…"
api POST /v1/person "$(jq -nc --arg n "$PERSON" '{attrs:{name:[$n], displayname:["IT User"], mail:["it@localhost"]}}')" >/dev/null \
  || die "create person failed"
api GET "/v1/person/$PERSON" | jq -e --arg n "$PERSON" '.attrs.name[0] == $n' >/dev/null \
  || die "verify person failed"
log "person verified."

log "creating group $GROUP…"
# Groups have no writable displayname (dl14/dl15 idm_acp_group_manage
# create attrs); this payload mirrors exactly what the Shenasa UI sends.
api POST /v1/group "$(jq -nc --arg n "$GROUP" '{attrs:{name:[$n]}}')" >/dev/null \
  || die "create group failed"

log "adding membership ($PERSON in $GROUP)…"
api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg m "$PERSON@localhost" '[$m]')" >/dev/null \
  || api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg m "$PERSON" '[$m]')" >/dev/null \
  || die "add member failed"
api GET "/v1/group/$GROUP" | jq -e --arg m "$PERSON" \
  '([.attrs.member[]? | split("@")[0]] | index($m)) != null' >/dev/null \
  || die "verify membership failed"
log "membership verified."

# --- 5b. v1.3 flows: batched membership, expiry PATCH (incl. purge), cred status
PERSON2=it_user2_$$
log "creating second person $PERSON2 for v1.3 batch checks…"
api POST /v1/person "$(jq -nc --arg n "$PERSON2" '{attrs:{name:[$n], displayname:["IT User Two"]}}')" >/dev/null \
  || die "create second person failed"

log "batched membership add (ONE POST, two members — Shenasa bulk add-to-group)…"
api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg a "$PERSON@localhost" --arg b "$PERSON2@localhost" '[$a,$b]')" >/dev/null \
  || api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg a "$PERSON" --arg b "$PERSON2" '[$a,$b]')" >/dev/null \
  || die "batched member add failed"
api GET "/v1/group/$GROUP" | jq -e --arg m "$PERSON2" \
  '([.attrs.member[]? | split("@")[0]] | index($m)) != null' >/dev/null \
  || die "verify batched membership failed"

log "setting account expiry via PATCH (Shenasa bulk set-expiry)…"
api PATCH "/v1/person/$PERSON2" "$(jq -nc '{attrs:{account_expire:["2030-01-01T00:00:00Z"]}}')" >/dev/null \
  || die "set expiry failed"
api GET "/v1/person/$PERSON2" | jq -e \
  '(.attrs.account_expire[0] // "") | startswith("2030-01-01")' >/dev/null \
  || die "verify expiry failed"

log "clearing expiry via purge (EMPTY ARRAY — ModifyList::from_patch)…"
api PATCH "/v1/person/$PERSON2" "$(jq -nc '{attrs:{account_expire:[]}}')" >/dev/null \
  || die "clear expiry failed"
api GET "/v1/person/$PERSON2" | jq -e \
  '((.attrs.account_expire // []) | length) == 0' >/dev/null \
  || die "verify purge failed"

log "reading credential status (Shenasa creds card / adoption report)…"
api GET "/v1/person/$PERSON2/_credential/_status" | jq -e 'has("creds")' >/dev/null \
  || die "credential status read failed"
log "v1.3 batch flows verified."

log "granting RBAC role (idm_service_desk membership)…"
api POST "/v1/group/idm_service_desk/_attr/member" "$(jq -nc --arg m "$PERSON@localhost" '[$m]')" >/dev/null \
  || api POST "/v1/group/idm_service_desk/_attr/member" "$(jq -nc --arg m "$PERSON" '[$m]')" >/dev/null \
  || die "role grant failed"
api GET "/v1/group/idm_service_desk" | jq -e --arg m "$PERSON" \
  '([.attrs.member[]? | split("@")[0]] | index($m)) != null' >/dev/null \
  || die "verify role grant failed"
log "RBAC grant verified."

# --- 6. OAuth2 client + discovery (the Shenasa SSO prerequisites) -----------------
CLIENT=it_shenasa_client
log "creating public OAuth2 client $CLIENT…"
# Create envelope verified against libs/client/src/oauth.rs
# (idm_oauth2_rs_public_create): name + displayname +
# oauth2_rs_origin_landing + oauth2_strict_redirect_uri — the internal
# "oauth2 rs name" class attr is NOT accepted on create.
STATUS=$(curl -sS --cacert "$WORK/ca.pem" -o "$WORK/client.json" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -c "$JAR" -b "$JAR" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST "$ORIGIN/v1/oauth2/_public" -d "$(jq -nc --arg id "$CLIENT" \
  '{attrs:{name:[$id], displayname:["IT Shenasa"],
           oauth2_rs_origin_landing:["https://localhost/"],
           oauth2_strict_redirect_uri:["true"]}}')")
if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
  cat "$WORK/client.json" >&2 || true
  die "public OAuth2 client create failed (HTTP $STATUS)"
fi
api PATCH "/v1/oauth2/$CLIENT" "$(jq -nc \
  '{attrs:{oauth2_rs_origin:["https://localhost"]}}')" >/dev/null \
  || die "client origin configure failed"
# Scope maps go through the dedicated endpoint (bare JSON array of scope
# strings) — writing the raw serialized oauth2_rs_scope_map attr is not a
# supported client path.
api POST "/v1/oauth2/$CLIENT/_scopemap/idm_service_desk@localhost" \
  '["openid","profile","email","groups"]' >/dev/null \
  || die "scope map grant failed"

# --- 6b. Basic (confidential) client + generated secret ----------------------
# POST /v1/oauth2/_basic takes the SAME attrs as _public (name, displayname,
# landing, strict). The secret is NEVER sent; Kanidm generates it and
# GET /v1/oauth2/{id}/_basic_secret returns it as a JSON string.
BASIC=it_basic_client
log "creating basic OAuth2 client $BASIC…"
STATUS=$(curl -sS --cacert "$WORK/ca.pem" -o "$WORK/basic.json" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -c "$JAR" -b "$JAR" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST "$ORIGIN/v1/oauth2/_basic" -d "$(jq -nc --arg id "$BASIC" \
  '{attrs:{name:[$id], displayname:["IT Basic"],
           oauth2_rs_origin_landing:["https://localhost/app"],
           oauth2_strict_redirect_uri:["true"]}}')")
if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
  cat "$WORK/basic.json" >&2 || true
  die "basic OAuth2 client create failed (HTTP $STATUS)"
fi
log "reading generated basic secret (GET /v1/oauth2/{id}/_basic_secret)…"
SECRET=$(api GET "/v1/oauth2/$BASIC/_basic_secret") || die "GET _basic_secret failed"
SECRET_VAL=$(printf '%s' "$SECRET" | jq -r 'if type == "string" then . elif . == null then "" else tostring end')
[ -n "$SECRET_VAL" ] && [ "$SECRET_VAL" != "null" ] || {
  printf '%s\n' "$SECRET" >&2
  die "basic secret was empty — Kanidm should generate one on _basic create"
}
api PATCH "/v1/oauth2/$BASIC" "$(jq -nc \
  '{attrs:{oauth2_rs_origin:["https://localhost/app"]}}')" >/dev/null \
  || die "basic client origin configure failed"
api GET "/v1/oauth2/$BASIC" | jq -e \
  '(.attrs.class // []) | index("oauth2_resource_server_basic") != null' >/dev/null \
  || die "basic client class missing oauth2_resource_server_basic"
api DELETE "/v1/oauth2/$BASIC" >/dev/null \
  || die "basic client delete failed"
log "basic client create + secret + origin + delete verified."

log "checking OIDC discovery at the origin root (never /v1)…"
DOC=$(curl -fsS --cacert "$WORK/ca.pem" "$ORIGIN/oauth2/openid/$CLIENT/.well-known/openid-configuration") \
  || die "discovery doc missing"
printf '%s' "$DOC" | jq -e '.authorization_endpoint | test("^https://[^/]+/ui/oauth2")' >/dev/null \
  || die "authorization_endpoint is not the /ui/oauth2 entry point at the origin root"

log "cleanup handled by trap."
printf '\n[integration] PASS — person/group/membership/RBAC created and verified; public + basic OAuth2 and SSO endpoints OK.\n'
