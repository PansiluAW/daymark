import { habits, dayInZone, offsetDay, mondayOf, formatDay, hasCheckin, checkinLevel, summarize, weekBoard, makeDemo, awardsFor } from './model.mjs';
import { circleView } from './circle-view.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const emptyDay = { gym: false, nutrition: false, note: '' };
const state = {
  data: null, circles: new Map(), circleErrors: new Set(), circleId: null, filter: 'all', clockOffset: 0,
  demo: false, offline: false, auth: null, booted: false, locking: false,
  installPrompt: null, heatmapDay: null,
};
const prefix = 'daymark.v1.';
const memory = new Map();
let bootRequest;
let toastTimeout;
let activeDialog = '';
let dialogReturnFocus;
let view = 'dashboard';
let lastToday;
let reviewedDraft;
let lastInvitePrompt;
let circleRequest = 0;
let sessionRevision = 0;
let pendingUpdate;

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function read(key, fallback = null) {
  if (memory.has(key)) return memory.get(key);
  try { return JSON.parse(localStorage.getItem(prefix + key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try {
    localStorage.setItem(prefix + key, JSON.stringify(value));
    memory.delete(key);
  } catch { memory.set(key, value); }
}
function forget(key) {
  memory.delete(key);
  try { localStorage.removeItem(prefix + key); } catch { /* no persistent storage */ }
}
function storageKeys() {
  const keys = new Set(memory.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.add(key.slice(prefix.length));
    }
  } catch { /* session memory remains available */ }
  return [...keys];
}

function draftKey(userId = state.data.user.id) {
  return 'draft.' + userId;
}

function getDraft(day = todayKey()) {
  const key = draftKey();
  const draft = state.demo ? memory.get(key) : read(key);
  return draft?.day === day ? { ...emptyDay, ...draft.values } : { ...emptyDay };
}

function setDraft(day, values) {
  if (day !== todayKey() || state.data.checkins[day] || state.locking) return false;
  const key = draftKey();
  const draft = { day, values: { ...getDraft(day), ...values } };
  if (state.demo) memory.set(key, draft);
  else save(key, draft);
  render();
  return true;
}

function migrateLegacyDraft() {
  const { user, today, checkins } = state.data;
  const queuePrefix = 'queue.' + user.id + '.';
  const changes = storageKeys().filter(key => key.startsWith(queuePrefix))
    .map(key => ({ key, ...read(key) })).sort((a, b) => a.created - b.created || a.key.localeCompare(b.key));
  if (!checkins[today] && read(draftKey())?.day !== today) {
    const values = { ...emptyDay };
    let found = false;
    for (const change of changes) {
      if (change.day !== today || !Object.hasOwn(emptyDay, change.field)) continue;
      values[change.field] = change.value;
      found = true;
    }
    if (found) save(draftKey(), { day: today, values });
  }
  for (const { key } of changes) forget(key);
  const draft = read(draftKey());
  if (draft && (draft.day < today || checkins[draft.day])) forget(draftKey());
}

async function api(path, method = 'GET', body, extra = {}) {
  const timed = method === 'GET' || (method === 'POST' && path.startsWith('checkins/'));
  const response = await fetch('./api/' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    signal: timed ? AbortSignal.timeout?.(10000) : undefined,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Daymark could not complete that request.');
    error.status = response.status;
    error.auth = data.auth;
    throw error;
  }
  return data;
}

function persist() {
  if (!state.data || state.demo) return;
  save('snapshot', state.data);
  save('auth', state.auth);
}

async function bootstrap({ announce = false } = {}) {
  if (bootRequest) return bootRequest;
  const revision = sessionRevision;
  const request = (async () => {
    try {
      const startedAt = Date.now();
      const data = await api('bootstrap?timeZone=' + encodeURIComponent(localZone));
      if (revision !== sessionRevision) return;
      const previous = state.data?.user.id;
      if (previous === data.user.id) {
        // A concurrent lock may have finished after the server read this snapshot.
        for (const day of [data.today, offsetDay(data.today, 1)]) {
          if (state.data.checkins[day] && !data.checkins[day]) data.checkins[day] = state.data.checkins[day];
        }
      } else {
        state.circles.clear();
        state.circleErrors.clear();
      }
      state.data = data;
      state.clockOffset = Number.isFinite(data.serverTime) ? data.serverTime - (startedAt + Date.now()) / 2 : 0;
      state.demo = false;
      state.offline = false;
      state.auth = data.auth || state.auth || read('auth') || 'chatgpt';
      migrateLegacyDraft();
      persist();
    } catch (error) {
      if (revision !== sessionRevision) return;
      if (error.status === 401) {
        forget('snapshot');
        state.auth = error.auth || 'password';
        save('auth', state.auth);
        enterDemo();
        if (announce) toast('Sign in to lock your day.');
      } else {
        state.offline = true;
        if (!state.data || state.demo) {
          const cached = read('snapshot');
          if (cached?.user?.id) {
            state.data = cached;
            state.auth = read('auth');
            state.demo = false;
          } else enterDemo();
        }
      }
    }
    state.booted = true;
    chooseCircle();
    render();
    if (!state.demo && !state.offline && getView() === 'circle') void loadCircle();
    maybeInvite();
  })().finally(() => { if (bootRequest === request) bootRequest = null; });
  bootRequest = request;
  return request;
}

function enterDemo(reset = false) {
  if (!state.demo || reset) {
    const sample = makeDemo(localZone);
    state.data = sample.data;
    state.clockOffset = 0;
    state.circles = new Map([[sample.circle.circle.id, sample.circle]]);
    state.circleErrors.clear();
    memory.delete(draftKey());
  }
  state.demo = true;
}

function chooseCircle(id) {
  const circles = state.data.circles;
  const desired = id || read('circle.' + state.data.user.id) || state.circleId;
  state.circleId = circles.find(circle => circle.id === desired)?.id || circles[0]?.id || null;
  if (state.circleId) save('circle.' + state.data.user.id, state.circleId);
}

function rivalKey() {
  return 'rival.' + state.data.user.id + '.' + state.circleId;
}

async function loadCircle({ quiet = true } = {}) {
  const id = state.circleId;
  if (!id || state.demo || state.offline) return;
  const userId = state.data.user.id;
  const request = ++circleRequest;
  try {
    const details = await api('circles/' + encodeURIComponent(id));
    if (request !== circleRequest || userId !== state.data?.user.id) return;
    const previous = state.circles.get(id);
    const hadError = state.circleErrors.delete(id);
    state.circles.set(id, details);
    if (state.circleId === id && (hadError || JSON.stringify(previous) !== JSON.stringify(details))) render();
  } catch (error) {
    if (request !== circleRequest) return;
    if (error.status === 401 || error.status === 404) {
      if (!bootRequest) void bootstrap();
    } else {
      state.circleErrors.add(id);
      if (state.circleId === id) render();
      if (!quiet) toast('Couldn’t refresh your circle. Try again.');
    }
  }
}

function todayKey() {
  return dayInZone(state.data?.user.timezone || localZone, new Date(Date.now() + state.clockOffset));
}

function dayLocked(day = todayKey()) {
  return Boolean(state.data?.checkins[day]);
}

function updateDemoCircle(day, checkin) {
  const details = state.circles.get(state.circleId);
  if (!details) return;
  details.today = day;
  details.boardToday = day;
  details.weekStart = mondayOf(day);
  const own = details.members.find(member => member.id === state.data.user.id);
  const stats = summarize(state.data.checkins, day);
  Object.assign(own, {
    gymToday: checkin.gym, nutritionToday: checkin.nutrition, submittedToday: true,
    gymDays: stats.week.gym, nutritionDays: stats.week.nutrition,
    activeDays: stats.week.activeDays, streak: stats.current,
    weekMarks: weekBoard(state.data.checkins, day).marks,
  });
  if (hasCheckin(checkin)) details.activity.unshift({
    id: own.id + ':' + day, userId: own.id, name: own.name, date: day,
    gym: checkin.gym, nutrition: checkin.nutrition, reactionCount: 0, reacted: false,
  });
}

async function lockDay(day, draft) {
  if (state.locking) return;
  if (day !== todayKey()) throw new Error('That day has ended. You can lock only today’s check-in.');
  if (dayLocked(day)) { closeDialog(); return; }
  if (navigator.onLine === false && !state.demo) throw new Error('Reconnect today to lock your check-in.');
  const userId = state.data.user.id;
  const beforeAwards = new Set(awardsFor(state.data.checkins, day).filter(a => a.earnedOn).map(a => a.id));
  state.locking = true;
  try {
    const { checkin } = state.demo ? { checkin: draft }
      : await api('checkins/' + day, 'POST', draft, { 'X-Daymark-User': userId });
    if (state.data?.user.id !== userId) return;
    state.data.checkins[day] = checkin;
    forget(draftKey(userId));
    if (state.demo) updateDemoCircle(day, checkin);
    else {
      state.offline = false;
      persist();
    }
    closeDialog();
    render();
    $('#daily-title')?.focus({ preventScroll: true });
    const streak = summarize(state.data.checkins, day).checkinStreak;
    const award = awardsFor(state.data.checkins, day).find(a => a.earnedOn === day && !beforeAwards.has(a.id));
    showLockMoment(checkin, streak, award);
    if (getView() === 'circle') void loadCircle();
  } catch (error) {
    if (error.status === 401 || error.status === 409) {
      await bootstrap({ announce: error.status === 401 });
      if (state.data?.user.id === userId && dayLocked(day)) {
        closeDialog();
        toast('Your check-in is already locked.');
        return;
      }
    }
    if (!error.status) {
      state.offline = true;
      render();
      throw new Error('Connection interrupted. Your draft is saved here. Try again before midnight.');
    }
    throw error;
  } finally {
    state.locking = false;
  }
}

function icon(name, className = 'icon') {
  return '<svg class="' + className + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}
function initials(name) {
  return name.trim().split(/\s+/u).slice(0, 2).map(piece => Array.from(piece)[0]?.toUpperCase() || '').join('') || 'D';
}
function avatar(name, index = 0) {
  return '<span class="avatar avatar-tone-' + index % 4 + '" aria-hidden="true">' + escape(initials(name)) + '</span>';
}
function getView() {
  const key = location.hash.slice(1).split('?')[0];
  return ['dashboard', 'history', 'circle', 'settings'].includes(key) ? key : 'dashboard';
}
function navigate(next) {
  if (getView() === next && !location.hash.includes('?')) return;
  location.hash = next;
}
function toast(message) {
  const element = $('#toast');
  if (!element) return;
  clearTimeout(toastTimeout);
  element.textContent = message;
  element.hidden = false;
  toastTimeout = setTimeout(() => { element.hidden = true; }, 3300);
}
function button(label, action, variant = 'secondary', symbol = '', attributes = '') {
  return '<button type="button" class="button button-' + variant + '" data-action="' + action + '" ' + attributes + '>'
    + (symbol ? icon(symbol) : '') + '<span>' + escape(label) + '</span></button>';
}
function panel(content, className = '') {
  return '<article class="panel ' + className + '">' + content + '</article>';
}
function empty(title, text, symbol, actions = '') {
  return '<div class="empty-state"><span class="empty-icon">' + icon(symbol) + '</span><h3>' + escape(title)
    + '</h3><p>' + escape(text) + '</p>' + (actions ? '<div class="form-actions">' + actions + '</div>' : '') + '</div>';
}

function render() {
  if (!state.data) return;
  const focused = document.activeElement;
  const focusKey = focused?.dataset.action ? [focused.dataset.action, focused.dataset.day, focused.dataset.habit, focused.dataset.user] : null;
  const nextView = getView();
  const changedView = view !== nextView;
  const historyScroll = !changedView && view === 'history' ? $('.heatmap-scroll')?.scrollLeft : null;
  view = nextView;
  for (const section of $$('[id^="view-"]')) section.hidden = section.id !== 'view-' + view;
  for (const nav of $$('a[data-view]')) {
    if (nav.dataset.view === view) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  const avatarButton = $('#user-avatar');
  if (view === 'settings') avatarButton.setAttribute('aria-current', 'page');
  else avatarButton.removeAttribute('aria-current');
  const today = todayKey();
  lastToday = today;
  const logs = state.data.checkins;
  const stats = summarize(logs, today);
  avatarButton.textContent = initials(state.data.user.name);
  renderStatus();
  if (view === 'dashboard') renderDashboard(today, logs, stats);
  if (view === 'history') {
    renderHistory(today, logs, stats);
    if (historyScroll != null) $('.heatmap-scroll').scrollLeft = historyScroll;
  }
  if (view === 'circle') renderCircles(today);
  if (view === 'settings') renderSettings();
  if (changedView) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = $('#view-' + view + ' h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  } else if (focusKey && !focused.isConnected && !$('#app-dialog').open) {
    const candidate = $$('[data-action]').find(element => !element.closest('[hidden]')
      && [element.dataset.action, element.dataset.day, element.dataset.habit, element.dataset.user]
        .every((value, index) => value === focusKey[index]));
    candidate?.focus({ preventScroll: true });
  }
}
function renderStatus() {
  const status = $('#sync-status');
  if (status) status.textContent = state.offline ? 'Connection lost' : '';
  const banner = $('#site-banner');
  let message = '';
  if (state.offline) {
    message = '<span><strong>Can’t reach Daymark.</strong> ' + (state.demo
      ? 'You can still try the sample board.' : 'Your draft stays here. Reconnect before midnight to lock it.') + '</span>'
      + button('Retry', 'retry', 'quiet');
  } else if (state.demo) {
    message = '<span><strong>Sample board</strong> · Take it for a spin.</span>'
      + button('Start my board', 'auth', 'quiet', 'arrow-right');
  }
  banner.hidden = !message;
  if (banner.dataset.message !== message) {
    banner.dataset.message = message;
    banner.innerHTML = message;
  }
}

function stamp(key, habit, picked, locked, today) {
  const label = locked ? (picked ? 'Done' : 'No mark') : (picked ? 'Marked' : 'Tap to mark');
  const classes = 'habit-stamp habit-' + key + (picked ? ' is-marked' : '') + (locked ? ' is-locked' : '');
  const content = '<span class="stamp-icon">' + icon(habit.icon) + '</span><span class="stamp-copy"><strong>' + habit.label
    + '</strong><small>' + label + '</small></span><span class="stamp-state" aria-hidden="true">'
    + icon(picked ? 'check' : (locked ? 'minus' : 'plus')) + '</span>';
  if (locked) return '<div class="' + classes + '">' + content + '</div>';
  return '<button type="button" class="' + classes + '" data-action="toggle" data-habit="' + key + '" data-day="' + today
    + '" aria-label="' + habit.label + '" aria-pressed="' + picked + '">' + content + '</button>';
}

function renderDashboard(today, logs, stats) {
  const date = $('#today-date');
  date.textContent = formatDay(today, { weekday: 'long', month: 'short', day: 'numeric' });
  date.dateTime = today;
  const locked = dayLocked(today);
  const log = locked ? logs[today] : getDraft(today);
  const marks = checkinLevel(log);
  const headline = locked ? 'Day locked.' : 'Make your mark.';
  const hint = locked ? (stats.checkinStreak > 1
    ? stats.checkinStreak + ' days in a row. See you tomorrow.'
    : 'Today is on the board. Come back tomorrow for day two.')
    : stats.checkinStreak > 0 ? 'Lock today for day ' + (stats.checkinStreak + 1) + '.'
      : stats.bestCheckinStreak > 0 ? 'A fresh streak starts today.' : 'Your first check-in starts it.';
  const tiles = Object.entries(habits).map(([key, habit]) => stamp(key, habit, Boolean(log[key]), locked, today)).join('');
  const note = log.note ? 'Edit private note' : 'Add a private note';
  const unavailable = state.offline && !state.demo;
  const disabled = navigator.onLine === false && !state.demo ? 'disabled' : '';
  const footer = locked
    ? '<div class="daily-footer"><span class="daily-complete">' + icon('lock') + ' Saved for today</span>'
      + (log.note ? button('Read note', 'view-day', 'quiet', 'edit', 'data-day="' + today + '"') : '') + '</div>'
    : '<div class="daily-footer"><p class="daily-hint">' + (unavailable ? 'Draft saved on this device.' : 'Lock by midnight.')
      + ' ' + button(note, 'edit-note', 'quiet', 'edit') + '</p><div class="daily-actions">'
      + (marks === 0 ? button('Log a rest day', 'review-lock', 'secondary', 'lock', disabled)
        : button('Review & lock', 'review-lock', 'primary', 'lock', disabled))
      + '</div></div>';
  const chip = locked
    ? (marks === 0 ? 'Rest day' : marks === 1 ? 'Single mark' : 'Double mark')
    : marks + ' / 2';
  $('#today-checkin').innerHTML = '<article class="daily-card' + (locked ? ' is-locked' : '') + '">'
    + '<div class="daily-top"><div class="daily-copy"><h2 id="daily-title" tabindex="-1">' + headline + '</h2>'
    + '<p>' + (locked ? hint : 'Tap the habits you did today.') + '</p></div>'
    + '<div class="daily-count" aria-label="' + marks + ' of 2 marks">' + (locked ? icon('check') : '') + chip + '</div></div>'
    + '<div class="stamp-grid">' + tiles + '</div>' + footer + '</article>';
  $('#personal-progress').innerHTML = renderWeek(today, logs, stats, locked ? '' : hint);
  $('#circle-preview').innerHTML = '<article class="circle-gateway"><span class="gateway-icon">'
    + icon(locked ? 'users' : 'lock') + '</span><div class="gateway-copy"><h2>Circle</h2><p>'
    + (locked ? 'See how your friends showed up today.' : 'Your circle opens after you lock your day.') + '</p></div>'
    + (locked ? '<a class="button button-secondary" href="#circle">See circle ' + icon('arrow-right') + '</a>' : '') + '</article>';
}

function renderWeek(today, logs, stats, prompt) {
  const { dates, marks } = weekBoard(logs, today);
  const tileIcons = { gym: ['gym'], nutrition: ['diet'], both: ['gym', 'diet'], rest: ['minus'], missed: [], open: [], future: [] };
  const tileLabels = { gym: 'Gym', nutrition: 'Nutrition', both: 'Gym and nutrition', rest: 'Rest day', missed: 'No check-in', open: 'Ready to check in', future: 'Upcoming' };
  const tiles = dates.map((day, index) => {
    const mark = marks[index];
    const current = day === today;
    const label = formatDay(day, { weekday: 'long', month: 'short', day: 'numeric' }) + ' · ' + tileLabels[mark];
    const attrs = ' class="week-day' + (current ? ' is-today' : '') + '" data-mark="' + mark + '"';
    const inner = '<span class="week-day-label">' + formatDay(day, { weekday: 'short' }) + '</span><span class="week-day-tile" aria-hidden="true">'
      + tileIcons[mark].map(name => icon(name)).join('') + '</span>';
    if (day > today) return '<div' + attrs + ' aria-label="' + escape(label) + '">' + inner + '</div>';
    return '<button type="button"' + attrs + ' data-action="' + (mark === 'open' ? 'focus-checkin' : 'view-day') + '" data-day="' + day
      + '" aria-label="' + escape(label) + '" title="' + escape(label) + '">' + inner + '</button>';
  }).join('');
  const streak = stats.checkinStreak + (stats.checkinStreak === 1 ? ' day' : ' days');
  return '<article class="progress-card personal-week"><div class="progress-head"><div><h2>This week</h2><p>'
    + stats.week.checkinDays + (stats.week.checkinDays === 1 ? ' check-in' : ' check-ins') + ' · '
    + stats.week.activeDays + (stats.week.activeDays === 1 ? ' active day' : ' active days') + '</p></div>'
    + '<a class="button button-quiet progress-summary" href="#history">Full grid ' + icon('arrow-right') + '</a></div>'
    + '<div class="week-track" aria-label="My week from Monday to Sunday">' + tiles + '</div>'
    + '<div class="week-momentum"><strong>' + icon('flame') + ' ' + (stats.checkinStreak ? streak + ' in a row' : 'Build a streak') + '</strong>'
    + (prompt ? '<span>' + prompt + '</span>' : '<span>Rest days count as check-ins.</span>') + '</div></article>';
}

function progressMetrics(stats) {
  const metric = (value, label) => '<div><strong class="metric-value">' + value + '</strong><span class="metric-label">' + label + '</span></div>';
  const days = count => count + (count === 1 ? ' day' : ' days');
  return '<div class="progress-metrics">'
    + metric(days(stats.checkinStreak), 'Check-in streak')
    + metric(stats.last28, 'Active days · last 4 weeks')
    + metric(days(stats.bestCheckinStreak), 'Best check-in streak') + '</div>';
}

function heatmap(today, logs, weeks, filter = 'all') {
  const end = mondayOf(today);
  const first = offsetDay(end, -7 * (weeks - 1));
  const focusDay = state.heatmapDay >= first && state.heatmapDay <= today ? state.heatmapDay : today;
  const months = [];
  const tiles = [];
  let previousMonth = '';
  for (let column = 0; column < weeks; column++) {
    const monday = offsetDay(first, column * 7);
    const month = monday.slice(0, 7);
    if (month !== previousMonth) {
      if (column === 0 || column > 1) months.push('<span style="grid-column:' + (column + 1) + '">' + formatDay(monday, { month: 'short' }) + '</span>');
      previousMonth = month;
    }
    for (let row = 0; row < 7; row++) {
      const day = offsetDay(monday, row);
      const log = logs[day];
      const level = checkinLevel(log, filter);
      const isRest = filter === 'all' && log && !hasCheckin(log);
      const details = [log?.gym ? 'Gym' : '', log?.nutrition ? 'Nutrition' : ''].filter(Boolean).join(' and ');
      const label = formatDay(day, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) + ' · '
        + (details || (log ? 'Rest day' : 'No check-in'));
      if (day > today) tiles.push('<span class="heatmap-cell is-future" aria-hidden="true"></span>');
      else tiles.push('<button class="heatmap-cell' + (day === today ? ' is-today' : '') + (isRest ? ' is-rest' : '') + '" data-level="' + level
        + '" tabindex="' + (day === focusDay ? '0' : '-1')
        + '" type="button" data-action="view-day" data-day="' + day + '" aria-label="' + escape(label) + '" title="' + escape(label) + '"></button>');
    }
  }
  const legend = filter === 'all'
    ? '<span><i data-level="0"></i>No mark</span><span><i data-level="1"></i>1 habit</span><span><i data-level="2"></i>2 habits</span><span><i class="is-rest"></i>Rest</span>'
    : '<span><i data-level="0"></i>No mark</span><span><i data-level="1"></i>Marked</span>';
  return '<div class="heatmap-scroll" data-weeks="' + weeks + '"><div class="heatmap-chart" style="--weeks:' + weeks + '"><div class="heatmap-months">'
    + months.join('') + '</div><div class="heatmap-body"><div class="heatmap-days" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>'
    + '<div class="heatmap-grid" aria-label="Daily consistency grid">' + tiles.join('') + '</div></div></div></div><div class="heatmap-legend">' + legend + '</div>';
}


/** Personal awards come from saved check-ins, never from local drafts or mock circle scores. */
function renderAwards(today, logs) {
  const badges = awardsFor(logs, today);
  const earned = badges.filter(b => b.earnedOn).length;
  const tiles = badges.map(a =>
    '<li class="award-tile' + (a.earnedOn ? ' award-earned' : '') + '">'
    + '<span class="award-glyph" aria-hidden="true">' + a.icon + '</span>'
    + '<span class="award-copy"><strong>' + escape(a.name) + '</strong><small>'
    + escape(a.earnedOn ? 'Earned ' + formatDay(a.earnedOn) : a.description) + '</small></span></li>'
  ).join('');
  return panel('<div class="panel-heading"><div><p class="eyebrow">YOUR ACHIEVEMENTS</p><h2>Awards cabinet</h2>'
    + '<p>Each locked day is a win. Rest days count toward showing up; gym and nutrition awards need actual marks.</p>'
    + '</div><span class="award-total">' + earned + ' / ' + badges.length + '</span></div>'
    + '<ul class="award-grid">' + tiles + '</ul>', 'awards-panel');
}
let markMomentTimer;
function showLockMoment(checkin, streak, award) {
  const el = $('#mark-moment');
  if (!el) { toast('Day locked.'); return; }
  const both = Boolean(checkin.gym && checkin.nutrition);
  const rest = !checkin.gym && !checkin.nutrition;
  const iconText = award?.icon || (both ? '⚡' : rest ? '🌿' : checkin.gym ? '💪' : '🥗');
  const headline = award ? 'Award unlocked: ' + award.name : both ? 'Double mark!' : rest ? 'Recovery counts!' : 'Day secured!';
  const detail = award ? award.description : streak > 1 ? streak + ' consecutive check-ins. Keep your rhythm.'
    : both ? 'Gym and nutrition, both on the board.' : rest ? 'You showed up and protected your rest.' : 'Your mark is on the board.';
  const tier = award ? 'award' : rest ? 'rest' : both ? 'double' : 'single';
  el.dataset.tier = tier;
  el.querySelector('.mark-moment-symbol').textContent = iconText;
  el.querySelector('.mark-moment-title').textContent = headline;
  el.querySelector('.mark-moment-detail').textContent = detail;
  clearTimeout(markMomentTimer);
  el.hidden = false;
  el.classList.remove('mark-moment-animate');
  void el.offsetWidth;
  el.classList.add('mark-moment-animate');
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches && navigator.vibrate) {
    try { navigator.vibrate(tier === 'award' || tier === 'double' ? [25,45,35,55,25] : tier === 'rest' ? [12] : [20,40,30]); } catch {}
  }
  markMomentTimer = setTimeout(() => { el.hidden = true; }, tier === 'double' || tier === 'award' ? 3500 : tier === 'rest' ? 2200 : 2800);
}
function showTapMoment(habit, marked) {
  if (!marked) return; // Unmarking is correction, not a victory.
  const el = $('#tap-moment');
  if (!el) return;
  el.textContent = (habit === 'gym' ? '💪 Gym marked' : '🥗 Nutrition marked') + ' · lock today to save';
  el.hidden = false;
  el.classList.remove('tap-moment-animate');
  void el.offsetWidth;
  el.classList.add('tap-moment-animate');
  clearTimeout(showTapMoment.timer);
  showTapMoment.timer = setTimeout(() => { el.hidden = true; }, 1350);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && navigator.vibrate) {
    try { navigator.vibrate(12); } catch {}
  }
}

function renderHistory(today, logs, stats) {
  const filters = [['all', 'All'], ['gym', 'Gym'], ['diet', 'Nutrition']].map(([value, label]) =>
    '<button type="button" data-filter="' + value + '" aria-pressed="' + (state.filter === value) + '">' + label + '</button>').join('');
  const goals = Object.entries(habits).map(([key, habit]) => {
    const goal = state.data.user[key === 'gym' ? 'gymGoal' : 'nutritionGoal'];
    return '<div class="goal-row"><div><span>' + icon(habit.icon) + ' ' + habit.label + '</span><strong>' + stats.week[key] + ' / ' + goal
      + '</strong></div><progress value="' + Math.min(stats.week[key], goal) + '" max="' + goal + '" aria-label="' + habit.label + ' weekly goal"></progress></div>';
  }).join('');
  $('#history-content').innerHTML = '<article class="progress-card"><div class="progress-head"><div><h2>Your year in marks</h2><p>Tap a tile for details. Scroll for earlier months.</p></div>'
    + '<div class="segment" aria-label="Filter check-ins">' + filters + '</div></div>' + progressMetrics(stats)
    + heatmap(today, logs, 52, state.filter) + '</article>'
    + panel('<div class="panel-heading"><h2>This week’s goals</h2></div><div class="goal-list">' + goals + '</div>', 'weekly-goals')
    + renderAwards(today, logs);
}

function renderCircles(today) {
  const choices = state.data.circles;
  const container = $('#circle-content');
  const focusedSelect = document.activeElement?.matches('#race-rival, #circle-select') ? document.activeElement.id : null;
  const expanded = container.dataset.circleId === state.circleId
    ? $$('[data-circle-disclosure][open]', container).map(item => item.dataset.circleDisclosure) : [];
  container.dataset.circleId = state.circleId || '';
  container.innerHTML = circleView({
    choices,
    selected: choices.find(circle => circle.id === state.circleId),
    details: state.circles.get(state.circleId),
    userId: state.data.user.id,
    rivalId: state.circleId ? read(rivalKey()) : null,
    demo: state.demo,
    offline: state.offline,
    lockedToday: dayLocked(today),
    today,
    error: state.circleErrors.has(state.circleId),
  }, { escape, icon, avatar, button, panel, empty });
  for (const detail of $$('[data-circle-disclosure]', container)) {
    detail.open = expanded.includes(detail.dataset.circleDisclosure);
  }
  if (focusedSelect) document.getElementById(focusedSelect)?.focus({ preventScroll: true });
}

function renderSettings() {
  const { user } = state.data;
  const container = $('#settings-content');
  const renderKey = JSON.stringify([user, state.demo, state.offline]);
  if (container.dataset.renderKey === renderKey) return;
  container.dataset.renderKey = renderKey;
  const options = (count) => Array.from({ length: 7 }, (_, index) => '<option' + (count === index + 1 ? ' selected' : '') + '>'
    + (index + 1) + '</option>').join('');
  const disabled = state.offline && !state.demo ? ' disabled' : '';
  const form = '<form data-form="profile" class="form-stack"><label class="field">Display name<input name="name" maxlength="32" required value="'
    + escape(user.name) + '" autocomplete="nickname"></label>'
    + '<div class="field-pair"><label class="field">Gym days per week<select name="gymGoal">' + options(user.gymGoal) + '</select></label>'
    + '<label class="field">Nutrition days per week<select name="nutritionGoal">' + options(user.nutritionGoal) + '</select></label></div>'
    + '<p class="subtle">Your day ends at midnight (' + escape(user.timezone.split('/').at(-1).replaceAll('_', ' ')) + ' time).</p>'
    + '<p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button button-primary" type="submit"' + disabled + '>Save settings</button></div></form>';
  const account = state.demo
    ? '<p>Make a board of your own and save your progress.</p>' + button('Create account or sign in', 'auth', 'primary')
    : '<p>Download a copy of your personal check-ins, including private notes.</p><div class="form-actions">'
      + button('Export data', 'export', 'secondary', 'download') + button('Sign out', 'logout', 'quiet', 'logout', disabled) + '</div>';
  container.innerHTML = '<div class="settings-grid">'
    + panel('<div class="panel-heading"><div><p class="eyebrow">THE BASICS</p><h2>Profile &amp; goals</h2></div></div>' + form)
    + '<div class="settings-aside">' + panel('<div class="panel-heading"><div><p class="eyebrow">DAYMARK ANYWHERE</p><h2>Install Daymark</h2></div></div>'
      + '<p>Open it from your home screen. You can draft offline and lock your marks when you reconnect that day.</p>' + button('Install app', 'install', 'secondary', 'download'))
    + panel('<div class="panel-heading"><div><p class="eyebrow">YOUR DATA</p><h2>Account</h2></div></div>' + account) + '</div></div>';
}

function openDialog(kind, title, content) {
  const dialog = $('#app-dialog');
  activeDialog = kind;
  if (!dialog.open) dialogReturnFocus = document.activeElement;
  $('#dialog-content').innerHTML = '<div class="dialog-heading"><h2 id="dialog-title">' + escape(title)
    + '</h2><button type="button" class="icon-button" data-action="close" aria-label="Close dialog">' + icon('close') + '</button></div>' + content;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('[data-initial-focus]', dialog)?.focus());
}
function closeDialog() { $('#app-dialog').close(); }
function formDialog(kind, title, text, fields, submit) {
  openDialog(kind, title, (text ? '<p>' + escape(text) + '</p>' : '') + '<form class="form-stack" data-form="' + kind + '">'
    + fields + '<p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button button-primary" type="submit">'
    + escape(submit) + '</button>' + button('Cancel', 'close', 'quiet') + '</div></form>');
}

