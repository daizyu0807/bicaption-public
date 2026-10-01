# BiCaption

macOS 即時雙語字幕、會議逐字稿與按住說話的語音輸入工具。

Live bilingual captions, meeting transcripts, and hold-to-talk dictation for macOS.

[繁體中文](#繁體中文) · [English](#english) · [下載 / Download](https://github.com/daizyu0807/bicaption-public/releases/latest)

## 繁體中文

### 安裝與首次使用

安裝包支援 **Apple Silicon（arm64）**。Apple 原生翻譯需要 **macOS 15 或更新版本**；macOS 26 起使用持續翻譯元件。

1. 從 [最新 Release](https://github.com/daizyu0807/bicaption-public/releases/latest) 下載 DMG，將 BiCaption 拖到「應用程式」。
2. 開啟 `/Applications/BiCaption.app`，設定視窗會顯示到前景。
3. 從右上角「使用準備」完成需要的授權，完成後一次重新啟動。
4. 啟用雙語字幕前，在「使用準備」下載來源與目標語言的 Apple 翻譯語言包。
5. 選用 SenseVoice、Breeze 等本地模型時，先在 App 內下載模型。

目前採 ad-hoc 簽章，尚未經 Apple 公證。首次開啟若被 macOS 擋下，可在 Finder 右鍵選「打開」，或到「系統設定 → 隱私權與安全性」允許開啟。

### 功能與模型

- **雙語字幕**：擷取麥克風或系統音訊，在浮動視窗顯示原文與翻譯。「預覽字幕視窗」位於浮動視窗外觀設定。
- **會議字幕**：保留原文與翻譯、區分音訊來源、複製或匯出逐字稿，並提供選用的會議筆記與報告功能。
- **語音輸入**：按住快捷鍵說話，放開後辨識並複製或貼上文字；可選擇字典修正與潤稿。
- **Menubar 常駐**：關閉設定視窗後 App 會繼續執行。設定自動儲存；進行中的會議需以畫面上的套用操作更新設定。

| 模型／功能 | 適用情境 | 準備方式 |
| --- | --- | --- |
| SFSpeechRecognizer | macOS 原生辨識、快速字幕與語音輸入 | 語音辨識權限 |
| SenseVoice | 本地串流字幕與會議辨識 | App 內下載模型 |
| Breeze ASR 25 | 台灣中文、中英混說的分段辨識 | App 內下載模型；本版包含執行元件 |
| Groq Whisper | 選用線上辨識 | 使用者自行設定 API key 與網路 |
| Apple 原生翻譯 | 雙語字幕與會議翻譯 | 下載語言包；不需要翻譯 API key |

Apple 翻譯的 App 語言選項包含英文、繁體中文、日文與韓文。Breeze 的中英自動辨識會逐片段判斷來源語言；輸出速度受語句長度與硬體影響。原本的 Google 免費翻譯端點、實驗性 SpeechAnalyzer 與 Gemini Live 已移除。

部分筆記／潤稿功能需另外設定選用模型或服務。本版不包含選用本地 LLM 潤稿 runtime。

### 權限與語言包

「使用準備」依功能整理授權，完成後保留手動入口，不持續占用主畫面。

- 麥克風收音需要麥克風權限；系統音訊需要螢幕與系統音訊錄製權限。
- SFSpeechRecognizer 使用語音辨識權限。
- 選用聽寫快捷鍵／自動貼上時，才需要輸入監控／輔助使用權限。
- 翻譯語言包是下載項目，並非額外隱私權限。準備時需網路，下載完成後可供本機翻譯。

### 更新

點 menubar 的 **檢查更新**，發現新版後按「前往下載」，會開啟本公開 repo 的 Release。下載後退出舊版，再將新版覆蓋到「應用程式」。**目前採手動安裝，不會在 App 內自動下載、安裝或重啟。**

ad-hoc 簽章更新後可能需要重新授權。若已勾選卻無法收音或使用快捷鍵，先退出 BiCaption，在系統設定中只移除 BiCaption 的相關舊授權，再開啟新版重新允許。保留其他 App 權限；不要全域重置，也不要授權 `release/` 裡的暫存 App。

更新保留使用者設定與模型；尚未保存的會議內容請先匯出。

## English

### Install and prepare

This release provides an **Apple Silicon (arm64)** build. Apple on-device translation requires **macOS 15+**; macOS 26+ uses the persistent translation helper.

1. Download the DMG from the [latest Release](https://github.com/daizyu0807/bicaption-public/releases/latest) and drag BiCaption into Applications.
2. Open the installed app. Settings come to the foreground on launch.
3. Open **使用準備** (Setup), grant the permissions needed for your workflow, and restart once afterward.
4. Download Apple translation language packs before enabling bilingual captions.
5. Download optional local recognition models from inside the app.

The app is ad-hoc signed and not notarized. If macOS blocks the first launch, use Finder’s right-click **Open**, or allow it in **System Settings → Privacy & Security**.

### Features

- **Bilingual captions**: microphone or system audio, with source text and translation in a floating overlay. Preview is under floating-window appearance.
- **Meeting captions**: bilingual transcripts, source labels, copy/export, and optional notes/report workflows.
- **Dictation**: hold a hotkey to record, release to transcribe, then copy or paste. Optional dictionary correction and polishing are available.
- **Menu Bar mode**: closing settings keeps the app running in the menu bar. Settings save automatically.
- **Recognition**: SFSpeechRecognizer, SenseVoice, Breeze ASR 25, and optional Groq Whisper. Local models require an in-app download; Groq requires your own API key.
- **Translation**: Apple on-device translation, with English, Traditional Chinese, Japanese, and Korean app options. Download language packs first; no translation API key is needed.

Breeze supports Chinese/English code-switching through segmented recognition. Output timing depends on segment length and hardware. The free Google translation endpoint, experimental SpeechAnalyzer, and Gemini Live options have been removed. The default package does not include the optional local LLM polishing runtime.

### Permissions and updates

Microphone capture needs microphone access; system audio needs Screen & System Audio Recording access. SFSpeechRecognizer uses Speech Recognition permission. Global dictation hotkeys and auto-paste optionally need Input Monitoring and Accessibility. Translation language packs are downloads, not extra privacy permissions.

Use **Check for Updates** in the menu bar to find a newer public Release. The button opens the download page; quit the old app and manually replace it in Applications. In-app automatic download, installation, and restart are not implemented.

An ad-hoc signed update may require fresh permissions. If an existing checkmark does not work, quit BiCaption and remove only its affected entries in System Settings before granting them again. Keep other apps’ permissions intact. Grant access to the installed Applications copy, not a temporary build. Export unsaved meeting content before updating.

## Development

Source development requires Node.js 22.12+, Python 3.12 (recommended), and Apple’s command-line developer tools. Install the locked Node dependencies, create a project-local Python virtual environment, and install the requirements from `python/requirements.txt` inside it.

```bash
npm ci
npm run build:apple-stt
npm run build:global-hotkey
npm run dev
```

Download recognition models in the app, or use `bash scripts/download-models.sh`. Development and packaged builds use different model directories.

```bash
npm run type-check
npm test
npm run test:sidecar
npm run dist
```

The default package includes the Breeze runtime. Optional local LLM polishing requires a separate build with `npm run build:sidecar:full`.

## Public repository boundary

This repo contains BiCaption source and build assets. It excludes private workspace history, other projects, credentials, user settings, meeting transcripts, model caches, virtual environments, dependency directories, and local acceptance records. Release downloads contain the app and its required runtimes.

## License

MIT. Third-party components retain their respective licenses; see [LICENSE](LICENSE) and the component notices included in the app.
