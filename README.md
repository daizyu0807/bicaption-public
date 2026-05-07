# BiCaption

BiCaption is a macOS app for realtime bilingual subtitles, meeting captions, and hold-to-talk dictation.

It can capture microphone audio or system audio, transcribe speech locally, show subtitles in an always-on-top overlay, save meeting transcripts, and turn speech into text for quick input.

[English](#english) | [繁體中文](#繁體中文)

---

## English

### What It Does

- **Bilingual subtitles**: show realtime captions and translations for meetings, videos, or calls.
- **Meeting captions**: keep a live transcript, label speakers, generate notes, and export an HTML report.
- **Dictation**: hold a hotkey, speak, then copy or paste the recognized text.
- **Menu Bar mode**: close the settings window and keep the app running from the macOS Menu Bar.
- **Local-first speech recognition**: use local STT models for most workflows.

### Download

For normal use, download the latest macOS package from:

https://github.com/daizyu0807/bicaption-public/releases

If no release package is available yet, you can run the app from source by following the developer setup below.

### macOS Permissions

BiCaption may ask for these permissions depending on the feature you use:

- **Microphone**: microphone captions and dictation.
- **Screen & System Audio Recording**: system audio capture.
- **Accessibility**: auto-paste dictation output.
- **Input Monitoring**: global hold-to-talk hotkeys.
- **Speech Recognition**: Apple native speech recognition mode.

If a permission was denied earlier, open **System Settings -> Privacy & Security**, enable BiCaption for the relevant permission, then restart the app.

### Speech Models

| Model | Best For | Notes |
| --- | --- | --- |
| SenseVoice | Traditional Chinese, English, meeting captions | Recommended default for local captions. |
| SFSpeechRecognizer | Built-in macOS recognition | Fast native option, no model download. |
| Groq Whisper | Online dictation | Requires your own API key. |
| MLX Whisper | Higher-quality local dictation | Apple Silicon recommended. |

API keys are not included in this repository. If you use an online provider, configure your own key locally in the app.

### Quick Start From Source

Requirements:

- macOS, Apple Silicon recommended
- Node.js 20+
- Python 3.9+, Python 3.12+ recommended
- Homebrew Python is recommended over macOS system Python
- PortAudio may be needed on some systems: `brew install portaudio`

Setup:

```bash
npm install

/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

bash scripts/download-models.sh
```

Run in development mode:

```bash
npm run dev
```

Build checks:

```bash
npm run type-check
npm test
```

Package a local unsigned macOS app:

```bash
npm run dist:unsigned
npm run verify:app
npm run install:local-app
```

The install script places the app at `/Applications/BiCaption.app`.

### Common Issues

- If the app says models are missing, run `bash scripts/download-models.sh` or download models from the app settings.
- If system audio does not work, enable BiCaption under **Screen & System Audio Recording** and restart the app.
- If dictation does not paste text, enable **Accessibility** for `/Applications/BiCaption.app`.
- If the hold-to-talk hotkey does not work, enable **Input Monitoring**.
- If a development run cannot find Apple Speech Recognition helper files, run `bash scripts/build-apple-stt.sh`.

### Repository Notes

This public repository is a clean source snapshot for sharing BiCaption. It does not include local machine data, `.env` files, packaged release output, model caches, Python virtual environments, or `node_modules`.

### License

MIT

---

## 繁體中文

### 這是什麼

BiCaption 是 macOS 即時雙語字幕、會議字幕與按住說話語音輸入工具。

它可以擷取麥克風或系統音訊，用本地語音辨識模型轉成文字，在置頂字幕視窗顯示原文與翻譯；也可以保存會議逐字稿、產生會議記錄，或把語音輸入成可複製/貼上的文字。

### 主要功能

- **雙語字幕**：會議、影片、通話時顯示即時字幕與翻譯。
- **會議字幕**：保存逐字稿、設定說話者標籤、產生會議記錄、匯出 HTML 報告。
- **語音輸入**：按住快捷鍵說話，放開後自動辨識並複製或貼上文字。
- **Menu Bar 常駐**：關掉設定視窗後，仍可從 macOS Menu Bar 操作。
- **本地優先辨識**：大多數字幕與語音輸入流程可使用本地 STT 模型。

### 下載

一般使用請到 Releases 下載最新版 macOS 安裝包：

https://github.com/daizyu0807/bicaption-public/releases

如果目前還沒有 release 安裝包，可以依照下方開發者方式從原始碼執行。

### macOS 權限

依照你使用的功能，BiCaption 可能需要：

- **麥克風**：麥克風字幕與語音輸入。
- **螢幕與系統音訊錄製**：擷取系統音訊。
- **輔助使用 Accessibility**：自動貼上語音輸入結果。
- **輸入監控 Input Monitoring**：全域 hold-to-talk 快捷鍵。
- **語音辨識 Speech Recognition**：Apple 內建語音辨識模式。

如果之前拒絕過授權，請到 **系統設定 -> 隱私權與安全性** 裡重新開啟 BiCaption 的對應權限，然後重啟 App。

### 語音模型

| 模型 | 適合場景 | 備註 |
| --- | --- | --- |
| SenseVoice | 繁體中文、英文、會議字幕 | 建議預設本地字幕模型。 |
| SFSpeechRecognizer | macOS 內建辨識 | 不需要下載模型。 |
| Groq Whisper | 線上語音輸入 | 需要自己提供 API key。 |
| MLX Whisper | 較高品質本地語音輸入 | 建議 Apple Silicon。 |

這個 repo 不包含任何 API key。若要使用線上服務，請在本機 App 設定自己的 key。

### 從原始碼執行

需求：

- macOS，建議 Apple Silicon
- Node.js 20+
- Python 3.9+，建議 Python 3.12+
- 建議使用 Homebrew Python，不要使用 macOS 內建 Python
- 部分系統可能需要 PortAudio：`brew install portaudio`

安裝：

```bash
npm install

/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

bash scripts/download-models.sh
```

開發模式執行：

```bash
npm run dev
```

基本檢查：

```bash
npm run type-check
npm test
```

本機打包與安裝 unsigned macOS App：

```bash
npm run dist:unsigned
npm run verify:app
npm run install:local-app
```

安裝後 App 會在 `/Applications/BiCaption.app`。

### 常見問題

- 如果提示缺少模型，請執行 `bash scripts/download-models.sh`，或從 App 設定內下載模型。
- 如果系統音訊不能用，請在 **螢幕與系統音訊錄製** 開啟 BiCaption，然後重啟 App。
- 如果語音輸入不能自動貼上，請為 `/Applications/BiCaption.app` 開啟 **輔助使用 Accessibility**。
- 如果 hold-to-talk 快捷鍵沒有反應，請開啟 **輸入監控 Input Monitoring**。
- 如果開發模式找不到 Apple Speech Recognition helper，請執行 `bash scripts/build-apple-stt.sh`。

### Repo 說明

這是為了分享 BiCaption 而建立的乾淨公開原始碼快照。它不包含本機資料、`.env`、打包輸出、模型快取、Python 虛擬環境或 `node_modules`。

### 授權

MIT
