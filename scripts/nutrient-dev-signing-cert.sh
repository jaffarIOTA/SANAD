#!/usr/bin/env bash
# Throwaway signing material for the development signing service
# (adapters/nutrient/signing-service/server.mjs, check V-04).
#
# Writes a self-signed CA and a signer certificate issued by it into
# adapters/nutrient/compose/.signing/, which is gitignored. Both are named
# "DEVELOPMENT ONLY — NOT TRUSTED", valid for 30 days, and must never be used
# for anything but plumbing: a signature made with them proves the path works,
# not that a document is signed (OI-06 needs the licensed provider's certificate).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/adapters/nutrient/compose/.signing"
if [[ -f "$DIR/signer.key" && "${1:-}" != "--force" ]]; then
  echo "Signing material already exists in $DIR (pass --force to replace it)."
  exit 0
fi
mkdir -p "$DIR/trust"
chmod 700 "$DIR"
cd "$DIR"

openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 30 \
  -keyout ca.key -out ca.crt \
  -subj "/O=Sanad development/CN=Sanad Development Signing CA - NOT TRUSTED" \
  -extensions v3_ca -config <(printf '[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n') 2>/dev/null

openssl req -newkey rsa:3072 -nodes -sha256 \
  -keyout signer.key -out signer.csr \
  -subj "/O=Sanad development/CN=Sanad Development Signer - NOT TRUSTED" 2>/dev/null

openssl x509 -req -in signer.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 30 \
  -out signer.crt \
  -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n') 2>/dev/null

rm -f signer.csr ca.srl
cp ca.crt trust/sanad-development-ca.crt
# The signing service runs as the node image's user; it must read the key, nobody else on the host.
chmod 600 ca.key
chmod 644 signer.key signer.crt ca.crt trust/sanad-development-ca.crt
chmod 755 "$DIR"
echo "Wrote development signing material to $DIR (self-signed, 30 days, NOT TRUSTED)."
