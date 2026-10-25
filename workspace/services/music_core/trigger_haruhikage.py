#!/usr/bin/env python3
"""Direct Haruhikage playback trigger"""

import requests
import json
import time

import pathlib
_ids = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'discord_ids.local.json').read_text(encoding='utf-8-sig'))
guild_id = _ids['guildId']
channel_id = _ids['voiceChannelId']

# MyGO official video
payload = {
    'url': 'https://www.youtube.com/watch?v=YVWIyDg-wgc',
    'guild_id': guild_id,
    'channel_id': channel_id,
    'requester': 'direct_exec'
}

print('[TIMESTAMP] Starting Haruhikage playback test...')
start_time = time.time()

try:
    resp = requests.post('http://127.0.0.1:8080/api/play', json=payload, timeout=60)
    elapsed = time.time() - start_time
    
    print(f'[HTTP] {resp.status_code} ({elapsed:.2f}s)')
    result = resp.json()
    
    if result.get('status') in ('queued', 'extracted'):
        print(f"\n✅ [EXTRACTED] {result.get('title')}")
        print(f"   Platform: {result.get('platform')}")
        print(f"   Duration: {result.get('duration')}s")
        if result.get('message'):
            print(f"   Note: {result['message']}")
    else:
        print(f"\n❌ [{result.get('status', 'error')}]")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        
except Exception as e:
    print(f'❌ [ERROR] {type(e).__name__}: {e}')
