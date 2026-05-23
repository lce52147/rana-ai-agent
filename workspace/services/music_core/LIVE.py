"""
LIVE.py — Rana Music Core Service v1.1
=======================================
FastAPI persistent background service.
Handles yt-dlp extraction + Lavalink REST API v4 control.
Zero VRAM usage. CPU + System RAM only.

Lavalink.jar location: C:\\Users\\Administrator\\.openclaw\\Lavalink.jar
Lavalink port:         2333 (standard)
LIVE.py port:          8080
Python:                D:\\Users\\Administrator\\miniconda3\\python.exe (3.11)

Architecture:
  Discord (text) → OpenClaw tool call → POST /api/play
  POST /api/play → yt-dlp extract (thread pool) → Lavalink REST → Discord (voice)

Run: D:\\Users\\Administrator\\miniconda3\\python.exe -m uvicorn LIVE:app --host 127.0.0.1 --port 8080
"""

import asyncio
import logging
import os
import re
import secrets
import time
import traceback
from contextlib import asynccontextmanager
from typing import Optional

import aiohttp
import yt_dlp
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, field_validator

# ─────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("LIVE")

# ─────────────────────────────────────────────────────────────
# Config — Lavalink standard port 2333
# ─────────────────────────────────────────────────────────────
LAVALINK_HOST  = os.getenv("LAVALINK_HOST", "http://127.0.0.1:2333")
LAVALINK_PASS  = os.getenv("LAVALINK_PASS", "youshallnotpass")
DISCORD_BOT_ID = os.getenv("DISCORD_BOT_ID", "")
VOICE_BRIDGE   = os.getenv("VOICE_BRIDGE", "http://127.0.0.1:8081")
LIVE_VERSION   = "1.2.0"
MEDIA_PROXY_BASE = os.getenv("MEDIA_PROXY_BASE", "http://127.0.0.1:8080")
MEDIA_PROXY_TTL_SECONDS = int(os.getenv("MEDIA_PROXY_TTL_SECONDS", "7200"))

# ─────────────────────────────────────────────────────────────
# yt-dlp Options — extraction only, no disk I/O
# Platform support: YouTube, Bilibili, Threads, Instagram, Facebook
# ─────────────────────────────────────────────────────────────
_COOKIE_FILE = os.path.join(os.path.dirname(__file__), "cookies.txt")

