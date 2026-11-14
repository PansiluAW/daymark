const COOKIE = 'daymark_session';
const DAY_MS = 86_400_000;
const SESSION_AGE = 30 * DAY_MS;
const LOGIN_WINDOW = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_CIRCLES = 16;
const MAX_MEMBERS = 25;
const ACTIVITY_DAYS = 30;
const PASSWORD_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function fail(status, message, extra) {
  throw new ApiError(status, message, extra);
}

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function statement(db, sql, ...params) {
  return db.prepare(sql).bind(...params);
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(length) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(salt.match(/../g), byte => Number.parseInt(byte, 16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

function equalHash(first, second) {
  let difference = first.length ^ second.length;
  for (let i = 0; i < first.length; i++) {
    difference |= first.charCodeAt(i) ^ second.charCodeAt(i);
  }
  return difference === 0;
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 80) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localDate(timezone, timestamp = Date.now()) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day].join('-');
}

function dateOffset(day, offset) {
  const value = new Date(day + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function isDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const value = new Date(day + 'T00:00:00Z');
  return Number.isFinite(value.valueOf()) && value.toISOString().slice(0, 10) === day;
}

function monday(day) {
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  return dateOffset(day, -((weekday + 6) % 7));
}

function streak(days, today, dayOpen) {
  const active = day => {
    const checkin = days.get(day);
    return checkin?.gym || checkin?.nutrition;
  };
  let cursor = dayOpen && !days.has(today) ? dateOffset(today, -1) : today;
  let count = 0;
  while (active(cursor)) {
    count++;
    cursor = dateOffset(cursor, -1);
  }
  return count;
}

function shortName(value, field, length) {
  if (typeof value !== 'string') fail(400, field + ' is required.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || Array.from(name).length > length || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(400, field + ' must be between 1 and ' + length + ' characters.');
  }
  return name;
}

function normalEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    fail(400, 'Enter a valid email address.');
  }
  return email;
}

function readPassword(value, registration) {
  if (typeof value !== 'string' || !value || encoder.encode(value).length > 256) {
    fail(400, 'Enter a password with up to 256 bytes.');
  }
  if (registration && Array.from(value).length < 10) fail(400, 'Choose a password with at least 10 characters.');
  return value;
}

function userView(row) {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    gymGoal: row.gym_goal,
    nutritionGoal: row.nutrition_goal,
  };
}

function checkinView(row) {
  return { gym: !!row.gym, nutrition: !!row.nutrition, note: row.note };
}

function circleView(row) {
  return { id: row.id, name: row.name, role: row.role, memberCount: row.member_count };
}

function cookieHeader(request, token, age) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + secure;
}