function openDay(day) {
  if (!day || day > todayKey()) return;
  const log = state.data.checkins[day];
  const title = formatDay(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const content = log
    ? '<p>' + icon('lock') + ' ' + (hasCheckin(log) ? 'Locked check-in' : 'Rest day') + '</p><ul class="day-details">'
      + Object.entries(habits).map(([key, habit]) => '<li>' + icon(log[key] ? 'check' : 'minus') + '<strong>' + habit.label
        + '</strong><span>' + (log[key] ? 'Done' : 'No mark') + '</span></li>').join('') + '</ul>'
      + (log.note ? '<div class="archived-note"><strong>Private note</strong><p>' + escape(log.note) + '</p></div>' : '')
    : '<p>' + (day === todayKey() ? 'Today is still open. Make your marks on the Today tab.' : 'No check-in. This day has ended.') + '</p>';
  openDialog('view-day', title, content);
}

function openNote() {
  const day = todayKey();
  if (dayLocked(day)) return;
  formDialog('note', 'Private note', 'Only you can see this. It locks with the rest of today’s check-in.',
    '<input type="hidden" name="day" value="' + day + '"><label class="field">Note<textarea name="note" maxlength="500" rows="4" data-initial-focus>'
    + escape(getDraft(day).note) + '</textarea></label>', 'Save draft note');
}

function reviewDayLock() {
  const day = todayKey();
  if (dayLocked(day) || state.locking) return;
  const draft = getDraft(day);
  reviewedDraft = { day, userId: state.data.user.id, values: draft };
  const names = Object.entries(habits).filter(([key]) => draft[key]).map(([, habit]) => habit.label);
  formDialog('lock-day', names.length ? 'Lock today?' : 'Log a rest day?',
    names.length ? names.join(' + ') + ' will go on your board. This check-in is final.' : 'Today goes on the board as a rest day with no habit marks. This check-in is final.',
    '<input type="hidden" name="day" value="' + day + '">', names.length ? 'Lock my day' : 'Lock rest day');
}

function inviteCode() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return params.get('invite') || new URLSearchParams(location.search).get('invite') || '';
}
function maybeInvite() {
  const code = inviteCode();
  if (!code || state.offline || !state.booted) return;
  if (activeDialog) return;
  const key = state.data.user.id + ':' + code;
  if (lastInvitePrompt === key) return;
  lastInvitePrompt = key;
  if (state.demo) showAuth('register');
  else openJoin(code);
}
function openJoin(code = inviteCode()) {
  if (!requireOnlineAccount()) return;
  formDialog('join-circle', 'Join a circle', 'Members can see each other’s recent habit check-ins and streaks. Your notes stay private.',
    '<label class="field">Invite code<input name="code" required maxlength="64" autocapitalize="characters" spellcheck="false" data-initial-focus value="'
    + escape(code) + '" placeholder="Paste your friend’s code"></label>', 'Join circle');
}

