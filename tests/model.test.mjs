import assert from 'node:assert/strict';
import test from 'node:test';
import { checkinLevel, dayInZone, mondayOf, offsetDay, summarize, weekBoard } from '../public/model.mjs';

test('calendar dates stay correct across timezones, DST and year boundaries', () => {
  const midnight = new Date('2026-11-09T19:00:00Z');
  assert.equal(dayInZone('Asia/Colombo', midnight), '2026-11-10');
  assert.equal(dayInZone('America/New_York', midnight), '2026-11-09');
  assert.equal(mondayOf('2027-01-03'), '2026-12-28');
  assert.equal(offsetDay('2026-03-08', 1), '2026-03-09');
});

test('streak can still be extended today and ignores private notes and future dates', () => {
  const logs = {
    '2026-11-05': { gym: true },
    '2026-11-06': { gym: true },
    '2026-11-07': { note: 'Rest' },
    '2026-11-08': { gym: true, nutrition: true },
    '2026-11-09': { nutrition: true },
    '2026-11-11': { gym: true },
  };
  assert.deepEqual(summarize(logs, '2026-11-10'), {
    current: 2, best: 2, week: { gym: 0, nutrition: 1, activeDays: 1, checkinDays: 1 },
    checkinStreak: 5, bestCheckinStreak: 5, activeDays: 4, last28: 4,
  });
  const rest = summarize({ ...logs, '2026-11-10': { gym: false, nutrition: false } }, '2026-11-10');
  assert.equal(rest.current, 0);
  assert.equal(rest.checkinStreak, 6);
  assert.equal(rest.week.checkinDays, 2);
  assert.equal(rest.week.activeDays, 1);
  assert.equal(checkinLevel(logs['2026-11-08']), 2);
  assert.equal(checkinLevel(logs['2026-11-08'], 'diet'), 1);
});

test('the weekly track separates rest, missed, open and upcoming days', () => {
  const week = weekBoard({
    '2026-11-09': { gym: true },
    '2026-11-10': { gym: false, nutrition: false },
    '2026-11-12': { gym: true, nutrition: true },
    '2026-11-14': { nutrition: true },
  }, '2026-11-13');
  assert.deepEqual(week.dates, ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.deepEqual(week.marks, ['gym', 'rest', 'missed', 'both', 'open', 'future', 'future']);
});