function sessionToken(request) {
  const pair = (request.headers.get('Cookie') || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(COOKIE + '='));
  const token = pair?.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

async function sessionCookie(request, db, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await db.batch([
    statement(db, 'DELETE FROM sessions WHERE expires_at <= ?', now),
    statement(db, 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      await sha256(token), userId, now + SESSION_AGE),
  ]);
  return { 'Set-Cookie': cookieHeader(request, token, Math.floor(SESSION_AGE / 1000)) };
}

async function readJson(request) {
  const mediaType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') fail(415, 'Send JSON to this endpoint.');
  if (!request.body) fail(400, 'Provide a JSON object.');
  const stream = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await stream.cancel();
        fail(413, 'This request is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    stream.releaseLock();
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail(400, 'Provide a valid JSON object.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'Provide a JSON object.');
  return result;
}

async function authenticate(request, { db, standalone, trustedIdentity }, url) {
  if (standalone) {
    const token = sessionToken(request);
    if (!token) return null;
    return statement(db, `
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `, await sha256(token), Date.now()).first();
  }
  if (!trustedIdentity?.id) return null;
  const existing = await statement(db, 'SELECT * FROM users WHERE external_id = ?', trustedIdentity.id).first();
  if (existing) return existing;
  const name = Array.from(String(trustedIdentity.name || 'Daymarker')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 32).join('') || 'Daymarker';
  await statement(db, `
    INSERT INTO users (id, external_id, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO NOTHING
  `, crypto.randomUUID(), trustedIdentity.id, name, validTimeZone(url.searchParams.get('timeZone')) || 'UTC', Date.now()).run();
  return statement(db, 'SELECT * FROM users WHERE external_id = ?', trustedIdentity.id).first();
}

async function register(request, db) {
  const input = await readJson(request);
  const name = shortName(input.name, 'Name', 32);
  const email = normalEmail(input.email);
  const password = readPassword(input.password, true);
  const timezone = validTimeZone(input.timezone) || 'UTC';
  const salt = randomHex(16);
  const hash = await passwordHash(password, salt);
  const user = await statement(db, `
    INSERT INTO users (id, email, password_salt, password_hash, name, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id
  `, crypto.randomUUID(), email, salt, hash, name, timezone, Date.now()).first();
  if (!user) fail(409, 'An account already uses this email. Sign in to continue.');
  return reply({ ok: true }, 201, await sessionCookie(request, db, user.id));
}

async function login(request, db, remoteAddress) {
  const input = await readJson(request);
  const email = normalEmail(input.email);
  const password = readPassword(input.password, false);
  const key = await sha256(email + '\n' + (remoteAddress || ''));
  const now = Date.now();
  const windowFloor = now - LOGIN_WINDOW;
  const attempt = await statement(db, `
    INSERT INTO login_attempts (login_key, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(login_key) DO UPDATE SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    WHERE window_start <= ? OR attempts < ?
    RETURNING attempts
  `, key, now, windowFloor, windowFloor, windowFloor, MAX_LOGIN_ATTEMPTS).first();
  if (!attempt) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  const user = await statement(db, 'SELECT * FROM users WHERE email = ?', email).first();
  const candidate = await passwordHash(password, user?.password_salt || '00000000000000000000000000000000');
  if (!user || !equalHash(candidate, user.password_hash)) fail(401, 'Email or password is incorrect.');
  await db.batch([
    statement(db, 'DELETE FROM login_attempts WHERE login_key = ?', key),
    statement(db, 'DELETE FROM login_attempts WHERE window_start <= ?', windowFloor),
  ]);
  return reply({ ok: true }, 200, await sessionCookie(request, db, user.id));
}

async function logout(request, db) {
  const token = sessionToken(request);
  if (token) await statement(db, 'DELETE FROM sessions WHERE token_hash = ?', await sha256(token)).run();
  return reply({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, '', 0) });
}

const CIRCLE_SELECT = `
  SELECT c.id, c.name, c.invite_code, m.role,
    (SELECT COUNT(*) FROM circle_members count_members WHERE count_members.circle_id = c.id) AS member_count
  FROM circle_members m JOIN circles c ON c.id = m.circle_id
`;

async function bootstrap(db, user, standalone) {
  const serverTime = Date.now();
  const today = localDate(user.timezone, serverTime);
  const results = await db.batch([
    statement(db, 'SELECT day, gym, nutrition, note FROM checkins WHERE user_id = ? AND day >= ?',
      user.id, dateOffset(today, -730)),
    statement(db, CIRCLE_SELECT + ' WHERE m.user_id = ? ORDER BY m.joined_at, c.name', user.id),
  ]);
  return reply({
    auth: standalone ? 'password' : 'chatgpt',
    user: userView(user),
    today,
    serverTime,
    checkins: Object.fromEntries(results[0].results.map(row => [row.day, checkinView(row)])),
    circles: results[1].results.map(circleView),
  });
}

async function updateProfile(request, db, user) {
  const input = await readJson(request);
  const name = input.name === undefined ? null : shortName(input.name, 'Name', 32);
  if (input.timezone !== undefined) {
    const timezone = validTimeZone(input.timezone);
    if (!timezone) fail(400, 'Choose a valid time zone.');
    if (timezone !== validTimeZone(user.timezone)) fail(409, 'Your check-in time zone is fixed for this account.');
  }
  for (const field of ['gymGoal', 'nutritionGoal']) {
    const value = input[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 7)) {
      fail(400, 'Weekly goals must be between 1 and 7 days.');
    }
  }
  const updated = await statement(db, `
    UPDATE users SET name = COALESCE(?, name),
      gym_goal = COALESCE(?, gym_goal), nutrition_goal = COALESCE(?, nutrition_goal)
    WHERE id = ? RETURNING *
  `, name, input.gymGoal ?? null, input.nutritionGoal ?? null, user.id).first();
  return reply({ user: userView(updated) });
}

async function lockCheckin(request, db, user, day) {
  const expectedUser = request.headers.get('X-Daymark-User');
  if (expectedUser !== null && expectedUser !== user.id) {
    fail(409, 'This check-in belongs to a different Daymark account.');
  }
  if (!isDate(day)) fail(400, 'Choose a valid check-in date.');
  const input = await readJson(request);
  const { gym, nutrition, note = '' } = input;
  if (typeof gym !== 'boolean' || typeof nutrition !== 'boolean') {
    fail(400, 'Choose which of today’s habits you completed.');
  }
  if (typeof note !== 'string' || Array.from(note).length > 500) {
    fail(400, 'Keep private notes to 500 characters.');
  }
  const now = Date.now();
  const today = localDate(user.timezone, now);
  if (day !== today) fail(409, 'Only today’s check-in is open.', { code: 'day_closed', today });

  const [inserted, stored] = await db.batch([
    statement(db, `
      INSERT INTO checkins (user_id, day, gym, nutrition, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day) DO NOTHING RETURNING day
    `, user.id, day, Number(gym), Number(nutrition), note, now),
    statement(db, 'SELECT gym, nutrition, note FROM checkins WHERE user_id = ? AND day = ?', user.id, day),
  ]);
  const checkin = checkinView(stored.results[0]);
  if (checkin.gym !== gym || checkin.nutrition !== nutrition || checkin.note !== note) {
    fail(409, 'Today’s check-in is already locked.', { code: 'day_locked', today });
  }
  return reply({ date: day, checkin }, inserted.results.length ? 201 : 200);
}

async function getCircle(db, circleId, userId) {
  const row = await statement(db, CIRCLE_SELECT + ' WHERE c.id = ? AND m.user_id = ?', circleId, userId).first();
  if (!row) fail(404, 'Circle not found.');
  return row;
}

async function createCircle(request, db, user) {
  const input = await readJson(request);
  const name = shortName(input.name, 'Circle name', 36);
  const id = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch([
    statement(db, `
      INSERT INTO circles (id, name, invite_code, created_at)
      SELECT ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM circle_members WHERE user_id = ?) < ?
      RETURNING id
    `, id, name, randomHex(10).toUpperCase(), now, user.id, MAX_CIRCLES),
    statement(db, `
      INSERT INTO circle_members (circle_id, user_id, role, joined_at)
      SELECT id, ?, 'owner', ? FROM circles WHERE id = ?
    `, user.id, now, id),
  ]);
  if (!results[0].results.length) fail(409, 'You have reached the limit of ' + MAX_CIRCLES + ' circles.');
  return reply({ circle: { id, name, role: 'owner', memberCount: 1 } }, 201);
}

async function joinCircle(request, db, user) {
  const input = await readJson(request);
  const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/g, '').toUpperCase() : '';
  if (!/^[0-9A-F]{20}$/.test(code)) fail(400, 'Enter a valid 20-character invite code.');
  const results = await db.batch([
    statement(db, `
      INSERT INTO circle_members (circle_id, user_id, role, joined_at)
      SELECT c.id, ?, 'member', ? FROM circles c WHERE c.invite_code = ?
        AND (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) < ?
        AND (SELECT COUNT(*) FROM circle_members WHERE user_id = ?) < ?
      ON CONFLICT(circle_id, user_id) DO NOTHING
    `, user.id, Date.now(), code, MAX_MEMBERS, user.id, MAX_CIRCLES),
    statement(db, CIRCLE_SELECT + ' WHERE c.invite_code = ? AND m.user_id = ?', code, user.id),
    statement(db, 'SELECT id FROM circles WHERE invite_code = ?', code),
  ]);
  const circle = results[1].results[0];
  if (circle) return reply({ circle: circleView(circle) });
  if (!results[2].results.length) fail(404, 'This invite code is no longer active.');
  fail(409, 'This circle is full or you have reached your circle limit.');
}