function showAuth(mode = 'register') {
  if (state.offline) { toast('Reconnect to sign in.'); return; }
  if (state.auth === 'chatgpt') {
    const redirect = location.pathname + location.search + location.hash;
    openDialog('auth', 'Start your board', '<p>Sign in with ChatGPT to make check-ins your own and join friends.</p><a class="button button-primary" target="_top" href="/signin-with-chatgpt?return_to='
      + encodeURIComponent(redirect) + '">Continue with ChatGPT</a>');
    return;
  }
  const registering = mode === 'register';
  const fields = (registering ? '<label class="field">Display name<input name="name" maxlength="32" autocomplete="nickname" required data-initial-focus></label>' : '')
    + '<label class="field">Email<input type="email" name="email" autocomplete="username" maxlength="254" required'
    + (registering ? '' : ' data-initial-focus') + '></label><label class="field">Password<input type="password" name="password" autocomplete="'
    + (registering ? 'new-password" minlength="12' : 'current-password') + '" maxlength="256" required>'
    + (registering ? '<small>Use at least 12 characters. You’ll sign in with this password.</small>' : '') + '</label>';
  formDialog('auth-' + mode, registering ? 'Start your board' : 'Welcome back',
    registering ? 'Create a Daymark account to save your check-ins and join friends.' : 'Pick up where you left off.', fields,
    registering ? 'Create account' : 'Sign in');
  $('#dialog-content').insertAdjacentHTML('beforeend',
    button(registering ? 'Already have an account? Sign in' : 'New to Daymark? Create an account', registering ? 'sign-in' : 'auth', 'quiet'));
}

