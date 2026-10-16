import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const afterPack = readFileSync(new URL('../scripts/afterPack.cjs', import.meta.url), 'utf8');

test('packaging stays ad-hoc signed unless a certificate identity is supplied', () => {
  assert.match(afterPack, /process\.env\.BICAPTION_SIGN_IDENTITY \|\| ''\)\.trim\(\) \|\| '-'/);
  assert.match(afterPack, /SIGN_IDENTITY === '-' \? `--requirements '=designated => identifier/);
  // Every codesign call goes through the shared flags, so no helper can end up signed with a different identity.
  assert.doesNotMatch(afterPack, /--sign -[ "]/);
  assert.equal((afterPack.match(/codesign --force/g) ?? []).length, (afterPack.match(/\$\{signFlags\}/g) ?? []).length);
});

test('the certificate scripts keep the private key out of the repository', () => {
  const create = readFileSync(new URL('../scripts/make-signing-cert.sh', import.meta.url), 'utf8');
  const env = readFileSync(new URL('../scripts/signing-env.sh', import.meta.url), 'utf8');
  assert.match(create, /Library\/Application Support\/BiCaptionSigning/);
  assert.match(create, /umask 077/);
  assert.doesNotMatch(create + env, /gh secret|--to-github|git (add|push)/);
});
