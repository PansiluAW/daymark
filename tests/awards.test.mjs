import assert from 'node:assert/strict';
import test from 'node:test';
import { awardRules, awardsFor, offsetDay } from '../public/model.mjs';

const unlocked = (logs, today) => Object.fromEntries(awardsFor(logs, today).filter(a => a.earnedOn).map(a => [a.id, a.earnedOn]));

test('awards only count locked records and include recovery without misreporting gym', () => {
  const logs = {
    '2026-11-09': { gym: false, nutrition: false, note: 'recovery' },
    '2026-11-10': { gym: true, nutrition: false },
    '2026-11-11': { gym: true, nutrition: true },
  };
  const a = unlocked(logs, '2026-11-11');
  assert.equal(a.first, '2026-11-09');
  assert.equal(a.rest1, '2026-11-09');
  assert.equal(a.gym1, '2026-11-10');
  assert.equal(a.food1, '2026-11-11');
  assert.equal(a.double1, '2026-11-11');
  assert.equal(a.gym10, undefined);
  assert.equal(awardsFor(logs, '2026-11-10').find(x => x.id === 'food1').earnedOn, null);
});

test('consecutive check-ins earn 7, 14 and 30 day awards; gaps reset the run', () => {
  const logs = {};
  for(let n=0;n<30;n++) logs[offsetDay('2026-10-01',n)] = n%2
    ? { gym: true, nutrition: true } : { gym: false, nutrition: false };
  const a = unlocked(logs, '2026-10-30');
  assert.equal(a.week, '2026-10-07');
  assert.equal(a.fortnight, '2026-10-14');
  assert.equal(a.month, '2026-10-30');
  assert.equal(a.gym10, '2026-10-20');
  assert.equal(a.food10, '2026-10-20');
  assert.equal(a.double10, '2026-10-20');
  delete logs['2026-10-05'];
  const after = unlocked(logs, '2026-10-30');
  assert.equal(after.week, '2026-10-12');
  assert.equal(after.fortnight, '2026-10-19');
  assert.equal(after.month, undefined);
});

test('future checkins and empty dataset never unlock awards', () => {
  assert.equal(awardsFor({}, '2026-11-15').filter(a=>a.earnedOn).length,0);
  assert.equal(awardsFor({'2026-11-16':{gym:true,nutrition:true}},'2026-11-15').filter(a=>a.earnedOn).length,0);
  assert.equal(new Set(awardRules.map(a=>a.id)).size,awardRules.length);
});