function requireOnlineAccount() {
  if (state.offline) { toast('Reconnect to manage your circle or account.'); return false; }
  if (state.demo) { showAuth(); return false; }
  return true;
}

function showInvite() {
  if (!requireOnlineAccount()) return;
  const details = state.circles.get(state.circleId);
  if (!details?.circle.inviteCode) return;
  const code = details.circle.inviteCode;
  const url = location.origin + location.pathname + '#circle?invite=' + encodeURIComponent(code);
  openDialog('invite', 'Invite a friend', '<p>Send this link or code to someone you want in ' + escape(details.circle.name) + '.</p>'
    + (state.auth === 'chatgpt' ? '<p class="subtle">' + icon('lock') + ' The Daymark owner also needs to grant them access to this site.</p>' : '')
    + '<label class="field">Invite link<input id="invite-link" value="' + escape(url) + '" readonly></label>'
    + '<label class="field">Invite code<input id="invite-code" value="' + escape(code) + '" readonly></label>'
    + '<div class="form-actions">' + button('Copy link', 'copy-link', 'primary', 'copy') + button('Copy code', 'copy-code', 'secondary', 'copy')
    + (details.circle.role === 'owner' ? button('Reset code', 'rotate-invite', 'quiet') : '') + '</div>');
}
async function copyField(id) {
  const input = $(id);
  try { await navigator.clipboard.writeText(input.value); toast('Copied to clipboard.'); }
  catch { input.select(); toast('Selected. Use your device’s Copy command.'); }
}

