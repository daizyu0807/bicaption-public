import AppKit
import SwiftUI
import Translation
import NaturalLanguage

func output(_ value: [String: Any], code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
    exit(code)
}

func language(_ value: String) -> Locale.Language {
    Locale.Language(identifier: value.lowercased() == "zh-tw" ? "zh-Hant" : value)
}

// A short token has too little evidence for unrestricted language detection.
// Breeze supplies its Chinese/English language contract; other engines stay unrestricted.
func detectTranslationSource(_ text: String, candidates: [String]) -> String? {
    let recognizer = NLLanguageRecognizer()
    let allowed = ["en", "zh-Hant", "zh-Hans", "ja", "ko"]
    let constraints = candidates.filter { allowed.contains($0) }.map { NLLanguage(rawValue: $0) }
    if !constraints.isEmpty { recognizer.languageConstraints = constraints }
    recognizer.processString(text)
    return recognizer.dominantLanguage?.rawValue
}

func hasLanguageContent(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet.letters.contains($0) }
}

func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

@available(macOS 26, *)
@MainActor func serveTranslations() async {
    var sessions: [String: TranslationSession] = [:]
    reply(["status": "ready"])
    while let line = await Task.detached(operation: { readLine() }).value {
        guard let data = line.data(using: .utf8), data.count <= 100_000,
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let texts = request["texts"] as? [String], !texts.isEmpty,
              var from = request["source"] as? String, let to = request["target"] as? String else {
            reply(["status": "error", "message": "翻譯內容無效。"]); continue
        }
        if from == "auto" {
            if texts.allSatisfy({ !hasLanguageContent($0) }) && ["en", "zh-TW", "zh-Hant", "zh-Hans", "ja", "ko"].contains(to) {
                reply(["status": "installed", "translations": texts]); continue
            }
            from = detectTranslationSource(texts[0], candidates: request["sourceLanguages"] as? [String] ?? []) ?? ""
        }
        let allowed = ["en", "zh-TW", "zh-Hant", "zh-Hans", "ja", "ko"]
        guard allowed.contains(from), allowed.contains(to) else {
            reply(["status": "unsupported", "message": "這組翻譯語言目前無法使用。"]); continue
        }
        let source = language(from), target = language(to)
        if source == target { reply(["status": "installed", "translations": texts]); continue }
        let key = "\(from):\(to)"
        do {
            let session: TranslationSession
            if let existing = sessions[key] { session = existing }
            else {
                guard await LanguageAvailability().status(from: source, to: target) == .installed else {
                    reply(["status": "error", "message": "請先在使用準備中下載翻譯語言包。"]); continue
                }
                session = TranslationSession(installedSource: source, target: target)
                sessions[key] = session
            }
            let responses = try await session.translations(from: texts.enumerated().map {
                TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
            })
            reply(["status": "installed", "translations": responses.map(\.targetText)])
        } catch {
            sessions.removeValue(forKey: key)
            reply(["status": "error", "message": "Apple 翻譯失敗：\(error.localizedDescription)"])
        }
    }
    exit(0)
}

@available(macOS 15, *)
struct TranslationPreparation: View {
    let source: Locale.Language
    let target: Locale.Language
    let texts: [String]?
    var body: some View {
        VStack(spacing: 16) {
            Text("BiCaption 翻譯語言包").font(.title2)
            Text("請在 Apple 的提示中允許下載。完成後即可離線翻譯，無需帳號或金鑰。")
                .multilineTextAlignment(.center)
            ProgressView()
        }.padding(28).frame(width: 400, height: 180)
            .translationTask(source: source, target: target) { session in
                do {
                    try await session.prepareTranslation()
                    if let texts {
                        let responses = try await session.translations(from: texts.enumerated().map {
                            TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
                        })
                        output(["status": "installed", "translations": responses.map(\.targetText)])
                    }
                    output(["status": "installed"])
                } catch {
                    output(["status": "error", "message": "語言包準備未完成：\(error.localizedDescription)"], code: 1)
                }
            }
    }
}

