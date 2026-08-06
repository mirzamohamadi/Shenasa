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
IMAGE=${SHENASA_IT_IMAGE:-kanidm/server:latest}
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
api POST /v1/group "$(jq -nc --arg n "$GROUP" '{attrs:{name:[$n], displayname:["IT Group"]}}')" >/dev/null \
  || die "create group failed"

log "adding membership ($PERSON in $GROUP)…"
api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg m "$PERSON@localhost" '[$m]')" >/dev/null \
  || api POST "/v1/group/$GROUP/_attr/member" "$(jq -nc --arg m "$PERSON" '[$m]')" >/dev/null \
  || die "add member failed"
api GET "/v1/group/$GROUP" | jq -e --arg m "$PERSON" \
  '([.attrs.member[]? | split("@")[0]] | index($m)) != null' >/dev/null \
  || die "verify membership failed"
log "membership verified."

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
STATUS=$(curl -sS --cacert "$WORK/ca.pem" -o "$WORK/client.json" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -c "$JAR" -b "$JAR" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST "$ORIGIN/v1/oauth2/_public" -d "$(jq -nc --arg id "$CLIENT" \
  '{attrs:{oauth2_rs_name:[$id], displayname:["IT Shenasa"]}}')")
if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
  cat "$WORK/client.json" >&2 || true
  die "public OAuth2 client create failed (HTTP $STATUS)"
fi
api PATCH "/v1/oauth2/$CLIENT" "$(jq -nc \
  '{attrs:{oauth2_rs_origin_landing:["https://localhost/"], oauth2_rs_origin:["https://localhost"],
           oauth2_rs_scope_map:["idm_service_desk@localhost:openid,profile,email,groups"]}}')" >/dev/null \
  || die "client configure failed"

log "checking OIDC discovery at the origin root (never /v1)…"
DOC=$(curl -fsS --cacert "$WORK/ca.pem" "$ORIGIN/oauth2/openid/$CLIENT/.well-known/openid-configuration") \
  || die "discovery doc missing"
printf '%s' "$DOC" | jq -e '.authorization_endpoint | test("^https://[^/]+/ui/oauth2")' >/dev/null \
  || die "authorization_endpoint is not the /ui/oauth2 entry point at the origin root"

log "cleanup handled by trap."
printf '\n[integration] PASS — person/group/membership/RBAC created and verified; SSO endpoints OK.\n'
