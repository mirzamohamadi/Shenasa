#!/usr/bin/env bash
#
# bootstrap.sh — recover the idm_admin password and provision the public
# OAuth2/OIDC client that Shenasa signs in with (Authorization Code + PKCE,
# no client secret).
#
# Everything is done over Kanidm's real interfaces: `kanidmd recover-account`
# inside the container, then the REST API (step-based /v1/auth login +
# /v1/oauth2). No state is faked; the Kanidm server remains the source of
# truth.
#
# Request/response shapes below were verified against the Kanidm 1.10.x
# source (server/core/src/https/v1_oauth2.rs, libs/client/src/oauth.rs):
#   * POST  /v1/oauth2/_public                    body: {"attrs":{...}}
#   * PATCH /v1/oauth2/{rs_name}                  body: {"attrs":{...}}
#   * POST  /v1/oauth2/{rs_name}/_scopemap/{grp}  body: ["scope",...]
#
# Environment overrides:
#   KANIDM_DOMAIN            primary domain         (default: idm.example.com)
#   KANIDM_API_ORIGIN        server origin          (default: https://<DOMAIN>:8443)
#   KANIDM_TLS_CA            CA bundle for curl     (default: deploy/tls/ca.pem if present)
#   KANIDM_RESOLVE_LOCAL    resolve domain to 127.0.0.1 (default: 1; set 0 if remote)
#   SHENASA_CLIENT_ID        OAuth2 client id       (default: shenasa_admin_ui)
#   SHENASA_REDIRECT_URI     OIDC redirect/landing  (default: https://<DOMAIN>/admin/)
#   SHENASA_DISPLAYNAME      client display name    (default: Shenasa Admin UI)
#
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KANIDM_DOMAIN=${KANIDM_DOMAIN:-idm.example.com}
KANIDM_API_ORIGIN=${KANIDM_API_ORIGIN:-https://${KANIDM_DOMAIN}:8443}
KANIDM_TLS_CA=${KANIDM_TLS_CA:-$SCRIPT_DIR/tls/ca.pem}
SHENASA_CLIENT_ID=${SHENASA_CLIENT_ID:-shenasa_admin_ui}
SHENASA_REDIRECT_URI=${SHENASA_REDIRECT_URI:-https://${KANIDM_DOMAIN}/admin/}
SHENASA_DISPLAYNAME=${SHENASA_DISPLAYNAME:-Shenasa Admin UI}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml")
else
  COMPOSE=(docker-compose -f "$SCRIPT_DIR/docker-compose.yml")
fi

# TLS: use the local CA only when it exists (quickstart); public certs are
# verified by the system CA pool. Connect using the cert's domain name (so
# verification matches) but resolve it to localhost; set
# KANIDM_RESOLVE_LOCAL=0 when the server is remote.
CURL_CA=()
if [ -f "$KANIDM_TLS_CA" ]; then CURL_CA=(--cacert "$KANIDM_TLS_CA"); fi
ORIGIN_HOST=$(printf '%s' "$KANIDM_API_ORIGIN" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')
ORIGIN_PORT=$(printf '%s' "$KANIDM_API_ORIGIN" | grep -oE ':[0-9]+' | head -n1 | tr -d ':')
[ -z "$ORIGIN_PORT" ] && ORIGIN_PORT=443
CURL_RESOLVE=()
if [ "${KANIDM_RESOLVE_LOCAL:-1}" = "1" ] && [ -n "$ORIGIN_HOST" ]; then
  CURL_RESOLVE=(--resolve "$ORIGIN_HOST:$ORIGIN_PORT:127.0.0.1")
fi

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

need curl
need jq
need docker

# Derive the OAuth2 origin (scheme://host[:port]) from the redirect URI.
SHENASA_ORIGIN=$(printf '%s' "$SHENASA_REDIRECT_URI" | sed -E 's#^((https?)://[^/]+)/?.*$#\1#')

# --- 1. Recover the idm_admin password -------------------------------------
log "recovering idm_admin credentials (kanidmd recover-account)…"
RECOVER_OUT=$("${COMPOSE[@]}" exec -T kanidm kanidmd recover-account idm_admin 2>&1) || {
  printf '%s\n' "$RECOVER_OUT" >&2
  die "recover-account failed — is the kanidm container running? (docker compose up -d)"
}
printf '%s\n' "$RECOVER_OUT" | grep -qi 'new_password' || {
  printf '%s\n' "$RECOVER_OUT" >&2
  die "recover-account did not return a password"
}
IDM_ADMIN_PASSWORD=$(printf '%s\n' "$RECOVER_OUT" | sed -n 's/.*new_password: "\([^"]*\)".*/\1/p' | head -n1)
# Older versions print "Password: xxx" instead.
if [ -z "$IDM_ADMIN_PASSWORD" ]; then
  IDM_ADMIN_PASSWORD=$(printf '%s\n' "$RECOVER_OUT" | grep -i 'password' | tail -n1 | sed -E 's/.*[Pp]assword:?[[:space:]]*"?([^" ]+)"?.*/\1/')
fi
[ -n "$IDM_ADMIN_PASSWORD" ] || die "could not parse the new password from recover-account output"
log "idm_admin password recovered (keep it safe)."

# --- 2. REST login (step-based password auth) -------------------------------
COOKIE_JAR=$(mktemp)
RESP_FILE=$(mktemp)
trap 'rm -f "$COOKIE_JAR" "$RESP_FILE"' EXIT

auth_step() {
  curl -fsS "${CURL_CA[@]}" "${CURL_RESOLVE[@]}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -X POST "$KANIDM_API_ORIGIN/v1/auth" -d "$1"
}

log "logging in over REST (/v1/auth, password mechanism)…"
auth_step '{"step":{"init":"idm_admin"}}' >/dev/null || die "auth step 'init' failed"
auth_step '{"step":{"begin":"password"}}' >/dev/null || die "auth step 'begin' failed"
LOGIN_JSON=$(jq -nc --arg pw "$IDM_ADMIN_PASSWORD" '{step:{cred:{password:$pw}}}')
LOGIN_RESP=$(auth_step "$LOGIN_JSON") || die "auth step 'cred' failed"
TOKEN=$(printf '%s' "$LOGIN_RESP" | jq -r '.state.success // .token // .jwt // empty')
[ -n "$TOKEN" ] || {
  printf '%s\n' "$LOGIN_RESP" >&2
  die "login did not return a session token. Cookie continuity and JSON shapes vary by Kanidm version."
}
log "authenticated as idm_admin."

# req METHOD PATH [JSON]  →  global $STATUS (http code) and body in $RESP_FILE
req() {
  local method=$1 path=$2 body=${3:-}
  local args=()
  if [ -n "$body" ]; then
    args=(-H 'Content-Type: application/json' -d "$body")
  fi
  curl -sS "${CURL_CA[@]}" "${CURL_RESOLVE[@]}" -H "Authorization: Bearer $TOKEN" \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'Accept: application/json' \
    "${args[@]}" -o "$RESP_FILE" -w '%{http_code}' \
    -X "$method" "$KANIDM_API_ORIGIN$path"
}

ok2xx() { case "$1" in 20*) return 0 ;; *) return 1 ;; esac; }

# --- 3. Create the public OAuth2 client (PKCE, no secret) -------------------
# Body shape {"attrs":{...}} with the attribute names Kanidm 1.10 expects
# (attr "name", not "oauth2_rs_name"). The landing URL is the exact redirect
# URI the SPA uses (strict redirect matching).
CLIENT_BODY=$(jq -nc \
  --arg id "$SHENASA_CLIENT_ID" \
  --arg dn "$SHENASA_DISPLAYNAME" \
  --arg landing "$SHENASA_REDIRECT_URI" \
  '{attrs:{
      name: [$id],
      displayname: [$dn],
      oauth2_rs_origin_landing: [$landing],
      oauth2_strict_redirect_uri: ["true"]
  }}')

