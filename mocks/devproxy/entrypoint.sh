#!/usr/bin/env bash
# Starts Dev Proxy (mock Azure) and exports its root CA as PEM, so the MCP server can trust it
# through NODE_EXTRA_CA_CERTS. Mock/demo use only: never used by the production compose file.
set -uo pipefail

CERT_DIR=/home/devproxy/.config/dev-proxy/rootCert
PEM="$CERT_DIR/devproxy-ca.pem"
CONFIG="/config/${DEVPROXY_CONFIG:-devproxyrc.json}"
LOG=/tmp/devproxy.log
API=http://127.0.0.1:8897

mkdir -p "$CERT_DIR"
rm -f "$PEM" "$PEM.tmp"

/app/devproxy/devproxy \
  --ip-address 0.0.0.0 \
  --api-ip-address 0.0.0.0 \
  --as-system-proxy false \
  --config-file "$CONFIG" 2>&1 | tee "$LOG" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null; pkill -f /app/devproxy/devproxy 2>/dev/null; exit 0' TERM INT

# The Dev Proxy API needs a bearer token (generated per run). Try the token file, the startup
# banner, then the CLI.
api_token() {
  local f
  f=$(find /home/devproxy /tmp -name 'api-*.token' 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then
    tr -d '[:space:]' <"$f"
    return
  fi
  if grep -qE 'API token: [0-9A-Fa-f]{64}' "$LOG" 2>/dev/null; then
    grep -oE 'API token: [0-9A-Fa-f]{64}' "$LOG" | head -n 1 | cut -d ' ' -f 3
    return
  fi
  /app/devproxy/devproxy api token 2>/dev/null | grep -oE '[0-9A-Fa-f]{64}' | head -n 1
}

export_cert() {
  local token
  for _ in $(seq 1 90); do
    token=$(api_token)
    if [ -n "$token" ] &&
      curl -fsS -H "Authorization: Bearer $token" "$API/proxy/rootCertificate?format=crt" -o "$PEM.tmp" 2>/dev/null &&
      grep -q 'BEGIN CERTIFICATE' "$PEM.tmp"; then
      chmod 644 "$PEM.tmp" && mv "$PEM.tmp" "$PEM"
      echo "devproxy-entrypoint: root CA exported to $PEM"
      return 0
    fi
    # Fallback for images that ship openssl: convert the PKCS#12 root (empty password).
    if [ -s "$CERT_DIR/rootCert.pfx" ] && command -v openssl >/dev/null 2>&1 &&
      openssl pkcs12 -in "$CERT_DIR/rootCert.pfx" -clcerts -nokeys -passin pass: -out "$PEM.tmp" 2>/dev/null; then
      chmod 644 "$PEM.tmp" && mv "$PEM.tmp" "$PEM"
      echo "devproxy-entrypoint: root CA converted to $PEM"
      return 0
    fi
    sleep 1
  done
  echo "devproxy-entrypoint: could not export the Dev Proxy root CA" >&2
  return 1
}

export_cert || {
  kill "$proxy_pid" 2>/dev/null
  exit 1
}
wait "$proxy_pid"
