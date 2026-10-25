#!/usr/bin/env python3
"""Final test: Lavalink fallback playback"""
import requests
import json
import time

# Init voice bridge
requests.get('http://127.0.0.1:8081/init', timeout=5)
time.sleep(2)

import pathlib
_ids = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'discord_ids.local.json').read_text(encoding='utf-8-sig'))
guild_id = _ids['guildId']
channel_id = _ids['voiceChannelId']

payload = {
    'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'guild_id': guild_id,
    'channel_id': channel_id,
    'requester': 'fallback_final'
}

print('[EXECUTION] Final Lavalink+Fallback test')
print(f'[GUILD] {guild_id}')
print(f'[CHANNEL] {channel_id}')
print()

t0 = time.time()
resp = requests.post('http://127.0.0.1:8080/api/play', json=payload, timeout=60)
elapsed = time.time() - t0

result = resp.json()
print(f'[HTTP] {resp.status_code} ({elapsed:.2f}s)')
print(f'[STATUS] {result.get("status")}')
print(f'[TITLE] {result.get("title")}')
if result.get('message'):
    print(f'[MESSAGE] {result["message"]}')
print()
print(json.dumps(result, indent=2, ensure_ascii=False))
