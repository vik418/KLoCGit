#!/bin/sh
set -eu

# The intercepted TLS connection must retain verification against both normal
# roots and Cloudflare's public container CA.
container_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$container_ca" ]; then
  certificate_bundle=/tmp/klocgit-certificate-bundle.pem
  cat /etc/ssl/certs/ca-certificates.crt "$container_ca" > "$certificate_bundle"
  export SSL_CERT_FILE="$certificate_bundle"
fi

exec /usr/local/bin/klocgit-host
