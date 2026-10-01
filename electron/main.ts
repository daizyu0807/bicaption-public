import { prepareAppleTranslation } from './apple-translation.js';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Tray, nativeImage, screen, shell, systemPreferences } from 'electron';
import type { MessageBoxOptions } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, open as fsOpenAsync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SidecarBridge } from './sidecar.js';
import { SystemAudioCapture } from './system-audio-capture.js';
import { NativeHotkeyBridge } from './native-hotkey.js';
import { getActivateBehavior } from './activate-behavior.js';
import { getTrayImagePreferenceOrder } from './tray-strategy.js';
import { shouldHideDockForTray, shouldKeepDockVisibleWithoutTray } from './tray-startup.js';
import { loadSettings, saveSettings } from './settings.js';
import { ModelDownloader } from './model-downloader.js';
import { appendDictationLearningRecord, listDictationLearningRecords } from './dictation-learning.js';
import { getAppleSttCommand, getAppleSttHelperAppPath, getDebugTracePath, getDictationLearningHistoryPath, getSidecarCommand, getGlobalHotkeyCommand, getManagedHuggingFaceHome, getModelDir, getSpawnCwd } from './paths.js';
import type { AppSettings, CaptionConfig, DictationFinalEvent, DictationHotkeyBinding, DictationHotkeyEvent, DictationLearningRecord, DictationOutputAction, DictationOutputStatusEvent, MeetingCopilotInsightsRequest, MeetingCopilotInsightsResult, MeetingEnrollSpeakerRequest, MeetingEnrollSpeakerResult, MeetingNotesRequest, MeetingNotesResult, MeetingReportRequest, MeetingReportResult, ModelDownloadProgress, OverlayBounds, SessionMode, SidecarEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isPackaged = app.isPackaged;
const rendererEntry = process.env.VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../renderer/index.html')}`;
const projectRoot = join(__dirname, '../..');
const preloadPath = isPackaged
  ? join(app.getAppPath(), 'electron', 'preload.cjs')
  : join(projectRoot, 'electron', 'preload.cjs');

let settingsWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlaySuppressed = false;
let saveFilePath: string | null = null;
let meetingTranscriptFilePath: string | null = null;
let isQuitting = false;
let activeSessionMode: SessionMode | null = null;
let activeSessionId: string | null = null;
let sessionTransitionPromise: Promise<void> | null = null;
let hotkeyListenerMode: 'dictation' | 'test' | 'idle' = 'idle';
let pendingDictationStop = false;
let dictationHotkeyPressed = false;
let dictationModifierOnlyStartTimeout: NodeJS.Timeout | null = null;
let dictationStartedAtMs: number | null = null;
let pendingDictationCancel = false;
let pendingDictationPasteTarget: FocusSnapshot | null = null;
let dictationOverlayHideTimeout: NodeJS.Timeout | null = null;
let overlayMode: 'hidden' | 'subtitle' | 'dictation' | 'preview' = 'hidden';
let subtitleOverlayBoundsCache: OverlayBounds | null = null;
let dictationOverlayBoundsCache: OverlayBounds | null = null;
let tray: Tray | null = null;
let trayAvailable = false;
let updateStatus: 'idle' | 'checking' = 'idle';

type FocusSnapshot = {
  appName: string;
  windowTitle: string | null;
  windowX: number | null;
  windowY: number | null;
  windowWidth: number | null;
  windowHeight: number | null;
};

const GITHUB_RELEASES_URL = 'https://github.com/daizyu0807/bicaption-public/releases';
const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/daizyu0807/bicaption-public/releases/latest';
const GROQ_CHAT_COMPLETIONS_API = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_TEXT_MODEL = 'llama-3.3-70b-versatile';
const MEETING_COPILOT_MAX_TRANSCRIPT_CHARS = 12000;
const MEETING_COPILOT_TIMEOUT_MS = 15000;

const DEFAULT_SUBTITLE_OVERLAY_WIDTH = 900;
const DEFAULT_SUBTITLE_OVERLAY_HEIGHT = 220;
const MIN_SUBTITLE_OVERLAY_WIDTH = 420;
const MIN_SUBTITLE_OVERLAY_HEIGHT = 140;
const DICTATION_OVERLAY_SIZE = 56;
const TRAY_ICON_SIZE = 20;

const bridge = new SidecarBridge();
const nativeHotkeyBridge = new NativeHotkeyBridge();
const systemAudioCapture = new SystemAudioCapture();
let sckPipePath: string | null = null;
let sckPipeFd: number | null = null;
const modelDownloader = new ModelDownloader(getModelDir(), getManagedHuggingFaceHome());
const tracePath = getDebugTracePath();
const verboseMainTracing = process.env.BICAPTION_VERBOSE_TRACE === '1';

function isRecoverableGroqWhisperQuotaError(event: SidecarEvent): event is Extract<SidecarEvent, { type: 'error' }> {
  return event.type === 'error'
    && event.mode === 'dictation'
    && event.code === 'groq_whisper_quota_exceeded';
}

function isRecoverableBreezeAsrError(event: SidecarEvent): event is Extract<SidecarEvent, { type: 'error' }> {
  return event.type === 'error'
    && event.mode === 'dictation'
    && (event.code === 'breeze_asr_unavailable' || event.code === 'breeze_asr_failed');
}

function fallbackDictationSttToAppleStt(expectedModel: 'groq-whisper' | 'breeze-asr-25') {
  const settings = loadSettings();
  if (settings.dictationSttModel !== expectedModel) {
    return false;
  }
  const nextSettings = saveSettings({
    dictationSttModel: 'apple-stt',
  } satisfies Partial<AppSettings>);
  sendToWindows('settings:changed', nextSettings);
  rebuildTrayMenu();
  return true;
}

function traceMain(message: string) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${new Date().toISOString()} [electron-main] ${message}\n`, 'utf-8');
  } catch {
    // Ignore trace write failures.
  }
}

function traceMainVerbose(message: string) {
  if (!verboseMainTracing) {
    return;
  }
  traceMain(message);
}

traceMain(`module_loaded pid=${process.pid} packaged=${String(app.isPackaged)} cwd=${process.cwd()}`);

function getTrayIconPath() {
  if (isPackaged) {
    return join(process.resourcesPath, 'icon_1024_norm.png');
  }
  return join(projectRoot, 'build', 'icon.icns');
}

function getTrayAppIconPath() {
  if (isPackaged) {
    return join(process.resourcesPath, 'icon_1024_norm.png');
  }
  return join(projectRoot, 'build', 'icon_1024_norm.png');
}

function createTrayTemplateImage() {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="12" height="12" rx="2.75" stroke-width="1.5"/>
        <path d="M1.8 9h2.1c.34 0 .63-.21.86-.73l.82-1.88c.2-.45.48-.69.83-.69.35 0 .63.24.83.69l1.14 4.76c.2.45.48.69.83.69.35 0 .63-.24.83-.69l1.15-4.17c.2-.45.48-.69.83-.69.35 0 .64.24.84.69l.6 1.63c.2.52.49.73.83.73H16.2" stroke-width="1.35"/>
      </g>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  const resized = image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  resized.setTemplateImage(true);
  return resized;
}

function describeNativeImage(image: Electron.NativeImage) {
  const size = image.getSize();
  return `empty=${String(image.isEmpty())} size=${size.width}x${size.height} template=${String(image.isTemplateImage())}`;
}

function createNamedTrayImage() {
  const image = nativeImage.createFromNamedImage('NSImageNameActionTemplate');
  const resized = image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  resized.setTemplateImage(true);
  return resized;
}

function getTrayTemplatePath() {
  if (isPackaged) {
    return join(process.resourcesPath, 'trayTemplate.png');
  }
  return join(projectRoot, 'build', 'trayTemplate.png');
}

function createTrayImage() {
  for (const source of getTrayImagePreferenceOrder({ isPackaged })) {
    if (source === 'app-icon') {
      const appImage = nativeImage.createFromPath(getTrayAppIconPath()).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
      if (!appImage.isEmpty()) {
        traceMain(`createTrayImage source=app-icon path=${getTrayAppIconPath()} ${describeNativeImage(appImage)}`);
        return appImage;
      }
      continue;
    }
    if (source === 'template-file') {
      const templatePath = getTrayTemplatePath();
      const templateImage = nativeImage.createFromPath(templatePath);
      if (!templateImage.isEmpty()) {
        const resized = templateImage.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
        resized.setTemplateImage(true);
        traceMain(`createTrayImage source=template path=${templatePath} ${describeNativeImage(resized)}`);
        return resized;
      }
      continue;
    }
    if (source === 'inline-template') {
      const inlineImage = createTrayTemplateImage();
      if (!inlineImage.isEmpty()) {
        traceMain(`createTrayImage source=inline ${describeNativeImage(inlineImage)}`);
        return inlineImage;
      }
      continue;
    }
    if (source === 'named-template') {
      const namedImage = createNamedTrayImage();
      if (!namedImage.isEmpty()) {
        traceMain(`createTrayImage source=named ${describeNativeImage(namedImage)}`);
        return namedImage;
      }
    }
  }
  const fallbackInline = createTrayTemplateImage();
  traceMain(`createTrayImage source=fallback-inline ${describeNativeImage(fallbackInline)}`);
  return fallbackInline;
}

function formatSaveFilename(date: Date): string {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}.txt`;
}

function formatMeetingTranscriptFilename(date: Date) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}_meeting.md`;
}

function initSaveFile() {
  const settings = loadSettings();
  if (!settings.saveEnabled || !settings.saveDirectory) {
    saveFilePath = null;
    return;
  }
  if (!existsSync(settings.saveDirectory)) {
    mkdirSync(settings.saveDirectory, { recursive: true });
  }
  saveFilePath = join(settings.saveDirectory, formatSaveFilename(new Date()));
}

function initMeetingTranscriptFile() {
  const settings = loadSettings();
  if (!settings.meetingSaveTranscript || !settings.meetingTranscriptDirectory) {
    meetingTranscriptFilePath = null;
    return;
  }
  if (!existsSync(settings.meetingTranscriptDirectory)) {
    mkdirSync(settings.meetingTranscriptDirectory, { recursive: true });
  }
  meetingTranscriptFilePath = join(settings.meetingTranscriptDirectory, formatMeetingTranscriptFilename(new Date()));
  appendFileSync(meetingTranscriptFilePath, `# Meeting Transcript\n\nStarted: ${new Date().toISOString()}\n\n`, 'utf-8');
}

