import { formatDay, offsetDay } from './model.mjs';
import { raceMatchup } from './race-model.mjs';

const marks = {
  gym: { label: 'Gym', icons: ['gym'] },
  nutrition: { label: 'Nutrition', icons: ['diet'] },
  both: { label: 'Both habits', icons: ['gym', 'diet'] },
  rest: { label: 'Rest day' },
  missed: { label: 'No check-in' },
  open: { label: 'Still open' },
  future: { label: 'Upcoming' },
};
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const raceRange = (start, end) => {
  const options = { day: 'numeric', month: 'short' };
  return formatDay(start, options) + ' – ' + formatDay(end, options);
};

export function circleView({ choices, selected, details, userId, rivalId, demo, offline, lockedToday, today, error }, ui) {
  const { escape, icon, avatar, button, panel, empty } = ui;
  const wrap = content => '<div class="circle-space">' + content + '</div>';
  const offlineAttr = offline ? 'disabled' : '';
  const create = () => button('Create circle', 'create-circle', 'secondary', 'plus', offlineAttr);
  const join = () => button('Join with a code', 'join-circle', 'quiet', 'link', offlineAttr);

  if (!selected) {
    return wrap(panel(empty('Find your circle', offline
      ? 'Reconnect to create a circle or join a friend’s.'
      : 'Start a private board with friends, or join one with an invite.', 'users', create() + join()), 'circle-empty'));
  }

  const current = details && (!today || details.today === today);
  const members = lockedToday && current && !details.locked ? details.members : null;
  const invite = details?.circle?.inviteCode || demo
    ? button('Invite', 'invite', 'quiet', 'link', offlineAttr)
    : '';
  const switcher = choices.length > 1
    ? '<label class="circle-switch"><span class="circle-sr-only">Switch circle</span><select id="circle-select">'
      + choices.map(circle => '<option value="' + escape(circle.id) + '"' + (circle.id === selected.id ? ' selected' : '')
        + '>' + escape(circle.name) + '</option>').join('') + '</select></label>'
    : '<h2 class="circle-name">' + escape(selected.name) + '</h2>';
  const header = '<header class="circle-board-header"><div class="circle-board-identity">' + switcher + '</div>' + invite + '</header>';
  const activeCircle = details?.circle || selected;
  const ownerWithMembers = activeCircle.role === 'owner' && activeCircle.memberCount > 1;
  const leave = button(activeCircle.role === 'owner' ? 'Delete circle' : 'Leave circle', 'leave-circle', 'quiet', '',
    offline || ownerWithMembers ? 'disabled' : '');
  const manage = '<details class="circle-disclosure" data-circle-disclosure="management"><summary>'
    + icon('settings') + '<span>Manage circle</span>' + icon('chevron-right', 'icon circle-chevron') + '</summary>'
    + '<div class="circle-management"><div class="button-row">' + create() + join() + leave + '</div>'
    + (ownerWithMembers ? '<p>The owner can delete the circle after the other members leave.</p>' : '')
    + '<p>' + icon('lock') + ' Circle members can see your habit marks. Your notes stay private.</p></div></details>';

  if (!lockedToday) {
    const cover = '<div class="circle-cover"><span class="circle-lock-art" aria-hidden="true">'
      + '<i></i><i></i>' + icon('lock') + '</span><div><h3>Your day comes first</h3>'
      + '<p>Lock today’s check-in to see how your friends showed up.</p></div>'
      + '<a class="button button-primary" href="#dashboard">Go to today ' + icon('arrow-right') + '</a></div>';
    return wrap(panel(header + cover, 'circle-board') + manage);
  }

  if (!members) {
    const waiting = offline
      ? '<p>Reconnect to see your circle’s marks.</p>'
      : error ? '<p>The weekly race didn’t load.</p>' + button('Retry', 'retry-circle', 'secondary')
        : '<p role="status">Loading the weekly race…</p>';
    return wrap(panel(header + '<div class="circle-load">' + waiting + '</div>', 'circle-board') + manage);
  }

  const boardToday = details.boardToday ?? details.today;
  const race = weeklyRace(details, members, boardToday, userId, rivalId, offline, ui);
  const earlier = details.activity.filter(event => event.date < boardToday);
  const history = earlier.length ? '<details class="circle-disclosure" data-circle-disclosure="history"><summary>'
    + icon('clock') + '<span>Earlier marks</span>' + icon('chevron-right', 'icon circle-chevron') + '</summary><ul class="circle-earlier">'
    + earlier.map((event, index) => '<li>' + avatar(event.name, index)
      + '<div><strong>' + (event.userId === userId ? 'You' : escape(event.name)) + '</strong><small>'
      + [event.gym && 'Gym', event.nutrition && 'Nutrition'].filter(Boolean).join(' + ') + ' · ' + escape(formatDay(event.date))
      + '</small></div>' + spark(event, userId, offline, true, ui) + '</li>').join('')
    + '</ul></details>' : '';
  return wrap(panel(header + race, 'circle-board') + lastRaceCard(details.lastRace, userId, ui) + history + manage);
}

