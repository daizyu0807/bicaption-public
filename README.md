# BiCaption

Realtime bilingual subtitles, meeting captions, and hold-to-talk dictation app for macOS.

[English](#english) | [繁體中文](#繁體中文)

---

## English

Captures system audio via macOS ScreenCaptureKit or microphone input, transcribes speech locally, shows bilingual subtitles in a transparent always-on-top overlay, supports meeting caption sessions with transcript/notes export, and provides hold-to-talk dictation for quick text input.

### Download

Download the latest macOS package from [GitHub Releases](https://github.com/daizyu0807/bicaption-public/releases).

The distributed macOS build is ad-hoc signed and not notarized. On first launch, macOS may require right-clicking the app and choosing **Open**, or allowing it from **System Settings → Privacy & Security**.

### Features

- **Three workflows in one app**
  - **Bilingual subtitles** — realtime subtitle overlay for meetings, videos, and calls
  - **Meeting captions** — meeting transcript workspace with speaker labels, notes generation, and HTML report export
  - **Dictation** — hold-to-talk speech input that copies or pastes recognized text
- **Menu Bar utility** — close the settings window and keep BiCaption running from the macOS Menu Bar
- **Multi-model STT** — choose the best model for your language:
  - **SenseVoice** — optimized for Traditional Chinese and English in the current product setup (~67ms)
  - **Breeze ASR** — optimized for Taiwanese Mandarin and code-switching, with a warm in-process model for lower repeated-use latency
  - **SFSpeechRecognizer** — macOS built-in speech recognition for fast native dictation/subtitles
- Google Translate for bilingual captions (source → target)
- Bilingual subtitle toggle — enable/disable translation independently
- Transparent, draggable, resizable overlay window
- Blue/cyan technology-focused settings UI with permission status consolidated into one flow
- Recording ripple and overlay placement follow the display containing the active target window
- Silero VAD for natural speech segmentation (optimized for multi-speaker)
- In-app model download with progress tracking
- Independent subtitle/dictation microphone selection
- Hold-to-talk dictation hotkeys, including modifier-only modes such as `Hold Ctrl` or `Hold Fn`
- Dictation output actions: copy, paste, or copy-and-paste
- Stable auto-paste targeting without duplicate insertion or unintended clipboard UI activation
- Dictation post-processing: dictionary normalization, cleanup rules, and optional local LLM polish
- Local-first dictation polish via MLX models on Apple Silicon
- Meeting transcript persistence, meeting notes generation, and HTML report export
- Custom microphone/remote speaker labels for meeting mode
- Optional subtitle log saving
- Settings UI for device selection, language pair, subtitle appearance, meeting controls, dictation output, and local polish options

### Requirements

- macOS (Apple Silicon recommended)
- Node.js 22.12+
- Python 3.9+ (Python 3.12+ recommended)
- On some systems, PortAudio may be required: `brew install portaudio`
- Screen Recording permission (required for system audio capture)
- Accessibility permission (required for auto-paste)
- Input Monitoring permission (required for global hold-to-talk hotkeys)

> Recommended: use a Homebrew Python build such as `python@3.12` instead of the macOS system Python.
> The system Python may use LibreSSL and can produce `urllib3` SSL warnings.

### Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python venv and install dependencies
#    Recommended on macOS:
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. Download STT models — REQUIRED before first run
#    You can also download models from the in-app Settings UI.
bash scripts/download-models.sh
```

### Run

```bash
npm run dev
```

This starts both the Electron app and the Python sidecar.

Typical usage:
- Use the **雙語字幕** tab to configure realtime subtitle capture and start the subtitle session
- Use the **會議字幕** tab to capture a meeting transcript, generate notes, and export a report
- Use the **語音輸入** tab to configure hold-to-talk dictation
- Close the settings window if you want the app to continue running from the macOS Menu Bar

### Meeting Captions

BiCaption also supports a dedicated meeting workflow:

- Capture meeting audio from microphone, system audio, or dual-source mode
- Show live meeting transcript and translation inside the settings workspace
- Save a meeting transcript automatically
- Generate meeting notes from the current transcript
- Export a single-file HTML report
- Customize local/remote speaker labels
- Optionally enroll a local microphone speaker sample for conservative local-speaker verification

Meeting-mode STT notes:

- **SenseVoice** is the current safe default for meeting captions in the product setup.
- **Moonshine** is still experimental in meeting mode. It requires an explicit supported source language such as `en`, `zh`, `ja`, or `ko`.
- If the UI does not expose a meeting source-language selector in your current build, prefer **SenseVoice** instead of **Moonshine**.

### Dictation

BiCaption also supports hold-to-talk dictation:

- Choose a dedicated microphone and speech model for dictation
- Assign a hotkey such as `Hold Ctrl`
- Press and hold to start recording
- Release to finish recording and start post-processing
- Output the result by copying to clipboard or pasting into the current app
- Optionally polish the final text with dictionary correction, cleanup rules, and a local LLM rewrite pass

For auto-paste, BiCaption needs Accessibility permission.
For global hold-to-talk hotkeys, BiCaption needs Input Monitoring permission.

Default dictation flow:

1. Hold the hotkey to record
2. Transcribe locally with the selected STT engine
3. Apply dictionary normalization and cleanup rules
4. Optionally run a local LLM polish pass
5. Copy or paste the final text

### STT Models

| Model | Best for | Size | Latency |
|-------|----------|------|---------|
| SenseVoice | Traditional Chinese and English | ~230 MB | ~67ms |
| Breeze ASR | Taiwanese Mandarin and Chinese/English code-switching | packaged model/runtime | low after warm-up |
| Groq Whisper | Online dictation with API key | none in app | network/API dependent |
| SFSpeechRecognizer | macOS built-in, quick native recognition | none | low |

SenseVoice is recommended for realtime subtitle and meeting streaming in the current product setup.
Breeze ASR is available for dictation and meeting workflows that benefit from Taiwanese Mandarin and code-switching recognition. Its model is warmed once and reused instead of being relaunched for every utterance.
Groq Whisper is available for online dictation when an API key is configured.
SFSpeechRecognizer is useful when you want the built-in macOS recognition path.

### Local LLM Polish

BiCaption can optionally polish dictation output with a local MLX model.

- Optional local runtime, not included in the default core package
- Current preferred model: `mlx-community/Qwen2.5-3B-Instruct-4bit`
- Default packaged builds exclude `mlx_lm`; use `npm run build:sidecar:full` for an explicit local-LLM package build
- Rewrite behavior is intentionally conservative:
  - preserve the original meaning
  - repair obvious ASR wording when context is clear
  - remove filler words and hesitation sounds
  - improve punctuation and sentence flow
  - avoid inventing new facts

For lower-memory machines you can switch to a smaller model, but `3B` is currently the recommended quality baseline for Traditional Chinese dictation.

### Troubleshooting

- If `npm run dev` prints `[dev preflight] Node dependencies are missing`, run `npm install`.
- If it prints `[dev preflight] Python virtual environment is missing` or `Python dependencies are incomplete`, recreate `.venv` and reinstall `python/requirements.txt`.
- If it prints `[dev preflight] Speech models are missing`, run `bash scripts/download-models.sh`.
- If `vite` or `rollup` fails with `ERR_DLOPEN_FAILED` while the process path points to `Codex.app/Contents/Resources/node`, the project will now try to fall back to an external Node automatically. If no external Node is available, install one such as Homebrew Node and ensure it is on `PATH`.
- In dev mode, models are loaded from the local `python/` directory inside the project. A packaged `/Applications/BiCaption.app` build uses the app bundle plus the user-data model directory instead, so a model that works in the installed app may still need to be prepared separately for `npm run dev`.
- If bilingual subtitles fail with an Apple Speech Recognition startup error in dev mode, verify that `python/apple-stt` exists or rebuild it with `bash scripts/build-apple-stt.sh`.

### Audio Setup (System Audio)

To capture system audio from meetings or videos:

1. In the app, choose **系統音訊（免切換）** for the system audio source.
2. When macOS asks for permission, allow BiCaption to use Screen Recording / system audio capture.
3. If permission was previously denied, open **System Settings → Privacy & Security → Screen & System Audio Recording**, enable BiCaption, then restart the app.

### Stack

- **Electron + React** — UI (settings window + overlay)
- **Python sidecar** — audio capture, VAD, STT, translation
- **sherpa-onnx** — local speech-to-text (SenseVoice, Whisper, Zipformer)
- **Silero VAD** — voice activity detection for natural segmentation
- **Google Translate** — bilingual translation (via `deep-translator`)

### Build

```bash
npm run build
npm run type-check
```

If you need to refresh the packaged Python runtime for dictation polish, rebuild
the sidecar directly:

```bash
bash scripts/build-sidecar.sh
```

Expected build log:

- `[build-sidecar] Including mlx_lm package`

### Local Install

Recommended full local-update flow:

```bash
npm run dist:unsigned
npm run verify:app
npm run install:local-app
```

This flow packages a fresh local app bundle, verifies the artifact, installs it
to `/Applications`, and removes the duplicate release `.app` bundle.

If you already have a verified local app bundle in `release/mac-arm64`, you can
run only:

```bash
npm run install:local-app
```

Confirmed local-update behavior on macOS:

- `install:local-app` preserves current TCC permissions by default.
- A properly signed update with stable bundle IDs and code-signing identity
  should not require users to re-authorize permissions on every update.
- Local unsigned/ad-hoc builds may not reuse permission state reliably because
  macOS privacy permissions are tied to code-signing identity. Re-authorize the
  installed app in System Settings if needed.
- For a clean local permission reset, run `BICAPTION_RESET_TCC=1 npm run install:local-app`.
  This attempts an app-scoped reset of `Accessibility`, `ListenEvent`, and
  `ScreenCapture` for the BiCaption main app and packaged helper bundle IDs.
- On unsigned/ad-hoc builds, macOS can retain an older helper authorization
  even when the reset command exits successfully. Before re-authorizing,
  verify that the BiCaption rows are disabled. If they remain enabled, remove
  only the BiCaption rows from Accessibility, Input Monitoring, and Screen &
  System Audio Recording in System Settings. Do not use a global TCC reset,
  because it also clears permissions for unrelated apps.
- After reinstall, validate permissions against `/Applications/BiCaption.app`
  instead of the temporary app bundle under `release/`.

### License

MIT

### Public Repository Boundary

This repository contains only the BiCaption source and release inputs. It does not include local `.env` files, model caches, virtual environments, packaged build output, personal data, or files from other projects.

---

## 繁體中文

macOS 即時雙語字幕、會議字幕與按住說話語音輸入工具。可透過 macOS ScreenCaptureKit 擷取系統音訊，或使用麥克風輸入，搭配本地語音辨識模型進行辨識，在透明置頂視窗中顯示雙語字幕，也可進入會議記錄工作流產生逐字稿、會議記錄與報告，或透過 hold-to-talk 快速輸入文字。

### 下載

請從 [GitHub Releases](https://github.com/daizyu0807/bicaption-public/releases) 下載最新版 macOS 安裝包。

目前發布的 macOS 版本採 ad-hoc 簽章且未 notarize。第一次啟動時，可能需要對 App 按右鍵選擇「打開」，或前往「系統設定 → 隱私權與安全性」允許開啟。

### 功能特色

- **三種核心工作流**
  - **雙語字幕** — 會議、影片、通話的即時字幕疊加
  - **會議字幕** — 會議逐字稿工作區，支援 speaker label、會議記錄生成與 HTML 報告匯出
  - **語音輸入** — 按住說話、放開送出的 dictation 輸入模式
- **Menu Bar 常駐工具** — 關掉設定視窗後仍可從 macOS Menu Bar 操作
- **多模型語音辨識** — 根據語言選擇最佳模型：
  - **SenseVoice** — 目前產品設定以繁體中文與英文為主（~67ms）
  - **Breeze ASR** — 針對台灣華語與中英混用情境，常駐模型以降低重複使用延遲
  - **SFSpeechRecognizer** — macOS 內建辨識引擎，適合快速原生輸入
- Google 翻譯即時雙語字幕（原文 → 目標語言）
- 雙語字幕開關 — 獨立控制是否顯示翻譯
- 透明、可拖曳、可調整大小的字幕疊加視窗
- 藍／青科技感設定介面，權限狀態整合為單一流程
- 錄音水波動畫與浮動視窗會跟隨目前操作視窗所在的螢幕
- Silero VAD 自然語音斷句（針對多人對話優化）
- 應用內模型下載，附下載進度顯示
- 字幕與語音輸入各自獨立的麥克風與語音模型設定
- 支援 hold-to-talk 快捷鍵，包含 `Hold Ctrl` / `Hold Fn`
- 語音輸入可選擇複製、貼上、或先複製再貼上
- 穩定鎖定原本輸入視窗，自動貼上不重複插入，也不會意外喚出剪貼簿介面
- 語音輸入後處理：字典正規化、規則清理、可選本地 LLM 潤稿
- 以 Apple Silicon 的 MLX 本地模型為主的 local-first 潤稿流程
- 會議逐字稿保存、會議記錄生成、HTML 報告匯出
- 會議模式支援我方/遠端 speaker label 自訂
- 可選的字幕記錄保存
- 設定介面：裝置選擇、語言對、字幕顯示、會議記錄、語音輸出與本地潤稿選項

### 系統需求

- macOS（建議 Apple Silicon）
- Node.js 22.12+
- Python 3.9+（建議 3.12+）
- 部分系統可能需要安裝 PortAudio：`brew install portaudio`
- 螢幕與系統音訊錄製權限（擷取系統音訊需要）
- Accessibility 權限（自動貼上需要）
- Input Monitoring 權限（全域 hold-to-talk 快捷鍵需要）

> 建議使用 Homebrew 安裝的 Python，例如 `python@3.12`，不要直接使用 macOS 內建 Python。
> 內建 Python 可能會使用 LibreSSL，進而產生 `urllib3` 的 SSL 警告。

### 安裝

```bash
# 1. 安裝 Node 依賴
npm install

# 2. 建立 Python 虛擬環境並安裝依賴
#    macOS 建議：
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. 下載語音辨識模型 — 首次執行前必須完成
#    也可以在應用程式的設定介面中下載模型。
bash scripts/download-models.sh
```

### 執行

```bash
npm run dev
```

啟動後會同時運行 Electron 應用和 Python sidecar。

一般使用方式：
- 在 **雙語字幕** 分頁設定字幕擷取並啟動字幕工作流
- 在 **會議字幕** 分頁啟動會議逐字稿、產生會議記錄並匯出報告
- 在 **語音輸入** 分頁設定 hold-to-talk 語音輸入
- 關閉設定視窗後，BiCaption 仍可從 macOS Menu Bar 常駐操作

### 會議字幕

BiCaption 也支援獨立的會議工作流：

- 可從麥克風、系統音訊或雙來源模式擷取會議音訊
- 在設定視窗內顯示即時逐字稿與翻譯
- 可自動保存 meeting transcript
- 可直接從目前 transcript 生成會議記錄
- 可匯出單檔 HTML 報告
- 可自訂我方/遠端 speaker label
- 可選擇先建立本機說話者樣本，用於保守的 microphone speaker verification

會議模式語音辨識引擎注意事項：

- 目前在產品設定下，會議字幕建議優先使用 **SenseVoice**。
- **Moonshine** 在會議模式仍屬實驗性功能，要求明確的來源語言，例如 `en`、`zh`、`ja`、`ko`。
- 如果你目前的 build 還沒有提供會議模式的來源語言選項，建議不要在會議字幕中使用 **Moonshine**，改用 **SenseVoice**。

### 語音輸入

BiCaption 支援按住說話的 dictation 模式：

- 可為語音輸入單獨選擇麥克風與辨識引擎
- 可設定像 `Hold Ctrl` 這樣的快捷鍵
- 按住開始錄音
- 放開後結束錄音並進入後處理
- 將結果輸出到剪貼簿，或直接貼到目前視窗
- 可選擇在輸出前套用字典修正、規則清理與本地 LLM 潤稿

如果要自動貼上，需要 Accessibility 權限。
如果要使用全域 hold-to-talk 快捷鍵，需要 Input Monitoring 權限。

預設語音輸入流程：

1. 按住快捷鍵開始錄音
2. 使用選定的本地 STT 引擎完成辨識
3. 套用字典正規化與規則清理
4. 視設定決定是否再做本地 LLM 潤稿
5. 將最終文字複製或貼上

### 語音辨識模型

| 模型 | 適用場景 | 大小 | 延遲 |
|------|---------|------|------|
| SenseVoice | 繁體中文、英文 | ~230 MB | ~67ms |
| Breeze ASR | 台灣華語、中英混用 | 隨 App 打包模型與 runtime | 暖機後低延遲 |
| Groq Whisper | 線上 dictation，使用 API Key | App 內不佔空間 | 依網路/API |
| SFSpeechRecognizer | macOS 內建辨識，快速原生流程 | 無需下載 | 低 |

如果你目前主要使用繁體中文與英文即時字幕或會議字幕，建議優先使用 SenseVoice。
若語音輸入或會議情境以台灣華語、中英混用為主，可選擇 Breeze ASR；模型只在首次載入時暖機，後續語句會沿用同一個常駐模型。
如果你要線上 Whisper dictation，可使用 Groq Whisper。
如果你想用 macOS 內建辨識路徑，則可改用 SFSpeechRecognizer。

### 本地 LLM 潤稿

BiCaption 可選擇使用本地 MLX 模型潤飾語音輸入結果。

- 本地 LLM runtime 是可選能力，預設 core package 不內建
- 目前建議模型：`mlx-community/Qwen2.5-3B-Instruct-4bit`
- 預設打包會排除 `mlx_lm`；需要完整本地 LLM 包時使用 `npm run build:sidecar:full`
- 潤稿策略偏保守：
  - 保留原意
  - 在上下文明確時修正明顯 ASR 誤字
  - 移除語氣詞與猶豫音
  - 改善標點與斷句
  - 不補充原本沒說出的事實

若機器記憶體較小，可以改用較小模型；但以繁體中文 dictation 來說，`3B` 是目前較穩定的品質基準。

### 疑難排解

- 如果 `npm run dev` 顯示 `[dev preflight] Node dependencies are missing`，先執行 `npm install`。
- 如果顯示 `[dev preflight] Python virtual environment is missing` 或 `Python dependencies are incomplete`，請重建 `.venv` 並重新安裝 `python/requirements.txt`。
- 如果顯示 `[dev preflight] Speech models are missing`，請執行 `bash scripts/download-models.sh`。
- 在 dev mode 下，模型會從專案內的 `python/` 目錄讀取；已安裝的 `/Applications/BiCaption.app` 則會使用 app bundle 與 user-data 模型目錄。也就是說，已安裝 app 可用的模型，不一定代表 `npm run dev` 也已準備完成。
- 如果雙語字幕在 dev mode 顯示 Apple Speech Recognition 啟動失敗，先確認 `python/apple-stt` 是否存在；若不存在，執行 `bash scripts/build-apple-stt.sh`。

### 音訊設定（擷取系統音訊）

要擷取會議或影片的系統音訊：

1. 在應用程式中，將系統音訊來源選成 **系統音訊（免切換）**。
2. macOS 要求授權時，允許 BiCaption 使用螢幕與系統音訊錄製。
3. 如果之前曾拒絕授權，請到 **系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製** 開啟 BiCaption，然後重新啟動 app。

### 技術架構

- **Electron + React** — 介面（設定視窗 + 字幕疊加）
- **Python sidecar** — 音訊擷取、VAD、語音辨識、翻譯
- **sherpa-onnx** — 本地語音轉文字（SenseVoice、Whisper、Zipformer）
- **Silero VAD** — 語音活動偵測，自然斷句
- **Google Translate** — 雙語翻譯（透過 `deep-translator`）

### 建置

```bash
npm run build
npm run type-check
```

如果要確認 dictation 的本地 LLM runtime 已重新打包進 sidecar，可直接執行：

```bash
bash scripts/build-sidecar.sh
```

預期會看到：

- `[build-sidecar] Including mlx_lm package`

### 本機安裝

建議使用完整的本機更新流程：

```bash
npm run dist:unsigned
npm run verify:app
npm run install:local-app
```

這條路徑會重新打包 app、驗證 artifact，再安裝到 `/Applications`，並清掉重複的 release `.app`。

如果 `release/mac-arm64/BiCaption.app` 已經是你剛驗證過的最新包，也可以只執行：

```bash
npm run install:local-app
```

本次已確認的 macOS 本地更新行為：

- `install:local-app` 預設會保留目前 TCC 權限，不會每次清權限。
- 使用穩定 bundle ID 與穩定 code-signing identity 的正式簽章更新，不應要求使用者每次更新都重新授權。
- 在本地 unsigned / ad-hoc 重裝情境下，macOS 不保證沿用舊授權，因為隱私權限會綁定 code-signing identity；必要時仍需到系統設定重新允許 `/Applications/BiCaption.app`。
- 只有要做乾淨的本機權限重置時，才執行 `BICAPTION_RESET_TCC=1 npm run install:local-app`。這會嘗試只重置 BiCaption 主程式與 packaged helper bundle ID 的 `Accessibility`、`ListenEvent`、`ScreenCapture`。
- unsigned／ad-hoc build 可能在重置命令成功後仍保留舊 helper 授權。重新授權前要先確認 BiCaption 各列已關閉；若仍開啟，只從系統設定的「輔助使用」、「輸入監控」、「螢幕與系統音訊錄製」移除 BiCaption，不要使用會影響其他 App 的全域 TCC reset。
- 重新授權時，請以 `/Applications/BiCaption.app` 為唯一授權目標，不要誤授權 `release/` 目錄下的暫存 `.app`。

避免重踩的確認項目：

- 語音輸入恢復正常的前提，不只是重裝 app，而是先清舊 TCC，再重新授權。
- 雙語字幕與語音輸入都以 `/Applications/BiCaption.app` 為唯一授權目標，不要授權 release 目錄下的暫存 `.app`。
- 若要確認 packaged dictation polish 真的帶到本地 LLM runtime，請用 `npm run build:sidecar:full`，並確認 `build-sidecar.sh` 印出 `Including optional mlx_lm package`。

### 授權

MIT

### 公開內容邊界

本 repo 只包含 BiCaption 原始碼與發布所需檔案，不包含本機 `.env`、模型快取、虛擬環境、打包輸出、個人資料或其他專案內容。
