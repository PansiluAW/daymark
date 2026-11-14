import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleApi } from '../server/api.mjs';
import { openDatabase } from '../server/sqlite.mjs';

const origin = 'https://daymark.example';

function client(db, authOptions) {
  let cookie;
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const request = new Request(origin + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const response = await handleApi(request, { db, ...authOptions });
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json(), setCookie };
  };
}

test('only the server’s current account-local day can be locked, once', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  let now = Date.parse('2026-11-10T18:29:59Z');
  t.mock.method(Date, 'now', () => now);
  const member = client(db, { trustedIdentity: { id: 'daily-lock', name: 'Pat' } });
  const { data } = await member('/api/bootstrap?timeZone=Asia%2FColombo');
  const { user, today, serverTime } = data;
  assert.equal(today, '2026-11-10');
  assert.equal(serverTime, now);
  const path = '/api/checkins/' + today;
  const checkin = { gym: true, nutrition: false, note: 'A private note' };
  const competingCheckin = { gym: false, nutrition: true, note: 'A competing note' };
  const lock = (body = checkin, headers) => ({ method: 'POST', body, headers });

  assert.equal((await member(path, lock(checkin, { 'X-Daymark-User': 'different-account' }))).status, 409);
  assert.equal((await member('/api/checkins/2026-02-30', lock())).status, 400);
  assert.equal((await member('/api/checkins/2026-11-09', lock())).status, 409);
  assert.equal((await member('/api/checkins/2026-11-11', lock())).status, 409);
  assert.equal((await member(path, lock({ gym: true }))).status, 400);
  assert.equal((await member(path, { method: 'PATCH', body: checkin })).status, 405);

  const attempts = await Promise.all([
    member(path, lock(checkin, { 'X-Daymark-User': user.id })),
    member(path, lock(competingCheckin)),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  const saved = attempts.find(result => result.status === 201).data.checkin;
  const rejected = saved.gym ? competingCheckin : checkin;
  assert.deepEqual((await member(path, lock(saved))).data, { date: today, checkin: saved });
  assert.equal((await member(path, lock(rejected))).data.code, 'day_locked');
  assert.deepEqual((await member('/api/bootstrap')).data.checkins[today], saved);

  const delayedBody = new ReadableStream({
    pull(controller) {
      now += 1000;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(saved)));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const atMidnight = await handleApi(new Request(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: delayedBody, duplex: 'half',
  }), { db, trustedIdentity: { id: 'daily-lock', name: 'Pat' } });
  assert.equal(atMidnight.status, 409);
  assert.deepEqual(await atMidnight.json(), {
    error: 'Only today’s check-in is open.', code: 'day_closed', today: '2026-11-11',
  });
  const profile = (timezone) => ({ method: 'PATCH', body: { timezone } });
  assert.equal((await member('/api/profile', profile('Asia/Colombo'))).status, 200);
  assert.equal((await member('/api/profile', profile('UTC'))).status, 409);
  assert.equal((await member('/api/bootstrap?timeZone=UTC')).data.today, '2026-11-11');
  assert.equal((await member(path, lock(saved))).data.code, 'day_closed');
  const next = await member('/api/checkins/2026-11-11', lock({ gym: false, nutrition: false }));
  assert.equal(next.status, 201);
  assert.deepEqual(next.data.checkin, { gym: false, nutrition: false, note: '' });
});

test('circle activity stays within current membership and never includes notes', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  let now = Date.parse('2026-11-10T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const account = (id, name) => client(db, { trustedIdentity: { id, name } });
  const anna = account('external-anna', 'Anna');
  const kai = account('external-kai', 'Kai');
  const lou = account('external-lou', 'Lou');
  const outsider = account('external-other', 'Other');
  const bootstrap = await anna('/api/bootstrap?timeZone=Asia%2FColombo');
  assert.equal(bootstrap.status, 200);
  const { today, user: annaUser } = bootstrap.data;
  const dayPath = '/api/checkins/' + today;
  const post = body => ({ method: 'POST', body });
  const patch = body => ({ method: 'PATCH', body });

  const created = await anna('/api/circles', post({ name: 'Gym Friends' }));
  assert.equal(created.status, 201);
  const path = '/api/circles/' + created.data.circle.id;
  const details = await anna(path);
  assert.equal(details.status, 200);
  assert.equal(details.data.locked, true);
  assert.deepEqual(details.data.members, []);
  assert.deepEqual(details.data.activity, []);
  assert.equal((await outsider(path)).status, 404);
  const join = code => post({ code });
  assert.equal((await kai('/api/circles/join', join(details.data.circle.inviteCode))).status, 200);
  assert.equal((await lou('/api/circles/join', join(details.data.circle.inviteCode))).status, 200);
  const stored = await anna(dayPath, post({ gym: true, nutrition: true, note: 'Private text' }));
  assert.equal(stored.status, 201);

  const beforeLock = await kai(path);
  assert.equal(beforeLock.data.locked, true);
  assert.deepEqual(beforeLock.data.members, []);
  assert.deepEqual(beforeLock.data.activity, []);
  const cheerPath = path + '/activity/' + annaUser.id + '/' + today;
  assert.equal((await outsider(cheerPath, patch({ reacted: true }))).status, 404);
  assert.equal((await kai(cheerPath, patch({ reacted: true }))).status, 423);
  assert.equal((await kai(dayPath, post({ gym: false, nutrition: false }))).status, 201);
  const social = await kai(path);
  assert.equal(social.data.locked, false);
  assert.equal(social.data.members.length, 3);
  assert.equal(social.data.lastRace, null);
  const rest = social.data.members.find(member => member.name === 'Kai');
  assert.deepEqual([rest.submittedToday, rest.gymToday, rest.nutritionToday, rest.activeDays], [true, false, false, 0]);
  assert.equal(social.data.members.find(member => member.name === 'Lou').submittedToday, false);
  assert.equal(social.data.activity[0].gym, true);
  assert.equal(social.data.activity[0].nutrition, true);
  assert.equal(JSON.stringify(social.data).includes('Private text'), false);
  assert.equal(JSON.stringify(social.data).includes('external-anna'), false);
  assert.equal((await kai(path + '/rotate', { method: 'POST' })).status, 403);
  assert.deepEqual((await kai(cheerPath, patch({ reacted: true }))).data, { reacted: true, reactionCount: 1 });
  assert.deepEqual((await kai(cheerPath, patch({ reacted: true }))).data, { reacted: true, reactionCount: 1 });

  now += 86_400_000;
  assert.equal((await kai(path)).data.locked, true);
  assert.equal((await kai(cheerPath, patch({ reacted: false }))).status, 423);

  const rotated = await anna(path + '/rotate', { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.equal((await outsider('/api/circles/join', join(details.data.circle.inviteCode))).status, 404);
  assert.equal((await anna(path + '/membership', { method: 'DELETE' })).status, 409);
  assert.equal((await kai(path + '/membership', { method: 'DELETE' })).status, 200);
  assert.equal((await kai(path)).status, 404);
  assert.equal((await lou(path + '/membership', { method: 'DELETE' })).status, 200);
  assert.equal((await anna(path + '/membership', { method: 'DELETE' })).status, 200);
  assert.equal((await outsider('/api/circles/join', join(rotated.data.inviteCode))).status, 404);
});

test('friends see the same race week across time zones and upcoming marks stay hidden', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  let now = Date.parse('2026-11-08T17:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const account = (id, name) => client(db, { trustedIdentity: { id, name } });
  const host = account('race-host', 'Host');
  const east = account('race-east', 'East');
  const west = account('race-west', 'West');
  const post = body => ({ method: 'POST', body });
  const lock = (who, day, gym, nutrition) => who('/api/checkins/' + day, post({ gym, nutrition }));
  assert.equal((await host('/api/bootstrap?timeZone=Asia/Colombo')).data.today, '2026-11-08');
  const { data: eastProfile } = await east('/api/bootstrap?timeZone=Pacific/Kiritimati');
  assert.equal(eastProfile.today, '2026-11-09');
  assert.equal((await west('/api/bootstrap?timeZone=America/New_York')).data.today, '2026-11-08');
  const { data: created } = await host('/api/circles', post({ name: 'Different clocks' }));
  const path = '/api/circles/' + created.circle.id;
  const { data: covered } = await host(path);
  assert.equal(covered.locked, true);
  assert.deepEqual(covered.members, []);
  assert.equal(covered.boardTimezone, undefined);
  for (const guest of [east, west]) {
    assert.equal((await guest('/api/circles/join', post({ code: covered.circle.inviteCode }))).status, 200);
  }
  assert.equal((await lock(host, '2026-11-08', true, false)).status, 201);
  assert.equal((await lock(east, '2026-11-09', true, true)).status, 201);
  assert.equal((await lock(west, '2026-11-08', false, true)).status, 201);
  const cheer = path + '/activity/' + eastProfile.user.id + '/2026-11-09';
  const cheerEast = () => west(cheer, { method: 'PATCH', body: { reacted: true } });

  const { data: sunday } = await east(path);
  assert.equal(sunday.today, '2026-11-09');
  assert.equal(sunday.boardToday, '2026-11-08');
  assert.equal(sunday.weekStart, '2026-11-02');
  assert.ok(sunday.activity.every(event => event.date <= sunday.boardToday));
  assert.equal(sunday.members.find(member => member.name === 'East').activeDays, 0);
  assert.equal((await cheerEast()).status, 404);

  now = Date.parse('2026-11-08T19:15:00Z');
  const { data: mondayCover } = await host(path);
  assert.equal(mondayCover.locked, true);
  assert.deepEqual(mondayCover.activity, []);
  assert.equal((await lock(host, '2026-11-09', false, false)).status, 201);
  const { data: monday } = await host(path);
  const { data: westView } = await west(path);
  assert.equal(westView.today, '2026-11-08');
  assert.equal(monday.boardToday, '2026-11-09');
  assert.equal(monday.boardTimezone, 'Asia/Colombo');
  assert.deepEqual(monday.weekDates, [
    '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
  ]);
  assert.equal(westView.boardToday, monday.boardToday);
  assert.deepEqual(westView.members, monday.members);
  assert.deepEqual(monday.members.find(member => member.name === 'West').weekMarks, Array(7).fill('future'));
  assert.equal(monday.members.find(member => member.name === 'Host').weekMarks[0], 'rest');
  const leader = monday.members.find(member => member.name === 'East');
  assert.deepEqual([leader.activeDays, leader.gymDays, leader.nutritionDays, leader.weekMarks[0]], [1, 1, 1, 'both']);
  assert.equal((await cheerEast()).status, 200);

  now = Date.parse('2026-11-09T19:15:00Z');
  assert.equal((await lock(host, '2026-11-10', true, false)).status, 201);
  const { data: tuesday } = await host(path);
  assert.deepEqual(tuesday.members.find(member => member.name === 'West').weekMarks.slice(0, 2), ['open', 'future']);
  assert.deepEqual(tuesday.members.find(member => member.name === 'East').weekMarks.slice(0, 2), ['both', 'open']);
});

test('last week’s race settles across time zones and includes only eligible current members', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  let now = Date.parse('2026-11-07T17:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const account = (id, name) => client(db, { trustedIdentity: { id, name } });
  const host = account('results-host', 'Host');
  const west = account('results-west', 'West');
  const rest = account('results-rest', 'Rest');
  const late = account('results-late', 'Late');
  const post = body => ({ method: 'POST', body });
  const lock = (who, day, gym, nutrition, note) => who('/api/checkins/' + day, post({ gym, nutrition, note }));

  const { data: hostProfile } = await host('/api/bootstrap?timeZone=Asia/Colombo');
  const { data: westProfile } = await west('/api/bootstrap?timeZone=America/New_York');
  const { data: restProfile } = await rest('/api/bootstrap');
  await late('/api/bootstrap?timeZone=Asia/Colombo');
  const { data: created } = await host('/api/circles', post({ name: 'Weekend race' }));
  const path = '/api/circles/' + created.circle.id;
  const { data: invite } = await host(path);
  const join = who => who('/api/circles/join', post({ code: invite.circle.inviteCode }));
  assert.equal((await join(west)).status, 200);
  assert.equal((await join(rest)).status, 200);
  assert.equal((await lock(host, '2026-11-07', true, true, 'Private finish note')).status, 201);
  assert.equal((await lock(rest, '2026-11-07', false, false)).status, 201);
  assert.equal((await lock(late, '2026-11-07', true, false)).status, 201);
  now = Date.parse('2026-11-08T17:00:00Z');
  assert.equal((await lock(late, '2026-11-08', true, false)).status, 201);

  // The board is already on Monday, but West’s Sunday remains open.
  now = Date.parse('2026-11-08T19:15:00Z');
  assert.equal((await lock(host, '2026-11-09', false, false)).status, 201);
  const { data: monday } = await host(path);
  assert.equal(monday.boardToday, '2026-11-09');
  assert.equal(monday.lastRace, null);
  assert.equal((await join(late)).status, 200);

  now = Date.parse('2026-11-09T04:59:59Z');
  assert.equal((await lock(west, '2026-11-08', false, true)).status, 201);
  assert.equal((await host(path)).data.lastRace, null);

  now = Date.parse('2026-11-09T05:00:00Z');
  const { data: finish } = await host(path);
  const expected = {
    start: '2026-11-02', end: '2026-11-08', settled: true,
    standings: [
      { id: hostProfile.user.id, name: 'Host', activeDays: 1 },
      { id: westProfile.user.id, name: 'West', activeDays: 1 },
      { id: restProfile.user.id, name: 'Rest', activeDays: 0 },
    ],
  };
  assert.deepEqual(finish.lastRace, expected);
  const { data: lateBeforeCheckin } = await late(path);
  assert.equal(lateBeforeCheckin.locked, true);
  assert.equal(lateBeforeCheckin.lastRace, null);
  assert.equal((await lock(late, '2026-11-09', false, false)).status, 201);
  assert.deepEqual((await late(path)).data.lastRace, expected);

  assert.equal((await west(path + '/membership', { method: 'DELETE' })).status, 200);
  assert.equal((await west(path)).status, 404);
  assert.deepEqual((await host(path)).data.lastRace.standings, expected.standings.filter(member => member.name !== 'West'));
});

test('standalone accounts use expiring, revocable sessions and ignore forged hosted identity', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  const browser = client(db, { standalone: true, trustedIdentity: { id: 'injected' } });
  const another = client(db, { standalone: true });
  assert.equal((await browser('/api/bootstrap')).status, 401);
  const loginDetails = { email: 'pat@example.com', password: 'sample-strong-passphrase' };
  const registered = await browser('/api/auth/register', {
    method: 'POST', body: { ...loginDetails, name: 'Pat', timezone: 'Asia/Colombo' },
  });
  assert.equal(registered.status, 201);
  assert.match(registered.setCookie, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  const first = await browser('/api/bootstrap');
  assert.equal(first.data.user.name, 'Pat');
  assert.equal((await another('/api/bootstrap')).status, 401);
  assert.equal((await browser('/api/profile', {
    method: 'PATCH', body: { gymGoal: 4 }, headers: { Origin: 'https://somewhere.example' },
  })).status, 403);
  assert.equal((await browser('/api/profile', { method: 'PATCH', body: { gymGoal: 4 } })).data.user.gymGoal, 4);
  assert.equal((await another('/api/auth/login', {
    method: 'POST', body: { ...loginDetails, password: 'incorrect-passphrase' },
  })).status, 401);
  assert.equal((await another('/api/auth/login', { method: 'POST', body: loginDetails })).status, 200);
  assert.equal((await another('/api/bootstrap')).data.user.id, first.data.user.id);
  await browser('/api/auth/logout', { method: 'POST' });
  const stale = await browser('/api/bootstrap', { headers: { Cookie: registered.setCookie.split(';')[0] } });
  assert.equal(stale.status, 401);
  assert.equal((await another('/api/bootstrap')).status, 200);
});
