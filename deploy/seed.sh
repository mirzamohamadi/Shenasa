#!/usr/bin/env bash
#
# seed.sh — OPTIONAL organisation provisioning for Shenasa deployments.
#
# By default this script provisions NO data. It only creates the recommended
# real delegation structure when you ask for it:
#
#   --operators-group        create group "shenasa_operators" and give it the
#                            idm_people_admins + idm_group_admins roles
#   --operator NAME          create the operator person (idempotent)
#   --email MAIL             email address for --operator
#
# There is intentionally NO fake/demo data: everything created here is real
# provisioning against the server, which remains the source of truth.
#
# Authentication: set KANIDM_IDM_ADMIN_PASSWORD (from bootstrap.sh output),
# or you will be prompted.
#
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KANIDM_DOMAIN=${KANIDM_DOMAIN:-idm.example.com}
KANIDM_API_ORIGIN=${KANIDM_API_ORIGIN:-https://${KANIDM_DOMAIN}:8443}
KANIDM_TLS_CA=${KANIDM_TLS_CA:-$SCRIPT_DIR/tls/ca.pem}
OPERATORS_GROUP=${SHENASA_OPERATORS_GROUP:-shenasa_operators}

# Local CA only for quickstarts; --resolve keeps the cert's hostname while
# connecting locally (set KANIDM_RESOLVE_LOCAL=0 for remote servers).
CURL_CA=()
if [ -f "$KANIDM_TLS_CA" ]; then CURL_CA=(--cacert "$KANIDM_TLS_CA"); fi
ORIGIN_HOST=$(printf '%s' "$KANIDM_API_ORIGIN" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')
ORIGIN_PORT=$(printf '%s' "$KANIDM_API_ORIGIN" | grep -oE ':[0-9]+' | head -n1 | tr -d ':')
[ -z "$ORIGIN_PORT" ] && ORIGIN_PORT=443
CURL_RESOLVE=()
if [ "${KANIDM_RESOLVE_LOCAL:-1}" = "1" ] && [ -n "$ORIGIN_HOST" ]; then
  CURL_RESOLVE=(--resolve "$ORIGIN_HOST:$ORIGIN_PORT:127.0.0.1")
fi

log() { printf '[seed] %s\n' "$*"; }
die() { printf '[seed] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl
need jq

CREATE_OPERATORS=0
OPERATOR_NAME=""
OPERATOR_EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --operators-group) CREATE_OPERATORS=1; shift ;;
    --operator) OPERATOR_NAME=$2; shift 2 ;;
    --email) OPERATOR_EMAIL=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

if [ "$CREATE_OPERATORS" = "0" ] && [ -z "$OPERATOR_NAME" ]; then
  log "nothing to do by design (no fake data). Examples:"
  echo "  $0 --operators-group"
  echo "  $0 --operators-group --operator jane --email jane@example.com"
  exit 0
fi
if [ -n "$OPERATOR_NAME" ]; then CREATE_OPERATORS=1; fi

# --- credentials --------------------------------------------------------------
if [ -z "${KANIDM_IDM_ADMIN_PASSWORD:-}" ]; then
  printf 'idm_admin password (from bootstrap.sh output): '
  stty -echo 2>/dev/null || true
  read -r KANIDM_IDM_ADMIN_PASSWORD
  stty echo 2>/dev/null || true
  printf '\n'
fi
[ -n "$KANIDM_IDM_ADMIN_PASSWORD" ] || die "no idm_admin password provided"

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

auth_step() {
  curl -fsS "${CURL_CA[@]}" "${CURL_RESOLVE[@]}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -X POST "$KANIDM_API_ORIGIN/v1/auth" -d "$1"
}
log "authenticating…"
auth_step '{"step":{"init":"idm_admin"}}' >/dev/null || die "auth init failed"
auth_step '{"step":{"begin":"password"}}' >/dev/null || die "auth begin failed"
LOGIN_JSON=$(jq -nc --arg pw "$KANIDM_IDM_ADMIN_PASSWORD" '{step:{cred:{password:$pw}}}')
LOGIN_RESP=$(auth_step "$LOGIN_JSON") || die "auth cred step failed"
TOKEN=$(printf '%s' "$LOGIN_RESP" | jq -r '.state.success // .token // .jwt // empty')
[ -n "$TOKEN" ] || die "no session token returned"

api() { # method path [json] -- tolerates 409 Conflict (idempotent creates)
  local method=$1 path=$2 body=${3:-}
  local args=(curl -sS "${CURL_CA[@]}" "${CURL_RESOLVE[@]}" -H "Authorization: Bearer $TOKEN" -c "$COOKIE_JAR" -b "$COOKIE_JAR"
    -H 'Content-Type: application/json' -H 'Accept: application/json' -X "$method")
  if [ -n "$body" ]; then
    "${args[@]}" "$KANIDM_API_ORIGIN$path" -d "$body"
  else
    "${args[@]}" "$KANIDM_API_ORIGIN$path"
  fi
}

add_member() { # group member
  log "adding '$2' as member of '$1'…"
  api POST "/v1/group/$1/_attr/member" "$(jq -nc --arg m "$2" '[$m]')" >/dev/null
}

if [ "$CREATE_OPERATORS" = "1" ]; then
  log "creating operators group '$OPERATORS_GROUP'…"
  api POST /v1/group "$(jq -nc --arg n "$OPERATORS_GROUP" \
    '{attrs:{name:[$n], displayname:["Shenasa operators"]}}')" >/dev/null || true
  # Delegate the two UI roles Kanidm manages by group membership.
  log "granting idm_people_admins + idm_group_admins to '$OPERATORS_GROUP'…"
  api POST "/v1/group/idm_people_admins/_attr/member" \
    "$(jq -nc --arg m "$OPERATORS_GROUP@$KANIDM_DOMAIN" '[$m]')" >/dev/null || true
  api POST "/v1/group/idm_group_admins/_attr/member" \
    "$(jq -nc --arg m "$OPERATORS_GROUP@$KANIDM_DOMAIN" '[$m]')" >/dev/null || true
fi

if [ -n "$OPERATOR_NAME" ]; then
  log "creating operator person '$OPERATOR_NAME'…"
  ATTRS=$(jq -nc --arg n "$OPERATOR_NAME" --arg dn "$OPERATOR_NAME" \
    '{attrs:{name:[$n], displayname:[$dn]}}')
  if [ -n "$OPERATOR_EMAIL" ]; then
    ATTRS=$(printf '%s' "$ATTRS" | jq --arg mail "$OPERATOR_EMAIL" '.attrs.mail += [$mail]')
  fi
  api POST /v1/person "$ATTRS" >/dev/null || true
  api POST "/v1/group/$OPERATORS_GROUP/_attr/member" \
    "$(jq -nc --arg m "$OPERATOR_NAME@$KANIDM_DOMAIN" '[$m]')" >/dev/null
  log "operator '$OPERATOR_NAME' is a member of '$OPERATORS_GROUP'."
  log "Next: ask them to sign in to the Shenasa UI and register a passkey (Profile page)."
fi

# --- verification ---------------------------------------------------------------
log "verification:"
ENTRY=$(api GET "/v1/group/$OPERATORS_GROUP" 2>/dev/null || true)
if printf '%s' "$ENTRY" | jq -e '.attrs.name[0]' >/dev/null 2>&1; then
  printf '%s' "$ENTRY" | jq -r '.attrs | {name: .name[0], displayname: .displayname[0], member: (.member // [])}'
  log "OK: group exists on the server."
else
  log "WARNING: could not read back '$OPERATORS_GROUP' — verify manually."
fi
log "done."
