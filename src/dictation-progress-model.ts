/**
 * Maps the stage the dictation is really in, and how long it has been there, to a bar position. The stage boundaries
 * come from real events (recognition done, polish done, paste done); inside a stage the bar advances against how long
 * that stage has actually taken on this machine for this engine. Recognition scales with how long the user spoke, so a
 * batch engine (Breeze, Groq) is not judged by a streaming engine's 0.2 s. The bar never claims completion early and
 * jumps ahead when a stage finishes sooner than expected.
 */
export type TimedStage = 'transcribing' | 'polishing' | 'outputting';

export interface StageDurations {
  /** Fixed part of recognition, ms. */
  transcribing: number;
  /** Recognition cost per second of recorded audio, ms. */
  transcribingPerSecond: number;
  polishing: number;
  outputting: number;
}

/** Starting guesses per engine, from measured sessions; they are replaced by what this machine actually does. */
export function defaultDurationsForEngine(engine: string): StageDurations {
  const base = { polishing: 900, outputting: 800 };
  if (engine === 'breeze-asr-25') return { ...base, transcribing: 800, transcribingPerSecond: 250 };
  if (engine === 'groq-whisper') return { ...base, transcribing: 700, transcribingPerSecond: 80 };
  return { ...base, transcribing: 120, transcribingPerSecond: 15 };
}

const MIN_STAGE_MS = 50;
const MAX_STAGE_MS = 15_000;
const MAX_PER_SECOND_MS = 3000;
/** Share of a stage's span the bar may fill by elapsed time alone; the rest is only granted when the stage ends. */
const STAGE_SOFT_CAP = 0.9;
/** A stage that takes more than this many times its expectation is reported as running long. */
export const RUNNING_LONG_FACTOR = 2;

export function blendDuration(previous: number, observed: number, weight = 0.3, max = MAX_STAGE_MS) {
  const clamped = Math.min(max, Math.max(MIN_STAGE_MS, observed));
  return (1 - weight) * previous + weight * clamped;
}

export function expectedStageMs(stage: TimedStage, durations: StageDurations, recordedMs: number) {
  if (stage === 'transcribing') {
    return durations.transcribing + durations.transcribingPerSecond * (Math.max(0, recordedMs) / 1000);
  }
  return durations[stage];
}

export function learnStageDuration(
  current: StageDurations,
  stage: TimedStage,
  observedMs: number,
  recordedMs = 0,
): StageDurations {
  if (stage !== 'transcribing') {
    return { ...current, [stage]: blendDuration(current[stage], observedMs) };
  }
  const seconds = Math.max(0.5, recordedMs / 1000);
  const perSecond = Math.max(0, (observedMs - current.transcribing) / seconds);
  return {
    ...current,
    transcribingPerSecond: Math.min(MAX_PER_SECOND_MS, (1 - 0.3) * current.transcribingPerSecond + 0.3 * perSecond),
  };
}

export function stageOrder(polishEnabled: boolean): TimedStage[] {
  return polishEnabled ? ['transcribing', 'polishing', 'outputting'] : ['transcribing', 'outputting'];
}

export function stageIsRunningLong(stage: TimedStage, elapsedMs: number, durations: StageDurations, recordedMs: number) {
  return elapsedMs > RUNNING_LONG_FACTOR * expectedStageMs(stage, durations, recordedMs);
}

export function progressFraction(options: {
  stage: TimedStage;
  elapsedMs: number;
  recordedMs: number;
  polishEnabled: boolean;
  durations: StageDurations;
}): number {
  const order = stageOrder(options.polishEnabled);
  const expectedOf = (stage: TimedStage) => expectedStageMs(stage, options.durations, options.recordedMs);
  const total = order.reduce((sum, stage) => sum + expectedOf(stage), 0);
  const index = order.indexOf(options.stage);
  if (index === -1 || total <= 0) return 0;
  const before = order.slice(0, index).reduce((sum, stage) => sum + expectedOf(stage), 0);
  const expected = expectedOf(options.stage);
  const elapsed = Math.max(0, options.elapsedMs);
  const inStage = elapsed <= expected
    ? STAGE_SOFT_CAP * (elapsed / expected)
    : STAGE_SOFT_CAP + (1 - STAGE_SOFT_CAP) * (1 - Math.exp(-(elapsed - expected) / expected)) * 0.99;
  return (before + inStage * expected) / total;
}
