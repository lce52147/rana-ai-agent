import test from 'node:test';
import assert from 'node:assert/strict';
import { demoteUncorroboratedTournamentIdentity } from './evidence.js';

function tournamentResult(name, work) {
  return {
    status: 'resolved',
    reason: 'anilist_ensemble_tournament_visual_verified',
    resolvedIdentity: {
      name,
      work,
      scope: 'external',
      confidence: 'high',
      evidence: [{ reason: 'trace_work_anilist_ensemble_tournament_visual_match' }],
    },
  };
}

test('tournament-only name for a catalog character is demoted to a hint', () => {
  const result = tournamentResult('高松燈', 'BanG Dream! It\'s MyGO!!!!!');
  demoteUncorroboratedTournamentIdentity(result, { primaryCharacter: null });
  assert.equal(result.resolvedIdentity, null);
  assert.equal(result.unverifiedIdentity?.name, '高松燈');
  assert.equal(result.reason, 'anilist_tournament_uncorroborated_catalog_character');
});

test('tournament name that disagrees with the local identity is demoted', () => {
  const result = tournamentResult('高松燈', 'BanG Dream! Ave Mujica');
  demoteUncorroboratedTournamentIdentity(result, { primaryCharacter: { canonicalId: 'sakiko' } });
  assert.equal(result.resolvedIdentity, null);
});

test('tournament name that agrees with the local identity is kept', () => {
  const result = tournamentResult('高松燈', 'BanG Dream! It\'s MyGO!!!!!');
  demoteUncorroboratedTournamentIdentity(result, { primaryCharacter: { canonicalId: 'tomori' } });
  assert.equal(result.resolvedIdentity?.name, '高松燈');
});

test('tournament name for a work outside the catalog is kept', () => {
  const result = tournamentResult('角色10', 'Some Other Work');
  demoteUncorroboratedTournamentIdentity(result, { primaryCharacter: null });
  assert.equal(result.resolvedIdentity?.name, '角色10');
  assert.equal(result.unverifiedIdentity, undefined);
});