log "creating public OAuth2 client '$SHENASA_CLIENT_ID'…"
STATUS=$(req POST "/v1/oauth2/_public" "$CLIENT_BODY")
if ok2xx "$STATUS"; then
  log "client '$SHENASA_CLIENT_ID' created."
else
  # Re-run friendly: maybe it was created by a previous (partial) run.
  STATUS_CHECK=$(req GET "/v1/oauth2/$SHENASA_CLIENT_ID")
  if ok2xx "${STATUS_CHECK:-000}" && jq -e '.attrs.name[0]' "$RESP_FILE" >/dev/null 2>&1; then
    log "client already exists — converging its configuration…"
  else
    cat "$RESP_FILE" >&2 || true
    printf '\n' >&2
    die "creating the public client failed (HTTP $STATUS). Manual fallback (inside the container):
       kanidm system oauth2 create-public $SHENASA_CLIENT_ID \"$SHENASA_DISPLAYNAME\" $SHENASA_REDIRECT_URI"
  fi
fi

# --- 4. Converge client settings (idempotent PATCH) --------------------------
PATCH_BODY=$(jq -nc \
  --arg dn "$SHENASA_DISPLAYNAME" \
  --arg landing "$SHENASA_REDIRECT_URI" \
  '{attrs:{
      displayname: [$dn],
      oauth2_rs_origin_landing: [$landing],
      oauth2_strict_redirect_uri: ["true"]
  }}')

