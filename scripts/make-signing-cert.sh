#!/usr/bin/env bash
# make-signing-cert.sh — create the self-signed code-signing certificate used for BiCaption builds (run once).
#
# Why: ad-hoc signatures have no stable identity, so an update can only be matched to the installed app by bundle
# identifier. Signing every build with the same certificate gives the app a requirement that includes the certificate,
# which keeps macOS permission grants across updates and lets an update be checked against the installed app.
# This does NOT remove the Gatekeeper prompt: only an Apple Developer ID plus notarization does that.
#
# The certificate lives in its own keychain file with a random password stored next to it, so building never touches
# the login keychain and never shows an authorization dialog. The private key stays on this machine. Do not commit
# or upload anything from the directory below.
#
#   bash scripts/make-signing-cert.sh            create the certificate
#   bash scripts/make-signing-cert.sh --trust    let macOS trust it for code signing (asks for your login password)
#   bash scripts/make-signing-cert.sh --status   show whether the certificate exists and is trusted
#   source scripts/signing-env.sh                set the variables that make `npm run dist:unsigned` use it
set -euo pipefail

NAME="BiCaption Self-Signed"
DIR="${BICAPTION_SIGNING_DIR:-$HOME/Library/Application Support/BiCaptionSigning}"
KEYCHAIN="$DIR/bicaption-signing.keychain-db"

mode="${1:-create}"

if [ "$mode" = "--status" ]; then
  if [ ! -f "$KEYCHAIN" ]; then echo "not created: run scripts/make-signing-cert.sh"; exit 1; fi
  security unlock-keychain -p "$(cat "$DIR/password")" "$KEYCHAIN"
  security find-identity -p codesigning "$KEYCHAIN"
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$NAME" && echo "trusted: yes" || echo "trusted: no (run --trust)"
  exit 0
fi

if [ "$mode" = "--trust" ]; then
  [ -f "$KEYCHAIN" ] || { echo "Create the certificate first: bash scripts/make-signing-cert.sh"; exit 1; }
  pem="$(mktemp)"
  trap 'rm -f "$pem"' EXIT
  security unlock-keychain -p "$(cat "$DIR/password")" "$KEYCHAIN"
  security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$pem"
  echo "macOS will ask for your login password to trust \"$NAME\" for code signing."
  security add-trusted-cert -r trustRoot -p codeSign "$pem"
  security find-identity -v -p codesigning "$KEYCHAIN"
  exit 0
fi

if [ "$mode" != "create" ]; then
  echo "unknown option: $mode" >&2
  exit 2
fi

if [ -f "$KEYCHAIN" ]; then
  echo "The certificate already exists: $KEYCHAIN"
  echo "Check it with: bash scripts/make-signing-cert.sh --status"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
keychain_pass="$(openssl rand -hex 24)"
( umask 077; printf '%s' "$keychain_pass" > "$DIR/password" )

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
# macOS `security import` cannot read the default OpenSSL 3 PKCS#12 encryption; -legacy makes it readable.
p12pass="$(openssl rand -hex 12)"
openssl pkcs12 -export -legacy -inkey "$work/key.pem" -in "$work/cert.pem" -name "$NAME" \
  -out "$work/cert.p12" -passout "pass:$p12pass" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$NAME" \
       -out "$work/cert.p12" -passout "pass:$p12pass"

security create-keychain -p "$keychain_pass" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"            # never lock automatically
security unlock-keychain -p "$keychain_pass" "$KEYCHAIN"
security import "$work/cert.p12" -k "$KEYCHAIN" -P "$p12pass" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_pass" "$KEYCHAIN" >/dev/null

echo "Created \"$NAME\" in $KEYCHAIN (valid for 10 years)."
echo "Next: bash scripts/make-signing-cert.sh --trust   (once, asks for your login password)"
echo "Then: source scripts/signing-env.sh && npm run dist:unsigned"
