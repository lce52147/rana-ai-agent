import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, '').replace(/\//g, path.sep);
const multi = require(path.join(root, 'multi_voice_bridge.js'));
const supervisor = require(path.join(root, 'mygo_voice_bridges.js'));

function tokenFor(userId) {
  return `${Buffer.from(String(userId)).toString('base64url')}.test.signature`;
}

const fakeConfig = {
  channels: {
    discord: {
      accounts: Object.fromEntries(multi.SPECS.map((spec, index) => [
        spec.accountId,
        { token: tokenFor(String(10000000000000000n + BigInt(index))) },
      ])),
    },
  },
};

test('one multi bridge process owns five isolated client workers and ports', () => {
  assert.deepEqual(multi.SPECS.map((spec) => spec.port), [8081, 8082, 8083, 8084, 8085]);
  const configs = multi.SPECS.map((spec) => multi.workerConfig(spec, fakeConfig));
  assert.equal(configs.filter(Boolean).length, 5);
  assert.deepEqual(configs.map((config) => Number(config.BRIDGE_PORT)), [8081, 8082, 8083, 8084, 8085]);
  assert.deepEqual(configs.map((config) => config.MYGO_BOT_ID), ['rana', 'tomori', 'anon', 'soyo', 'taki']);
  assert.equal(new Set(configs.map((config) => config.BOT_USER_ID)).size, 5);
  assert.match(fs.readFileSync(path.join(root, 'voice_bridge.js'), 'utf8'), /workerData/);
  assert.match(fs.readFileSync(path.join(root, 'mygo_voice_bridges.js'), 'utf8'), /multi_voice_bridge\.js/);
});

test('supervisor accepts only matching per-port bot diagnostics', () => {
  for (const spec of multi.SPECS) {
    const expected = `1000000000000000${multi.SPECS.indexOf(spec)}`;
    assert.equal(supervisor.classifyDiagnostics({ discord_bot_id: expected, mygo_bot_id: spec.botId, discord_ready: true }, expected, spec.botId).healthy, true);
    assert.equal(supervisor.classifyDiagnostics({ discord_bot_id: expected, mygo_bot_id: 'wrong', discord_ready: true }, expected, spec.botId).healthy, false);
  }
});