YTDLP_OPTS: dict = {
    "format":         "bestaudio[ext=webm]/bestaudio/best",
    "noplaylist":     True,
    "quiet":          True,
    "no_warnings":    True,
    "extract_flat":   False,
    "socket_timeout": 20,
    "retries":        3,
    "fragment_retries": 3,
    "js_runtimes": {"node": {}},
    "http_headers": {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
}

PLAYLIST_LIMIT = int(os.getenv("PLAYLIST_LIMIT", "25"))

# Inject cookie file if present (needed for Bilibili login-gated content)
if os.path.isfile(_COOKIE_FILE):
    YTDLP_OPTS["cookiefile"] = _COOKIE_FILE
    log.info("cookies.txt found — authenticated extraction enabled.")

# ─────────────────────────────────────────────────────────────
# Shared HTTP session
# ─────────────────────────────────────────────────────────────
_http_session: Optional[aiohttp.ClientSession] = None
_voice_bridge_init_checked: bool = False
_media_proxy: dict[str, dict] = {}


async def ensure_voice_bridge_ready():
    """
    Lazy-init voice_bridge on first /api/play call.
    Idempotent: safe to call multiple times.
    """
    global _voice_bridge_init_checked
    if _voice_bridge_init_checked:
        return  # Already attempted
    
    _voice_bridge_init_checked = True
    try:
        async with _http_session.get(f"{VOICE_BRIDGE}/init", timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status in (200, 202):
                log.info("voice_bridge initialized successfully")
                # Give it 2-3 seconds to finish ready event if status=202
                if resp.status == 202:
                    await asyncio.sleep(3)
            else:
                log.warning("voice_bridge /init returned %s, proceeding anyway", resp.status)
    except aiohttp.ClientConnectorError:
        log.warning("voice_bridge not reachable yet, will retry on first play")
        _voice_bridge_init_checked = False  # Allow retry
    except Exception as e:
        log.warning("voice_bridge init check failed: %s, proceeding anyway", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_session
    _http_session = aiohttp.ClientSession(
        headers={
            "Authorization": LAVALINK_PASS,
            "Content-Type":  "application/json",
        },
        timeout=aiohttp.ClientTimeout(total=15),
    )
    log.info("LIVE.py v%s started | Lavalink → %s | Port 8080", LIVE_VERSION, LAVALINK_HOST)
    yield
    await _http_session.close()
    log.info("LIVE.py shutdown.")


app = FastAPI(
    title="Rana LIVE Music Service",
    version=LIVE_VERSION,
    description="yt-dlp + Lavalink v4 bridge for Rana Discord bot. Zero VRAM.",
    lifespan=lifespan,
)


def _is_bilibili_media_url(url: str) -> bool:
    lowered = (url or "").lower()
    return "bilivideo.com" in lowered or "akamaized.net/upgcxcode" in lowered or "/upgcxcode/" in lowered


def _media_headers(headers: Optional[dict], source_url: str) -> dict:
    merged = dict(YTDLP_OPTS.get("http_headers") or {})
    merged.update(headers or {})
    if _is_bilibili_media_url(source_url):
        merged.setdefault("Referer", "https://www.bilibili.com/")
        merged.setdefault("Origin", "https://www.bilibili.com")
        merged.setdefault("Accept", "*/*")
    merged.pop("Accept-Encoding", None)
    merged.pop("Host", None)
    return merged


def _cleanup_media_proxy() -> None:
    now = time.time()
    expired = [token for token, entry in _media_proxy.items() if entry.get("expires_at", 0) < now]
    for token in expired:
        _media_proxy.pop(token, None)


def _register_media_proxy(stream_url: str, headers: Optional[dict]) -> str:
    _cleanup_media_proxy()
    token = secrets.token_urlsafe(18)
    _media_proxy[token] = {
        "url": stream_url,
        "headers": _media_headers(headers, stream_url),
        "expires_at": time.time() + MEDIA_PROXY_TTL_SECONDS,
    }
    return f"{MEDIA_PROXY_BASE.rstrip('/')}/media-proxy/{token}"


def _prepare_stream_for_lavalink(info: dict) -> dict:
    stream_url = info.get("stream_url") or ""
    platform = (info.get("platform") or "").lower()
    if stream_url and (_is_bilibili_media_url(stream_url) or "bili" in platform):
        info["direct_stream_url"] = stream_url
        info["stream_url"] = _register_media_proxy(stream_url, info.get("stream_headers"))
        log.info("[media-proxy] Bilibili stream proxied for '%s'", info.get("title", "Unknown"))
    return info


@app.api_route("/media-proxy/{token}", methods=["GET", "HEAD"])
async def media_proxy(token: str, request: Request):
    entry = _media_proxy.get(token)
    if not entry or entry.get("expires_at", 0) < time.time():
        _media_proxy.pop(token, None)
        return JSONResponse(status_code=404, content={"error": "media proxy expired"})

    headers = dict(entry["headers"])
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]

    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=30))
    try:
        remote = await session.request(
            "GET",
            entry["url"],
            headers=headers,
            allow_redirects=True,
        )
    except Exception as exc:
        await session.close()
        return JSONResponse(status_code=502, content={"error": f"media proxy fetch failed: {exc}"})

    response_headers = {}
    for key in ("Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "Last-Modified", "ETag"):
        if remote.headers.get(key):
            response_headers[key] = remote.headers[key]
    content_type = remote.headers.get("Content-Type") or "audio/mp4"
    response_headers["Content-Type"] = content_type

    if request.method == "HEAD":
        remote.release()
        await session.close()
        return Response(status_code=remote.status, headers=response_headers)

    if remote.status >= 400:
        text = await remote.text()
        remote.release()
        await session.close()
        return JSONResponse(status_code=remote.status, content={"error": text[:300] or f"HTTP {remote.status}"})

    async def body_iter():
        try:
            async for chunk in remote.content.iter_chunked(64 * 1024):
                yield chunk
        finally:
            remote.release()
            await session.close()

    return StreamingResponse(body_iter(), status_code=remote.status, headers=response_headers, media_type=content_type)


# ─────────────────────────────────────────────────────────────
# Global Exception Handler — propagates structured errors to LLM
# ─────────────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """
    Catches ALL unhandled exceptions and formats them as structured JSON
    so OpenClaw's LLM can generate a Rana-style error response.
    """
    error_type = type(exc).__name__
    error_msg  = str(exc)
    log.error("Unhandled %s: %s\n%s", error_type, error_msg, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={
            "status":    "error",
            "error_type": error_type,
            "message":   error_msg,
            # This field is read by OpenClaw to generate Rana's reply
            "llm_hint":  f"Extraction or playback failed: {error_type} — {error_msg}",
        },
    )


# ─────────────────────────────────────────────────────────────
# Request / Response Models
# ─────────────────────────────────────────────────────────────
class PlayRequest(BaseModel):
    url:        str
    guild_id:   str
    channel_id: Optional[str] = None
    requester_id: Optional[str] = None
    requester:  Optional[str] = "unknown"
    # Optional voice state — provided by the Discord bot's VOICE_SERVER_UPDATE event
    voice_token:    Optional[str] = None
    voice_endpoint: Optional[str] = None
    voice_session:  Optional[str] = None

    @field_validator("url")
    @classmethod
    def url_must_not_be_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("url cannot be empty.")
        return v.strip()


class PlayResponse(BaseModel):
    status:     str   # "queued" | "extracted" | "error"
    title:      Optional[str] = None
    stream_url: Optional[str] = None
    duration:   Optional[float] = None
    platform:   Optional[str] = None
    thumbnail:  Optional[str] = None
    uploader:   Optional[str] = None
    playlist_count: Optional[int] = None
    queued_count: Optional[int] = None
    message:    Optional[str] = None
    # Surfaced to OpenClaw for Rana-character error replies
    llm_hint:   Optional[str] = None


class StatusResponse(BaseModel):
    service:   str
    lavalink:  str
    version:   str
    lavalink_version: Optional[str] = None


# ─────────────────────────────────────────────────────────────
# Helper: yt-dlp extraction
# Uses asyncio.get_running_loop() (Python 3.10+ safe)
# Propagates structured errors to LLM via llm_hint field
# ─────────────────────────────────────────────────────────────
async def _extract_info(url: str) -> dict:
    loop = asyncio.get_running_loop()

    def _sync_extract() -> dict:
        source_url = url
        with yt_dlp.YoutubeDL(YTDLP_OPTS) as ydl:
            if url.startswith("ytsearch"):
                search_opts = {
                    **YTDLP_OPTS,
                    "extract_flat": "in_playlist",
                    "playlistend": 5,
                }
                with yt_dlp.YoutubeDL(search_opts) as search_ydl:
                    search_info = search_ydl.extract_info(url, download=False)
                entries = search_info.get("entries") if search_info else None
                first = next((entry for entry in entries or [] if entry and entry.get("_type") != "playlist"), None)
                if not first:
                    raise ValueError("yt-dlp search returned no playable result.")
                source_url = first.get("webpage_url") or first.get("url") or first.get("id")
                if source_url and not re.match(r"^https?://", source_url):
                    source_url = f"https://www.youtube.com/watch?v={source_url}"

            info = ydl.extract_info(source_url, download=False)
            if not info:
                raise ValueError("yt-dlp returned no info for this URL.")
            if info.get("_type") in ("playlist", "multi_video") and info.get("entries"):
                first = next((entry for entry in info["entries"] if entry), None)
                if not first:
                    raise ValueError("yt-dlp search returned no playable result.")
                info = first

            # Best audio stream URL
            stream_url = info.get("url")
            selected_format = None
            if not stream_url and info.get("formats"):
                # Walk formats in reverse (best quality last) and grab first with url
                for fmt in reversed(info["formats"]):
                    if fmt.get("url") and fmt.get("vcodec") == "none":
                        stream_url = fmt["url"]
                        selected_format = fmt
                        break
                if not stream_url:
                    selected_format = info["formats"][-1]
                    stream_url = selected_format.get("url", "")

            stream_headers = {}
            stream_headers.update(info.get("http_headers") or {})
            if selected_format:
                stream_headers.update(selected_format.get("http_headers") or {})

            return {
                "title":      info.get("title", "Unknown"),
                "stream_url": stream_url,
                "stream_headers": stream_headers,
                "duration":   info.get("duration"),
                "platform":   info.get("extractor_key", "unknown"),
                "thumbnail":  info.get("thumbnail"),
                "uploader":   info.get("uploader") or info.get("channel"),
            }

    try:
        return _prepare_stream_for_lavalink(await loop.run_in_executor(None, _sync_extract))

    except yt_dlp.utils.DownloadError as e:
        raw = re.sub(r'\x1b\[[0-9;]*m', '', str(e))   # strip ANSI color codes
        log.error("[yt-dlp] DownloadError for %s: %s", url, raw)
        # Classify common failures for better LLM hints
        if "Sign in" in raw or "login" in raw.lower():
            hint = "This content requires login. Add cookies.txt to enable authenticated extraction."
        elif "Private" in raw or "private" in raw:
            hint = "This content is private and cannot be played."
        elif "unavailable" in raw.lower():
            hint = "That video is unavailable. Might be deleted or region-locked."
        elif "not available" in raw.lower() or "geo-restricted" in raw.lower() or "deleted" in raw.lower():
            hint = "That content is region-locked or has been deleted. Nothing I can do."
        elif "Unsupported URL" in raw:
            hint = f"Platform not supported by yt-dlp: {url}"
        elif "getaddrinfo failed" in raw or "Unable to download webpage" in raw:
            hint = "Can't reach that URL. Either the site is down or the link is broken."
        else:
            # Trim raw error to first sentence / 120 chars max
            first_line = raw.split("\n")[0].replace("ERROR: ", "").strip()
            hint = first_line[:120] if len(first_line) > 120 else first_line
        return {"error": True, "llm_hint": hint, "raw_error": raw}

    except Exception as e:
        log.error("[yt-dlp] Unexpected error for %s: %s", url, e)
        return {"error": True, "llm_hint": f"Unexpected extraction error: {e}", "raw_error": str(e)}


def _looks_like_playlist(url: str) -> bool:
    return "list=" in url or "/playlist?" in url


async def _extract_playlist(url: str, limit: int = PLAYLIST_LIMIT) -> dict:
    loop = asyncio.get_running_loop()

    def _sync_playlist() -> dict:
        opts = {
            **YTDLP_OPTS,
            "noplaylist": False,
            "extract_flat": "in_playlist",
            "playlistend": limit,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        entries = info.get("entries") if info else None
        urls = []
        for entry in entries or []:
            if not entry or entry.get("_type") == "playlist":
                continue
            item_url = entry.get("webpage_url") or entry.get("url") or entry.get("id")
            if item_url and not re.match(r"^https?://", item_url):
                item_url = f"https://www.youtube.com/watch?v={item_url}"
            if item_url:
                urls.append(item_url)
        return {
            "title": info.get("title", "Playlist") if info else "Playlist",
            "urls": urls[:limit],
        }

    try:
        playlist = await loop.run_in_executor(None, _sync_playlist)
        tracks = []
        for item_url in playlist["urls"]:
            info = await _extract_info(item_url)
            if not info.get("error") and info.get("stream_url"):
                tracks.append(info)
        if not tracks:
            return {"error": True, "llm_hint": "Playlist had no playable tracks.", "raw_error": "empty playlist"}
        return {
            "playlist": True,
            "title": playlist["title"],
            "tracks": tracks,
        }
    except Exception as e:
        log.error("[playlist] Unexpected error for %s: %s", url, e)
        return {"error": True, "llm_hint": f"Playlist extraction failed: {e}", "raw_error": str(e)}


# ─────────────────────────────────────────────────────────────
# Helper: Lavalink v4 REST — load track by identifier (URL)
# ─────────────────────────────────────────────────────────────
async def _lavalink_load_track(stream_url: str) -> Optional[dict]:
    """
    Load a track into Lavalink using /v4/loadtracks.
    Returns the encoded track string on success, None on failure.
    """
    try:
        params = {"identifier": stream_url}
        async with _http_session.get(
            f"{LAVALINK_HOST}/v4/loadtracks", params=params
        ) as resp:
            if resp.status != 200:
                log.warning("Lavalink /v4/loadtracks returned %s", resp.status)
                return None
            data = await resp.json()
            load_type = data.get("loadType")
            if load_type in ("track", "TRACK_LOADED"):
                return data.get("data") or (data.get("tracks") or [None])[0]
            log.warning("Unexpected loadType from Lavalink: %s", load_type)
            return None
    except aiohttp.ClientConnectorError:
        log.error("Cannot reach Lavalink at %s", LAVALINK_HOST)
        return None
    except Exception as e:
        log.error("Lavalink loadtracks error: %s", e)
        return None


async def _lavalink_play(
    guild_id: str,
    channel_id: str,
    stream_url: str,
    encoded_track: Optional[str] = None,
    voice_token: Optional[str] = None,
    voice_endpoint: Optional[str] = None,
    voice_session: Optional[str] = None,
) -> dict:
    """
    Create/update a Lavalink player and start playback.
    Returns {"success": bool, "message": str}
    """
    session_id = voice_session or f"rana-{guild_id}"
    player_url  = f"{LAVALINK_HOST}/v4/sessions/{session_id}/players/{guild_id}"

    body: dict = {"noReplace": False}

    # Attach voice state if Discord bot has forwarded it
    if voice_token and voice_endpoint:
        body["voice"] = {
            "token":     voice_token,
            "endpoint":  voice_endpoint,
            "sessionId": session_id,
        }

    # Prefer Lavalink-encoded track; fallback to raw stream URL as identifier
    if encoded_track:
        body["track"] = {"encoded": encoded_track}
    else:
        body["track"] = {"userData": {"identifier": stream_url}}

    try:
        async with _http_session.patch(
            player_url, json=body, params={"noReplace": "false"}
        ) as resp:
            if resp.status in (200, 204):
                return {"success": True, "message": "Queued."}
            err_body = await resp.text()
            log.warning("Lavalink PATCH returned %s: %s", resp.status, err_body)
            return {"success": False, "message": f"Lavalink error {resp.status}: {err_body}"}
    except aiohttp.ClientConnectorError:
        return {
            "success": False,
            "message": f"Cannot connect to Lavalink at {LAVALINK_HOST}. Is Lavalink.jar running?",
        }
    except Exception as e:
        return {"success": False, "message": str(e)}


# ─────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────
@app.get("/health", response_model=StatusResponse)
async def health_check():
    """Liveness probe. Returns Lavalink status + version."""
    lavalink_ok      = False
    lavalink_version = None
    try:
        async with _http_session.get(f"{LAVALINK_HOST}/v4/info") as resp:
            if resp.status == 200:
                lavalink_ok = True
                info = await resp.json()
                lavalink_version = info.get("version", {}).get("semver")
    except Exception:
        pass

    return StatusResponse(
        service          = "online",
        lavalink         = "online" if lavalink_ok else "offline",
        version          = LIVE_VERSION,
        lavalink_version = lavalink_version,
    )


@app.post("/api/play", response_model=PlayResponse)
async def play(req: PlayRequest):
    """
    Main IPC endpoint called by OpenClaw tool bridge.
    Flow: yt-dlp extract → Lavalink loadtracks → Lavalink player PATCH
    All errors include llm_hint for Rana character response generation.
    """
    log.info(
        "[PLAY] guild=%s channel=%s url=%s requester=%s",
        req.guild_id, req.channel_id, req.url, req.requester,
    )

    # Ensure voice_bridge is initialized (on-demand, idempotent)
    await ensure_voice_bridge_ready()

    # ── Step 1: yt-dlp extraction ──────────────────────────
    info = await _extract_playlist(req.url) if _looks_like_playlist(req.url) else await _extract_info(req.url)

    if info.get("error"):
        return PlayResponse(
            status   = "error",
            message  = info.get("raw_error"),
            llm_hint = info.get("llm_hint"),
        )

    if info.get("playlist"):
        log.info("[PLAYLIST] '%s' | tracks=%s", info["title"], len(info["tracks"]))
    else:
        log.info("[EXTRACTED] '%s' | platform=%s | duration=%ss",
                 info["title"], info["platform"], info.get("duration"))

    # ── Step 2: Route through voice_bridge for VC join + Lavalink playback ──
    try:
        payload = {
            "guild_id":   req.guild_id,
            "channel_id": req.channel_id,
            "requester_id": req.requester_id,
        }
        if info.get("playlist"):
            payload["tracks"] = [
                {
                    "stream_url": track["stream_url"],
                    "title": track["title"],
                    "requester_id": req.requester_id,
                    "channel_id": req.channel_id,
                }
                for track in info["tracks"]
            ]
        else:
            payload.update({
                "stream_url": info["stream_url"],
                "title":      info["title"],
            })

        async with _http_session.post(
            f"{VOICE_BRIDGE}/voice/play",
            json=payload,
            headers={"Content-Type": "application/json", "Authorization": ""},
        ) as resp:
            bridge_body = await resp.json()
            bridge_status = bridge_body.get("status", "")

            if resp.status == 200 and bridge_status in ("playing", "queued"):
                log.info("[%s] '%s' via voice_bridge", bridge_status.upper(), bridge_body.get("title", info["title"]))
                playlist_count = len(info["tracks"]) if info.get("playlist") else None
                queued_count = bridge_body.get("queued")
                return PlayResponse(
                    status    = "queued",
                    title     = bridge_body.get("title", info["title"]),
                    duration  = None if info.get("playlist") else info.get("duration"),
                    platform  = "Playlist" if info.get("playlist") else info.get("platform"),
                    thumbnail = None if info.get("playlist") else info.get("thumbnail"),
                    uploader  = None if info.get("playlist") else info.get("uploader"),
                    playlist_count = playlist_count,
                    queued_count = queued_count,
                    llm_hint  = (
                        f"Playlist queued: {playlist_count} tracks. Queue size: {queued_count}."
                        if info.get("playlist")
                        else (
                            f"Queued: {info['title']} (queue size: {queued_count})"
                            if bridge_status == "queued"
                            else f"Now playing: {info['title']} ({info.get('platform', 'unknown')})"
                        )
                    ),
                )
            else:
                # voice_bridge returned an error
                err_msg = bridge_body.get("message", str(bridge_body))
                log.warning("[VOICE_BRIDGE] Error: %s", err_msg)
                return PlayResponse(
                    status     = "extracted",
                    title      = info["title"],
                    stream_url = None if info.get("playlist") else info["stream_url"],
                    duration   = info.get("duration"),
                    platform   = info.get("platform"),
                    thumbnail  = info.get("thumbnail"),
                    uploader   = info.get("uploader"),
                    message    = err_msg,
                    llm_hint   = f"Extracted but voice bridge error: {err_msg}",
                )

    except aiohttp.ClientConnectorError:
        log.warning("[VOICE_BRIDGE] Offline — returning extracted info without playback")
        return PlayResponse(
            status     = "extracted",
            title      = info["title"],
            stream_url = None if info.get("playlist") else info["stream_url"],
            duration   = info.get("duration"),
            platform   = "Playlist" if info.get("playlist") else info.get("platform"),
            thumbnail  = None if info.get("playlist") else info.get("thumbnail"),
            uploader   = None if info.get("playlist") else info.get("uploader"),
            message    = "Voice bridge offline. Start voice_bridge.js.",
            llm_hint   = (
                "Audio extracted but voice bridge is offline. "
                "Start voice_bridge.js to enable voice channel playback."
            ),
        )
    except Exception as e:
        log.error("[VOICE_BRIDGE] Unexpected error: %s", e)
        return PlayResponse(
            status     = "extracted",
            title      = info["title"],
            stream_url = None if info.get("playlist") else info["stream_url"],
            duration   = info.get("duration"),
            platform   = "Playlist" if info.get("playlist") else info.get("platform"),
            thumbnail  = None if info.get("playlist") else info.get("thumbnail"),
            uploader   = None if info.get("playlist") else info.get("uploader"),
            message    = str(e),
            llm_hint   = f"Extraction OK but playback failed: {e}",
        )


@app.post("/api/stop")
async def stop(guild_id: str):
    """Pause playback for a guild. Gracefully degrades when Lavalink is offline."""
    session_id = f"rana-{guild_id}"
    url = f"{LAVALINK_HOST}/v4/sessions/{session_id}/players/{guild_id}"
    try:
        async with _http_session.patch(url, json={"paused": True}) as resp:
            return JSONResponse({"status": "stopped", "guild": guild_id})
    except aiohttp.ClientConnectorError:
        log.warning("[stop] Lavalink offline — returning degraded stop for guild %s", guild_id)
        return JSONResponse({
            "status": "stopped",
            "guild":  guild_id,
            "note":   "Lavalink offline; player state cleared locally.",
        })
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.delete("/api/destroy")
async def destroy(guild_id: str):
    """Destroy Lavalink player and disconnect from voice. Gracefully degrades when Lavalink is offline."""
    session_id = f"rana-{guild_id}"
    url = f"{LAVALINK_HOST}/v4/sessions/{session_id}/players/{guild_id}"
    try:
        async with _http_session.delete(url) as resp:
            return JSONResponse({"status": "destroyed", "guild": guild_id})
    except aiohttp.ClientConnectorError:
        log.warning("[destroy] Lavalink offline — returning degraded destroy for guild %s", guild_id)
        return JSONResponse({
            "status": "destroyed",
            "guild":  guild_id,
            "note":   "Lavalink offline; nothing to destroy.",
        })
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)
