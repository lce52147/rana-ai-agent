import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAniListVisualIdentity } from './deep_search.js';

function candidates(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    mediaId: 169295,
    characterId: index + 1,
    role: index < 5 ? 'MAIN' : 'SUPPORTING',
    relevanceIndex: index,
    name: `角色${index + 1}`,
    fullName: `Character ${index + 1}`,
    nativeName: `角色${index + 1}`,
    alternativeNames: [],
    work: 'BanG Dream! ensemble fixture',
    imageUrl: `https://example.invalid/${index + 1}.png`,
    url: '',
    description: '',
  }));
}

const fetchReference = async (url) => ({
  image: Buffer.from(`reference:${url}`),
  mimeType: 'image/png',
  url,
});

test('ensemble resolver considers candidates beyond the first four', async () => {
  const calls = [];
  const batchCompare = async ({ candidates: group }) => {
    const ids = group.map((item) => item.metadata.characterId);
    calls.push(ids);
    const finalRound = group.some((item) => Object.hasOwn(item, 'batchConfidence'));
    const wanted = finalRound ? 10 : (ids.includes(10) ? 10 : ids[0]);
    const index = ids.indexOf(wanted);
    const confidence = finalRound ? 0.96 : (wanted === 10 ? 0.94 : (ids[0] === 1 ? 0.78 : 0.82));
    return {
      status: 'ok',
      best_index: index,
      same_character: true,
      confidence,
      evidence: finalRound ? 'tournament winner' : 'batch winner',
    };
  };

  const result = await resolveAniListVisualIdentity({
    image: Buffer.from('target'),
    mimeType: 'image/png',
    candidates: candidates(12),
    batchCompare,
    fetchReference,
    requestId: '',
    deadlineAt: Date.now() + 300_000,
  });

  assert.equal(result.candidateCount, 12);
  assert.equal(result.comparedBatchCount, 3);
  assert.equal(calls.length, 4, 'three candidate batches plus one finalist tournament');
  assert.deepEqual(calls[2], [9, 10, 11, 12]);
  assert.equal(result.resolvedIdentity?.name, '角色10');
  assert.equal(result.resolvedIdentity?.evidence?.[0]?.comparedCandidates, 12);
  assert.equal(result.reason, 'anilist_ensemble_tournament_visual_verified');
});

test('ensemble tournament keeps a stricter final acceptance gate', async () => {
  const batchCompare = async ({ candidates: group }) => {
    const finalRound = group.some((item) => Object.hasOwn(item, 'batchConfidence'));
    return {
      status: 'ok',
      best_index: 0,
      same_character: true,
      confidence: finalRound ? 0.89 : 0.93,
      evidence: 'fixture',
    };
  };

  const result = await resolveAniListVisualIdentity({
    image: Buffer.from('target'),
    mimeType: 'image/png',
    candidates: candidates(8),
    batchCompare,
    fetchReference,
    requestId: '',
    deadlineAt: Date.now() + 300_000,
  });

  assert.equal(result.comparedBatchCount, 2);
  assert.equal(result.resolvedIdentity, null);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.batch.confidence, 0.89);
});

test('single reliable shortlist remains compatible with the previous 0.88 gate', async () => {
  const batchCompare = async ({ candidates: group }) => {
    const containsTarget = group.some((item) => item.metadata.characterId === 7);
    return containsTarget
      ? { status: 'ok', best_index: group.findIndex((item) => item.metadata.characterId === 7), same_character: true, confidence: 0.91, evidence: 'only reliable batch' }
      : { status: 'ok', best_index: -1, same_character: false, confidence: 0.2, evidence: 'none' };
  };

  const result = await resolveAniListVisualIdentity({
    image: Buffer.from('target'),
    mimeType: 'image/png',
    candidates: candidates(12),
    batchCompare,
    fetchReference,
    requestId: '',
    deadlineAt: Date.now() + 300_000,
  });

  assert.equal(result.resolvedIdentity?.name, '角色7');
  assert.equal(result.batch.status, 'single_shortlist');
  assert.equal(result.batch.confidence, 0.91);
});
