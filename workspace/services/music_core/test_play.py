#!/usr/bin/env python3
"""Test script for voice playback chain"""

import requests
import json
import sys

# Test payload with YouTube test URL
payload = {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "guild_id": "123456789012345678",  # Placeholder — will extract actual or use bot's first guild
    "channel_id": "987654321098765432",  # Placeholder
    "requester": "test_harness"
}

print("[TEST] POST /api/play with test YouTube URL...")
print(f"[TEST] Payload: {json.dumps(payload, indent=2)}")

try:
    r = requests.post('http://127.0.0.1:8080/api/play', json=payload, timeout=45)
    print(f"\n[RESPONSE] HTTP {r.status_code}")
    result = r.json()
    print(json.dumps(result, indent=2))
    
    # Check for errors or extraction success
    if result.get("status") == "error":
        print("\n[ERROR] Playback failed — likely missing guild/channel IDs")
        print("Expected: Use valid Discord guild_id and channel_id from your bot's state")
        sys.exit(1)
    elif result.get("status") in ("queued", "extracted"):
        print(f"\n[SUCCESS] {result['status'].upper()}: {result.get('title', 'Unknown')}")
        if result.get("message"):
            print(f"[INFO] {result['message']}")
    
except requests.exceptions.Timeout:
    print("[ERROR] Request timeout — yt-dlp extraction took too long")
except requests.exceptions.ConnectionError as e:
    print(f"[ERROR] Connection failed: {e}")
except Exception as e:
    print(f"[ERROR] {type(e).__name__}: {e}")
    sys.exit(1)