function weeklyRace(details, members, boardToday, userId, rivalId, offline, ui) {
  const { escape, icon, avatar } = ui;
  const days = details.weekDates ?? weekdays.map((_, index) => offsetDay(details.weekStart, index));
  const score = member => Number(member.activeDays) || 0;
  const standings = [...members].sort((a, b) => score(b) - score(a));
  const you = standings.find(member => member.id === userId);
  const ordered = you ? [you, ...standings.filter(member => member !== you)] : standings;
  const lead = standings.length ? score(standings[0]) : 0;
  const ranks = new Map();
  const tiedScores = new Set();
  for (const [index, member] of standings.entries()) {
    const total = score(member);
    if (ranks.has(total)) tiedScores.add(total);
    else ranks.set(total, index + 1);
  }
  const todayEvents = new Map(details.activity.filter(event => event.date === boardToday).map(event => [event.userId, event]));
  const activity = new Map(details.activity.map(event => [event.userId + ':' + event.date, event]));
  const timeZone = details.boardTimezone?.split('/').at(-1).replaceAll('_', ' ');
  const boardDayLabel = boardToday === details.today ? 'Today' : formatDay(boardToday, { weekday: 'short', day: 'numeric' });
  const matchup = raceMatchup({ members, userId, rivalId });
  const overall = you && lead ? {
    rank: ranks.get(score(you)),
    tied: tiedScores.has(score(you)),
    gap: lead - score(you),
  } : null;
  const pace = duelCard(matchup, members, raceRange(days[0], days.at(-1)), overall, ui);
  // Team rhythm measures check-ins rather than leaderboard points, so rest days count too.
  const boardIndex = days.indexOf(boardToday);
  const attended = members.filter(member => {
    const mark = member.weekMarks?.[boardIndex] ?? fallbackMark(member, boardToday, boardToday, details.activity);
    return ['gym', 'nutrition', 'both', 'rest'].includes(mark);
  }).length;
  const sharedProgress = '<section class="circle-together" aria-label="Friend circle check-in progress">'
    + '<div class="circle-together-heading"><span>✦ Circle momentum</span><strong>' + attended + ' / ' + members.length + ' checked in</strong></div>'
    + '<div class="circle-together-track" role="progressbar" aria-label="Circle members who checked in" aria-valuemin="0" aria-valuemax="' + members.length
    + '" aria-valuenow="' + attended + '"><span style="width:' + (members.length ? attended / members.length * 100 : 0) + '%"></span></div>'
    + '<small>Every check-in matters, including recovery days. The race still counts active days.</small></section>';

  const axis = '<div class="circle-lane circle-axis" aria-hidden="true"><span>Member</span><div class="circle-week">'
    + weekdays.map((name, index) => '<span' + (days[index] === boardToday ? ' class="is-today"' : '') + '>'
      + name + '</span>').join('') + '</div><span>Active</span><span>Spark</span></div>';
  const rows = ordered.map((member, index) => {
    const isSelf = member === you;
    const isRival = member.id === matchup?.rival?.id;
    const total = score(member);
    const rank = ranks.get(total);
    const shared = tiedScores.has(total);
    const rankLabel = lead ? ', ' + (shared ? 'tied for rank ' : 'rank ') + rank : '';
    const week = member.weekMarks ?? days.map(day => fallbackMark(member, day, boardToday, activity));
    const currentMark = marks[week[days.indexOf(boardToday)]] ?? marks.future;
    const track = days.map((day, index) => dayMark(week[index], day, day === boardToday, ui)).join('');
    return '<li class="circle-lane circle-race-row' + (isSelf ? ' is-self' : '') + (isRival ? ' is-rival' : '') + '"><div class="circle-person">'
      + avatar(member.name, index) + '<div><strong title="' + escape(member.name) + '">' + (isSelf ? 'You' : escape(member.name))
      + '</strong><small>' + escape(boardDayLabel) + ' · ' + currentMark.label + '</small></div></div>'
      + '<div class="circle-week circle-track" role="group" aria-label="Monday to Sunday">' + track + '</div>'
      + '<div class="circle-race-score' + (lead > 0 && rank === 1 ? ' is-leading' : '') + '" role="group" aria-label="' + total
      + ' active ' + (total === 1 ? 'day' : 'days') + rankLabel + '"><strong aria-hidden="true">' + total + '</strong><small aria-hidden="true">'
      + (total === 1 ? 'day' : 'days') + '</small>' + (lead ? '<span aria-hidden="true">' + (shared ? 'Tied #' : '#') + rank + '</span>' : '') + '</div>'
      + '<div class="circle-race-spark">' + spark(todayEvents.get(member.id), userId, offline, false, ui) + '</div></li>';
  }).join('');
  const legend = '<div class="circle-legend">' + ['gym', 'nutrition', 'both', 'rest', 'open', 'missed'].map(key =>
    '<span>' + dayMark(key, null, false, ui) + ' ' + marks[key].label + '</span>').join('') + '</div>';
  const footer = '<p class="circle-race-foot">One point per day with at least one habit. ' + (offline ? 'Offline · Showing the last marks loaded.' : '')
    + (offline && timeZone ? ' ' : '') + (timeZone ? 'Week resets Monday · ' + escape(timeZone) + ' time' : '') + '</p>';
  return pace + sharedProgress + '<div class="circle-race">' + axis + '<ol class="circle-race-rows" role="list" aria-label="Circle standings">'
    + rows + '</ol></div>' + legend + footer;
}

