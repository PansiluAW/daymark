import assert from 'node:assert/strict';
import test from 'node:test';
import { raceMatchup } from '../public/race-model.mjs';

function member(id, score, remaining) {
  return {
    id, name: id, activeDays: score,
    weekMarks: [
      ...Array(score).fill('gym'),
      ...Array(7 - score - remaining).fill('rest'),
      ...Array(remaining).fill('future'),
    ],
  };
}

test('auto picks the nearest score ahead and preserves stable order for equal rivals', () => {
  const members = [member('leader', 4, 3), member('next', 3, 3), member('tied next', 3, 3), member('me', 2, 3)];
  const result = raceMatchup({ members, userId: 'me' });
  assert.equal(result.rival.id, 'next');
  assert.equal(result.gap, -1);
  assert.equal(result.tone, 'chasing');
  assert.match(result.detail, /1 to tie, 2 to pass if your rival stays put/);
  assert.equal(raceMatchup({ members, userId: 'me', rivalId: 'missing' }).rival.id, 'next');
  assert.equal(raceMatchup({ members, userId: 'me', rivalId: 'me' }).manual, false);
});

test('a selected friend overrides auto and a leading or tied user sees the strongest rival', () => {
  const members = [member('low', 1, 3), member('high', 4, 3), member('me', 4, 3)];
  const tied = raceMatchup({ members, userId: 'me' });
  assert.equal(tied.rival.id, 'high');
  assert.equal(tied.gap, 0);
  assert.equal(tied.tone, 'tied');

  const manual = raceMatchup({ members, userId: 'me', rivalId: 'low' });
  assert.equal(manual.rival.id, 'low');
  assert.equal(manual.manual, true);
  assert.equal(manual.gap, 3);
  assert.match(manual.detail, /clinch the matchup/);

  const leading = raceMatchup({ members: [member('next', 2, 3), ...members.slice(1)], userId: 'me', rivalId: 'next' });
  assert.equal(leading.tone, 'ahead');
  assert.match(leading.detail, /needs 2 active days to tie/);
});

test('rest and double marks do not inflate score or remaining days', () => {
  const me = {
    id: 'me', name: 'Me', activeDays: 2,
    weekMarks: ['both', 'rest', 'open', 'missed', 'nutrition', 'future', 'future'],
  };
  const { you } = raceMatchup({ members: [me], userId: 'me' });
  assert.deepEqual(you, { id: 'me', name: 'Me', score: 2, remaining: 3, max: 5 });
});

test('Sunday distinguishes a possible tie, an out-of-reach matchup and a clinched matchup', () => {
  const rival = member('friend', 4, 0);
  const me = member('me', 3, 1);
  me.weekMarks[6] = 'open';
  const tiedMax = raceMatchup({ members: [me, rival], userId: 'me' });
  assert.match(tiedMax.detail, /^1 active day to tie\.$/);

  const unreachable = raceMatchup({ members: [member('me', 2, 1), rival], userId: 'me' });
  assert.match(unreachable.detail, /This matchup is out of reach/);

  const clinched = raceMatchup({
    members: [member('me', 4, 0), member('friend', 2, 1), member('other', 7, 0)],
    userId: 'me',
    rivalId: 'friend',
  });
  assert.equal(clinched.tone, 'clinched');
  assert.equal(clinched.title, 'Matchup clinched.');

  const finishedTie = raceMatchup({ members: [member('me', 4, 0), rival], userId: 'me' });
  assert.equal(finishedTie.title, 'You finish level.');
});

test('empty and solo races remain actionable and incomplete week data never claims a clinch', () => {
  assert.equal(raceMatchup({ members: [], userId: 'me' }), null);
  assert.equal(raceMatchup({ members: [member('me', 0, 6)], userId: 'me' }).rival, null);
  assert.equal(raceMatchup({
    members: [member('me', 0, 6), member('friend', 0, 7)], userId: 'me',
  }).title, 'The race is open.');
  const incomplete = raceMatchup({
    members: [{ id: 'me', activeDays: 5 }, { id: 'friend', activeDays: 1 }], userId: 'me',
  });
  assert.equal(incomplete.tone, 'ahead');
});