async function circleDetail(db, circleId, user) {
  const now = Date.now();
  const today = localDate(user.timezone, now);
  const access = await statement(db, `
    SELECT member.*, host.timezone AS board_timezone,
      EXISTS(SELECT 1 FROM checkins WHERE user_id = ? AND day = ?) AS submitted
    FROM (${CIRCLE_SELECT} WHERE m.circle_id = ? AND m.user_id = ?) member
    JOIN circle_members owner ON owner.circle_id = member.id AND owner.role = 'owner'
    JOIN users host ON host.id = owner.user_id
  `, user.id, today, circleId, user.id).first();
  if (!access) fail(404, 'Circle not found.');
  if (!access.submitted) return reply({
    circle: { ...circleView(access), inviteCode: access.invite_code },
    locked: true, members: [], activity: [], today, weekStart: monday(today), lastRace: null,
  });

  const boardTimezone = access.board_timezone;
  const boardToday = localDate(boardTimezone, now);
  const weekStart = monday(boardToday);
  const weekDates = Array.from({ length: 7 }, (_, index) => dateOffset(weekStart, index));
  const [circleRow, memberRows, historyRows, activityRows] = await db.batch([
    statement(db, CIRCLE_SELECT + ' WHERE c.id = ? AND m.user_id = ?', circleId, user.id),
    statement(db, `
      SELECT u.id, u.name, u.timezone, m.role, m.joined_at
      FROM circle_members m JOIN users u ON u.id = m.user_id
      JOIN circle_members viewer ON viewer.circle_id = m.circle_id AND viewer.user_id = ?
      WHERE m.circle_id = ? ORDER BY m.joined_at, u.name, u.id
    `, user.id, circleId),
    statement(db, `
      SELECT k.user_id, k.day, k.gym, k.nutrition
      FROM circle_members m JOIN checkins k ON k.user_id = m.user_id
      JOIN circle_members viewer ON viewer.circle_id = m.circle_id AND viewer.user_id = ?
      WHERE m.circle_id = ? AND k.day BETWEEN ? AND ?
    `, user.id, circleId, dateOffset(boardToday, -730), boardToday),
    statement(db, `
      SELECT k.user_id, k.day, k.gym, k.nutrition, u.name,
        (SELECT COUNT(*) FROM cheers c WHERE c.circle_id = m.circle_id AND c.subject_id = k.user_id AND c.day = k.day)
          AS reaction_count,
        EXISTS (SELECT 1 FROM cheers c WHERE c.circle_id = m.circle_id AND c.subject_id = k.user_id
          AND c.day = k.day AND c.author_id = ?) AS reacted
      FROM circle_members m JOIN checkins k ON k.user_id = m.user_id
      JOIN users u ON u.id = m.user_id
      JOIN circle_members viewer ON viewer.circle_id = m.circle_id AND viewer.user_id = ?
      WHERE m.circle_id = ? AND k.day BETWEEN ? AND ? AND (k.gym = 1 OR k.nutrition = 1)
      ORDER BY k.day DESC, k.updated_at DESC, k.user_id
      LIMIT 50
    `, user.id, user.id, circleId, dateOffset(boardToday, -ACTIVITY_DAYS), boardToday),
  ]);
  const circle = circleRow.results[0];
  if (!circle) fail(404, 'Circle not found.');
  const participants = memberRows.results.map(member => ({
    ...member,
    today: localDate(member.timezone, now),
  }));
  const histories = new Map(participants.map(member => [member.id, new Map()]));
  for (const entry of historyRows.results) histories.get(entry.user_id)?.set(entry.day, entry);
  const members = participants.map(member => {
    const history = histories.get(member.id);
    const current = history.get(boardToday);
    const memberToday = member.today;
    const weekMarks = weekDates.map(day => weekMark(history, day, boardToday, memberToday));
    const bothDays = weekMarks.filter(mark => mark === 'both').length;
    const gymDays = bothDays + weekMarks.filter(mark => mark === 'gym').length;
    const nutritionDays = bothDays + weekMarks.filter(mark => mark === 'nutrition').length;
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      gymDays,
      nutritionDays,
      activeDays: gymDays + nutritionDays - bothDays,
      weekMarks,
      streak: streak(history, memberToday < boardToday ? memberToday : boardToday, memberToday <= boardToday),
      submittedToday: !!current,
      gymToday: !!current?.gym,
      nutritionToday: !!current?.nutrition,
    };
  });
  const activity = activityRows.results.map(entry => ({
    id: entry.user_id + ':' + entry.day,
    date: entry.day,
    userId: entry.user_id,
    name: entry.name,
    gym: !!entry.gym,
    nutrition: !!entry.nutrition,
    reactionCount: entry.reaction_count,
    reacted: !!entry.reacted,
  }));
  return reply({
    circle: { ...circleView(circle), inviteCode: circle.invite_code },
    locked: false,
    members, activity, today, boardToday, boardTimezone, weekStart, weekDates,
    lastRace: lastWeekRace(participants, histories, boardTimezone, weekStart),
  });
}

