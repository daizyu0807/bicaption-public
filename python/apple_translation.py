"""Apple on-device translation; never silently sends text to a cloud fallback."""
import json
import os
from pathlib import Path
import subprocess
import platform
import queue
import threading


def normalize_translation_language(value):
    normalized = value.strip()
    key = normalized.lower()
    mapping = {
        "zh": "zh-Hant", "zh-tw": "zh-Hant", "zh-hant": "zh-Hant",
        "zh-cn": "zh-Hans", "zh-hans": "zh-Hans",
        "en-us": "en", "en-gb": "en", "english": "en",
        "chinese": "zh-Hant", "ja-jp": "ja", "ko-kr": "ko",
    }
    if key in ("auto", "unknown"):
        return key
    return mapping.get(key, normalized)


class AppleTranslationProvider:
    def __init__(self, persistent=None, source_languages=None):
        self.helper = os.environ.get("BICAPTION_APPLE_TRANSLATION_HELPER", "")
        if not self.helper or not Path(self.helper).is_file():
            raise RuntimeError("Apple 翻譯元件缺失，請重新安裝 BiCaption。")
        self.source_languages = list(source_languages or [])
        self.cache = {}
        version = platform.mac_ver()[0].split('.')[0]
        self.persistent = persistent if persistent is not None else bool(version and int(version) >= 26)
        self._process = None
        self._responses = None
        self._lock = threading.RLock()

    def __del__(self):
        if getattr(self, '_process', None) is not None:
            try:
                self.close()
            except Exception:
                pass

    def close(self):
        with self._lock:
            process, self._process = self._process, None
            if process is None:
                return
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
            if process.stdout:
                process.stdout.close()

    def _request(self, texts, source, target):
        with self._lock:
            if self._process is None or self._process.poll() is not None:
                self.close()
                process = subprocess.Popen([self.helper, '--server'], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           text=True, bufsize=1)
                self._process = process
                responses = queue.Queue()
                self._responses = responses
                def read():
                    try:
                        for line in process.stdout:
                            responses.put(line)
                    finally:
                        responses.put(None)
                threading.Thread(target=read, daemon=True).start()
                try:
                    welcome = json.loads(responses.get(timeout=30) or '{}')
                    if not isinstance(welcome, dict) or welcome.get('status') != 'ready':
                        self.close()
                        if not isinstance(welcome, dict):
                            raise RuntimeError('Apple 翻譯元件回應無效。')
                        raise RuntimeError(welcome.get('message') or 'Apple 翻譯元件未就緒。')
                except (queue.Empty, ValueError):
                    self.close()
                    raise RuntimeError('Apple 翻譯元件啟動逾時或回應無效。')
            try:
                self._process.stdin.write(json.dumps({'texts': texts, 'source': source, 'target': target, 'sourceLanguages': self.source_languages}, ensure_ascii=False) + '\n')
                self._process.stdin.flush()
                line = self._responses.get(timeout=30)
                if line is None:
                    self.close()
                    raise RuntimeError('Apple 翻譯元件已中止。')
                payload = json.loads(line)
                if not isinstance(payload, dict):
                    raise ValueError('Invalid reply')
                return payload
            except (queue.Empty, OSError, ValueError) as error:
                self.close()
                raise RuntimeError('Apple 翻譯逾時或回應無效，請重試。') from error

    def translate(self, text, source_lang, target_lang):
        return self.translate_many([text], source_lang, target_lang)[0]

    def translate_many(self, texts, source_lang, target_lang):
        source_lang = normalize_translation_language(source_lang)
        target_lang = normalize_translation_language(target_lang)
        if source_lang == "auto" and len(texts) > 1:
            # Language detection is per fragment; do not mix source languages
            # in a single Apple translation batch.
            return [self.translate_many([text], source_lang, target_lang)[0] for text in texts]
        result = [""] * len(texts)
        indexes = []
        for i, text in enumerate(texts):
            key = (text, source_lang, target_lang)
            if not text.strip():
                continue
            if key in self.cache:
                result[i] = self.cache[key]
            else:
                indexes.append(i)
        if not indexes:
            return result
        if self.persistent:
            payload = self._request([texts[i] for i in indexes], source_lang, target_lang)
            returncode = 0
        else:
            payload, returncode = self._one_shot([texts[i] for i in indexes], source_lang, target_lang)
        if returncode or payload.get("status") != "installed":
            raise RuntimeError(payload.get("message") or "請先完成 Apple 翻譯語言包準備。")
        translated = payload.get("translations")
        if not isinstance(translated, list) or len(translated) != len(indexes) or any(
            not isinstance(item, str) or not item.strip() for item in translated
        ):
            raise RuntimeError("Apple 翻譯結果不完整，請重試。")
        for i, item in zip(indexes, translated):
            result[i] = item
            self.cache[(texts[i], source_lang, target_lang)] = item
        return result

    def _one_shot(self, texts, source_lang, target_lang):
        try:
            completed = subprocess.run(
                [self.helper, "--translate", "--source", source_lang, "--target", target_lang]
                + (["--source-languages", ",".join(self.source_languages)] if self.source_languages else []),
                input=json.dumps(texts, ensure_ascii=False),
                text=True, capture_output=True, timeout=30,
            )
            payload = json.loads(completed.stdout.strip().splitlines()[-1])
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Apple 翻譯逾時，請重試。") from error
        except (OSError, ValueError, IndexError) as error:
            raise RuntimeError("Apple 翻譯元件沒有回傳有效結果。") from error
        return payload, completed.returncode