function appendCaption(event: SidecarEvent) {
  if (!saveFilePath || event.type !== 'final_caption' || event.mode !== 'subtitle') {
    return;
  }
  const settings = loadSettings();
  const translationEnabled = settings.translateModel !== 'disabled'
    && (settings.sourceLang === 'auto' || settings.targetLang !== settings.sourceLang);
  // When translation is enabled, wait for the second emit that carries
  // translatedText — skip the first emit (sourceText only) to avoid
  // duplicate English lines in the saved file.
  if (translationEnabled && !event.translatedText) {
    return;
  }
  let line = event.sourceText;
  if (event.translatedText) {
    line += `\n${event.translatedText}`;
  }
  appendFileSync(saveFilePath, line + '\n\n', 'utf-8');
}

function formatTimeLabel(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString('zh-TW', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function appendMeetingCaption(event: SidecarEvent) {
  if (!meetingTranscriptFilePath || event.type !== 'meeting_caption' || event.mode !== 'meeting') {
    return;
  }
  const settings = loadSettings();
  const label = event.speakerKind === 'verified-local'
    ? settings.meetingMicrophoneLabel || event.speakerLabel || '我方'
    : event.source === 'microphone'
      ? settings.meetingMicrophoneLabel
      : settings.meetingSystemLabel;
  const startedAt = formatTimeLabel(event.tsStartMs);
  const endedAt = formatTimeLabel(event.tsEndMs);

  if (event.translatedText) {
    // Second emission: translation arrived — append translation only.
    appendFileSync(meetingTranscriptFilePath, `> [${startedAt}] ${event.translatedText}\n\n`, 'utf-8');
  } else {
    // First emission: always save the original text immediately.
    const block = `## [${startedAt} - ${endedAt}] ${label}\n\n${event.text}`;
    appendFileSync(meetingTranscriptFilePath, block + '\n\n', 'utf-8');
  }
}

function getLatestMeetingTranscriptPath() {
  const settings = loadSettings();
  const baseDir = settings.meetingTranscriptDirectory;
  if (!baseDir || !existsSync(baseDir)) {
    return null;
  }
  const candidates = readdirSync(baseDir)
    .filter((entry) => entry.endsWith('_meeting.md'))
    .map((entry) => {
      const path = join(baseDir, entry);
      return {
        path,
        mtimeMs: statSync(path).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

function buildMeetingNotesPrompt(transcript: string, request: MeetingNotesRequest) {
  return [
    'You are a deterministic meeting notes generator.',
    `Target language: ${request.targetLang}.`,
    'Return a minified JSON object with this exact shape:',
    '{"summary":"string","decisions":["string"],"actionItems":["string"],"risks":["string"]}',
    'Rules:',
    '1. Base everything strictly on the transcript.',
    '2. Do not invent owners, dates, or decisions that are not supported by the transcript.',
    `3. ${request.includeActionItems ? 'Include concrete action items when present.' : 'Leave actionItems empty.'}`,
    `4. ${request.includeRisks ? 'Include open risks or unresolved questions when present.' : 'Leave risks empty.'}`,
    `5. ${request.includeSpeakerNames ? 'Preserve speaker labels when they help clarity.' : 'Do not emphasize speaker labels.'}`,
    '6. Keep the summary concise but useful.',
    'Additional instructions:',
    request.promptTemplate.trim() || 'Summarize the meeting into an executive summary with decisions and follow-ups.',
    'Transcript:',
    transcript.trim(),
  ].join('\n');
}

function resolveGroqTextModel(model: string | undefined) {
  const candidate = (model ?? '').trim();
  if (candidate && candidate.toLowerCase() !== 'auto') {
    return candidate;
  }
  return DEFAULT_GROQ_TEXT_MODEL;
}

function takeRecentMeetingTranscript(transcript: string) {
  const normalized = transcript.trim();
  if (normalized.length <= MEETING_COPILOT_MAX_TRANSCRIPT_CHARS) {
    return normalized;
  }
  return normalized.slice(-MEETING_COPILOT_MAX_TRANSCRIPT_CHARS);
}

function resolveMeetingCopilotTargetLang(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (candidate && candidate.length <= 20 && /^[a-z0-9-]+$/i.test(candidate)) {
    return candidate;
  }
  return 'zh-TW';
}

function buildMeetingCopilotPrompt(transcript: string, request: MeetingCopilotInsightsRequest) {
  const targetLang = resolveMeetingCopilotTargetLang(request?.targetLang);
  return [
    'You are a careful in-meeting copilot.',
    `Target language: ${targetLang}.`,
    'Return a minified JSON object with this exact shape:',
    '{"summary":"string","topics":["string"],"reminders":["string"]}',
    'Rules:',
    '1. Base every factual claim strictly on the transcript excerpt.',
    '2. Do not invent decisions, owners, dates, facts, or action items.',
    '3. Keep summary short and useful for someone currently in the meeting.',
    '4. Topics should name what is currently or recently being discussed.',
    '5. Reminders should be lightweight unresolved points, questions, or follow-ups.',
    '6. If there is not enough transcript yet, keep fields brief instead of guessing.',
    '7. Return valid JSON only. Do not include markdown, code fences, or explanations.',
    'Transcript excerpt:',
    takeRecentMeetingTranscript(transcript),
  ].join('\n');
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function extractJsonObjectText(raw: string) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

async function runMeetingCopilotInsights(request: MeetingCopilotInsightsRequest): Promise<MeetingCopilotInsightsResult> {
  const transcript = (typeof request?.transcriptText === 'string' ? request.transcriptText : '').trim();
  if (!transcript) {
    throw new Error('No meeting transcript is available yet.');
  }

  const settings = loadSettings();
  const apiKey = settings.dictationCloudApiKey.trim();
  if (!apiKey) {
    throw new Error('Groq API Key is required for meeting insights.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEETING_COPILOT_TIMEOUT_MS);
  try {
    const response = await fetch(GROQ_CHAT_COMPLETIONS_API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `BiCaption/${app.getVersion()}`,
      },
      body: JSON.stringify({
        model: resolveGroqTextModel(settings.dictationCloudModel),
        temperature: 0.2,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You generate concise in-meeting insights. Return valid JSON only.',
          },
          {
            role: 'user',
            content: buildMeetingCopilotPrompt(transcript, request),
          },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Groq meeting insights failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) {
      throw new Error('Groq meeting insights returned an empty response.');
    }
    const parsed = JSON.parse(extractJsonObjectText(content)) as { summary?: unknown; topics?: unknown; reminders?: unknown };
    return {
      summary: String(parsed.summary ?? '').trim(),
      topics: normalizeStringArray(parsed.topics),
      reminders: normalizeStringArray(parsed.reminders),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Groq meeting insights timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatMeetingNotesMarkdown(result: MeetingNotesResult) {
  const sections = [
    '# Meeting Notes',
    '',
    '## Summary',
    result.summary || 'No summary generated.',
    '',
    '## Decisions',
    ...(result.decisions.length > 0 ? result.decisions.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Action Items',
    ...(result.actionItems.length > 0 ? result.actionItems.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Risks',
    ...(result.risks.length > 0 ? result.risks.map((item) => `- ${item}`) : ['- None']),
    '',
  ];
  return sections.join('\n');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildMeetingReportHtml(title: string, transcript: string, notes: MeetingNotesResult | null) {
  const transcriptBlocks = transcript
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<article class="transcript-block"><pre>${escapeHtml(block)}</pre></article>`)
    .join('\n');

  const renderList = (items: string[]) => (
    items.length > 0
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="muted">None</p>'
  );

  const notesSection = notes ? `
    <section class="card">
      <h2>Summary</h2>
      <p>${escapeHtml(notes.summary || 'No summary generated.')}</p>
      <h3>Decisions</h3>
      ${renderList(notes.decisions)}
      <h3>Action Items</h3>
      ${renderList(notes.actionItems)}
      <h3>Risks</h3>
      ${renderList(notes.risks)}
    </section>
  ` : `
    <section class="card">
      <h2>Summary</h2>
      <p class="muted">No meeting notes were generated.</p>
    </section>
  `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f1e8; color: #1f1d1a; }
      main { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
      h1, h2, h3 { margin: 0 0 12px; }
      .hero { margin-bottom: 24px; padding: 28px; border-radius: 24px; background: linear-gradient(135deg, #fff9ef, #efe1c6); border: 1px solid #d8c8a7; }
      .grid { display: grid; gap: 20px; }
      .card { padding: 24px; border-radius: 20px; background: rgba(255,255,255,0.8); border: 1px solid #d8c8a7; box-shadow: 0 10px 30px rgba(78, 57, 24, 0.08); }
      .muted { color: #6b6256; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
      ul { margin: 0; padding-left: 20px; }
      .transcript-list { display: grid; gap: 12px; }
      .transcript-block { padding: 16px; border-radius: 14px; background: #fffdf8; border: 1px solid #e4d7bd; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">Exported from BiCaption meeting mode.</p>
      </section>
      <div class="grid">
        ${notesSection}
        <section class="card">
          <h2>Transcript</h2>
          <div class="transcript-list">
            ${transcriptBlocks || '<p class="muted">No transcript available.</p>'}
          </div>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function runMeetingNotesGeneration(request: MeetingNotesRequest): MeetingNotesResult {
  const transcriptPath = meetingTranscriptFilePath ?? getLatestMeetingTranscriptPath();
  const transcript = (request.transcriptText ?? '').trim() || (
    transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8').trim() : ''
  );
  if (!transcript) {
    throw new Error('No meeting transcript is available yet.');
  }

  const prompt = buildMeetingNotesPrompt(transcript, request);
  const localLlmScript = isPackaged
    ? join(process.resourcesPath!, 'sidecar', '_internal', 'local-llm-rewrite.py')
    : join(projectRoot, 'python', 'local-llm-rewrite.py');
  if (!existsSync(localLlmScript)) {
    throw new Error('Meeting notes generator script is unavailable.');
  }

  const venvPython = join(projectRoot, '.venv', 'bin', 'python');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
  const sidecarBin = isPackaged ? join(process.resourcesPath!, 'sidecar', 'bicaption-sidecar') : null;
  const command = isPackaged ? sidecarBin! : '/usr/bin/arch';
  const args = isPackaged ? ['--run-script', localLlmScript] : ['-arm64', pythonBin, localLlmScript];
  const settings = loadSettings();
  const rawOutput = execFileSync(command, args, {
    cwd: getSpawnCwd(),
    encoding: 'utf-8',
    input: JSON.stringify({
      prompt,
      model: settings.dictationLocalLlmModel,
      runner: settings.dictationLocalLlmRunner,
    }),
  }).trim();

  let payloadText = '';
  try {
    const wrapped = JSON.parse(rawOutput) as { text?: string };
    payloadText = String(wrapped.text ?? '').trim();
  } catch {
    payloadText = rawOutput;
  }

  let result: MeetingNotesResult;
  try {
    const parsed = JSON.parse(payloadText) as Partial<MeetingNotesResult>;
    result = {
      summary: String(parsed.summary ?? '').trim(),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((item) => String(item).trim()).filter(Boolean) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map((item) => String(item).trim()).filter(Boolean) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item).trim()).filter(Boolean) : [],
      rawPrompt: prompt,
    };
  } catch {
    result = {
      summary: payloadText || 'No summary generated.',
      decisions: [],
      actionItems: [],
      risks: [],
      rawPrompt: prompt,
    };
  }

  const notesBasePath = transcriptPath && existsSync(transcriptPath)
    ? transcriptPath
    : join(loadSettings().meetingTranscriptDirectory || getSpawnCwd(), 'latest_meeting.md');
  const notesPath = join(dirname(notesBasePath), `${basename(notesBasePath, extname(notesBasePath))}-notes.md`);
  writeFileSync(notesPath, formatMeetingNotesMarkdown(result), 'utf-8');
  return result;
}

function runMeetingReportExport(request: MeetingReportRequest): MeetingReportResult {
  const transcriptPath = meetingTranscriptFilePath ?? getLatestMeetingTranscriptPath();
  const transcript = (request.transcriptText ?? '').trim() || (
    transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8').trim() : ''
  );
  if (!transcript) {
    throw new Error('No meeting transcript is available yet.');
  }

  const title = request.title?.trim() || `Meeting Report ${new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-')}`;
  const notes = request.notes ?? null;
  const reportBasePath = transcriptPath && existsSync(transcriptPath)
    ? transcriptPath
    : join(loadSettings().meetingTranscriptDirectory || getSpawnCwd(), 'latest_meeting.md');
  const reportPath = join(dirname(reportBasePath), `${basename(reportBasePath, extname(reportBasePath))}-report.html`);
  writeFileSync(reportPath, buildMeetingReportHtml(title, transcript, notes), 'utf-8');
  return { path: reportPath };
}

function sendToWindows(channel: string, payload: unknown) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

function setOverlayMode(mode: 'hidden' | 'subtitle' | 'dictation' | 'preview') {
  if (overlayMode === mode) {
    return;
  }
  overlayMode = mode;
  sendToWindows('overlay:mode', { mode });
}

function isSubtitleSizedBounds(bounds: OverlayBounds | Electron.Rectangle) {
  return bounds.width >= MIN_SUBTITLE_OVERLAY_WIDTH && bounds.height >= MIN_SUBTITLE_OVERLAY_HEIGHT;
}

function getDefaultSubtitleOverlayBounds() {
  const primary = screen.getPrimaryDisplay();
  const settings = loadSettings();
  const width = Math.max(MIN_SUBTITLE_OVERLAY_WIDTH, settings.overlayWidth || DEFAULT_SUBTITLE_OVERLAY_WIDTH);
  const height = Math.max(MIN_SUBTITLE_OVERLAY_HEIGHT, settings.overlayHeight || DEFAULT_SUBTITLE_OVERLAY_HEIGHT);
  const defaultX = Math.round((primary.workArea.width - width) / 2);
  const defaultY = primary.workArea.height - height - 40;
  const hasStoredPosition = Number.isFinite(settings.overlayX)
    && Number.isFinite(settings.overlayY)
    && !(settings.overlayX === 0 && settings.overlayY === 0);
  return {
    x: hasStoredPosition ? settings.overlayX : defaultX,
    y: hasStoredPosition ? settings.overlayY : defaultY,
    width,
    height,
  } satisfies OverlayBounds;
}

function getSubtitleOverlayBounds() {
  if (subtitleOverlayBoundsCache && isSubtitleSizedBounds(subtitleOverlayBoundsCache)) {
    return subtitleOverlayBoundsCache;
  }
  return getDefaultSubtitleOverlayBounds();
}

function getDictationTargetDisplay() {
  if (
    pendingDictationPasteTarget
    && pendingDictationPasteTarget.windowX !== null
    && pendingDictationPasteTarget.windowY !== null
    && pendingDictationPasteTarget.windowWidth !== null
    && pendingDictationPasteTarget.windowHeight !== null
  ) {
    return screen.getDisplayMatching({
      x: pendingDictationPasteTarget.windowX,
      y: pendingDictationPasteTarget.windowY,
      width: Math.max(1, pendingDictationPasteTarget.windowWidth),
      height: Math.max(1, pendingDictationPasteTarget.windowHeight),
    });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function getDefaultDictationOverlayBounds(targetDisplay = getDictationTargetDisplay()) {
  const workArea = targetDisplay.workArea;
  const x = Math.round(workArea.x + (workArea.width - DICTATION_OVERLAY_SIZE) / 2);
  const y = Math.round(workArea.y + workArea.height - DICTATION_OVERLAY_SIZE - 128);
  return {
    x,
    y,
    width: DICTATION_OVERLAY_SIZE,
    height: DICTATION_OVERLAY_SIZE,
  } satisfies OverlayBounds;
}

function getDictationOverlayBounds() {
  const targetDisplay = getDictationTargetDisplay();
  if (dictationOverlayBoundsCache) {
    const cachedDisplay = screen.getDisplayMatching(dictationOverlayBoundsCache);
    if (cachedDisplay.id === targetDisplay.id) {
      return dictationOverlayBoundsCache;
    }
  }
  return getDefaultDictationOverlayBounds(targetDisplay);
}

function restoreSubtitleOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }
  const nextBounds = getSubtitleOverlayBounds();
  subtitleOverlayBoundsCache = nextBounds;
  overlayWindow.setBounds(nextBounds);
}

async function handleDictationFinal(event: SidecarEvent) {
  if (event.type !== 'dictation_final') {
    return;
  }
  traceMainVerbose(`dictation_final session=${event.sessionId} literal=${event.literalTranscript.length} final=${event.finalText.length}`);
  const settings = loadSettings();
  appendDictationLearningRecord(
    getDictationLearningHistoryPath(),
    event as DictationFinalEvent,
    settings.dictationSourceLang,
  );
  const outputAction = settings.dictationOutputAction;
  const outputText = event.finalText || event.literalTranscript;
  if (outputText.trim()) {
    clipboard.writeText(outputText);
    if (outputAction === 'copy') {
      sendToWindows('dictation:output-status', {
        type: 'dictation_output_status',
        action: outputAction,
        status: 'copied',
      } satisfies DictationOutputStatusEvent);
    } else {
      const pasted = await tryPasteClipboard(outputAction, pendingDictationPasteTarget);
      const fallbackDetail = pasted ? 'Pasted into foreground app.' : await getPasteFallbackDetail();
      traceMain(
        `dictation output action=${outputAction} status=${pasted ? 'pasted' : 'fallback'} detail=${fallbackDetail}`,
      );
      sendToWindows('dictation:output-status', {
        type: 'dictation_output_status',
        action: outputAction,
        status: pasted ? 'pasted' : 'fallback',
        detail: fallbackDetail,
      } satisfies DictationOutputStatusEvent);
    }
  }
  pendingDictationPasteTarget = null;
  clearActiveSession(event.sessionId);
  dictationHotkeyPressed = false;
  pendingDictationStop = false;
  sendToWindows('sidecar:event', event);
}

function runAppleScript(lines: string[]) {
  return new Promise<string>((resolve, reject) => {
    const args = lines.flatMap((line) => ['-e', line]);
    execFile('osascript', args, {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function getFrontmostFocusSnapshot(): Promise<FocusSnapshot | null> {
  try {
    const output = (await runAppleScript([
      'tell application "System Events"',
      'set frontApp to first application process whose frontmost is true',
      'set appName to name of frontApp',
      'set windowTitle to ""',
      'set windowX to ""',
      'set windowY to ""',
      'set windowWidth to ""',
      'set windowHeight to ""',
      'try',
      'set windowTitle to name of front window of frontApp',
      'end try',
      'try',
      'set {windowX, windowY} to position of front window of frontApp',
      'end try',
      'try',
      'set {windowWidth, windowHeight} to size of front window of frontApp',
      'end try',
      'return appName & linefeed & windowTitle & linefeed & windowX & linefeed & windowY & linefeed & windowWidth & linefeed & windowHeight',
      'end tell',
    ])).trimEnd();
    const [appName, windowTitle, windowX, windowY, windowWidth, windowHeight] = output.split('\n');
    if (!appName) {
      return null;
    }
    const parseCoordinate = (value: string | undefined) => {
      if (!value) {
        return null;
      }
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      appName,
      windowTitle: windowTitle || null,
      windowX: parseCoordinate(windowX),
      windowY: parseCoordinate(windowY),
      windowWidth: parseCoordinate(windowWidth),
      windowHeight: parseCoordinate(windowHeight),
    };
  } catch {
    return null;
  }
}

function focusSnapshotsMatch(expected: FocusSnapshot, current: FocusSnapshot) {
  if (current.appName !== expected.appName) {
    return false;
  }
  if (
    expected.windowTitle
    && current.windowTitle
    && current.windowTitle !== expected.windowTitle
  ) {
    return false;
  }
  const hasExpectedGeometry = [
    expected.windowX,
    expected.windowY,
    expected.windowWidth,
    expected.windowHeight,
  ].every((value) => value !== null);
  const hasCurrentGeometry = [
    current.windowX,
    current.windowY,
    current.windowWidth,
    current.windowHeight,
  ].every((value) => value !== null);
  if (hasExpectedGeometry && hasCurrentGeometry) {
    const xDiff = Math.abs((current.windowX ?? 0) - (expected.windowX ?? 0));
    const yDiff = Math.abs((current.windowY ?? 0) - (expected.windowY ?? 0));
    const widthDiff = Math.abs((current.windowWidth ?? 0) - (expected.windowWidth ?? 0));
    const heightDiff = Math.abs((current.windowHeight ?? 0) - (expected.windowHeight ?? 0));
    if (xDiff > 24 || yDiff > 24 || widthDiff > 48 || heightDiff > 48) {
      return false;
    }
  }
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFrontmostFocusSnapshotWithRetry(attempts = 3, delayMs = 80): Promise<FocusSnapshot | null> {
  for (let index = 0; index < attempts; index += 1) {
    const snapshot = await getFrontmostFocusSnapshot();
    if (snapshot?.appName) {
      return snapshot;
    }
    if (index < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return null;
}

async function getPasteFallbackDetail() {
  if (!pendingDictationPasteTarget) {
    return 'Paste unavailable, kept clipboard copy.';
  }
  const currentFocus = await getFrontmostFocusSnapshot();
  if (currentFocus && currentFocus.appName !== pendingDictationPasteTarget.appName) {
    return `Focus changed from ${pendingDictationPasteTarget.appName} to ${currentFocus.appName}, kept clipboard copy.`;
  }
  if (
    currentFocus
    && pendingDictationPasteTarget.windowTitle
    && currentFocus.windowTitle
    && currentFocus.windowTitle !== pendingDictationPasteTarget.windowTitle
  ) {
    return `Window changed from ${pendingDictationPasteTarget.windowTitle} to ${currentFocus.windowTitle}, kept clipboard copy.`;
  }
  if (currentFocus && !focusSnapshotsMatch(pendingDictationPasteTarget, currentFocus)) {
    return 'Focused window moved or changed on another screen, kept clipboard copy.';
  }
  return 'Paste unavailable, kept clipboard copy.';
}

async function tryPasteClipboard(action: DictationOutputAction, expectedTarget: FocusSnapshot | null) {
  if (action === 'copy') {
    return false;
  }
  const accessibility = checkAccessibilityPermission();
  if (!accessibility.trusted) {
    return false;
  }
  if (expectedTarget) {
    let currentFocus = await getFrontmostFocusSnapshotWithRetry();
    if (!currentFocus || !focusSnapshotsMatch(expectedTarget, currentFocus)) {
      await sleep(120);
      currentFocus = await getFrontmostFocusSnapshotWithRetry(2, 60);
    }
    if (!currentFocus || !focusSnapshotsMatch(expectedTarget, currentFocus)) {
      return false;
    }
  }
  try {
    await runAppleScript([
      'tell application "System Events" to keystroke "v" using command down',
    ]);
    return true;
  } catch {
    return false;
  }
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode): CaptionConfig {
  const isDictation = mode === 'dictation';
  const isMeeting = mode === 'meeting';
  const subtitleTranslateModel = settings.translateModel;
  const meetingPrimaryDeviceId = settings.meetingSourceMode === 'system-audio'
    ? settings.meetingSystemAudioDeviceId
    : settings.meetingMicDeviceId;
  const meetingSecondaryDeviceId = settings.meetingSourceMode === 'dual'
    ? settings.meetingSystemAudioDeviceId
    : '';
  return {
    mode,
    sessionId: randomUUID(),
    deviceId: isMeeting ? meetingPrimaryDeviceId : isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: isMeeting ? meetingSecondaryDeviceId : isDictation ? '' : settings.outputDeviceId,
    sourceLang: isMeeting ? settings.meetingSourceLang : isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: isMeeting ? settings.meetingTargetLang : settings.targetLang,
    sttModel: isMeeting ? settings.meetingSttModel : isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: isMeeting ? settings.meetingTranslateModel : isDictation ? settings.translateModel : subtitleTranslateModel,
    chunkMs: isDictation ? settings.dictationChunkMs : settings.subtitleChunkMs,
    partialStableMs: isMeeting ? settings.meetingPartialStableMs : isDictation ? settings.dictationEndpointMs : settings.subtitlePartialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
    dictationRewriteMode: isDictation ? settings.dictationRewriteMode : undefined,
    dictationCloudEnhancementEnabled: isDictation ? settings.dictationCloudEnhancementEnabled : undefined,
    dictationOutputStyle: isDictation ? settings.dictationOutputStyle : undefined,
    dictationVocabularyContext: isDictation ? settings.dictationVocabularyContext : undefined,
    dictationProperNounCorrectionEnabled: isDictation ? settings.dictationProperNounCorrectionEnabled : undefined,
    dictationPersonalGlossary: isDictation ? settings.dictationPersonalGlossary : undefined,
    dictationCloudApiKey: isDictation ? settings.dictationCloudApiKey : undefined,
    dictationCloudModel: isDictation ? settings.dictationCloudModel : undefined,
    dictationCloudLlmPrompt: isDictation ? settings.dictationCloudLlmPrompt : undefined,
    dictationMaxRewriteExpansionRatio: isDictation ? settings.dictationMaxRewriteExpansionRatio : undefined,
    dictationLocalLlmModel: isDictation ? settings.dictationLocalLlmModel : undefined,
    dictationLocalLlmRunner: isDictation ? settings.dictationLocalLlmRunner : undefined,
    dictationLocalLlmPrompt: isDictation ? settings.dictationLocalLlmPrompt : undefined,
    meetingSourceMode: isMeeting ? settings.meetingSourceMode : undefined,
    meetingSpeakerLabelsEnabled: isMeeting ? settings.meetingSpeakerLabelsEnabled : undefined,
    meetingMicrophoneLabel: isMeeting ? settings.meetingMicrophoneLabel : undefined,
    meetingSystemLabel: isMeeting ? settings.meetingSystemLabel : undefined,
    meetingNotesPrompt: isMeeting ? settings.meetingNotesPrompt : undefined,
    meetingSaveTranscript: isMeeting ? settings.meetingSaveTranscript : undefined,
    meetingTranscriptDirectory: isMeeting ? settings.meetingTranscriptDirectory : undefined,
  };
}

function runMeetingLocalSpeakerEnrollment(request: MeetingEnrollSpeakerRequest): MeetingEnrollSpeakerResult {
  const { command: sidecarCmd, args: sidecarArgs } = getSidecarCommand();
  const output = execFileSync(sidecarCmd, [
    ...sidecarArgs,
    '--enroll-speaker',
    '--device-id',
    request.deviceId,
    '--duration-sec',
    String(request.durationSec ?? 8),
  ], {
    cwd: getSpawnCwd(),
    encoding: 'utf-8',
  }).trim();
  const parsed = JSON.parse(output) as Partial<MeetingEnrollSpeakerResult>;
  if (!parsed.profileId || !parsed.fingerprint) {
    throw new Error('Speaker enrollment returned an invalid result.');
  }
  return {
    profileId: String(parsed.profileId),
    fingerprint: String(parsed.fingerprint),
    sampleDurationMs: Number(parsed.sampleDurationMs ?? 0),
    enrolledAtMs: Number(parsed.enrolledAtMs ?? Date.now()),
    speechRatio: parsed.speechRatio == null ? undefined : Number(parsed.speechRatio),
    qualityScore: parsed.qualityScore == null ? undefined : Number(parsed.qualityScore),
  };
}

async function prepareSession(config: CaptionConfig) {
  overlaySuppressed = config.mode === 'subtitle' ? false : overlaySuppressed;
  if (config.mode === 'subtitle') {
    setOverlayMode('subtitle');
    initSaveFile();
    meetingTranscriptFilePath = null;
  } else if (config.mode === 'meeting') {
    saveFilePath = null;
    initMeetingTranscriptFile();
  } else {
    saveFilePath = null;
    meetingTranscriptFilePath = null;
  }
  activeSessionMode = config.mode;
  activeSessionId = config.sessionId;

  // Start Electron-side system audio capture if SCK is selected (non-blocking).
  startSystemAudioCapture(config);
}

const SCK_DEVICE_ID = '__screencapturekit__';

function startSystemAudioCapture(config: CaptionConfig): void {
  if (config.outputDeviceId !== SCK_DEVICE_ID) return;

  // In packaged mode, skip Electron's desktopCapturer-based SCK capture entirely.
  // Electron's getDisplayMedia requires "Screen & System Audio Recording" permission,
  // but BiCaption only needs system audio. The sidecar's native fallback uses
  // apple-stt --audio-tap (via AppleSTTHelper.app) which already has the correct
  // "System Audio Recording Only" permission. By NOT setting config.sckPipePath,
  // the sidecar will automatically use the native fallback path.
  if (app.isPackaged) {
    traceMain('startSystemAudioCapture: packaged mode — delegating to sidecar native apple-stt --audio-tap');
    return;
  }

  // Dev mode: use Electron desktopCapturer via named pipe (inherits terminal TCC).
  // Create a named pipe for PCM data transfer to the sidecar.
  const pipePath = join(app.getPath('temp'), `bicaption-sck-${config.sessionId}`);
  try { unlinkSync(pipePath); } catch { /* ignore */ }
  execSync(`mkfifo "${pipePath}"`);
  sckPipePath = pipePath;
  config.sckPipePath = pipePath;
  // Assume 48kHz — updated when capture actually starts.
  config.sckSampleRate = 48000;

  traceMain(`startSystemAudioCapture pipe=${pipePath}`);

  // Fire-and-forget: capture starts in background while sidecar also starts.
  // Sidecar opens pipe read end (blocks) → capture ready → opens write end → unblocks.
  systemAudioCapture.start((pcmBuffer) => {
    if (sckPipeFd !== null) {
      try { writeSync(sckPipeFd, pcmBuffer); } catch { /* pipe closed */ }
    }
  }).then((sampleRate) => {
    traceMain(`startSystemAudioCapture ready sampleRate=${sampleRate}`);
    // Open write end of pipe via callback-based fs.open (non-blocking via libuv).
    // This blocks in the libuv thread pool until sidecar opens the read end.
    if (sckPipePath) {
      fsOpenAsync(sckPipePath, 'w', (err, fd) => {
        if (err) {
          traceMain(`startSystemAudioCapture pipe open error: ${err}`);
          return;
        }
        sckPipeFd = fd;
        traceMain(`startSystemAudioCapture pipe fd=${fd} opened`);
      });
    }
  }).catch((err) => {
    traceMain(`startSystemAudioCapture failed: ${err}`);
    // Clean up so next start() attempt doesn't throw "already running".
    systemAudioCapture.stop();
  });
}

function stopSystemAudioCapture(): void {
  systemAudioCapture.stop();
  if (sckPipeFd !== null) {
    try { closeSync(sckPipeFd); } catch { /* ignore */ }
    sckPipeFd = null;
  }
  if (sckPipePath) {
    try { unlinkSync(sckPipePath); } catch { /* ignore */ }
    sckPipePath = null;
  }
  traceMain('stopSystemAudioCapture done');
}

function clearActiveSession(sessionId?: string) {
  if (!sessionId || !activeSessionId || sessionId === activeSessionId) {
    traceMain(`clearActiveSession target=${sessionId ?? 'none'} active=${activeSessionId ?? 'none'}`);
    activeSessionMode = null;
    activeSessionId = null;
    pendingDictationStop = false;
    pendingDictationPasteTarget = null;
  }
}

async function stopActiveSession() {
  if (!activeSessionMode) {
    traceMain('stopActiveSession skipped because activeSessionMode is null');
    return;
  }
  traceMain(`stopActiveSession mode=${activeSessionMode} session=${activeSessionId ?? 'none'}`);
  stopSystemAudioCapture();
  await bridge.stopSession();
  traceMain(`stopActiveSession resolved session=${activeSessionId ?? 'none'}`);
}

function runSessionTransition(task: () => Promise<void>) {
  if (sessionTransitionPromise) {
    return sessionTransitionPromise;
  }
  sessionTransitionPromise = (async () => {
    try {
      await task();
    } finally {
      sessionTransitionPromise = null;
    }
  })();
  return sessionTransitionPromise;
}

async function startDictationFromHotkey() {
  traceMainVerbose(`startDictationFromHotkey enter pressed=${String(dictationHotkeyPressed)} activeMode=${activeSessionMode ?? 'none'} pendingStop=${String(pendingDictationStop)} transition=${String(Boolean(sessionTransitionPromise))}`);
  pendingDictationPasteTarget = await getFrontmostFocusSnapshotWithRetry();
  traceMainVerbose(
    `startDictationFromHotkey captured paste target app=${pendingDictationPasteTarget?.appName ?? 'none'} `
    + `window=${pendingDictationPasteTarget?.windowTitle ?? 'none'}`,
  );
  showDictationOverlay();
  await runSessionTransition(async () => {
    if (activeSessionMode) {
      traceMainVerbose(`startDictationFromHotkey stopping active session=${activeSessionId ?? 'none'}`);
      await stopActiveSession();
    }
    const settings = loadSettings();
    const config = buildSessionConfig(settings, 'dictation');
    pendingDictationCancel = false;
    await prepareSession(config);
    traceMainVerbose(`startDictationFromHotkey startSession session=${config.sessionId}`);
    bridge.startSession(config);
    dictationStartedAtMs = Date.now();
  });
  if (pendingDictationStop && activeSessionMode === 'dictation') {
    traceMainVerbose(`startDictationFromHotkey detected pending stop for session=${activeSessionId ?? 'none'}`);
    pendingDictationStop = false;
    await stopDictationFromHotkey();
  }
  traceMainVerbose(`startDictationFromHotkey exit activeMode=${activeSessionMode ?? 'none'} activeSession=${activeSessionId ?? 'none'}`);
}

function emitLocalDictationProcessingState() {
  if (activeSessionMode !== 'dictation' || !activeSessionId) {
    return;
  }
  const event: SidecarEvent = {
    type: 'dictation_state',
    mode: 'dictation',
    sessionId: activeSessionId,
    state: 'processing',
    detail: 'Finalizing dictation output',
  };
  showDictationOverlay();
  sendToWindows('sidecar:event', event);
}

async function stopDictationFromHotkey() {
  traceMainVerbose(`stopDictationFromHotkey enter pressed=${String(dictationHotkeyPressed)} activeMode=${activeSessionMode ?? 'none'} transition=${String(Boolean(sessionTransitionPromise))}`);
  if (sessionTransitionPromise) {
    if (!pendingDictationPasteTarget) {
      pendingDictationPasteTarget = await getFrontmostFocusSnapshotWithRetry();
      traceMainVerbose(
        `stopDictationFromHotkey captured deferred paste target app=${pendingDictationPasteTarget?.appName ?? 'none'} `
        + `window=${pendingDictationPasteTarget?.windowTitle ?? 'none'} `
        + `x=${String(pendingDictationPasteTarget?.windowX ?? 'none')} `
        + `y=${String(pendingDictationPasteTarget?.windowY ?? 'none')} `
        + `w=${String(pendingDictationPasteTarget?.windowWidth ?? 'none')} `
        + `h=${String(pendingDictationPasteTarget?.windowHeight ?? 'none')}`,
      );
    }
    traceMainVerbose('stopDictationFromHotkey deferred via pendingDictationStop');
    pendingDictationStop = true;
    return;
  }
  const currentFocus = pendingDictationPasteTarget ?? await getFrontmostFocusSnapshotWithRetry();
  pendingDictationPasteTarget = currentFocus;
  await runSessionTransition(async () => {
    if (activeSessionMode !== 'dictation') {
      traceMainVerbose(`stopDictationFromHotkey skipped because activeMode=${activeSessionMode ?? 'none'}`);
      return;
    }
    const shouldCancel = pendingDictationCancel
      || (dictationStartedAtMs !== null && Date.now() - dictationStartedAtMs < 400);
    if (shouldCancel) {
      traceMainVerbose(`stopDictationFromHotkey abort short dictation session=${activeSessionId ?? 'none'}`);
      pendingDictationPasteTarget = null;
      await stopActiveSession();
      clearActiveSession(activeSessionId ?? undefined);
      setOverlayMode('hidden');
      return;
    }
    emitLocalDictationProcessingState();
    await stopActiveSession();
  });
  dictationStartedAtMs = null;
  pendingDictationCancel = false;
  pendingDictationStop = false;
  traceMainVerbose(`stopDictationFromHotkey exit activeMode=${activeSessionMode ?? 'none'} activeSession=${activeSessionId ?? 'none'}`);
}

function clearDictationModifierOnlyStartTimeout() {
  if (!dictationModifierOnlyStartTimeout) {
    return;
  }
  clearTimeout(dictationModifierOnlyStartTimeout);
  dictationModifierOnlyStartTimeout = null;
}

function isModifierOnlyDictationBinding(binding: DictationHotkeyBinding) {
  return binding.modifiers.length === 0 && [59, 63].includes(binding.keyCode);
}

function isModifierOnlyBindingActive() {
  return isModifierOnlyDictationBinding(loadSettings().dictationHotkey);
}

function restartDictationHotkeyListener() {
  const settings = loadSettings();
  if (!settings.dictationEnabled) {
    hotkeyListenerMode = 'idle';
    nativeHotkeyBridge.stopListening();
    return;
  }
  hotkeyListenerMode = 'dictation';
  nativeHotkeyBridge.startListening(settings.dictationHotkey);
}

function setOverlayVisible(visible: boolean) {
  if (visible) {
    setOverlayMode('subtitle');
    if (overlaySuppressed) {
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    restoreSubtitleOverlayBounds();
    overlayWindow?.showInactive();
  } else {
    setOverlayMode('hidden');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }
}

async function hideSubtitleOverlayAndStopSessionIfNeeded() {
  overlaySuppressed = true;
  setOverlayMode('hidden');
  overlayWindow?.hide();
  if (activeSessionMode === 'subtitle') {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
  }
  rebuildTrayMenu();
}

function clearDictationOverlayHideTimeout() {
  if (dictationOverlayHideTimeout) {
    clearTimeout(dictationOverlayHideTimeout);
    dictationOverlayHideTimeout = null;
  }
}

function showDictationOverlay() {
  clearDictationOverlayHideTimeout();
  setOverlayMode('dictation');
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }
  if (overlayWindow) {
    const currentBounds = overlayWindow.getBounds();
    if (isSubtitleSizedBounds(currentBounds)) {
      subtitleOverlayBoundsCache = currentBounds;
    }
    overlayWindow.setBounds(getDictationOverlayBounds());
  }
  overlayWindow?.showInactive();
}

function hideDictationOverlaySoon(delayMs = 1800) {
  clearDictationOverlayHideTimeout();
  dictationOverlayHideTimeout = setTimeout(() => {
    dictationOverlayHideTimeout = null;
    if (activeSessionMode === 'subtitle') {
      restoreSubtitleOverlayBounds();
      setOverlayMode('subtitle');
      return;
    }
    setOverlayMode('hidden');
    overlayWindow?.hide();
  }, delayMs);
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 1120,
    minHeight: 720,
    title: 'BiCaption',
    show: false,
    frame: false,
    backgroundColor: '#fbf5ea',
    webPreferences: {
      preload: preloadPath,
    },
  });

  settingsWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWindow?.hide();
      if (shouldHideDockForTray({
        trayCreated: trayAvailable,
        isPackaged,
        platform: process.platform,
      })) {
        app.dock?.hide();
      } else {
        app.dock?.show();
      }
    }
  });

  settingsWindow.once('ready-to-show', () => showSettingsWindow());
  void settingsWindow.loadURL(rendererEntry);
  if (isDev && process.env.OPEN_DEVTOOLS === '1') {
    settingsWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  }
  app.dock?.show();
  if (settingsWindow?.isMinimized()) {
    settingsWindow.restore();
  }
  settingsWindow?.show();
  settingsWindow?.focus();
}

function isWindowVisible(window: BrowserWindow | null) {
  return Boolean(window && !window.isDestroyed() && window.isVisible());
}

async function toggleSessionFromTray(mode: SessionMode) {
  if (activeSessionMode === mode) {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
    rebuildTrayMenu();
    return;
  }
  const settings = loadSettings();
  const config = buildSessionConfig(settings, mode);
  await runSessionTransition(async () => {
    if (activeSessionMode) {
      await stopActiveSession();
    }
    await prepareSession(config);
    bridge.startSession(config);
  });
  rebuildTrayMenu();
}

async function toggleDictationEnabledFromTray() {
  const currentSettings = loadSettings();
  const nextSettings = saveSettings({
    dictationEnabled: !currentSettings.dictationEnabled,
  } satisfies Partial<AppSettings>);
  if (!nextSettings.dictationEnabled && activeSessionMode === 'dictation') {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
    clearActiveSession(activeSessionId ?? undefined);
    setOverlayMode('hidden');
  }
  if (hotkeyListenerMode !== 'test') {
    restartDictationHotkeyListener();
  }
  sendToWindows('settings:changed', nextSettings);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) {
    return;
  }
  const settings = loadSettings();
  const updateMenuLabel = updateStatus === 'checking' ? '檢查更新中…' : '檢查更新';
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打開設定',
      click: () => showSettingsWindow(),
    },
    {
      label: activeSessionMode === 'subtitle' ? '停止雙語字幕' : '開始雙語字幕',
      click: () => {
        void toggleSessionFromTray('subtitle');
      },
    },
    {
      label: activeSessionMode === 'meeting' ? '停止會議字幕' : '開始會議字幕',
      click: () => {
        void toggleSessionFromTray('meeting');
      },
    },
    {
      label: settings.dictationEnabled ? '關閉語音輸入' : '開啟語音輸入',
      click: () => {
        void toggleDictationEnabledFromTray();
      },
    },
    { type: 'separator' },
    {
      label: updateMenuLabel,
      enabled: updateStatus !== 'checking',
      click: () => {
        void checkForAppUpdates(true);
      },
    },
    { type: 'separator' },
    {
      label: '結束 BiCaption',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) {
    trayAvailable = true;
    return true;
  }
  const trayIconPath = getTrayIconPath();
  const fileImage = nativeImage.createFromPath(trayIconPath);
  const trayImage = createTrayImage();
  traceMain(`createTray iconPath=${trayIconPath} file=${describeNativeImage(fileImage)} tray=${describeNativeImage(trayImage)}`);
  try {
    tray = new Tray(trayImage);
    tray.setToolTip('BiCaption');
    tray.on('click', () => showSettingsWindow());
    rebuildTrayMenu();
    trayAvailable = true;
    traceMain('createTray success');
    return true;
  } catch (error) {
    tray = null;
    trayAvailable = false;
    traceMain(`createTray failed=${String(error)}`);
    return false;
  }
}

function createOverlayWindow() {
  const subtitleBounds = getDefaultSubtitleOverlayBounds();
  overlayWindow = new BrowserWindow({
    width: subtitleBounds.width,
    height: subtitleBounds.height,
    x: subtitleBounds.x,
    y: subtitleBounds.y,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
    },
  });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.hide();
  overlayWindow.on('move', persistOverlayBounds);
  overlayWindow.on('resize', persistOverlayBounds);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  void overlayWindow.loadURL(`${rendererEntry}#overlay`);
}

function persistOverlayBounds() {
  if (!overlayWindow) {
    return;
  }
  const bounds = overlayWindow.getBounds();
  if (overlayMode === 'dictation') {
    dictationOverlayBoundsCache = bounds;
    return;
  }
  subtitleOverlayBoundsCache = bounds;
  saveSettings({
    overlayX: bounds.x,
    overlayY: bounds.y,
    overlayWidth: bounds.width,
    overlayHeight: bounds.height,
  } satisfies Partial<AppSettings>);
}

function bindBridge() {
  traceMain('bindBridge called');
  bridge.on('partial_caption', (event: SidecarEvent) => {
    if (event.type === 'partial_caption' && event.mode === 'subtitle') {
      setOverlayVisible(true);
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.on('final_caption', (event: SidecarEvent) => {
    if (event.type === 'final_caption' && event.mode === 'subtitle') {
      setOverlayVisible(true);
    }
    appendCaption(event);
    sendToWindows('sidecar:event', event);
  });
  bridge.on('meeting_caption', (event: SidecarEvent) => {
    appendMeetingCaption(event);
    sendToWindows('sidecar:event', event);
  });
  bridge.on('metrics', forwardEvent);
  bridge.on('session_state', (event: SidecarEvent) => {
    if (event.type === 'session_state' && event.mode === 'subtitle') {
      if (event.state === 'streaming') {
        setOverlayVisible(true);
      } else {
        setOverlayVisible(false);
      }
    }
    if (event.type === 'session_state' && event.state === 'error') {
      clearActiveSession(event.sessionId);
    }
    rebuildTrayMenu();
    sendToWindows('sidecar:event', event);
  });
  bridge.on('dictation_state', (event: SidecarEvent) => {
    if (event.type === 'dictation_state') {
      showDictationOverlay();
      if (event.state === 'stopped' || event.state === 'error') {
        dictationHotkeyPressed = false;
      }
    }
    forwardEvent(event);
  });
  bridge.on('dictation_final', (event: SidecarEvent) => {
    void handleDictationFinal(event);
    hideDictationOverlaySoon();
  });
  bridge.on('session_stopped_ack', (event: SidecarEvent) => {
    if (event.type === 'session_stopped_ack') {
      traceMain(`session_stopped_ack session=${event.sessionId}`);
      clearActiveSession(event.sessionId);
    }
    rebuildTrayMenu();
    forwardEvent(event);
  });
  bridge.on('error', (event: SidecarEvent) => {
    let nextEvent = event;
    if (isRecoverableGroqWhisperQuotaError(event) && fallbackDictationSttToAppleStt('groq-whisper')) {
      nextEvent = {
        ...event,
        message: 'Groq Whisper 額度已用完，已自動切換為 SFSpeechRecognizer。',
      };
    }
    if (isRecoverableBreezeAsrError(event) && fallbackDictationSttToAppleStt('breeze-asr-25')) {
      nextEvent = {
        ...event,
        message: 'Breeze ASR 無法完成本次辨識，已切回 SFSpeechRecognizer；請再說一次。',
      };
    }
    if (event.type === 'error' && event.mode === 'subtitle' && !event.recoverable) {
      setOverlayVisible(false);
    }
    if (nextEvent.type === 'error' && !nextEvent.recoverable) {
      clearActiveSession(nextEvent.sessionId);
    }
    rebuildTrayMenu();
    sendToWindows('sidecar:event', nextEvent);
  });
  bridge.start();
}

function forwardEvent(event: SidecarEvent) {
  sendToWindows('sidecar:event', event);
}

function mergeCommaSeparatedTerms(current: string, incoming: string) {
  const merged = new Map<string, string>();
  for (const term of `${current},${incoming}`.split(',')) {
    const normalized = term.trim();
    if (!normalized) {
      continue;
    }
    merged.set(normalized.toLowerCase(), normalized);
  }
  return Array.from(merged.values()).join(', ');
}

function shouldEnableAutoUpdater() {
  return isPackaged && !isDev;
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

async function showUpdateInfo(message: string, detail?: string) {
  const options: MessageBoxOptions = {
    type: 'info',
    message,
    detail,
    buttons: ['知道了'],
    defaultId: 0,
  };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    await dialog.showMessageBox(settingsWindow, options);
    return;
  }
  await dialog.showMessageBox(options);
}

async function fetchLatestReleaseVersion() {
  const response = await fetch(GITHUB_LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BiCaption',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release check failed (${response.status})`);
  }
  const payload = await response.json() as { tag_name?: string; html_url?: string };
  if (!payload.tag_name) {
    throw new Error('GitHub release payload did not include tag_name');
  }
  return {
    version: normalizeVersion(payload.tag_name),
    url: payload.html_url || GITHUB_RELEASES_URL,
  };
}

async function checkForAppUpdates(manual = false) {
  if (!shouldEnableAutoUpdater()) {
    if (manual) {
      await showUpdateInfo('目前是開發模式或未打包版本。', '請直接到 GitHub Releases 頁面下載最新版本。');
    }
    return;
  }

  updateStatus = 'checking';
  rebuildTrayMenu();
  try {
    const latest = await fetchLatestReleaseVersion();
    const currentVersion = app.getVersion();
    const comparison = compareVersions(latest.version, currentVersion);
    updateStatus = 'idle';
    rebuildTrayMenu();
    traceMain(`releaseCheck current=${currentVersion} latest=${latest.version} comparison=${comparison}`);
    if (comparison > 0) {
      const options: MessageBoxOptions = {
        type: 'info',
        message: `發現新版本 ${latest.version}`,
        detail: '目前版本不支援 app 內自動更新，將前往 GitHub Releases 下載最新安裝包。',
        buttons: ['稍後', '前往下載'],
        defaultId: 1,
        cancelId: 0,
      };
      const result = settingsWindow && !settingsWindow.isDestroyed()
        ? await dialog.showMessageBox(settingsWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response === 1) {
        await shell.openExternal(latest.url);
      }
      return;
    }
    if (manual) {
      await showUpdateInfo('目前已是最新版本');
    }
  } catch (error) {
    updateStatus = 'idle';
    rebuildTrayMenu();
    traceMain(`releaseCheck failed=${String(error)}`);
    const detail = error instanceof Error ? error.message : String(error);
    if (manual) {
      const options: MessageBoxOptions = {
        type: 'warning',
        message: '檢查更新失敗',
        detail: `${detail}\n\n可直接前往 GitHub Releases 頁面手動下載最新版本。`,
        buttons: ['知道了', '前往下載頁'],
        defaultId: 1,
        cancelId: 0,
      };
      const result = settingsWindow && !settingsWindow.isDestroyed()
        ? await dialog.showMessageBox(settingsWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response === 1) {
        await shell.openExternal(GITHUB_RELEASES_URL);
      }
    }
  }
}

function forwardHotkeyEvent(event: DictationHotkeyEvent) {
  traceMainVerbose(`hotkey event=${event.type} keyCode=${String(event.keyCode)} pressed=${String(dictationHotkeyPressed)} mode=${hotkeyListenerMode}`);
  sendToWindows('dictation:hotkey-event', event);
  if (hotkeyListenerMode !== 'dictation') {
    return;
  }
  if (event.type === 'hotkey_down') {
    if (dictationHotkeyPressed) {
      return;
    }
    dictationHotkeyPressed = true;
    if (isModifierOnlyBindingActive()) {
      clearDictationModifierOnlyStartTimeout();
      dictationModifierOnlyStartTimeout = setTimeout(() => {
        dictationModifierOnlyStartTimeout = null;
        if (!dictationHotkeyPressed) {
          return;
        }
        void startDictationFromHotkey();
      }, 160);
      return;
    }
    void startDictationFromHotkey();
  } else if (event.type === 'hotkey_up') {
    clearDictationModifierOnlyStartTimeout();
    pendingDictationCancel = Boolean(event.cancelled);
    dictationHotkeyPressed = false;
    void stopDictationFromHotkey();
  } else if (event.type === 'listener_stopped' || event.type === 'error') {
    clearDictationModifierOnlyStartTimeout();
    dictationHotkeyPressed = false;
    dictationStartedAtMs = null;
    pendingDictationCancel = false;
  }
}

async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') {
    return true;
  }
  return systemPreferences.askForMediaAccess('microphone');
}

function checkAccessibilityPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, status: 'not-applicable' };
  }
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  return {
    trusted,
    status: trusted ? 'granted' : 'denied',
  };
}

function requestAccessibilityPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, status: 'not-applicable' };
  }
  const trusted = systemPreferences.isTrustedAccessibilityClient(true);
  return {
    trusted,
    status: trusted ? 'granted' : 'denied',
  };
}

function checkInputMonitoringPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, available: true, detail: 'not-applicable' };
  }

  const { command, args } = getGlobalHotkeyCommand();
  if (!existsSync(command)) {
    return {
      trusted: false,
      available: false,
      detail: `Missing global-hotkey helper at ${command}`,
    };
  }
  try {
    const output = execFileSync(command, [...args, '--check-access'], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
      timeout: 4_000,
    }).trim();
    const parsed = JSON.parse(output) as { trusted?: boolean; identifier?: string; executablePath?: string };
    const helperIdentity = [parsed.identifier, parsed.executablePath].filter(Boolean).join(' @ ');
    return {
      trusted: Boolean(parsed.trusted),
      available: true,
      detail: helperIdentity || undefined,
    };
  } catch (error) {
    return {
      trusted: false,
      available: false,
      detail: error instanceof Error ? error.message : 'Unknown global-hotkey helper error',
    };
  }
}

function requestInputMonitoringPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, available: true, detail: 'not-applicable' };
  }

  const { command, args } = getGlobalHotkeyCommand();
  if (!existsSync(command)) {
    return {
      trusted: false,
      available: false,
      detail: `Missing global-hotkey helper at ${command}`,
    };
  }
  try {
    const output = execFileSync(command, [...args, '--request-access'], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
      timeout: 4_000,
    }).trim();
    const parsed = JSON.parse(output) as { trusted?: boolean; identifier?: string; executablePath?: string };
    const helperIdentity = [parsed.identifier, parsed.executablePath].filter(Boolean).join(' @ ');
    return {
      trusted: Boolean(parsed.trusted),
      available: true,
      detail: helperIdentity || undefined,
    };
  } catch (error) {
    return {
      trusted: false,
      available: false,
      detail: error instanceof Error ? error.message : 'Unknown global-hotkey helper error',
    };
  }
}

function usesScreenCapturePermission(config: CaptionConfig) {
  return config.deviceId === SCK_DEVICE_ID || config.outputDeviceId === SCK_DEVICE_ID;
}

function shouldPreflightScreenCapturePermission(config: CaptionConfig) {
  if (!usesScreenCapturePermission(config)) {
    return false;
  }
  // Packaged builds delegate system audio capture to AppleSTTHelper through the
  // sidecar. Preflighting here can disagree with macOS TCC and block a valid
  // authorized session before the actual capture path has a chance to run.
  return !app.isPackaged;
}

function requiresMicrophonePermission(config: CaptionConfig) {
  if (config.mode === 'dictation') {
    return true;
  }
  if (config.mode === 'meeting') {
    return config.meetingSourceMode !== 'system-audio';
  }
  return config.deviceId !== '__disabled__';
}

async function openInputMonitoringSettings() {
  if (process.platform !== 'darwin') {
    return { ok: false };
  }
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  return { ok: true };
}

async function openAccessibilitySettings() {
  if (process.platform !== 'darwin') {
    return { ok: false };
  }
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  return { ok: true };
}

function checkScreenRecordingPermission(): { granted: boolean; detail?: string } {
  if (process.platform !== 'darwin') {
    return { granted: true };
  }
  if (app.isPackaged) {
    const { command, args } = getAppleSttCommand();
    if (!existsSync(command)) {
      return {
        granted: false,
        detail: '螢幕錄製 helper 缺失，請重新安裝 BiCaption。',
      };
    }
    try {
      const output = execFileSync(command, [...args, '--check-screen-capture'], {
        cwd: getSpawnCwd(),
        encoding: 'utf-8',
        timeout: 4_000,
      }).trim();
      const parsed = JSON.parse(output) as { granted?: boolean };
      return {
        granted: Boolean(parsed.granted),
        detail: parsed.granted ? undefined : '請在系統設定允許 BiCaption 的螢幕錄製權限，完成後回到 BiCaption 再試一次。',
      };
    } catch (error) {
      return {
        granted: false,
        detail: '無法檢查螢幕錄製權限，請打開系統設定確認。',
      };
    }
  }
  // Dev mode uses Electron's own desktopCapturer path, so this TCC status is
  // the correct source of truth.
  const status = systemPreferences.getMediaAccessStatus('screen');
  return {
    granted: status === 'granted',
    detail: status !== 'granted' ? `Screen recording status: ${status}` : undefined,
  };
}

function runAppleSttHelperAppForScreenCapture(action: '--check-screen-capture' | '--request-screen-capture'): { granted: boolean; detail?: string } {
  const helperAppPath = getAppleSttHelperAppPath();
  if (!existsSync(helperAppPath)) {
    return {
      granted: false,
      detail: '螢幕錄製 helper 缺失，請重新安裝 BiCaption。',
    };
  }

  const outputPath = join(app.getPath('temp'), `bicaption-screen-capture-${process.pid}-${Date.now()}.json`);
  const errorPath = join(app.getPath('temp'), `bicaption-screen-capture-${process.pid}-${Date.now()}.err`);
  const openArgs = action === '--request-screen-capture'
    ? ['-n', '-a', helperAppPath]
    : ['-n', '-g', '-a', helperAppPath];
  try {
    execFileSync('/usr/bin/open', [
      ...openArgs,
      '--stdout',
      outputPath,
      '--stderr',
      errorPath,
      '--args',
      action,
    ], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
      timeout: 8_000,
    });
  } catch {
    // `open` can warn for short-lived helpers while still writing stdout.
  }

  try {
    const output = readFileSync(outputPath, 'utf-8').trim();
    const parsed = JSON.parse(output) as { granted?: boolean };
    return {
      granted: Boolean(parsed.granted),
      detail: parsed.granted ? undefined : '請允許 BiCaption 的螢幕與系統音訊錄製權限，完成後回到 BiCaption 再試一次。',
    };
  } catch {
    const stderr = existsSync(errorPath) ? readFileSync(errorPath, 'utf-8').trim() : '';
    return {
      granted: false,
      detail: stderr || '無法觸發螢幕錄製授權，請打開系統設定確認。',
    };
  } finally {
    try { unlinkSync(outputPath); } catch { /* ignore */ }
    try { unlinkSync(errorPath); } catch { /* ignore */ }
  }
}

function requestScreenRecordingPermission(): { granted: boolean; detail?: string } {
  if (process.platform !== 'darwin') {
    return { granted: true };
  }
  if (!app.isPackaged) {
    return checkScreenRecordingPermission();
  }

  return runAppleSttHelperAppForScreenCapture('--request-screen-capture');
}

async function openScreenRecordingSettings() {
  if (process.platform !== 'darwin') {
    return { ok: false };
  }
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return { ok: true };
}

function logEnvironmentReport() {
  const { command: sidecarCmd } = getSidecarCommand();
  const { command: hotkeyCmd } = getGlobalHotkeyCommand();
  const mic = systemPreferences.getMediaAccessStatus('microphone');
  const screenRec = systemPreferences.getMediaAccessStatus('screen');
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  const report = [
    '=== BiCaption Environment Report ===',
    `packaged=${String(app.isPackaged)}`,
    `pid=${process.pid}`,
    `arch=${process.arch}`,
    `electron=${process.versions.electron}`,
    `appPath=${app.getAppPath()}`,
    `resourcesPath=${process.resourcesPath ?? 'N/A'}`,
    `userData=${app.getPath('userData')}`,
    `cwd=${process.cwd()}`,
    `sidecar=${sidecarCmd} exists=${String(existsSync(sidecarCmd))}`,
    `globalHotkey=${hotkeyCmd} exists=${String(existsSync(hotkeyCmd))}`,
    `perm.microphone=${mic}`,
    `perm.screenRecording=${screenRec}`,
    `perm.accessibility=${String(accessibility)}`,
    '=== End Environment Report ===',
  ];
  for (const line of report) {
    traceMain(line);
  }
}

app.whenReady().then(() => {
  traceMain('app.whenReady entered');
  logEnvironmentReport();

  createSettingsWindow();
  createOverlayWindow();
  const trayCreated = createTray();
  if (shouldHideDockForTray({
    trayCreated,
    isPackaged,
    platform: process.platform,
  })) {
    app.dock?.hide();
  } else {
    const shouldKeepDockVisible = shouldKeepDockVisibleWithoutTray({
      trayCreated,
      isPackaged,
      platform: process.platform,
    });
    if (!shouldKeepDockVisible) {
      traceMain('dock visibility fallback skipped unexpectedly');
      return;
    }
    app.dock?.show();
    if (!trayCreated) {
      traceMain('tray unavailable; keeping dock visible as fallback');
    } else if (!isPackaged && process.platform === 'darwin') {
      traceMain('dev mode; keeping dock visible');
    } else {
      traceMain('dock remains visible on this platform');
    }
  }

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, partial) => {
    const settings = saveSettings(partial);
    if (hotkeyListenerMode !== 'test') {
      restartDictationHotkeyListener();
    }
    sendToWindows('settings:changed', settings);
    rebuildTrayMenu();
    return settings;
  });
  ipcMain.handle('dictation-learning:list', () => {
    return listDictationLearningRecords(getDictationLearningHistoryPath()) as DictationLearningRecord[];
  });
  ipcMain.handle('dictation-learning:add-initial-prompt-term', (_event, term: string) => {
    const settings = loadSettings();
    const nextSettings = saveSettings({
      dictationInitialPromptText: mergeCommaSeparatedTerms(settings.dictationInitialPromptText, term),
    });
    sendToWindows('settings:changed', nextSettings);
    return nextSettings;
  });
  ipcMain.handle('permissions:check-speech', async () => {
    const { command } = getAppleSttCommand();
    if (!existsSync(command) || !readFileSync(command).includes(Buffer.from('--check-speech-permission'))) {
      return { granted: false, available: false };
    }
    return new Promise((resolve) => execFile(command, ['--check-speech-permission'], { timeout: 5_000 }, (error, stdout) => {
      try { resolve({ granted: !error && JSON.parse(stdout).granted === true, available: true }); }
      catch { resolve({ granted: false, available: true }); }
    }));
  });
  ipcMain.handle('permissions:request-speech', async () => {
    const { command } = getAppleSttCommand();
    if (!existsSync(command) || !readFileSync(command).includes(Buffer.from('--request-speech-permission'))) {
      return { granted: false, available: false };
    }
    return new Promise((resolve) => execFile(command, ['--request-speech-permission'], { timeout: 60_000 }, (error, stdout) => {
      try { resolve({ granted: !error && JSON.parse(stdout).granted === true, available: true }); }
      catch { resolve({ granted: false, available: true }); }
    }));
  });
  ipcMain.handle('permissions:check-accessibility', () => checkAccessibilityPermission());
  ipcMain.handle('permissions:request-accessibility', () => requestAccessibilityPermission());
  ipcMain.handle('permissions:open-accessibility', () => openAccessibilitySettings());
  ipcMain.handle('permissions:check-input-monitoring', () => checkInputMonitoringPermission());
  ipcMain.handle('permissions:request-input-monitoring', () => requestInputMonitoringPermission());
  ipcMain.handle('permissions:open-input-monitoring', () => openInputMonitoringSettings());
  ipcMain.handle('permissions:check-screen-recording', () => checkScreenRecordingPermission());
  ipcMain.handle('permissions:request-screen-recording', () => requestScreenRecordingPermission());
  ipcMain.handle('permissions:open-screen-recording', () => openScreenRecordingSettings());
  ipcMain.handle('dictation:test-hotkey', (_event, binding: DictationHotkeyBinding) => {
    hotkeyListenerMode = 'test';
    nativeHotkeyBridge.startListening(binding);
    return { ok: true };
  });
  ipcMain.handle('dictation:stop-hotkey-test', () => {
    nativeHotkeyBridge.stopListening();
    restartDictationHotkeyListener();
    return { ok: true };
  });
  ipcMain.handle('session:start', async (_event, config: CaptionConfig) => {
    await runSessionTransition(async () => {
      if (activeSessionMode) {
        await stopActiveSession();
      }
      if (requiresMicrophonePermission(config)) {
        const hasMicAccess = await ensureMicrophoneAccess();
        if (!hasMicAccess) {
          throw new Error('Microphone permission was denied. Allow microphone access in the system prompt or System Settings, then try again.');
        }
      }
      if (shouldPreflightScreenCapturePermission(config)) {
        const screenAccess = requestScreenRecordingPermission();
        if (!screenAccess.granted) {
          throw new Error('Screen recording permission was denied. Allow access in the system prompt or System Settings, then try again.');
        }
      }
      if (config.mode !== 'dictation' && config.translateModel === 'apple-translation') {
        const translation = await prepareAppleTranslation(config.sourceLang, config.targetLang, false, config.sttModel);
        if (translation.status !== 'installed') {
          throw new Error(translation.message ?? '請先在「使用準備」下載 Apple 翻譯語言包。');
        }
      }
      await prepareSession(config);
      bridge.startSession(config);
    });
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('session:update', async (_event, payload) => {
    if (!activeSessionMode || activeSessionMode !== payload?.mode) {
      return { ok: false };
    }
    bridge.updateSession(payload);
    return { ok: true };
  });
  ipcMain.handle('session:stop', async () => {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('session:devices', async () => {
    const { command: sidecarCmd, args: sidecarArgs } = getSidecarCommand();
    const output = execFileSync(sidecarCmd, [...sidecarArgs, '--list-devices'], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    });
    const devices = JSON.parse(output) as Array<{ id: string; label: string; kind: string }>;
    if (devices.length === 0) {
      throw new Error('No audio devices were detected. Check microphone permission and connected audio devices, then restart the app.');
    }
    return devices;
  });
  ipcMain.handle('meeting:enroll-local-speaker', async (_event, request: MeetingEnrollSpeakerRequest) => {
    const hasAccess = await ensureMicrophoneAccess();
    if (!hasAccess) {
      throw new Error('Microphone permission was denied. Allow microphone access in System Settings and restart the app.');
    }
    if (!request?.deviceId) {
      throw new Error('A microphone device must be selected before speaker enrollment.');
    }
    return runMeetingLocalSpeakerEnrollment(request);
  });
  ipcMain.handle('app:show-settings', () => {
    showSettingsWindow();
    return { ok: true };
  });
  ipcMain.handle('app:hide-settings', () => {
    settingsWindow?.hide();
    return { ok: true };
  });
  ipcMain.handle('app:minimize-settings', () => {
    settingsWindow?.minimize();
    return { ok: true };
  });
  ipcMain.handle('app:toggle-settings-maximize', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      return { ok: false };
    }
    if (settingsWindow.isMaximized()) {
      settingsWindow.unmaximize();
    } else {
      settingsWindow.maximize();
    }
    return { ok: true };
  });
  ipcMain.handle('app:relaunch', () => {
    isQuitting = true;
    app.relaunch();
    app.quit();
    return { ok: true };
  });
  ipcMain.handle('overlay:get-position', () => {
    return overlayWindow?.getPosition() ?? [0, 0];
  });
  ipcMain.handle('overlay:set-position', (_event, x: number, y: number) => {
    overlayWindow?.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('overlay:get-bounds', () => {
    return overlayWindow?.getBounds() ?? getDefaultSubtitleOverlayBounds();
  });
  ipcMain.handle('overlay:set-bounds', (_event, partial: Partial<OverlayBounds>) => {
    if (!overlayWindow) {
      return getDefaultSubtitleOverlayBounds();
    }
    const current = overlayWindow.getBounds();
    const next = {
      x: partial.x ?? current.x,
      y: partial.y ?? current.y,
      width: Math.max(MIN_SUBTITLE_OVERLAY_WIDTH, partial.width ?? current.width),
      height: Math.max(MIN_SUBTITLE_OVERLAY_HEIGHT, partial.height ?? current.height),
    };
    overlayWindow.setBounds(next);
    persistOverlayBounds();
    return overlayWindow.getBounds();
  });
  ipcMain.handle('save:choose-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '選擇字幕保存位置',
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('save:open-directory', (_event, directory?: string) => {
    const settings = loadSettings();
    const targetDirectory = (directory && directory.trim()) || settings.saveDirectory;
    if (targetDirectory && existsSync(targetDirectory)) {
      shell.openPath(targetDirectory);
    }
    return { ok: true };
  });
  ipcMain.handle('meeting:generate-copilot-insights', (_event, request: MeetingCopilotInsightsRequest) => {
    return runMeetingCopilotInsights(request);
  });
  ipcMain.handle('meeting:generate-notes', (_event, request: MeetingNotesRequest) => {
    return runMeetingNotesGeneration(request);
  });
  ipcMain.handle('meeting:export-report', (_event, request: MeetingReportRequest) => {
    return runMeetingReportExport(request);
  });
  ipcMain.handle('translation:status', (_event, source: string, target: string, model: string) => prepareAppleTranslation(source, target, false, model));
  ipcMain.handle('translation:prepare', (_event, source: string, target: string, model: string) => prepareAppleTranslation(source, target, true, model));
  ipcMain.handle('permissions:check-microphone', () => ({ granted: systemPreferences.getMediaAccessStatus('microphone') === 'granted' }));
  ipcMain.handle('permissions:request-microphone', async () => {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted };
  });
  ipcMain.handle('models:check', () => {
    return modelDownloader.checkStatus();
  });
  ipcMain.handle('models:download', () => {
    modelDownloader.downloadAll().catch((err: Error) => {
      sendToWindows('models:error', err.message);
    });
    return { ok: true };
  });
  ipcMain.handle('models:download-one', (_event, modelKey: string) => {
    modelDownloader.downloadOne(modelKey).catch((err: Error) => {
      sendToWindows('models:error', err.message);
    });
    return { ok: true };
  });

  ipcMain.handle('models:delete', (_event, modelKey: string) => {
    modelDownloader.deleteModel(modelKey);
    return modelDownloader.checkStatus();
  });
  modelDownloader.on('progress', (progress: ModelDownloadProgress) => {
    sendToWindows('models:progress', progress);
  });
  modelDownloader.on('done', (status: unknown) => {
    sendToWindows('models:done', status);
  });
  nativeHotkeyBridge.on('event', forwardHotkeyEvent);
  restartDictationHotkeyListener();

  ipcMain.handle('overlay:get-mode', () => ({ mode: overlayMode }));
  ipcMain.handle('overlay:show', () => {
    if (activeSessionMode === 'dictation') throw new Error('請先完成這次聽寫，再開啟字幕預覽。');
    overlaySuppressed = false;
    setOverlayMode(activeSessionMode === 'subtitle' ? 'subtitle' : 'preview');
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    restoreSubtitleOverlayBounds();
    overlayWindow?.showInactive();
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('overlay:hide', () => {
    return hideSubtitleOverlayAndStopSessionIfNeeded().then(() => ({ ok: true }));
  });

  // Start sidecar AFTER all IPC handlers are registered
  try {
    bindBridge();
  } catch (err) {
    console.error('Failed to start sidecar bridge:', err);
  }

});

app.on('activate', () => {
  // Clicking the always-on-top subtitle overlay can activate the app on macOS.
  // When the overlay is visible, avoid forcing the settings window to the front.
  const behavior = getActivateBehavior({
    settingsVisible: isWindowVisible(settingsWindow),
    overlayVisible: isWindowVisible(overlayWindow),
  });
  if (behavior === 'noop') {
    return;
  }
  showSettingsWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  nativeHotkeyBridge.stopListening();
  bridge.dispose();
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});
