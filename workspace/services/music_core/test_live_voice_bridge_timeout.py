#!/usr/bin/env python3
"""Regression tests for LIVE's per-request voice bridge timeout boundary."""

import asyncio
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("LIVE.py")
SPEC = importlib.util.spec_from_file_location("live_voice_bridge_timeout_test_module", MODULE_PATH)
LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIVE)


class _FakeResponse:
    status = 200

    async def json(self):
        return {"status": "playing", "title": "mock track", "queued": 0}


class _FakePostContext:
    def __init__(self, timeout, response_delay_seconds=None, force_timeout=False):
        self.timeout = timeout
        self.response_delay_seconds = response_delay_seconds
        self.force_timeout = force_timeout

    async def __aenter__(self):
        if self.force_timeout or (
            self.response_delay_seconds is not None
            and self.timeout.total <= self.response_delay_seconds
        ):
            raise asyncio.TimeoutError()
        return _FakeResponse()

    async def __aexit__(self, exc_type, exc_value, traceback):
        return False


class _FakeSession:
    def __init__(self, response_delay_seconds=None, force_timeout=False):
        self.response_delay_seconds = response_delay_seconds
        self.force_timeout = force_timeout
        self.post_calls = []

    def post(self, url, **kwargs):
        self.post_calls.append({"url": url, **kwargs})
        return _FakePostContext(
            kwargs["timeout"],
            response_delay_seconds=self.response_delay_seconds,
            force_timeout=self.force_timeout,
        )


def _fake_extracted_info():
    return {
        "title": "mock track",
        "stream_url": "https://media.example.invalid/stream?token=not-returned",
        "duration": 12.0,
        "platform": "Mock",
        "thumbnail": None,
        "uploader": "mock uploader",
    }


class VoiceBridgeTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.original_session = LIVE._http_session
        self.original_checked = LIVE._voice_bridge_init_checked
        self.original_extract_info = LIVE._extract_info
        LIVE._voice_bridge_init_checked = {"rana"}

    def tearDown(self):
        LIVE._http_session = self.original_session
        LIVE._voice_bridge_init_checked = self.original_checked
        LIVE._extract_info = self.original_extract_info

    def test_response_after_old_15_second_deadline_before_bridge_deadline_is_not_cut_off(self):
        response_delay_seconds = 17
        session = _FakeSession(response_delay_seconds=response_delay_seconds)
        LIVE._http_session = session

        async def fake_extract_info(url):
            return _fake_extracted_info()

        LIVE._extract_info = fake_extract_info
        result = asyncio.run(
            LIVE.play(
                LIVE.PlayRequest(
                    url="https://example.invalid/mock",
                    guild_id="guild",
                    channel_id="channel",
                    bot_id="rana",
                )
            )
        )

        self.assertEqual(result.status, "queued")
        request_timeout = session.post_calls[0]["timeout"].total
        self.assertGreater(response_delay_seconds, 15)
        self.assertLess(response_delay_seconds, 20)
        self.assertEqual(request_timeout, LIVE.VOICE_BRIDGE_PLAY_TIMEOUT_SECONDS)
        self.assertGreater(request_timeout, 20)

    def test_timeout_returns_nonempty_safe_structured_error(self):
        session = _FakeSession(force_timeout=True)
        LIVE._http_session = session

        async def fake_extract_info(url):
            return _fake_extracted_info()

        LIVE._extract_info = fake_extract_info
        result = asyncio.run(
            LIVE.play(
                LIVE.PlayRequest(
                    url="https://example.invalid/mock",
                    guild_id="guild",
                    channel_id="channel",
                    bot_id="rana",
                )
            )
        )

        self.assertEqual(result.status, "extracted")
        self.assertTrue(result.message)
        self.assertTrue(result.llm_hint)
        self.assertIsNotNone(result.error)
        self.assertEqual(result.error.code, "VOICE_BRIDGE_TIMEOUT")
        self.assertEqual(result.error.stage, "voice_bridge")
        self.assertEqual(result.error.timeout_seconds, LIVE.VOICE_BRIDGE_PLAY_TIMEOUT_SECONDS)
        self.assertIsNone(result.stream_url)
        self.assertNotIn("127.0.0.1", result.message)
        self.assertNotIn("token=", result.message)
        self.assertNotIn("https://", result.llm_hint)


if __name__ == "__main__":
    unittest.main()