async function spark(user, day, element) {
  const circleId = state.circleId;
  const item = state.circles.get(circleId)?.activity.find(entry => entry.userId === user && entry.date === day);
  if (!dayLocked() || !item || (state.offline && !state.demo)) return;
  const reacted = !item.reacted;
  element.disabled = true;
  try {
    const result = state.demo ? { reacted, reactionCount: item.reactionCount + (reacted ? 1 : -1) }
      : await api('circles/' + circleId + '/activity/' + user + '/' + day, 'PATCH', { reacted });
    Object.assign(item, result);
    if (reacted) toast('Spark sent ✦');
    render();
    if (!state.demo) void loadCircle();
  } catch (error) { toast(error.message); }
  finally { element.disabled = false; }
}

async function exportData() {
  const data = { exportedAt: new Date().toISOString(), profile: state.data.user, checkins: state.data.checkins };
  const file = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'daymark-' + todayKey() + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showInstall() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    toast('Daymark is already installed.');
    return;
  }
  if (state.installPrompt) {
    const prompt = state.installPrompt;
    state.installPrompt = null;
    await prompt.prompt();
    return;
  }
  openDialog('install', 'Keep Daymark handy', '<p>On iPhone or iPad, open Daymark in Safari. Use Share, then Add to Home Screen.</p>'
    + '<p>On Android or desktop, look for Install or Add to home screen in your browser’s menu.</p>'
    + button('Got it', 'close', 'primary'));
}

