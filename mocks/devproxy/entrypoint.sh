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

# Dev Proxy 4 reads its API bearer token from DEV_PROXY_API_TOKEN (at least 32 characters). Set
# it here, per run, instead of scraping it from a file or the log. The API never leaves the
# container's network and the token never leaves this script.
DEV_PROXY_API_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
export DEV_PROXY_API_TOKEN

/app/devproxy/devproxy \
  --ip-address 0.0.0.0 \
  --api-ip-address 0.0.0.0 \
  --as-system-proxy false \
  --config-file "$CONFIG" 2>&1 | tee "$LOG" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null; pkill -f /app/devproxy/devproxy 2>/dev/null; exit 0' TERM INT

# Export the root the engine signs leaf certificates with, from the API (the in-memory
# certificate). Never convert rootCert.pfx from disk: with Dev Proxy 4 that file is not
# guaranteed to be the certificate the engine uses, and trusting the wrong one breaks every TLS
# handshake (Node: UNABLE_TO_VERIFY_LEAF_SIGNATURE, the server's login then fails with a 502).
export_cert() {
  for _ in $(seq 1 90); do
    if curl -fsS -H "Authorization: Bearer $DEV_PROXY_API_TOKEN" \
      "$API/proxy/rootCertificate?format=crt" -o "$PEM.tmp" 2>/dev/null &&
      grep -q 'BEGIN CERTIFICATE' "$PEM.tmp"; then
      chmod 644 "$PEM.tmp" && mv "$PEM.tmp" "$PEM"
      echo "devproxy-entrypoint: root CA exported to $PEM"
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
