import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

test('standard app packaging includes the Breeze runtime so its model can be downloaded', () => {
  assert.match(packageJson.scripts.dist, /build:sidecar:breeze-asr/);
  assert.match(packageJson.scripts['dist:unsigned'], /build:sidecar:breeze-asr/);
});

test('Breeze remains selectable for VAD-segmented meeting captions after restart', () => {
  const settingsSource = readFileSync(join(import.meta.dirname, '..', 'electron', 'settings.ts'), 'utf8');
  const appSource = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
  const providerRegistryPath = join(import.meta.dirname, '..', '..', '..', '.agent', 'capabilities', 'providers.json');

  const meetingNormalization = settingsSource.slice(
    settingsSource.indexOf('function normalizeMeetingSttModel'),
    settingsSource.indexOf('function normalizeSubtitleTranslateModel'),
  );
  const meetingOptions = appSource.slice(
    appSource.indexOf("const meetingAsrOptions"),
    appSource.indexOf('const meetingTurns'),
  );

  assert.doesNotMatch(meetingNormalization, /breeze-asr-25/);
  assert.match(meetingOptions, /option\.key === 'breeze-asr-25' && !localModelStatus\?\.breezeAsr/);

  // The provider registry belongs to the parent workspace, not the extracted
  // BiCaption repository. Validate it when present without making standalone
  // app tests depend on a private monorepo layout.
  if (existsSync(providerRegistryPath)) {
    const providers = JSON.parse(readFileSync(providerRegistryPath, 'utf8')) as {
      providers: Array<{ id: string; supportedUiModes: string[] }>;
    };
    const breeze = providers.providers.find((provider) => provider.id === 'breeze-asr-25');
    assert.ok(breeze?.supportedUiModes.includes('meeting'));
  }
});

test('Breeze packaging keeps mlx-whisper timing dependencies available', () => {
  const buildScript = readFileSync(join(import.meta.dirname, '..', 'scripts', 'build-sidecar.sh'), 'utf8');

  assert.match(buildScript, /if ! bicaption_include_breeze_asr; then\s+LOCAL_LLM_EXCLUDES\+=\(\s+--exclude-module scipy\s+--exclude-module numba\s+--exclude-module llvmlite\s+\)/s);
});