function lastWeekRace(participants, histories, boardTimezone, weekStart) {
  const end = dateOffset(weekStart, -1);
  const eligible = participants.filter(member => localDate(boardTimezone, member.joined_at) <= end);
  if (eligible.length < 2 || eligible.some(member => member.today <= end)) return null;

  const start = dateOffset(weekStart, -7);
  const dates = Array.from({ length: 7 }, (_, index) => dateOffset(start, index));
  const standings = eligible.map(({ id, name }) => {
    const history = histories.get(id);
    const activeDays = dates.filter(day => {
      const entry = history.get(day);
      return entry?.gym || entry?.nutrition;
    }).length;
    return { id, name, activeDays };
  }).sort((a, b) => b.activeDays - a.activeDays);
  return standings[0].activeDays ? { start, end, settled: true, standings } : null;
}

function weekMark(history, day, boardToday, memberToday) {
  if (day > boardToday) return 'future';
  const entry = history.get(day);
  if (entry) {
    if (entry.gym) return entry.nutrition ? 'both' : 'gym';
    return entry.nutrition ? 'nutrition' : 'rest';
  }
  if (day > memberToday) return 'future';
  return day === memberToday ? 'open' : 'missed';
}

async function rotateInvite(db, circleId, user) {
  const inviteCode = randomHex(10).toUpperCase();
  const updated = await statement(db, `
    UPDATE circles SET invite_code = ? WHERE id = ? AND EXISTS (
      SELECT 1 FROM circle_members WHERE circle_id = circles.id AND user_id = ? AND role = 'owner'
    ) RETURNING id
  `, inviteCode, circleId, user.id).first();
  if (!updated) {
    await getCircle(db, circleId, user.id);
    fail(403, 'Only the circle owner can reset its invite code.');
  }
  return reply({ inviteCode });
}

