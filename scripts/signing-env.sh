#!/usr/bin/env bash
# signing-env.sh — source this before packaging so scripts/afterPack.cjs signs with the self-signed certificate:
#   source scripts/signing-env.sh && npm run dist:unsigned
# Nothing is exported (and the build stays ad-hoc signed) when the certificate has not been created yet.

_dir="${BICAPTION_SIGNING_DIR:-$HOME/Library/Application Support/BiCaptionSigning}"
_keychain="$_dir/bicaption-signing.keychain-db"
if [ -f "$_keychain" ] && [ -f "$_dir/password" ]; then
  security unlock-keychain -p "$(cat "$_dir/password")" "$_keychain"
  export BICAPTION_SIGN_IDENTITY="BiCaption Self-Signed"
  export BICAPTION_SIGN_KEYCHAIN="$_keychain"
  echo "signing-env: using \"$BICAPTION_SIGN_IDENTITY\""
else
  echo "signing-env: no certificate found, the build will be ad-hoc signed (run scripts/make-signing-cert.sh)"
fi
unset _dir _keychain
