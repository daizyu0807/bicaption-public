import json
from pathlib import Path
import subprocess
import sys
import unittest
import types
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

stubbed_modules = {
    "sounddevice": {},
    "sherpa_onnx": {},
    "deep_translator": {
        "GoogleTranslator": type(
            "GoogleTranslator",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "translate": lambda self, text: "你好" if text.strip().lower() == "hello" else text,
            },
        ),
    },
    "opencc": {
        "OpenCC": type(
            "OpenCC",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "convert": lambda self, text: text,
            },
        ),
    },
}

try:
    import numpy  # noqa: F401
except Exception:
    stubbed_modules["numpy"] = {}

for module_name, attrs in stubbed_modules.items():
    if module_name not in sys.modules:
        module = types.ModuleType(module_name)
        for attr_name, attr_value in attrs.items():
            setattr(module, attr_name, attr_value)
        sys.modules[module_name] = module

import numpy as np
import sidecar as sidecar_module
HAS_REAL_NUMPY = hasattr(np, "array")

from sidecar import (
    AppleSttTranscriber,
    BreezeAsrBatchTranscriber,
    BreezeAsrMeetingTranscriber,
    SidecarApp,
    StreamingLinearResampler,
    assess_speaker_audio,
    apply_dictation_dictionary,
    apply_dictation_rules_rewrite,
    build_speaker_fingerprint,
    build_local_llm_rewrite_prompt,
    compare_speaker_fingerprints,
    get_sidecar_invocation_command,
    get_local_llm_python_bin,
    LocalLlmRewriteProvider,
    MeetingSpeakerMatchStats,
    FallbackTranslator,
    GEMINI_LIVE_AUDIO_CHUNK_SAMPLES,
    GeminiLiveCaptionEvent,
    GeminiLiveCaptionStabilizer,
    GeminiLiveTranslateClient,
    build_dictation_final_event,
    build_dictation_state_event,
    DictationFragment,
    TranscriptChunk,
    build_meeting_audio_path,
    build_meeting_audio_temp_path,
    append_dictation_fragment,
    count_transcript_units,
    looks_like_garbage_text,
    make_segment_id,
    make_meeting_segment_id,
    normalize_mlx_whisper_lang,
    normalize_groq_transcription_lang,
    is_groq_transcription_quota_error,
    normalize_text,
    normalize_moonshine_lang,
    resolve_cloud_llm_model,
    parse_dictation_dictionary,
    parse_speaker_fingerprint,
    contains_cjk,
    prefers_traditional_chinese,
    serialize_speaker_fingerprint,
    should_use_local_llm_rewrite,
    get_local_llm_max_tokens,
    get_meeting_recording_sources,
    should_accept_rewrite,
    should_attempt_dictation_batch_fallback,
    summarize_meeting_match_stats,
    DictationRewriteResult,
    build_groq_transcription_prompt,
    build_meeting_mix_chunk,
    get_streaming_transcriber,
    mix_meeting_audio_sources,
)