STATUS=$(req PATCH "/v1/oauth2/$SHENASA_CLIENT_ID" "$PATCH_BODY")
ok2xx "$STATUS" || {
  cat "$RESP_FILE" >&2 || true
  printf '\n' >&2
  die "updating the client failed (HTTP $STATUS). CLI equivalent:
       kanidm system oauth2 add-redirect-url $SHENASA_CLIENT_ID $SHENASA_REDIRECT_URI"
}
log "redirect URL (landing) set: $SHENASA_REDIRECT_URI"

# --- 5. Scope maps: role groups -> allowed scopes (groups claim => RBAC) -----
# POST /v1/oauth2/{rs}/_scopemap/{group} with a JSON list of scopes. The
# built-in "groups" scope emits group SPNs, which Shenasa maps to UI roles.
ROLE_GROUPS="idm_admins idm_people_admins idm_group_admins idm_people_pii_read idm_access_control_admins idm_people_self_mail_write idm_service_desk"
SCOPES_JSON='["openid","profile","email","groups"]'
FAILED_GROUPS=""
for g in $ROLE_GROUPS; do
  STATUS=$(req POST "/v1/oauth2/$SHENASA_CLIENT_ID/_scopemap/$g" "$SCOPES_JSON")
  if ok2xx "$STATUS"; then
    log "scope map: $g -> openid profile email groups"
  else
    printf '[bootstrap] WARNING: scope map for group %s failed (HTTP %s): ' "$g" "$STATUS" >&2
    cat "$RESP_FILE" >&2 || true
    printf '\n' >&2
    FAILED_GROUPS="$FAILED_GROUPS $g"
  fi
done
if [ -n "$FAILED_GROUPS" ]; then
  die "scope map failed for group(s):$FAILED_GROUPS. CLI equivalent per group:
       kanidm system oauth2 update-scope-map $SHENASA_CLIENT_ID <group> openid profile email groups"
fi

# --- 6. Verify ---------------------------------------------------------------
log "verifying client configuration…"
STATUS=$(req GET "/v1/oauth2/$SHENASA_CLIENT_ID")
ok2xx "$STATUS" || die "could not read the client back (HTTP $STATUS)"
jq -e --arg landing "$SHENASA_REDIRECT_URI" \
  '.attrs.oauth2_rs_origin_landing | index($landing) != null' "$RESP_FILE" >/dev/null \
  || log "WARNING: redirect URL not visible in client entry; check manually."
SCOPE_COUNT=$(jq -r '(.attrs.oauth2_rs_scope_map // []) | length' "$RESP_FILE")
log "scope maps on client: $SCOPE_COUNT"
DISCOVERY="$KANIDM_API_ORIGIN/oauth2/openid/$SHENASA_CLIENT_ID/.well-known/openid-configuration"
if curl -fsS "${CURL_CA[@]}" "${CURL_RESOLVE[@]}" "$DISCOVERY" >/dev/null 2>&1; then
  log "OIDC discovery document reachable."
else
  log "WARNING: $DISCOVERY not reachable yet (client may take a moment, or the server is behind a proxy)."
fi

# --- Summary -----------------------------------------------------------------
cat <<EOF

============================================================
 Shenasa OAuth2 client summary
============================================================
 Client id (public, PKCE — no secret): $SHENASA_CLIENT_ID
 Display name:                         $SHENASA_DISPLAYNAME
 Redirect / landing URL:               $SHENASA_REDIRECT_URI
 OAuth2 origin:                        $SHENASA_ORIGIN
 OIDC discovery:                       $DISCOVERY
 Scope maps (groups claim -> roles):   $ROLE_GROUPS

 js/config.js should contain:
   apiUrl:           "https://$KANIDM_DOMAIN/v1"
   oidcClientId:     "$SHENASA_CLIENT_ID"
   oidcScope:        "openid profile email groups"
   oidcRedirectUri:  "$SHENASA_REDIRECT_URI"

 idm_admin password: (printed once by recover-account — store it in
 your password manager; it grants full administration)
============================================================
EOF
log "done."
