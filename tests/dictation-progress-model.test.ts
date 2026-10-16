import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blendDuration,
  defaultDurationsForEngine,
  expectedStageMs,
  learnStageDuration,
  progressFraction,
  stageIsRunningLong,
  type StageDurations,
} from '../src/dictation-progress-model.js';

const durations: StageDurations = { transcribing: 200, transcribingPerSecond: 100, polishing: 1000, outputting: 700 };
const common = { polishEnabled: true, durations, recordedMs: 2000 }; // 2 s of speech -> recognition expected 400 ms

test('the bar starts at zero, rises with elapsed time, and is monotonic within a stage', () => {
  const at = (ms: number) => progressFraction({ ...common, stage: 'transcribing', elapsedMs: ms });
  assert.equal(at(0), 0);
  let previous = -1;
  for (let ms = 0; ms <= 3000; ms += 50) {
    const value = at(ms);
    assert.ok(value >= previous, `non-decreasing at ${ms} ms`);
    assert.ok(value < 1, 'never reaches 100% before the work is actually done');
    previous = value;
  }
});

test('stages occupy their share of the bar in proportion to their expected duration', () => {
  const total = 400 + 1000 + 700;
  const start = (stage: 'transcribing' | 'polishing' | 'outputting') => progressFraction({ ...common, stage, elapsedMs: 0 });
  assert.ok(Math.abs(start('polishing') - 400 / total) < 1e-9);
  assert.ok(Math.abs(start('outputting') - 1400 / total) < 1e-9);
});

test('recognition is expected to take longer for longer speech, so a batch engine is not judged by a short clip', () => {
  assert.equal(expectedStageMs('transcribing', durations, 0), 200);
  assert.equal(expectedStageMs('transcribing', durations, 10_000), 1200);
  const shortSpeech = progressFraction({ ...common, recordedMs: 1000, stage: 'transcribing', elapsedMs: 600 });
  const longSpeech = progressFraction({ ...common, recordedMs: 20_000, stage: 'transcribing', elapsedMs: 600 });
  assert.ok(longSpeech < shortSpeech, 'the same wait is a smaller share of a long recording');
});

test('engines start from their own measured expectations', () => {
  const breeze = defaultDurationsForEngine('breeze-asr-25');
  const sense = defaultDurationsForEngine('sensevoice');
  assert.ok(expectedStageMs('transcribing', breeze, 5000) > 5 * expectedStageMs('transcribing', sense, 5000));
});

test('without polishing the bar is split between recognising and outputting only', () => {
  const start = progressFraction({ ...common, polishEnabled: false, stage: 'outputting', elapsedMs: 0 });
  assert.ok(Math.abs(start - 400 / 1100) < 1e-9);
});

test('a stage that overruns its expectation creeps forward but cannot cross into the next stage', () => {
  const nextStart = progressFraction({ ...common, stage: 'outputting', elapsedMs: 0 });
  const overrun = progressFraction({ ...common, stage: 'polishing', elapsedMs: 60_000 });
  assert.ok(overrun < nextStart);
  assert.ok(overrun > progressFraction({ ...common, stage: 'polishing', elapsedMs: 1000 }));
});

test('finishing early jumps the bar ahead; running long is flagged so the UI can say so', () => {
  const early = progressFraction({ ...common, stage: 'outputting', elapsedMs: 0 });
  const stillPolishing = progressFraction({ ...common, stage: 'polishing', elapsedMs: 100 });
  assert.ok(early > stillPolishing + 0.3);
  assert.equal(stageIsRunningLong('transcribing', 700, durations, 2000), false);
  assert.equal(stageIsRunningLong('transcribing', 900, durations, 2000), true);
});

test('observed durations are blended in and clamped so a freak value cannot wreck the estimate', () => {
  assert.equal(blendDuration(1000, 500, 0.5), 750);
  assert.equal(blendDuration(1000, 60_000, 0.5), 0.5 * 1000 + 0.5 * 15_000);
  const polish = learnStageDuration(defaultDurationsForEngine('sensevoice'), 'polishing', 400);
  assert.ok(polish.polishing < 900 && polish.polishing > 400);
  assert.equal(polish.transcribing, defaultDurationsForEngine('sensevoice').transcribing);
});

test('recognition speed is learned per second of audio, not as a flat time', () => {
  const start = defaultDurationsForEngine('breeze-asr-25');
  // 20 s of speech took 6 s: a long recording must not teach a short one that recognition takes 6 s
  const learned = learnStageDuration(start, 'transcribing', 6000, 20_000);
  assert.ok(learned.transcribingPerSecond > 0 && learned.transcribingPerSecond < start.transcribingPerSecond + 300);
  assert.equal(learned.transcribing, start.transcribing);
  assert.ok(expectedStageMs('transcribing', learned, 1000) < 2000);
});

test('the overlay draws a determinate bar from the model and never from a looping animation', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useDictationBar\(/);
  assert.match(app, /role="progressbar"/);
  assert.match(app, /style=\{\{ width: `\$\{Math\.round\(barFraction \* 100\)\}%` \}\}/);
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.dictation-float-bar-fill\s*\{[^}]*transition: width/s);
  assert.doesNotMatch(styles.match(/\.dictation-float-bar-fill\s*\{[^}]*\}/s)![0], /animation/);
});
