import asyncio
import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("LIVE.py")
SPEC = importlib.util.spec_from_file_location("live_identity_test_module", MODULE_PATH)
LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIVE)


EXPECTED = {
    "rana": "http://127.0.0.1:8081",
    "tomori": "http://127.0.0.1:8082",
    "anon": "http://127.0.0.1:8083",
    "soyo": "http://127.0.0.1:8084",
    "taki": "http://127.0.0.1:8085",
}


def test_known_routes():
    for bot_id, base_url in EXPECTED.items():
        assert LIVE._normalize_voice_bot_id(bot_id) == bot_id
        assert LIVE.voice_bridge_for(bot_id) == base_url

    assert LIVE.voice_bridge_for("default") == EXPECTED["rana"]
    assert LIVE.voice_bridge_for("main") == EXPECTED["rana"]


def test_missing_unknown_routes_fail_closed():
    for bot_id in (None, "", "unknown", "rana-not-real"):
        assert LIVE._normalize_voice_bot_id(bot_id) is None
        assert LIVE.voice_bridge_for(bot_id) is None

    assert LIVE.PlayRequest(url="https://example.invalid/a", guild_id="g").bot_id is None

    anon = LIVE.PlayRequest(url="https://example.invalid/a", guild_id="g", bot_id="anon")
    taki = LIVE.PlayRequest(url="https://example.invalid/a", guild_id="g", bot_id="taki")
    assert anon.persona_id is None
    assert anon.account_id is None
    assert LIVE._voice_identity_metadata(anon, "anon") == {"persona_id": "anon", "account_id": "anon"}
    assert LIVE._voice_identity_metadata(taki, "taki") == {"persona_id": "taki", "account_id": "taki"}


def test_active_play_boundary_returns_structured_error_without_extraction():
    result = asyncio.run(
        LIVE.play(
            LIVE.PlayRequest(
                url="https://example.invalid/a",
                guild_id="g",
                bot_id="unknown",
            )
        )
    )
    assert result.status == "error"
    assert result.llm_hint == "missing or unknown bot identity"