async function leaveCircle(db, circleId, user) {
  const results = await db.batch([
    statement(db, `
      DELETE FROM circle_members WHERE circle_id = ? AND user_id = ? AND role = 'member' RETURNING circle_id
    `, circleId, user.id),
    statement(db, `
      DELETE FROM circles WHERE id = ? AND EXISTS (
        SELECT 1 FROM circle_members WHERE circle_id = circles.id AND user_id = ? AND role = 'owner'
      ) AND (SELECT COUNT(*) FROM circle_members WHERE circle_id = circles.id) = 1 RETURNING id
    `, circleId, user.id),
    statement(db, `
      SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?
    `, circleId, user.id),
  ]);
  if (results[0].results.length || results[1].results.length) return reply({ ok: true });
  if (results[2].results.length) fail(409, 'The circle owner can leave once the other members have left.');
  fail(404, 'Circle not found.');
}

async function cheer(request, db, circleId, user, subjectId, day) {
  if (!isDate(day)) fail(400, 'Choose a valid check-in date.');
  if (subjectId === user.id) fail(400, 'Cheer a friend’s check-in.');
  const input = await readJson(request);
  if (typeof input.reacted !== 'boolean') fail(400, 'Provide a cheer update.');
  const now = Date.now();
  const today = localDate(user.timezone, now);
  const viewer = await statement(db, `
    SELECT EXISTS (SELECT 1 FROM checkins WHERE user_id = m.user_id AND day = ?) AS submitted,
      host.timezone AS board_timezone
    FROM circle_members m
    JOIN circle_members owner ON owner.circle_id = m.circle_id AND owner.role = 'owner'
    JOIN users host ON host.id = owner.user_id
    WHERE m.circle_id = ? AND m.user_id = ?
  `, today, circleId, user.id).first();
  if (!viewer) fail(404, 'Check-in not found.');
  if (!viewer.submitted) fail(423, 'Lock today’s check-in to send a Spark.');
  const boardToday = localDate(viewer.board_timezone, now);
  if (day > boardToday || day < dateOffset(boardToday, -ACTIVITY_DAYS)) fail(404, 'Check-in not found.');
  const mutation = input.reacted
    ? statement(db, `
      INSERT INTO cheers (circle_id, author_id, subject_id, day)
      SELECT viewer.circle_id, viewer.user_id, subject.user_id, k.day
      FROM circle_members viewer
      JOIN circle_members subject ON subject.circle_id = viewer.circle_id
      JOIN checkins k ON k.user_id = subject.user_id
      WHERE viewer.circle_id = ? AND viewer.user_id = ? AND subject.user_id = ?
        AND k.day = ? AND (k.gym = 1 OR k.nutrition = 1)
      ON CONFLICT(circle_id, author_id, subject_id, day) DO NOTHING
    `, circleId, user.id, subjectId, day)
    : statement(db, 'DELETE FROM cheers WHERE circle_id = ? AND author_id = ? AND subject_id = ? AND day = ?',
      circleId, user.id, subjectId, day);
  const results = await db.batch([
    mutation,
    statement(db, `
      SELECT (SELECT COUNT(*) FROM cheers c WHERE c.circle_id = viewer.circle_id
        AND c.subject_id = subject.user_id AND c.day = k.day) AS reaction_count,
        EXISTS(SELECT 1 FROM cheers c WHERE c.circle_id = viewer.circle_id AND c.author_id = viewer.user_id
          AND c.subject_id = subject.user_id AND c.day = k.day) AS reacted
      FROM circle_members viewer
      JOIN circle_members subject ON subject.circle_id = viewer.circle_id
      JOIN checkins k ON k.user_id = subject.user_id
      WHERE viewer.circle_id = ? AND viewer.user_id = ? AND subject.user_id = ?
        AND k.day = ? AND (k.gym = 1 OR k.nutrition = 1)
    `, circleId, user.id, subjectId, day),
  ]);
  const row = results[1].results[0];
  if (!row) fail(404, 'Check-in not found.');
  return reply({ reacted: !!row.reacted, reactionCount: row.reaction_count });
}