function duelCard(matchup, members, weekRange, overall, { escape, icon }) {
  if (!matchup) return '';
  const { you, rival, gap, manual, title, detail, tone } = matchup;
  const candidates = members.filter(member => member.id !== you.id);
  const picker = candidates.length ? '<label class="circle-duel-picker"><span class="circle-sr-only">Choose a pace rival</span>'
    + '<select id="race-rival"><option value="">Auto rival</option>'
    + candidates.map(member => '<option value="' + escape(member.id) + '"' + (manual && member.id === rival?.id ? ' selected' : '')
      + '>' + escape(member.name) + '</option>').join('') + '</select></label>' : '';
  const lanes = duelLane(you, 'You', 'self', Boolean(rival) && gap > 0, escape)
    + (rival ? duelLane(rival, rival.name, 'rival', gap < 0, escape) : '');
  const badge = tone === 'clinched' || tone === 'ahead' ? 'trophy' : 'target';
  const position = overall && rival ? '<p class="circle-duel-position">Circle #' + overall.rank + (overall.tied ? ' (tied)' : '')
    + (overall.gap ? ' <span>· ' + overall.gap + ' ' + (overall.gap === 1 ? 'day' : 'days') + ' off the lead</span>' : '') + '</p>' : '';
  return '<section class="circle-pace" aria-label="' + (rival ? 'Weekly pace duel' : 'Your weekly race') + '">'
    + '<div class="circle-duel-top"><p class="circle-pace-week">' + icon('spark') + ' Weekly race <span>' + escape(weekRange) + '</span></p>'
    + picker + '</div><div class="circle-duel-main"><div class="circle-pace-copy">'
    + '<span class="circle-pace-badge" aria-hidden="true">' + icon(badge) + '</span>'
    + '<h3>' + escape(title) + '</h3><p class="circle-pace-rule">' + escape(detail) + '</p>' + position + '</div>'
    + '<div class="circle-duel-board"><p class="circle-duel-caption">' + (rival ? 'Pace duel' : 'Your pace') + '<span>Active days</span></p>'
    + lanes + '</div></div></section>';
}

