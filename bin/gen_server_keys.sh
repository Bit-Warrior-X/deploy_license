#!/usr/bin/env bash
# gen_server_keys.sh — generates server_private_key.pem + server_public_key.pem

set -euo pipefail

BITS="${1:-3072}"

mkdir -p secrets
chmod 700 secrets

# Unencrypted private key (PKCS#1 RSA key)
openssl genrsa -out secrets/server_private_key.pem "$BITS"

# Public key (SPKI/SubjectPublicKeyInfo)
openssl rsa -in secrets/server_private_key.pem -pubout -out secrets/server_public_key.pem

# Restrict permissions
chmod 600 secrets/server_private_key.pem
echo "Wrote: secrets/server_private_key.pem (priv), secrets/server_public_key.pem (pub)"