export async function handleApi(request, options) {
  const { db, standalone = false, remoteAddress } = options;
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  try {
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) fail(405, 'This request method is unsupported.');
    if (method !== 'GET') {
      const origin = request.headers.get('Origin');
      const site = request.headers.get('Sec-Fetch-Site');
      if ((origin && origin !== url.origin) || site === 'cross-site') {
        fail(403, 'Open Daymark to make this change.');
      }
    }
    if (pathname.startsWith('/api/auth/')) {
      if (standalone && method === 'POST') {
        if (pathname === '/api/auth/register') return await register(request, db);
        if (pathname === '/api/auth/login') return await login(request, db, remoteAddress);
        if (pathname === '/api/auth/logout') return await logout(request, db);
      }
      fail(404, 'Endpoint not found.');
    }

    const user = await authenticate(request, options, url);
    if (!user) fail(401, 'Sign in to continue.', { auth: standalone ? 'password' : 'chatgpt' });
    if (pathname === '/api/bootstrap' && method === 'GET') return await bootstrap(db, user, standalone);
    if (pathname === '/api/profile' && method === 'PATCH') return await updateProfile(request, db, user);
    const checkin = /^\/api\/checkins\/([^/]+)$/.exec(pathname);
    if (checkin) {
      if (method === 'POST') return await lockCheckin(request, db, user, checkin[1]);
      return reply({ error: 'Check-ins can only be locked once.' }, 405, { Allow: 'POST' });
    }

    if (pathname === '/api/circles' && method === 'POST') return await createCircle(request, db, user);
    if (pathname === '/api/circles/join' && method === 'POST') return await joinCircle(request, db, user);
    const circle = /^\/api\/circles\/([\da-f-]{36})(?:\/(.*))?$/.exec(pathname);
    if (circle) {
      const [, id, action] = circle;
      if (!action && method === 'GET') return await circleDetail(db, id, user);
      if (action === 'rotate' && method === 'POST') return await rotateInvite(db, id, user);
      if (action === 'membership' && method === 'DELETE') return await leaveCircle(db, id, user);
      const reaction = /^activity\/([\da-f-]{36})\/([^/]+)$/.exec(action || '');
      if (reaction && method === 'PATCH') return await cheer(request, db, id, user, reaction[1], reaction[2]);
    }
    fail(404, 'Endpoint not found.');
  } catch (error) {
    if (error instanceof ApiError) return reply({ error: error.message, ...error.extra }, error.status);
    console.error('Daymark API error', error);
    return reply({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
}