@main struct AppleTranslationHelper {
    @MainActor static var window: NSWindow?
    @MainActor static func run() async {
        guard #available(macOS 15, *) else {
            output(["status": "unsupported", "message": "Apple 本機翻譯需要 macOS 15 或更新版本。"])
        }
        let args = CommandLine.arguments
        if args.contains("--server") {
            if #available(macOS 26, *) { await serveTranslations() }
            output(["status": "unsupported", "message": "持續翻譯元件需要 macOS 26。"], code: 1)
        }
        func option(_ flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        var decodedTexts: [String]?
        if args.contains("--translate") {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 100_000, let decoded = try? JSONDecoder().decode([String].self, from: data), !decoded.isEmpty else {
                output(["status": "error", "message": "翻譯內容無效。"], code: 1)
            }
            decodedTexts = decoded
        }
        var detectedSource = option("--source")
        if detectedSource == "auto", let text = decodedTexts?.first {
            if decodedTexts!.allSatisfy({ !hasLanguageContent($0) }) && ["en", "zh-TW", "zh-Hant", "zh-Hans", "ja", "ko"].contains(option("--target") ?? "") {
                output(["status": "installed", "translations": decodedTexts!])
            }
            detectedSource = detectTranslationSource(text,
                candidates: option("--source-languages")?.split(separator: ",").map(String.init) ?? [])
        }
        guard let sourceValue = detectedSource, let targetValue = option("--target"),
              ["en", "zh-TW", "zh-Hant", "zh-Hans", "ja", "ko"].contains(sourceValue),
              ["en", "zh-TW", "zh-Hant", "zh-Hans", "ja", "ko"].contains(targetValue) else {
            output(["status": "unsupported", "message": "請選擇支援的來源與目標語言。"], code: 1)
        }
        let source = language(sourceValue), target = language(targetValue)
        if args.contains("--translate"), source == target, let decodedTexts {
            output(["status": "installed", "translations": decodedTexts])
        }
        let status = await LanguageAvailability().status(from: source, to: target)
        if args.contains("--status") {
            switch status {
            case .installed: output(["status": "installed"])
            case .supported: output(["status": "supported"])
            case .unsupported: output(["status": "unsupported", "message": "Apple 尚不支援這組翻譯語言。"])
            @unknown default: output(["status": "error", "message": "無法確認翻譯語言狀態。"])
            }
        }
        guard status != .unsupported else {
            output(["status": "unsupported", "message": "Apple 尚不支援這組翻譯語言。"], code: 1)
        }
        var texts: [String]?
        if args.contains("--translate") {
            guard status == .installed else {
                output(["status": "supported", "message": "請先在使用準備中下載翻譯語言包。"], code: 1)
            }
            guard let decoded = decodedTexts else { output(["status": "error", "message": "翻譯內容無效。"], code: 1) }
            texts = decoded
            if #available(macOS 26, *) {
                let session = TranslationSession(installedSource: source, target: target)
                do {
                    let responses = try await session.translations(from: decoded.enumerated().map {
                        TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
                    })
                    output(["status": "installed", "translations": responses.map(\.targetText)])
                } catch { output(["status": "error", "message": "Apple 翻譯失敗：\(error.localizedDescription)"], code: 1) }
            }
        } else if !args.contains("--prepare") {
            output(["status": "error", "message": "未知操作。"], code: 1)
        } else if status == .installed {
            output(["status": "installed"])
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        let host = NSHostingView(rootView: TranslationPreparation(source: source, target: target, texts: texts))
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 220),
                             styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "BiCaption 使用準備"
        panel.contentView = host
        window = panel // The TranslationSession must retain its hosting view.
        panel.center()
        // On macOS 15 the SwiftUI session must be attached to an ordered window.
        if texts != nil { panel.alphaValue = 0; panel.ignoresMouseEvents = true }
        panel.orderFrontRegardless()
        if texts == nil { panel.makeKeyAndOrderFront(nil); NSApplication.shared.activate(ignoringOtherApps: true) }
    }
    @MainActor static func main() {
        _ = NSApplication.shared
        Task { await run() }
        NSApplication.shared.run()
    }
}