function clearLocalAccount() {
  sessionRevision++;
  bootRequest = null;
  lastInvitePrompt = null;
  forget('snapshot');
  state.circles.clear();
  state.circleErrors.clear();
  state.data = null;
  state.demo = false;
}
async function signOut() {
  if (!requireOnlineAccount()) return;
  if (state.auth === 'chatgpt') {
    clearLocalAccount();
    window.top.location.href = '/signout-with-chatgpt?return_to=' + encodeURIComponent('/');
    return;
  }
  await api('auth/logout', 'POST');
  clearLocalAccount();
  enterDemo();
  chooseCircle();
  navigate('dashboard');
  render();
  toast('Signed out.');
}

function watchUpdates(registration) {
  function offerWaitingWorker() {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    pendingUpdate = registration.waiting;
    $('#update-banner').hidden = false;
  }
  function watchInstalling() {
    registration.installing?.addEventListener('statechange', offerWaitingWorker);
  }
  offerWaitingWorker();
  watchInstalling();
  registration.addEventListener('updatefound', watchInstalling);
}

function applyUpdate(target) {
  if (!pendingUpdate) return;
  if (state.locking || activeDialog || (!state.demo && memory.has(draftKey()))) {
    toast('Finish your current check-in before updating.');
    return;
  }
  if (pendingUpdate.state === 'activated') { location.reload(); return; }
  target.disabled = true;
  const onChange = () => location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', onChange, { once: true });
  pendingUpdate.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => {
    navigator.serviceWorker.removeEventListener('controllerchange', onChange);
    target.disabled = false;
  }, 8000);
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  const data = Object.fromEntries(values);
  const kind = form.dataset.form;
  const submit = $('button[type=submit]', form);
  const errorBox = $('.form-error', form);
  submit.disabled = true;
  if (errorBox) errorBox.hidden = true;
  try {
    if (kind === 'note') {
      if (!setDraft(data.day, { note: data.note })) throw new Error('Only an open day can be updated.');
      closeDialog();
      $('[data-action="edit-note"]')?.focus({ preventScroll: true });
    } else if (kind === 'lock-day') {
      if (reviewedDraft?.day !== data.day || reviewedDraft.userId !== state.data.user.id) {
        throw new Error('Review your check-in again before locking.');
      }
      if (JSON.stringify(reviewedDraft.values) !== JSON.stringify(getDraft(data.day)) && !dayLocked(data.day)) {
        reviewDayLock();
        return;
      }
      await lockDay(data.day, reviewedDraft.values);
    } else if (kind === 'profile') {
      data.gymGoal = Number(data.gymGoal);
      data.nutritionGoal = Number(data.nutritionGoal);
      if (state.demo) {
        state.data.user = { ...state.data.user, ...data };
      } else {
        const result = await api('profile', 'PATCH', data);
        state.data.user = result.user;
        persist();
      }
      render();
      toast('Settings saved.');
    } else if (kind.startsWith('auth-')) {
      await api('auth/' + kind.slice(5), 'POST', { ...data, timezone: localZone });
      closeDialog();
      clearLocalAccount();
      await bootstrap();
      toast('Your board is ready.');
    } else if (kind === 'create-circle' || kind === 'join-circle') {
      const result = await api(kind === 'create-circle' ? 'circles' : 'circles/join', 'POST', data);
      closeDialog();
      history.replaceState(null, '', location.pathname + '#circle');
      await bootstrap();
      chooseCircle(result.circle.id);
      render();
      await loadCircle({ quiet: false });
      toast(kind === 'create-circle' ? 'Circle created.' : 'You’re in the circle.');
      if (kind === 'create-circle') showInvite();
    }
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error instanceof RangeError ? 'Choose a valid time zone.' : error.message;
    } else toast(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.view) { navigate(target.dataset.view); return; }
  if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    render();
    $('[data-filter][aria-pressed="true"]')?.focus({ preventScroll: true });
    return;
  }
  const { action, habit, day, user } = target.dataset;
  if (!action || !state.data) return;
  try {
    switch (action) {
      case 'toggle': {
        const marked = !getDraft(day)[habit];
        if (setDraft(day, { [habit]: marked })) showTapMoment(habit, marked);
        break;
      }
      case 'focus-checkin': {
        const firstStamp = $('.habit-stamp[data-action="toggle"]');
        firstStamp?.focus();
        break;
      }
      case 'review-lock': reviewDayLock(); break;
      case 'edit-note': openNote(); break;
      case 'view-day': openDay(day); break;
      case 'auth': showAuth(); break;
      case 'sign-in': showAuth('login'); break;
      case 'close': closeDialog(); break;
      case 'create-circle':
        if (requireOnlineAccount()) formDialog('create-circle', 'Make a circle', 'Start with a name that sounds like your crew.',
          '<label class="field">Circle name<input name="name" required maxlength="36" data-initial-focus placeholder="The Early Crew"></label>', 'Create circle');
        break;
      case 'join-circle': openJoin(); break;
      case 'invite': showInvite(); break;
      case 'copy-link': await copyField('#invite-link'); break;
      case 'copy-code': await copyField('#invite-code'); break;
      case 'rotate-invite':
        openDialog('rotate', 'Reset the invite code?', '<p>The previous link and code will stop working. Your current members will stay in the circle.</p><div class="form-actions">'
          + button('Reset code', 'confirm-rotate', 'primary') + button('Cancel', 'invite', 'quiet') + '</div>');
        break;
      case 'confirm-rotate':
        target.disabled = true;
        await api('circles/' + state.circleId + '/rotate', 'POST');
        await loadCircle();
        showInvite();
        toast('Invite code reset.');
        break;
      case 'leave-circle': {
        const selected = state.data.circles.find(circle => circle.id === state.circleId);
        if (!requireOnlineAccount() || !selected) break;
        const deleting = selected.role === 'owner';
        openDialog('leave', deleting ? 'Delete this circle?' : 'Leave this circle?', '<p>' + (deleting
          ? 'This circle and its Sparks will be deleted. Your personal board will keep all your check-ins.'
          : 'This circle will lose access to your check-ins and you’ll need an invite to join again.') + '</p><div class="form-actions">'
          + button(deleting ? 'Delete circle' : 'Leave circle', 'confirm-leave', 'primary') + button('Cancel', 'close', 'quiet') + '</div>');
        break;
      }
      case 'confirm-leave':
        target.disabled = true;
        await api('circles/' + state.circleId + '/membership', 'DELETE');
        state.circles.delete(state.circleId);
        closeDialog();
        await bootstrap();
        toast('Circle removed from your board.');
        break;
      case 'spark': await spark(user, day, target); break;
      case 'retry':
        target.disabled = true;
        await bootstrap();
        target.disabled = false;
        break;
      case 'retry-circle':
        target.disabled = true;
        await loadCircle({ quiet: false });
        target.disabled = false;
        break;
      case 'apply-update': applyUpdate(target); break;
      case 'install': await showInstall(); break;
      case 'export': await exportData(); break;
      case 'logout': await signOut(); break;
      default: break;
    }
  } catch (error) {
    toast(error.message);
    target.disabled = false;
  }
});