function duelLane(runner, label, variant, leading, escape) {
  const track = Array.from({ length: 7 }, (_, index) => {
    const state = index < runner.score ? ' is-filled' : index < runner.max ? ' is-reachable' : '';
    return '<span class="circle-duel-step' + state + '"></span>';
  }).join('');
  const safeLabel = escape(label);
  return '<div class="circle-duel-lane is-' + variant + '"><div class="circle-duel-lane-title">'
    + '<span class="circle-duel-name" title="' + safeLabel + '">' + safeLabel + '</span>'
    + (leading ? '<span class="circle-duel-lead">Ahead</span>' : '')
    + '<span class="circle-duel-number" role="group" aria-label="' + runner.score + ' of 7 active days"><b aria-hidden="true">' + runner.score
    + '</b><small aria-hidden="true">/ 7</small></span>'
    + '</div><div class="circle-duel-track" aria-hidden="true">' + track + '</div></div>';
}

function lastRaceCard(race, userId, { escape, icon }) {
  if (!race?.settled || !race.standings?.length) return '';
  const score = race.standings[0].activeDays;
  const winners = race.standings.filter(member => member.activeDays === score);
  const labels = winners.map(member => member.id === userId ? 'You' : member.name);
  const caption = winners.length > 1 ? 'Last week’s co-winners' : 'Last week’s winner';
  const names = new Intl.ListFormat(undefined, { type: 'conjunction' }).format(labels);
  const own = race.standings.find(member => member.id === userId);
  const place = own && own.activeDays < score ? '<p class="circle-last-race-place">You finished '
    + (race.standings.filter(member => member.activeDays === own.activeDays).length > 1 ? 'tied for ' : '')
    + '#' + (1 + race.standings.filter(member => member.activeDays > own.activeDays).length) + '</p>' : '';
  return '<section class="circle-last-race" aria-label="' + caption + '"><div class="circle-last-race-icon" aria-hidden="true">' + icon('trophy')
    + '</div><div class="circle-last-race-copy"><p>' + caption + ' <span>' + escape(raceRange(race.start, race.end))
    + '</span></p><h3>' + escape(names) + '</h3>' + place + '</div><div class="circle-last-race-score"><strong>' + score
    + '</strong><span>active ' + (score === 1 ? 'day' : 'days') + '</span></div></section>';
}

function fallbackMark(member, day, boardToday, activity) {
  if (day > boardToday) return 'future';
  const event = activity.get(member.id + ':' + day);
  const gym = event?.gym || (day === boardToday && member.gymToday);
  const nutrition = event?.nutrition || (day === boardToday && member.nutritionToday);
  if (gym && nutrition) return 'both';
  if (gym) return 'gym';
  if (nutrition) return 'nutrition';
  if (day === boardToday) return member.submittedToday ? 'rest' : 'open';
  return 'missed';
}

function dayMark(value, day, today, { icon, escape }) {
  const key = Object.hasOwn(marks, value) ? value : 'future';
  const mark = marks[key];
  const label = day ? formatDay(day, { weekday: 'long', month: 'short', day: 'numeric' }) + ' · ' + mark.label : mark.label;
  const accessible = day ? ' role="img" aria-label="' + escape(label) + '" title="' + escape(label) + '"' : ' aria-hidden="true"';
  const glyph = mark.icons ? mark.icons.map(name => icon(name)).join('') : '<i></i>';
  return '<span class="circle-day-mark is-' + key + (today ? ' is-today' : '') + '"' + accessible + '>' + glyph + '</span>';
}

function spark(event, userId, offline, historical, { escape, icon }) {
  if (!event) return '';
  const count = Number(event.reactionCount) || 0;
  if (event.userId === userId) return count ? '<span class="circle-sparks-received" aria-label="' + count
    + (count === 1 ? ' Spark received' : ' Sparks received') + '">' + icon('spark') + ' ' + count + '</span>' : '';
  const action = (event.reacted ? 'Remove Spark for ' : 'Send a Spark to ') + event.name;
  const label = action + (historical ? ' on ' + formatDay(event.date) : '');
  return '<button class="circle-spark' + (event.reacted ? ' is-lit' : '') + '" type="button" data-action="spark" data-day="'
    + escape(event.date) + '" data-user="' + escape(event.userId) + '" aria-pressed="' + Boolean(event.reacted) + '" aria-label="'
    + escape(label) + '" title="' + escape(label) + '"' + (offline ? ' disabled' : '') + '>' + icon('spark')
    + (count ? '<span aria-hidden="true">' + count + '</span>' : '') + '</button>';
}