class TranslationProviderTest(unittest.TestCase):
    def test_translates_known_phrase(self) -> None:
        provider = FallbackTranslator()
        self.assertEqual(provider.translate("hello", "en", "zh-TW"), "你好")

    def test_preserves_unknown_text(self) -> None:
        provider = FallbackTranslator()
        self.assertIn("Roadmap", provider.translate("Roadmap review", "en", "zh-TW"))

    def test_normalizes_whitespace(self) -> None:
        self.assertEqual(normalize_text("  hello   world "), "hello world")

    def test_count_transcript_units_uses_word_count_for_spaced_text(self) -> None:
        self.assertEqual(count_transcript_units("hello wonderful world"), 3)

    def test_count_transcript_units_uses_cjk_chars_for_unspaced_text(self) -> None:
        self.assertGreaterEqual(count_transcript_units("今天我們先確認語音輸入完成速度是否穩定"), 14)

    def test_prefers_traditional_chinese_uses_source_or_target_lang(self) -> None:
        self.assertTrue(prefers_traditional_chinese("zh-TW", "en", "zh"))
        self.assertTrue(prefers_traditional_chinese("en", "zh-TW", "zh"))
        self.assertFalse(prefers_traditional_chinese("en", "en", "zh"))

    def test_contains_cjk_detects_chinese_text(self) -> None:
        self.assertTrue(contains_cjk("今天開會測試"))
        self.assertFalse(contains_cjk("meeting test"))

    def test_apple_stt_residual_delta_prefers_unpromoted_suffix(self) -> None:
        transcriber = AppleSttTranscriber(source_lang="zh-TW")
        transcriber._promoted_len = len("然後是斷句的部分其實第一句可以斷")
        transcriber._promoted_text = "然後是斷句的部分其實第一句可以斷"
        delta = transcriber._build_residual_delta("然後是斷句的部分其實第一句可以斷然後第二句開始他就不會斷句")
        self.assertEqual(delta, "然後第二句開始他就不會斷句")

    def test_gemini_stabilizer_emits_partial_before_final(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        events = stabilizer.add_translation("hello", 1000)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "partial")
        self.assertEqual(events[0].translated_text, "hello")

    def test_gemini_stabilizer_flushes_after_stable_timeout(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        stabilizer.add_translation("hello", 1000)

        # partial_stable_ms is floored at MIN_STABLE_MS (1500) for Gemini.
        self.assertEqual(stabilizer.drain_due(2400), [])
        events = stabilizer.drain_due(2600)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "final")
        self.assertEqual(events[0].translated_text, "hello")

    def test_gemini_stabilizer_merges_incremental_fragments(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        stabilizer.add_translation("hello", 1000)
        events = stabilizer.add_translation("world.", 1100)

        self.assertEqual([event.kind for event in events], ["partial", "final"])
        self.assertEqual(events[-1].translated_text, "hello world.")
        self.assertEqual(events[-1].segment_id, "gemini-live-1")

    def test_gemini_stabilizer_merges_cumulative_revision(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        stabilizer.add_translation("hello wor", 1000)
        events = stabilizer.add_translation("hello world.", 1100)

        self.assertEqual(events[-1].kind, "final")
        self.assertEqual(events[-1].translated_text, "hello world.")

    def test_gemini_stabilizer_keeps_short_cjk_text_pending(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        events = stabilizer.add_translation("今天我們先確認語音輸入完成速度是否穩定", 1000)

        # Below the runaway cap and without sentence punctuation the text
        # stays pending (partial only) instead of being chopped mid-sentence.
        self.assertEqual([event.kind for event in events], ["partial"])

    def test_gemini_stabilizer_flushes_cjk_runaway_cap(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        long_text = "今天我們先確認語音輸入完成速度是否穩定" * 3
        events = stabilizer.add_translation(long_text, 1000)

        self.assertEqual([event.kind for event in events], ["partial", "final"])
        self.assertEqual(events[-1].translated_text, long_text)

    def test_gemini_stabilizer_can_emit_source_only_caption(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        events = stabilizer.add_source("hello team.", 1000, detected_lang="en", emit_as_caption=True)

        self.assertEqual([event.kind for event in events], ["partial", "final"])
        self.assertEqual(events[-1].source_text, "hello team.")
        self.assertEqual(events[-1].translated_text, "")
        self.assertEqual(events[-1].detected_lang, "en")

    def test_gemini_stabilizer_flushes_source_only_after_timeout(self) -> None:
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        stabilizer.add_source("hello", 1000, emit_as_caption=True)

        self.assertEqual(stabilizer.drain_due(2400, include_source=True), [])
        events = stabilizer.drain_due(2600, include_source=True)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "final")
        self.assertEqual(events[0].source_text, "hello")
        self.assertEqual(events[0].translated_text, "")

    def test_gemini_stabilizer_drains_pending_source_even_with_translation_enabled(self) -> None:
        # If Gemini never sends output transcripts (e.g. same-language input),
        # accumulated source text must still flush instead of being held forever.
        stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        stabilizer.add_source("怎麼沒有出現呢", 1000, emit_as_caption=False)

        events = stabilizer.drain_due(2600)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "final")
        self.assertEqual(events[0].source_text, "怎麼沒有出現呢")

    def test_gemini_turn_complete_flushes_pending_caption(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="subtitle",
            session_id="subtitle-gemini",
            source_lang="auto",
            target_lang="zh-TW",
            translate_model="gemini-live",
            partial_stable_ms=500,
        )
        app.gemini_live_stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_live_event({"type": "input_transcript", "text": "hello there"}, 1000)
            app._emit_gemini_live_event({"type": "turn_complete"}, 1400)

        finals = [event for event in emitted if event.get("type") == "final_caption"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["sourceText"], "hello there")

    def test_gemini_client_throttles_queue_full_errors(self) -> None:
        client = GeminiLiveTranslateClient(types.SimpleNamespace(gemini_api_key="test-key"))
        overflow = np.zeros(GEMINI_LIVE_AUDIO_CHUNK_SAMPLES * (client.audio_queue.maxsize + 10), dtype=np.float32)

        client.feed_audio(overflow)
        client.feed_audio(overflow)

        errors = [event for event in client.poll_events() if event.get("type") == "error"]
        self.assertEqual(len(errors), 1)

    def test_gemini_meeting_final_emits_meeting_caption_with_translation(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini",
            source_lang="auto",
            target_lang="zh-TW",
            meeting_source_mode="microphone",
            meeting_speaker_labels_enabled=True,
        )
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_caption_event(GeminiLiveCaptionEvent(
                kind="final",
                segment_id="gemini-live-1",
                source_text="annyeonghaseyo",
                translated_text="你好",
                started_at_ms=1000,
                ended_at_ms=1800,
                detected_lang="ko",
            ))

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["type"], "meeting_caption")
        self.assertEqual(emitted[0]["source"], "microphone")
        self.assertEqual(emitted[0]["text"], "annyeonghaseyo")
        self.assertEqual(emitted[0]["translatedText"], "你好")
        self.assertEqual(emitted[0]["sourceLang"], "ko")

    def test_gemini_meeting_dual_final_uses_system_source_for_mixed_audio(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini-dual",
            source_lang="auto",
            target_lang="en",
            meeting_source_mode="dual",
            meeting_speaker_labels_enabled=True,
        )
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_caption_event(GeminiLiveCaptionEvent(
                kind="final",
                segment_id="gemini-live-1",
                source_text="회의를 시작하겠습니다",
                translated_text="We will start the meeting.",
                started_at_ms=1000,
                ended_at_ms=2200,
                detected_lang="ko",
            ))

        self.assertEqual(emitted[0]["type"], "meeting_caption")
        self.assertEqual(emitted[0]["source"], "system")
        self.assertEqual(emitted[0]["speakerKind"], "remote-default")

    def test_gemini_meeting_dual_final_uses_microphone_when_mic_is_dominant(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini-dual-mic",
            source_lang="auto",
            target_lang="zh-TW",
            meeting_source_mode="dual",
            meeting_speaker_labels_enabled=True,
        )
        app.gemini_meeting_source_levels = [
            (900, 2300, 0.035, 0.004),
        ]
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_caption_event(GeminiLiveCaptionEvent(
                kind="final",
                segment_id="gemini-live-1",
                source_text="我現在開始說話",
                translated_text="",
                started_at_ms=1000,
                ended_at_ms=2200,
                detected_lang="zh",
            ))

        self.assertEqual(emitted[0]["type"], "meeting_caption")
        self.assertEqual(emitted[0]["source"], "microphone")
        self.assertEqual(emitted[0]["speakerKind"], "source-default")

    def test_gemini_meeting_translation_disabled_uses_input_transcript(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini-source-only",
            source_lang="auto",
            target_lang="zh-TW",
            translate_model="disabled",
            partial_stable_ms=500,
            meeting_source_mode="microphone",
            meeting_speaker_labels_enabled=True,
        )
        app.gemini_live_stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_live_event({
                "type": "input_transcript",
                "text": "hello team.",
                "languageCode": "en",
            }, 1000)

        self.assertEqual([event.get("type") for event in emitted], ["partial_caption", "meeting_caption"])
        self.assertEqual(emitted[-1]["text"], "hello team.")
        self.assertEqual(emitted[-1]["translatedText"], "")
        self.assertEqual(emitted[-1]["sourceLang"], "en")

    def test_gemini_meeting_input_transcript_binds_microphone_source_hint(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini-source-hint",
            source_lang="auto",
            target_lang="zh-TW",
            translate_model="disabled",
            partial_stable_ms=500,
            meeting_source_mode="dual",
            meeting_speaker_labels_enabled=True,
        )
        app.gemini_live_stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        app.gemini_meeting_source_levels = [
            (1000, 2000, 0.030, 0.006),
            (2100, 2600, 0.001, 0.030),
        ]
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_live_event({
                "type": "input_transcript",
                "text": "我方第一句。",
                "languageCode": "zh",
            }, 1800)

        self.assertEqual(emitted[-1]["type"], "meeting_caption")
        self.assertEqual(emitted[-1]["source"], "microphone")
        self.assertEqual(emitted[-1]["speakerKind"], "source-default")

    def test_meeting_label_uses_configured_source_labels(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_microphone_label="主持人",
            meeting_system_label="來賓",
        )

        self.assertEqual(app._build_meeting_label("microphone"), ("microphone", "主持人"))
        self.assertEqual(app._build_meeting_label("system"), ("system", "來賓"))

    def test_gemini_meeting_translation_disabled_ignores_output_transcript(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            mode="meeting",
            session_id="meeting-gemini-no-translation",
            source_lang="auto",
            target_lang="zh-TW",
            translate_model="disabled",
            partial_stable_ms=500,
            meeting_source_mode="microphone",
            meeting_speaker_labels_enabled=True,
        )
        app.gemini_live_stabilizer = GeminiLiveCaptionStabilizer(partial_stable_ms=500)
        emitted: list[dict[str, object]] = []

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_gemini_live_event({
                "type": "output_transcript",
                "text": "Starting recording",
                "languageCode": "en",
            }, 1000)

        self.assertEqual(emitted, [])

    def test_meeting_loop_polls_apple_transcriber_during_silence(self) -> None:
        app = SidecarApp()
        transcriber = AppleSttTranscriber(source_lang="zh-TW")
        calls: list[int] = []
        silent_chunk = types.SimpleNamespace(size=0)

        def fake_feed_audio(samples, base_time_ms):
            calls.append(samples.size)
            return []

        transcriber.feed_audio = fake_feed_audio  # type: ignore[assignment]
        app._feed_meeting_transcriber("microphone", silent_chunk, transcriber, 1000)
        self.assertEqual(calls, [0])

    def test_meeting_microphone_duplicate_of_recent_system_chunk_is_skipped(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_speaker_labels_enabled=True,
            meetingMicrophoneLabel="我方",
            meetingSystemLabel="遠端",
            meeting_local_speaker_verification_enabled=False,
            meeting_local_speaker_profile_id="",
            source_lang="en",
            target_lang="en",
            translate_model="disabled",
            session_id="meeting-dup",
        )
        emitted: list[dict[str, object]] = []
        silent_audio = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-dup",
                segment_id="system-1",
                source_text="What you know I don't know and I feel like your manager is almost like your representative.",
                started_at_ms=1000,
                ended_at_ms=3000,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-dup",
                segment_id="mic-1",
                source_text="What you know I don't know and I feel like your manager is almost like your representative.",
                started_at_ms=3200,
                ended_at_ms=5200,
                confidence=0.9,
                detected_lang="en",
            ), "microphone", silent_audio)

        meeting_events = [event for event in emitted if event.get("type") == "meeting_caption"]
        self.assertEqual(len(meeting_events), 1)
        self.assertEqual(meeting_events[0].get("source"), "system")

    def test_meeting_microphone_unique_chunk_is_not_skipped(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_speaker_labels_enabled=True,
            meetingMicrophoneLabel="我方",
            meetingSystemLabel="遠端",
            meeting_local_speaker_verification_enabled=False,
            meeting_local_speaker_profile_id="",
            source_lang="en",
            target_lang="en",
            translate_model="disabled",
            session_id="meeting-unique",
        )
        emitted: list[dict[str, object]] = []
        silent_audio = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-unique",
                segment_id="system-1",
                source_text="What you know I don't know and I feel like your manager is almost like your representative.",
                started_at_ms=1000,
                ended_at_ms=3000,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-unique",
                segment_id="mic-1",
                source_text="I think we should probably rewrite the onboarding checklist before next week.",
                started_at_ms=3200,
                ended_at_ms=5200,
                confidence=0.9,
                detected_lang="en",
            ), "microphone", silent_audio)

        meeting_events = [event for event in emitted if event.get("type") == "meeting_caption"]
        self.assertEqual(len(meeting_events), 2)
        self.assertEqual([event.get("source") for event in meeting_events], ["system", "microphone"])

    def test_meeting_verified_local_chunk_is_not_suppressed_even_if_text_matches(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_speaker_labels_enabled=True,
            meetingMicrophoneLabel="我方",
            meetingSystemLabel="遠端",
            meeting_local_speaker_verification_enabled=True,
            meeting_local_speaker_profile_id="profile-1",
            source_lang="en",
            target_lang="en",
            translate_model="disabled",
            session_id="meeting-verified-local",
        )
        emitted: list[dict[str, object]] = []
        silent_audio = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            with patch.object(app, "_classify_meeting_speaker", return_value=("verified-local", "profile-1", 0.95)):
                app._emit_chunk_from_source(TranscriptChunk(
                    mode="meeting",
                    session_id="meeting-verified-local",
                    segment_id="system-1",
                    source_text="I need to be able to care about the kind of product that my company works for.",
                    started_at_ms=1000,
                    ended_at_ms=3000,
                    confidence=0.9,
                    detected_lang="en",
                ), "system")
                app._emit_chunk_from_source(TranscriptChunk(
                    mode="meeting",
                    session_id="meeting-verified-local",
                    segment_id="mic-1",
                    source_text="I need to be able to care about the kind of product that my company works for.",
                    started_at_ms=3200,
                    ended_at_ms=5200,
                    confidence=0.9,
                    detected_lang="en",
                ), "microphone", silent_audio)

        meeting_events = [event for event in emitted if event.get("type") == "meeting_caption"]
        self.assertEqual(len(meeting_events), 2)
        self.assertEqual(meeting_events[1].get("speakerKind"), "verified-local")

    def test_meeting_microphone_chunk_matching_combined_recent_system_text_is_skipped(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_speaker_labels_enabled=True,
            meetingMicrophoneLabel="我方",
            meetingSystemLabel="遠端",
            meeting_local_speaker_verification_enabled=False,
            meeting_local_speaker_profile_id="",
            source_lang="en",
            target_lang="en",
            translate_model="disabled",
            session_id="meeting-combined-dup",
        )
        emitted: list[dict[str, object]] = []
        silent_audio = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-combined-dup",
                segment_id="system-1",
                source_text="Second job is I actually have an opinion now on the tour that I want to do.",
                started_at_ms=1000,
                ended_at_ms=2600,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-combined-dup",
                segment_id="system-2",
                source_text="I feel like it's like I just want the actual work to be the right amount of challenging and interesting.",
                started_at_ms=2600,
                ended_at_ms=4200,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-combined-dup",
                segment_id="mic-1",
                source_text="Second job is I actually have an opinion now on the tour that I want to do. I feel like it's like I just want the actual work to be the right amount of challenging and interesting.",
                started_at_ms=4300,
                ended_at_ms=6500,
                confidence=0.9,
                detected_lang="en",
            ), "microphone", silent_audio)

        meeting_events = [event for event in emitted if event.get("type") == "meeting_caption"]
        self.assertEqual(len(meeting_events), 2)
        self.assertEqual([event.get("source") for event in meeting_events], ["system", "system"])

    def test_meeting_microphone_chunk_matching_long_history_is_skipped(self) -> None:
        app = SidecarApp()
        app.config = types.SimpleNamespace(
            meeting_speaker_labels_enabled=True,
            meetingMicrophoneLabel="我方",
            meetingSystemLabel="遠端",
            meeting_local_speaker_verification_enabled=False,
            meeting_local_speaker_profile_id="",
            source_lang="en",
            target_lang="en",
            translate_model="disabled",
            session_id="meeting-history-dup",
        )
        emitted: list[dict[str, object]] = []
        silent_audio = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "emit", side_effect=emitted.append):
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-history-dup",
                segment_id="system-1",
                source_text="Doesn't feel like you're bashing your head against the wall you know what I mean.",
                started_at_ms=1000,
                ended_at_ms=2600,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-history-dup",
                segment_id="system-2",
                source_text="I have a question do you guys care about the kind of level of autonomy you have at work.",
                started_at_ms=5200,
                ended_at_ms=7000,
                confidence=0.9,
                detected_lang="en",
            ), "system")
            app._emit_chunk_from_source(TranscriptChunk(
                mode="meeting",
                session_id="meeting-history-dup",
                segment_id="mic-1",
                source_text="Doesn't feel like you're bashing your head against the wall you know what I mean. I have a question do you guys care about the kind of level of autonomy you have at work.",
                started_at_ms=18500,
                ended_at_ms=21500,
                confidence=0.9,
                detected_lang="en",
            ), "microphone", silent_audio)

        meeting_events = [event for event in emitted if event.get("type") == "meeting_caption"]
        self.assertEqual(len(meeting_events), 2)
        self.assertEqual([event.get("source") for event in meeting_events], ["system", "system"])

    def test_apple_stt_dictation_promotes_stable_partial_before_stop(self) -> None:
        transcriber = AppleSttTranscriber(source_lang="zh-TW", partial_stable_ms=600)
        transcriber._results.put({"type": "partial", "text": "我們現在先測試一下停頓之後會不會先切開"})
        sidecar_module._emit_context["mode"] = "dictation"
        sidecar_module._emit_context["sessionId"] = "session-apple-dictation"
        silent_samples = types.SimpleNamespace(size=0)

        with patch.object(sidecar_module, "now_ms", side_effect=[1000, 1000, 2000, 2000]):
            first = transcriber.feed_audio(silent_samples, 1000)
            second = transcriber.feed_audio(silent_samples, 1000)

        promoted = first or second
        self.assertEqual(len(promoted), 1)
        self.assertEqual(promoted[0].source_text, "我們現在先測試一下停頓之後會不會先切開")

    def test_update_session_preserves_meeting_sensevoice_segment_counter(self) -> None:
        app = SidecarApp()
        app.active = True
        app.config = types.SimpleNamespace(
            mode="meeting",
            source_lang="zh-TW",
            target_lang="zh-TW",
            translate_model="google",
            meeting_speaker_labels_enabled=True,
            partial_stable_ms=180,
            session_id="session-1",
        )
        class FakeSenseVoiceTranscriber:
            def __init__(self, min_silence_duration: float = 0.3) -> None:
                self.min_silence_duration = min_silence_duration
                self._segment_counter = 0

        mic = FakeSenseVoiceTranscriber(0.18)
        mic._segment_counter = 4
        app.meeting_mic_transcriber = mic
        app.meeting_system_transcriber = None
        with patch.object(sidecar_module, "SenseVoiceTranscriber", FakeSenseVoiceTranscriber):
            app.update_session({"mode": "meeting", "partialStableMs": 120})
        self.assertIsInstance(app.meeting_mic_transcriber, FakeSenseVoiceTranscriber)
        self.assertEqual(app.meeting_mic_transcriber._segment_counter, 4)

    def test_segment_id_is_stable(self) -> None:
        self.assertEqual(make_segment_id(1049, 2899), "seg-10-29")

    def test_meeting_segment_id_includes_source_prefix(self) -> None:
        self.assertEqual(make_meeting_segment_id("microphone", "seg-10-29"), "microphone:seg-10-29")
        self.assertEqual(make_meeting_segment_id("system", "seg-10-29"), "system:seg-10-29")

    def test_filters_repeated_garbage_text(self) -> None:
        self.assertTrue(looks_like_garbage_text("M-M-M-M-M-M-M-M-"))

    def test_allows_normal_sentence(self) -> None:
        self.assertFalse(looks_like_garbage_text("People dream high in the quiet of the night"))

    def test_normalize_moonshine_lang_maps_supported_languages(self) -> None:
        self.assertEqual(normalize_moonshine_lang("en"), "en")
        self.assertEqual(normalize_moonshine_lang("zh-TW"), "zh")
        self.assertEqual(normalize_moonshine_lang("ja"), "ja")
        self.assertEqual(normalize_moonshine_lang("ko"), "ko")

    def test_normalize_moonshine_lang_rejects_auto(self) -> None:
        self.assertIsNone(normalize_moonshine_lang("auto"))

    def test_normalize_mlx_whisper_lang_maps_traditional_chinese_and_auto(self) -> None:
        self.assertEqual(normalize_mlx_whisper_lang("zh-TW"), "zh")
        self.assertEqual(normalize_mlx_whisper_lang("en"), "en")
        self.assertIsNone(normalize_mlx_whisper_lang("auto"))

    @unittest.skipUnless(HAS_REAL_NUMPY, "requires real numpy")
    def test_breeze_asr_unavailable_emits_recoverable_error_without_output(self) -> None:
        with patch.object(
            sidecar_module,
            "warm_breeze_asr_model",
            side_effect=RuntimeError("missing runtime"),
        ), patch.object(sidecar_module, "emit") as emit:
            with self.assertRaisesRegex(RuntimeError, "Breeze ASR runtime unavailable"):
                BreezeAsrBatchTranscriber(source_lang="zh-TW")
        emitted = [call.args[0] for call in emit.call_args_list]
        self.assertIn({"type": "error", "code": "breeze_asr_unavailable", "message": "Breeze ASR runtime 或固定版本模型尚未就緒。", "recoverable": True}, emitted)

    def test_breeze_asr_meeting_uses_vad_segmented_transcriber(self) -> None:
        config = types.SimpleNamespace(
            stt_model="breeze-asr-25",
            mode="meeting",
            source_lang="auto",
            partial_stable_ms=300,
        )
        with patch.object(sidecar_module, "BreezeAsrMeetingTranscriber") as transcriber_class:
            instance = transcriber_class.return_value
            self.assertIs(get_streaming_transcriber(config, announce=False), instance)
        transcriber_class.assert_called_once_with(source_lang="auto", min_silence_duration=0.3)

    @unittest.skipUnless(HAS_REAL_NUMPY, "requires real numpy")
    def test_breeze_meeting_transcription_reuses_in_process_model_without_subprocess(self) -> None:
        transcriber = object.__new__(BreezeAsrMeetingTranscriber)
        transcriber._source_lang = "zh"
        transcriber._segment_counter = 0
        transcriber._failure_reported = False
        audio = np.zeros(8_000, dtype=np.float32)

        with patch.object(
            sidecar_module,
            "transcribe_breeze_asr_in_process",
            return_value={"text": "會議字幕測試", "language": "zh"},
        ) as transcribe, patch.object(sidecar_module.subprocess, "run") as subprocess_run:
            chunks = transcriber.transcribe_buffer(audio, 2_000)

        transcribe.assert_called_once()
        subprocess_run.assert_not_called()
        self.assertEqual(chunks[0].source_text, "會議字幕測試")

    @unittest.skipUnless(HAS_REAL_NUMPY, "requires real numpy")
    def test_breeze_dictation_reuses_in_process_model_without_subprocess(self) -> None:
        transcriber = object.__new__(BreezeAsrBatchTranscriber)
        transcriber._source_lang = "zh"
        transcriber._initial_prompt = "BiCaption"
        transcriber._segment_counter = 0
        transcriber._failure_reported = False
        audio = np.zeros(8_000, dtype=np.float32)

        with patch.object(
            sidecar_module,
            "transcribe_breeze_asr_in_process",
            return_value={"text": "語音輸入測試", "language": "zh"},
        ) as transcribe, patch.object(sidecar_module.subprocess, "run") as subprocess_run:
            chunks = transcriber.transcribe_buffer(audio, 2_000)

        transcribe.assert_called_once_with(audio, "zh", "BiCaption")
        subprocess_run.assert_not_called()
        self.assertEqual(chunks[0].source_text, "語音輸入測試")

    def test_normalize_groq_transcription_lang_maps_traditional_chinese_and_auto(self) -> None:
        self.assertEqual(normalize_groq_transcription_lang("zh-TW"), "zh")
        self.assertEqual(normalize_groq_transcription_lang("en"), "en")
        self.assertEqual(normalize_groq_transcription_lang("auto"), "")

    def test_build_groq_transcription_prompt_includes_glossary_and_context(self) -> None:
        prompt = build_groq_transcription_prompt(
            "Claude, Codex",
            "AI agent 名稱\nCLI 工具名",
            "Claude Code\nCodex\nGemini CLI",
        )
        self.assertIn("Claude Code", prompt)
        self.assertIn("CLI 工具名", prompt)

    def test_is_groq_transcription_quota_error_detects_insufficient_quota(self) -> None:
        detail = json.dumps({
            "error": {
                "message": "You exceeded your current quota, please check your plan and billing details.",
                "type": "insufficient_quota",
            },
        })
        self.assertTrue(is_groq_transcription_quota_error(429, detail))

    def test_is_groq_transcription_quota_error_ignores_generic_rate_limit(self) -> None:
        detail = json.dumps({
            "error": {
                "message": "Rate limit reached for requests per minute.",
                "type": "rate_limit_exceeded",
            },
        })
        self.assertFalse(is_groq_transcription_quota_error(429, detail))

    def test_resolve_cloud_llm_model_defaults_auto_to_stable_model(self) -> None:
        self.assertEqual(resolve_cloud_llm_model("auto", "zh-TW", "polished"), "llama-3.3-70b-versatile")
        self.assertEqual(resolve_cloud_llm_model("", "en", "polished"), "llama-3.3-70b-versatile")

    def test_resolve_cloud_llm_model_preserves_manual_choice(self) -> None:
        self.assertEqual(resolve_cloud_llm_model("qwen/qwen3-32b", "zh-TW", "polished"), "qwen/qwen3-32b")

    def test_get_meeting_recording_sources_matches_source_mode(self) -> None:
        self.assertEqual(get_meeting_recording_sources("microphone"), ["microphone"])
        self.assertEqual(get_meeting_recording_sources("system-audio"), ["system"])
        self.assertEqual(get_meeting_recording_sources("dual"), ["mix"])

    def test_build_meeting_audio_path_uses_source_suffix(self) -> None:
        path = build_meeting_audio_path("/tmp", 1_700_000_000_000, "system")
        self.assertTrue(path.endswith("_meeting_system.m4a"))

    def test_build_meeting_audio_temp_path_uses_wav_suffix(self) -> None:
        path = build_meeting_audio_temp_path("/tmp", 1_700_000_000_000, "system")
        self.assertTrue(path.endswith("_meeting_system.wav"))

    def test_streaming_linear_resampler_preserves_expected_duration_for_44k1_input(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy unavailable in stubbed test environment")
        input_rate = 44_100
        target_rate = 16_000
        duration_seconds = 0.2
        total_samples = int(input_rate * duration_seconds)
        time_axis = np.arange(total_samples, dtype=np.float32) / np.float32(input_rate)
        source = np.sin(2 * np.pi * 440 * time_axis).astype(np.float32)

        resampler = StreamingLinearResampler(input_rate, target_rate)
        outputs = [
            resampler.process(source[:2_205]),
            resampler.process(source[2_205:4_410]),
            resampler.process(source[4_410:6_615]),
            resampler.process(source[6_615:]),
        ]
        combined = np.concatenate([chunk for chunk in outputs if chunk.size > 0]).astype(np.float32, copy=False)

        self.assertEqual(combined.size, int(target_rate * duration_seconds))
        self.assertGreater(float(np.max(np.abs(combined))), 0.1)

    def test_mix_meeting_audio_sources_combines_dual_inputs(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy unavailable in stubbed test environment")
        microphone = np.array([0.4, 0.2, -0.2], dtype=np.float32)
        system = np.array([0.2, -0.2], dtype=np.float32)
        mixed = mix_meeting_audio_sources(microphone, system)
        self.assertTrue(np.allclose(mixed, np.array([0.3, 0.0, -0.1], dtype=np.float32)))

    def test_build_meeting_mix_chunk_preserves_single_source_level(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy unavailable in stubbed test environment")
        mixed, pending_mic, pending_system = build_meeting_mix_chunk(
            np.zeros(0, dtype=np.float32),
            np.zeros(0, dtype=np.float32),
            np.array([0.6, -0.4, 0.2], dtype=np.float32),
            np.zeros(0, dtype=np.float32),
            max_skew_samples=1,
        )
        self.assertTrue(np.allclose(mixed, np.array([0.6, -0.4], dtype=np.float32)))
        self.assertTrue(np.allclose(pending_mic, np.array([0.2], dtype=np.float32)))
        self.assertEqual(pending_system.size, 0)

    def test_build_meeting_mix_chunk_aligns_overlap_and_keeps_remainder(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy unavailable in stubbed test environment")
        mixed, pending_mic, pending_system = build_meeting_mix_chunk(
            np.zeros(0, dtype=np.float32),
            np.zeros(0, dtype=np.float32),
            np.array([0.4, 0.2, -0.2], dtype=np.float32),
            np.array([0.2, -0.2], dtype=np.float32),
            max_skew_samples=4,
        )
        self.assertTrue(np.allclose(mixed, np.array([0.3, 0.0], dtype=np.float32)))
        self.assertTrue(np.allclose(pending_mic, np.array([-0.2], dtype=np.float32)))
        self.assertEqual(pending_system.size, 0)

    def test_dictation_batch_fallback_uses_buffer_length_for_mlx_whisper(self) -> None:
        self.assertTrue(should_attempt_dictation_batch_fallback("whisper-mlx", [], 0.01, 16000))
        self.assertFalse(should_attempt_dictation_batch_fallback("whisper-mlx", [], 0.5, 1000))

    def test_dictation_batch_fallback_uses_input_level_for_streaming_models(self) -> None:
        self.assertTrue(should_attempt_dictation_batch_fallback("sensevoice", [], 0.08, 1000))
        self.assertTrue(should_attempt_dictation_batch_fallback("sensevoice", [], 0.05, 16000))
        self.assertFalse(should_attempt_dictation_batch_fallback("sensevoice", ["hello"], 0.5, 16000))

    def test_sidecar_invocation_uses_script_path_under_python(self) -> None:
        with patch.object(sys, "executable", "/opt/homebrew/bin/python3"):
            command = get_sidecar_invocation_command()
        self.assertEqual(command[0], "/opt/homebrew/bin/python3")
        self.assertTrue(command[1].endswith("sidecar.py"))

    def test_sidecar_invocation_uses_single_binary_when_frozen(self) -> None:
        with patch.object(sys, "executable", "/Applications/BiCaption.app/Contents/Resources/sidecar/sidecar"):
            command = get_sidecar_invocation_command()
        self.assertEqual(command, ["/Applications/BiCaption.app/Contents/Resources/sidecar/sidecar"])

    def test_dictation_state_event_includes_state(self) -> None:
        event = build_dictation_state_event("recording", "Dictation session started")
        self.assertEqual(event["type"], "dictation_state")
        self.assertEqual(event["state"], "recording")
        self.assertEqual(event["detail"], "Dictation session started")

    def test_speaker_fingerprint_round_trip_and_similarity(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy is unavailable in this test environment")
        audio = np.zeros(16000, dtype="float32")
        t = np.arange(8000, dtype="float32") / 16000.0
        audio[4000:12000] = 0.18 * np.sin(2 * np.pi * 220 * t)
        fingerprint = build_speaker_fingerprint(audio)
        self.assertIsNotNone(fingerprint)
        encoded = serialize_speaker_fingerprint(fingerprint or [])
        parsed = parse_speaker_fingerprint(encoded)
        self.assertEqual(parsed, fingerprint)
        similarity = compare_speaker_fingerprints(fingerprint, parsed)
        self.assertGreaterEqual(similarity, 0.99)

    def test_speaker_fingerprint_rejects_too_short_audio(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy is unavailable in this test environment")
        audio = np.array([0.2] * 1000, dtype="float32")
        self.assertIsNone(build_speaker_fingerprint(audio))

    def test_speaker_audio_quality_rejects_silence(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy is unavailable in this test environment")
        audio = np.zeros(16000, dtype="float32")
        quality = assess_speaker_audio(audio)
        self.assertFalse(quality.valid)
        self.assertEqual(quality.speech_ratio, 0.0)

    def test_speaker_audio_quality_rejects_sparse_speech_for_enrollment(self) -> None:
        if not HAS_REAL_NUMPY:
            self.skipTest("numpy is unavailable in this test environment")
        audio = np.zeros(32000, dtype="float32")
        t = np.arange(3200, dtype="float32") / 16000.0
        audio[8000:11200] = 0.12 * np.sin(2 * np.pi * 220 * t)
        quality = assess_speaker_audio(audio, min_speech_ratio=0.5)
        self.assertFalse(quality.valid)
        self.assertLess(quality.speech_ratio, 0.5)

    def test_meeting_match_stats_summary_formats_counts_and_confidence(self) -> None:
        summary = summarize_meeting_match_stats(MeetingSpeakerMatchStats(
            attempted=3,
            verified=2,
            unverified=1,
            skipped_low_quality=4,
            skipped_fingerprint_unavailable=1,
            skipped_no_reference=2,
            confidence_sum=2.1,
            confidence_max=0.91,
        ))
        self.assertIn("attempted=3", summary)
        self.assertIn("verified=2", summary)
        self.assertIn("unverified=1", summary)
        self.assertIn("skipped_low_quality=4", summary)
        self.assertIn("skipped_fingerprint_unavailable=1", summary)
        self.assertIn("skipped_no_reference=2", summary)
        self.assertIn("avg_confidence=0.700", summary)
        self.assertIn("max_confidence=0.910", summary)

    def test_dictation_final_event_normalizes_buffered_text(self) -> None:
        event = build_dictation_final_event("session-1", ["  hello", "world  "], 10, 40)
        self.assertEqual(event["type"], "dictation_final")
        self.assertEqual(event["sessionId"], "session-1")
        self.assertEqual(event["literalTranscript"], "hello world")
        self.assertEqual(event["dictionaryText"], "hello world")
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "disabled")
        self.assertFalse(event["rewriteApplied"])
        self.assertEqual(event["chunkCount"], 1)
        self.assertEqual(event["latencyMs"], 30)

    def test_append_dictation_fragment_merges_short_tail_into_previous_part(self) -> None:
        parts: list[str] = []
        append_dictation_fragment(parts, "I'm a Mira and Amira and I are here today with a great")
        append_dictation_fragment(parts, "great lesson for you")
        self.assertEqual(parts, ["I'm a Mira and Amira and I are here today with a great great lesson for you"])

    def test_append_dictation_fragment_keeps_distinct_long_fragments_separate(self) -> None:
        parts: list[str] = []
        append_dictation_fragment(parts, "And two people are involved the waiter")
        append_dictation_fragment(parts, "I don't wanna say anymore don't say anymore let's just")
        self.assertEqual(parts, [
            "And two people are involved the waiter",
            "I don't wanna say anymore don't say anymore let's just",
        ])

    def test_dictation_final_event_converts_to_traditional_chinese(self) -> None:
        converter = types.SimpleNamespace(convert=lambda text: text.replace("汉", "漢").replace("语", "語"))
        event = build_dictation_final_event(
            "session-2",
            ["汉语", "  输入 "],
            10,
            40,
            convert_s2t=True,
            opencc_s2t=converter,
        )
        self.assertEqual(event["literalTranscript"], "漢語 输入")
        self.assertEqual(event["finalText"], "漢語 输入")

    def test_parse_dictation_dictionary_ignores_invalid_lines(self) -> None:
        entries = parse_dictation_dictionary("""
        # comment
        chat g p t => ChatGPT
        invalid line
        bicaption => BiCaption
        """)
        self.assertEqual(
            [(entry.canonical, entry.error_variants, entry.context_block) for entry in entries],
            [
                ("ChatGPT", ["chat g p t"], []),
                ("BiCaption", ["bicaption"], []),
            ],
        )

    def test_parse_dictation_dictionary_supports_contextual_error_variants(self) -> None:
        entries = parse_dictation_dictionary("""
        Claude <= Cloud, Clod || AI, Anthropic
        """)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].canonical, "Claude")
        self.assertEqual(entries[0].error_variants, ["Cloud", "Clod"])
        self.assertEqual(entries[0].context_block, ["AI", "Anthropic"])

    def test_apply_dictation_dictionary_replaces_known_terms(self) -> None:
        replaced, matched = apply_dictation_dictionary(
            "chat g p t works with bicaption",
            parse_dictation_dictionary("""
            chat g p t => ChatGPT
            bicaption => BiCaption
            """),
        )
        self.assertEqual(replaced, "ChatGPT works with BiCaption")
        self.assertEqual(matched, ["ChatGPT <= chat g p t", "BiCaption <= bicaption"])

    def test_apply_dictation_dictionary_requires_context_for_error_variants(self) -> None:
        replaced, matched = apply_dictation_dictionary(
            "Cloud is better in this AI workflow",
            parse_dictation_dictionary("Claude <= Cloud || AI, Anthropic"),
        )
        self.assertEqual(replaced, "Claude is better in this AI workflow")
        self.assertEqual(matched, ["Claude <= Cloud [context: AI, Anthropic]"])

    def test_apply_dictation_dictionary_skips_contextual_variant_without_context(self) -> None:
        replaced, matched = apply_dictation_dictionary(
            "cloud infrastructure bill is rising",
            parse_dictation_dictionary("Claude <= Cloud || AI, Anthropic"),
        )
        self.assertEqual(replaced, "cloud infrastructure bill is rising")
        self.assertEqual(matched, [])

    def test_apply_dictation_rules_rewrite_removes_fillers_and_duplicates(self) -> None:
        rewritten = apply_dictation_rules_rewrite("um um hello hello 那個 world")
        self.assertEqual(rewritten, "hello world")

    def test_apply_dictation_rules_rewrite_cleans_traditional_chinese_fillers_and_common_stt_typos(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "對，現在來測試繁體中文的斷句，看是不是有變得比較正常了。那這一句話就會稍微長一點。哎，這麼說的話也會有蠻多的罪字的哈"
        )
        self.assertEqual(
            rewritten,
            "對，現在來測試繁體中文的斷句，看是不是有變得比較正常了。那這一句話就會稍微長一點。這麼說的話也會有蠻多的贅字的",
        )

    def test_dictation_final_event_applies_dictionary_and_rules(self) -> None:
        event = build_dictation_final_event(
            "session-3",
            ["um chat g p t", "works works"],
            10,
            80,
            rewrite_mode="rules",
            initial_prompt_text="ChatGPT, OpenAI",
        )
        self.assertEqual(event["literalTranscript"], "um chat g p t works works")
        self.assertEqual(event["dictionaryText"], "um chat g p t works works")
        self.assertEqual(event["finalText"], "chat g p t works")
        self.assertEqual(event["initialPromptText"], "ChatGPT, OpenAI")
        self.assertEqual(event["matchedCorrections"], [])
        self.assertEqual(event["rewriteBackend"], "rules")
        self.assertTrue(event["rewriteApplied"])

    def test_dictation_final_event_adds_lightweight_punctuation_for_polished_output(self) -> None:
        event = build_dictation_final_event(
            "session-3c",
            ["這個 功能 現在 很快 但是 斷句 還 不夠 穩定 我們 今天 先 補 基本 標點"],
            10,
            80,
            rewrite_mode="rules",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertIn("，但是", event["finalText"])
        self.assertFalse(event["finalText"].endswith("。"))

    def test_apply_dictation_rules_rewrite_adds_question_mark_before_turn_connector(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "剛剛是這樣子嗎但是他沒有加上",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "剛剛是這樣子嗎？但是他沒有加上")

    def test_apply_dictation_rules_rewrite_does_not_force_question_mark_after_shi_bu_shi(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "你剛剛是不是內容沒有送出去",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "你剛剛是不是內容沒有送出去")

    def test_apply_dictation_rules_rewrite_adds_clause_comma_after_ba(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "好吧我們等一下就照這樣進行",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "好吧，我們等一下就照這樣進行")

    def test_apply_dictation_rules_rewrite_keeps_standalone_a_with_following_space(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "我剛剛啊後面還沒講完",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "我剛剛啊 後面還沒講完")

    def test_apply_dictation_rules_rewrite_adds_exclamation_after_luo(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "可以嘍我們開始吧",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "可以嘍！我們開始吧")

    def test_apply_dictation_rules_rewrite_adds_comma_before_list_heads(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "第一個我們先確認模型另外一個是確認標點",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "第一個我們先確認模型，另外一個是確認標點")

    def test_apply_dictation_rules_rewrite_rolls_back_sentence_before_subordinate_head(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "這個先保留。的話我們等一下再一起處理",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "這個先保留，的話我們等一下再一起處理")

    def test_apply_dictation_rules_rewrite_rolls_back_sentence_before_example_head(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "我們先看兩個例子。例如第一個是 Claude Code",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(rewritten, "我們先看兩個例子，例如，第一個是 Claude Code")

    def test_dictation_final_event_uses_pause_gap_to_add_sentence_boundary(self) -> None:
        event = build_dictation_final_event(
            "session-pause-1",
            [
                DictationFragment("剛剛是這樣子嗎", 0, 600),
                DictationFragment("但是他沒有加上", 1700, 2400),
            ],
            0,
            2400,
            rewrite_mode="rules",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(event["finalText"], "剛剛是這樣子嗎？但是他沒有加上")

    def test_dictation_final_event_falls_back_to_space_when_pause_boundary_is_ambiguous(self) -> None:
        event = build_dictation_final_event(
            "session-pause-2",
            [
                DictationFragment("Claude Code", 0, 300),
                DictationFragment("Codex", 520, 820),
                DictationFragment("Gemini CLI 這三個是我常用的 AI agent", 1950, 2800),
            ],
            0,
            2800,
            rewrite_mode="rules",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertIn("Claude Code Codex", event["literalTranscript"])
        self.assertIn("Claude Code Codex", event["finalText"])

    def test_dictation_final_event_uses_paragraph_boundary_for_long_pause(self) -> None:
        event = build_dictation_final_event(
            "session-pause-3",
            [
                DictationFragment("好我們先這樣", 0, 400),
                DictationFragment("接下來看第二部分", 2200, 2800),
            ],
            0,
            2800,
            rewrite_mode="rules",
            source_lang="zh-TW",
            output_style="polished",
        )
        self.assertEqual(event["finalText"], "好我們先這樣。接下來看第二部分")

    def test_dictation_final_event_does_not_protect_unmatched_dictionary_terms(self) -> None:
        event = build_dictation_final_event(
            "session-3b",
            ["hello world"],
            10,
            80,
            rewrite_mode="rules-and-local-llm",
        )
        self.assertEqual(event["fallbackReason"], "local_llm_model_missing")

    def test_should_accept_rewrite_only_requires_matched_dictionary_terms(self) -> None:
        accepted, fallback_reason = should_accept_rewrite(
            "CrossThinking Cloud should be formatted",
            "Cross Thinking Claude 應該要格式化",
            1.3,
            ["Cross Thinking Claude"],
        )
        self.assertTrue(accepted)
        self.assertIsNone(fallback_reason)

    def test_dictation_final_event_sets_fallback_reason_for_cloud_mode(self) -> None:
        event = build_dictation_final_event(
            "session-4",
            ["hello world"],
            10,
            80,
            rewrite_mode="rules-and-cloud",
        )
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "cloud-llm")
        self.assertEqual(event["fallbackReason"], "cloud_llm_api_key_missing")

    def test_dictation_final_event_uses_groq_rewrite_when_configured(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self) -> bytes:
                return json.dumps({
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps({
                                    "rewritten_text": "今天先確認語音輸入完成速度是否穩定，再決定要不要啟用潤稿。"
                                }, ensure_ascii=False)
                            }
                        }
                    ]
                }).encode("utf-8")

        with patch.object(sidecar_module.urllib.request, "urlopen", return_value=FakeResponse()):
            event = build_dictation_final_event(
                "session-4b",
                ["今天先確認語音輸入完成速度是否穩定再決定要不要啟用潤稿"],
                10,
                80,
                rewrite_mode="rules-and-cloud",
                source_lang="zh-TW",
                output_style="polished",
                cloud_api_key="gsk_test",
                cloud_model="qwen/qwen3-32b",
            )

        self.assertEqual(event["rewriteBackend"], "cloud-llm")
        self.assertTrue(event["rewriteApplied"])
        self.assertFalse(event["finalText"].endswith("。"))

    def test_dictation_final_event_sets_fallback_reason_for_local_llm_mode(self) -> None:
        event = build_dictation_final_event(
            "session-5",
            ["hello world"],
            10,
            80,
            rewrite_mode="rules-and-local-llm",
        )
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "local-llm")
        self.assertEqual(event["fallbackReason"], "local_llm_model_missing")

    def test_local_llm_prompt_preserves_sayit_style_constraints(self) -> None:
        prompt = build_local_llm_rewrite_prompt(
            literal_transcript="um chat g p t works",
            vocabulary_context="- Claude Code: Anthropic AI coding agent\n- Codex: OpenAI coding agent",
            personal_glossary="Claude Code\nCodex\nGemini CLI",
            proper_noun_correction_enabled=True,
            source_lang="zh",
            output_style="polished",
        )
        self.assertIn("deterministic dictation cleanup engine", prompt)
        self.assertIn("Do not add facts", prompt)
        self.assertIn("Do not expand fragments into complete ideas", prompt)
        self.assertIn("Fix obvious speech-recognition mistakes", prompt)
        self.assertIn("Prefer the most natural and fluent wording", prompt)
        self.assertIn("Claude Code", prompt)
        self.assertIn("Codex", prompt)
        self.assertIn("Personal glossary", prompt)
        self.assertIn("Proper noun correction", prompt)

    @patch.dict("sidecar.os.environ", {"BICAPTION_LOCAL_LLM_PYTHON": "/custom/python"}, clear=False)
    def test_local_llm_python_bin_prefers_env(self) -> None:
        self.assertEqual(get_local_llm_python_bin(), "/custom/python")

    @patch.dict("sidecar.os.environ", {}, clear=True)
    @patch("sidecar.os.path.exists")
    @patch("sidecar.sys.executable", "/Users/test/.venv/bin/python")
    def test_local_llm_python_bin_uses_current_python_when_available(self, exists_mock) -> None:
        exists_mock.return_value = False
        self.assertEqual(get_local_llm_python_bin(), "/Users/test/.venv/bin/python")

    @patch.dict("sidecar.os.environ", {}, clear=True)
    @patch("sidecar.os.path.exists")
    @patch("sidecar.sys.executable", "/Applications/BiCaption.app/Contents/MacOS/bicaption-sidecar")
    def test_local_llm_python_bin_falls_back_to_project_venv(self, exists_mock) -> None:
        exists_mock.side_effect = lambda path: path.endswith(".venv/bin/python")
        self.assertTrue(get_local_llm_python_bin().endswith(".venv/bin/python"))

    def test_local_llm_provider_reports_missing_model(self) -> None:
        provider = LocalLlmRewriteProvider("/tmp/non-existent-rewriter.py")
        result = provider.rewrite("hello", "hello", "zh", "polished", 1.3, [])
        self.assertFalse(result.applied)
        self.assertEqual(result.backend, "local-llm")
        self.assertEqual(result.fallback_reason, "local_llm_model_missing")

    def test_personal_glossary_does_not_force_all_terms_into_every_rewrite(self) -> None:
        class FakeProvider:
            backend = "cloud-llm"

            def rewrite(self, literal_transcript, text, source_lang, output_style, max_expansion_ratio, protected_terms, **kwargs):
                return DictationRewriteResult(
                    text="我常用的三種 Agent 是 Codex、Gemini CLI 和 Claude Code",
                    backend="cloud-llm",
                    applied=True,
                )

        with patch.object(sidecar_module, "get_dictation_rewrite_provider", return_value=FakeProvider()):
            event = build_dictation_final_event(
                "session-6",
                ["我常用的三種 Agent 是 CC Jamila C L I 跟 count"],
                10,
                80,
                rewrite_mode="rules-and-cloud",
                output_style="literal",
                proper_noun_correction_enabled=True,
                personal_glossary="Claude Code\nCodex\nGemini CLI",
                cloud_api_key="test-key",
            )
        self.assertEqual(event["finalText"], "我常用的三種 Agent 是 Codex、Gemini CLI 和 Claude Code")
        self.assertTrue(event["rewriteApplied"])

    def test_local_llm_rewrite_skips_short_polished_text(self) -> None:
        self.assertTrue(should_use_local_llm_rewrite("ChatGPT works", "polished", True, "Claude Code"))
        self.assertTrue(should_use_local_llm_rewrite("今天我們先確認語音輸入完成速度是否穩定，再決定要不要啟用潤稿。", "polished", True, "Claude Code"))
        self.assertTrue(should_use_local_llm_rewrite("今天測試 Claude", "literal", True, "Claude Code"))
        self.assertFalse(should_use_local_llm_rewrite("今天測試", "literal", False, ""))

    def test_local_llm_max_tokens_scales_with_input_length(self) -> None:
        self.assertEqual(get_local_llm_max_tokens("短句"), 48)
        self.assertGreater(get_local_llm_max_tokens("今天我們先確認語音輸入完成速度是否穩定，再決定要不要啟用潤稿。"), 48)
        self.assertLessEqual(get_local_llm_max_tokens("a" * 500), 160)

    @patch.object(LocalLlmRewriteProvider, "_get_or_load_model", side_effect=subprocess.TimeoutExpired(cmd="rewriter", timeout=2.5))
    def test_local_llm_provider_reports_timeout(self, _loader) -> None:
        provider = LocalLlmRewriteProvider("/tmp/rewriter.py")
        result = provider.rewrite(
            "今天我們先確認語音輸入完成速度是否穩定，再決定要不要啟用潤稿。",
            "今天我們先確認語音輸入完成速度是否穩定，再決定要不要啟用潤稿。",
            "zh",
            "polished",
            1.3,
            [],
            local_model="mlx-community/Qwen2.5-3B-Instruct-4bit",
        )
        self.assertFalse(result.applied)
        self.assertEqual(result.fallback_reason, "local_llm_timeout")

    @patch.dict(sys.modules, {
        "mlx_lm": types.SimpleNamespace(
            generate=lambda *args, **kwargs: "ChatGPT works",
        ),
    }, clear=False)
    @patch.object(LocalLlmRewriteProvider, "_get_or_load_model")
    def test_local_llm_provider_accepts_valid_mlx_lm_response(self, load_mock) -> None:
        tokenizer = types.SimpleNamespace(
            apply_chat_template=lambda messages, tokenize=False, add_generation_prompt=True: "prompt",
        )
        load_mock.return_value = (object(), tokenizer)
        provider = LocalLlmRewriteProvider("/tmp/rewriter.py")
        result = provider.rewrite(
            "um chat g p t works",
            "ChatGPT works",
            "zh",
            "polished",
            1.3,
            ["ChatGPT"],
            local_model="mlx-community/Qwen2.5-3B-Instruct-4bit",
        )
        self.assertEqual(result.text, "ChatGPT works")
        self.assertEqual(result.backend, "local-llm")

if __name__ == "__main__":
    unittest.main()