document.addEventListener('change', (event) => {
  const { id, value } = event.target;
  if (id === 'race-rival' && state.circleId && dayLocked()) {
    if (value) save(rivalKey(), value);
    else forget(rivalKey());
    renderCircles(todayKey());
  } else if (id === 'circle-select') {
    chooseCircle(value);
    render();
    void loadCircle({ quiet: false });
  }
});
document.addEventListener('keydown', (event) => {
  const cell = event.target.closest('button.heatmap-cell');
  const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
  if (!cell || !step) return;
  event.preventDefault();
  const day = offsetDay(cell.dataset.day, step);
  const next = cell.parentElement.querySelector('[data-day="' + day + '"]');
  if (!next) return;
  cell.tabIndex = -1;
  next.tabIndex = 0;
  state.heatmapDay = day;
  next.focus();
});
$('#app-dialog').addEventListener('close', () => {
  activeDialog = '';
  reviewedDraft = null;
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus({ preventScroll: true });
});
window.addEventListener('hashchange', () => {
  render();
  if (state.data && getView() === 'circle') void loadCircle();
  maybeInvite();
});
window.addEventListener('online', () => { void bootstrap(); });
window.addEventListener('offline', () => { state.offline = true; render(); });
window.addEventListener('storage', (event) => {
  if (!state.data || state.demo) return;
  if (event.key === prefix + draftKey()) render();
  if (event.key !== prefix + 'snapshot') return;
  const cached = read('snapshot');
  if (cached?.user?.id !== state.data.user.id) { void bootstrap(); return; }
  const day = todayKey();
  if (!dayLocked(day) && cached.checkins[day]) {
    state.data.checkins[day] = cached.checkins[day];
    render();
    if (view === 'circle') void loadCircle();
  }
});
function showNewDay() {
  if (!state.data || lastToday === todayKey()) return false;
  if (!state.locking && ['note', 'lock-day'].includes(activeDialog)) closeDialog();
  if (state.demo) { enterDemo(true); chooseCircle(); }
  render();
  return true;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.booted) return;
  showNewDay();
  if (!state.locking) void bootstrap();
});
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; });
window.addEventListener('appinstalled', () => { state.installPrompt = null; toast('Daymark added to your home screen.'); });
setInterval(() => {
  if (document.visibilityState === 'visible' && showNewDay() && !state.demo && !state.locking) void bootstrap();
}, 1000);
setInterval(() => {
  if (document.visibilityState !== 'visible' || !state.data || state.locking) return;
  if (state.offline) void bootstrap();
  else if (view === 'circle') void loadCircle();
}, 45000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(watchUpdates).catch(() => {});
void bootstrap();
