export const habits = {
  gym: { label: 'Gym', icon: 'gym' },
  nutrition: { label: 'Nutrition', icon: 'diet' },
};
const dayFormats = new Map();
const zoneFormats = new Map();

export function dayInZone(timezone, now = new Date()) {
  if (!zoneFormats.has(timezone)) {
    zoneFormats.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  const pieces = zoneFormats.get(timezone).formatToParts(now);
  return ['year', 'month', 'day'].map(type => pieces.find(piece => piece.type === type).value).join('-');
}

export function dateFor(day) {
  return new Date(day + 'T12:00:00Z');
}

export function offsetDay(day, amount) {
  const date = dateFor(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(day) {
  return offsetDay(day, -((dateFor(day).getUTCDay() + 6) % 7));
}

export function formatDay(day, options = { month: 'short', day: 'numeric' }) {
  const key = JSON.stringify(options);
  if (!dayFormats.has(key)) {
    dayFormats.set(key, new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }));
  }
  return dayFormats.get(key).format(dateFor(day));
}

export function hasCheckin(checkin) {
  return Boolean(checkin?.gym || checkin?.nutrition);
}

export function checkinLevel(checkin, filter = 'all') {
  if (filter !== 'all') return Number(Boolean(checkin?.[filter === 'diet' ? 'nutrition' : filter]));
  return Number(Boolean(checkin?.gym)) + Number(Boolean(checkin?.nutrition));
}

export function weekBoard(checkins, today) {
  const monday = mondayOf(today);
  const dates = Array.from({ length: 7 }, (_, index) => offsetDay(monday, index));
  const marks = dates.map(day => {
    if (day > today) return 'future';
    const log = checkins[day];
    if (!log) return day === today ? 'open' : 'missed';
    if (log.gym && log.nutrition) return 'both';
    if (log.gym) return 'gym';
    return log.nutrition ? 'nutrition' : 'rest';
  });
  return { dates, marks };
}

function streaks(days, today, finishedToday) {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const day of days) {
    run = previous && offsetDay(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  const recent = previous === today || (!finishedToday && previous === offsetDay(today, -1));
  return { current: recent ? run : 0, best };
}

export function summarize(checkins, today) {
  const checkinDays = Object.keys(checkins).filter(day => day <= today).sort();
  const activeDays = checkinDays.filter(day => hasCheckin(checkins[day]));
  const { current, best } = streaks(activeDays, today, Object.hasOwn(checkins, today));
  const attendance = streaks(checkinDays, today, false);
  const week = { gym: 0, nutrition: 0, activeDays: 0, checkinDays: 0 };
  for (let day = mondayOf(today); day <= today; day = offsetDay(day, 1)) {
    for (const habit of Object.keys(habits)) week[habit] += Number(Boolean(checkins[day]?.[habit]));
    week.activeDays += Number(hasCheckin(checkins[day]));
    week.checkinDays += Number(Object.hasOwn(checkins, day));
  }
  return {
    current, best, week, checkinStreak: attendance.current, bestCheckinStreak: attendance.best,
    activeDays: activeDays.length,
    last28: activeDays.filter(active => active >= offsetDay(today, -27)).length,
  };
}

export function makeDemo(timezone) {
  const today = dayInZone(timezone);
  const checkins = {};
  for (let age = 1; age < 174; age++) {
    const day = offsetDay(today, -age);
    const rank = (age * 19 + Math.floor(age / 7) * 11) % 31;
    const gym = rank < 12 && age < 165;
    const nutrition = (rank < 5 || rank > 17) && age < 169;
    if (gym || nutrition) checkins[day] = { gym, nutrition, note: '' };
  }
  for (let age = 1; age <= 5; age++) {
    checkins[offsetDay(today, -age)] = { gym: age % 2 === 0, nutrition: age !== 3, note: '' };
  }
  delete checkins[offsetDay(today, -6)];
  const circle = { id: 'example', name: 'The Early Crew', role: 'member', memberCount: 4 };
  const examples = [
    ['maya', 'Maya Chen', { [today]: { gym: true, nutrition: true }, [offsetDay(today, -1)]: { gym: true } }],
    ['leo', 'Leo Patel', { [today]: { gym: false, nutrition: false }, [offsetDay(today, -2)]: { gym: true, nutrition: true } }],
    ['jules', 'Jules Rivera', { [offsetDay(today, -1)]: { nutrition: true } }],
    ['demo', 'Alex Morgan', checkins],
  ];
  const week = weekBoard(checkins, today);
  for (const day of week.dates) {
    if (day < today) examples[0][2][day] ??= { nutrition: true };
  }
  const lastStart = offsetDay(week.dates[0], -7);
  const lastEnd = offsetDay(week.dates[0], -1);
  const previousSchedules = [[0, 1, 2, 3, 5], [0, 2, 3], [1, 2, 4, 6]];
  for (const [index, schedule] of previousSchedules.entries()) {
    for (const offset of schedule) {
      examples[index][2][offsetDay(lastStart, offset)] ??= { gym: offset % 2 === 0, nutrition: true };
    }
  }
  const lastRace = {
    start: lastStart, end: lastEnd, settled: true,
    standings: examples.map(([id, name, logs]) => ({
      id, name, activeDays: summarize(logs, lastEnd).week.activeDays,
    })).sort((a, b) => b.activeDays - a.activeDays),
  };
  const members = examples.map(([id, name, logs]) => {
    const { week, current } = summarize(logs, today);
    return {
      id, name, gymDays: week.gym, nutritionDays: week.nutrition, activeDays: week.activeDays, streak: current,
      gymToday: Boolean(logs[today]?.gym), nutritionToday: Boolean(logs[today]?.nutrition), submittedToday: Boolean(logs[today]),
      weekMarks: weekBoard(logs, today).marks,
    };
  });
  const activity = examples.flatMap(([id, name, logs]) => Object.entries(logs)
    .filter(([day, log]) => day >= offsetDay(today, -7) && hasCheckin(log))
    .map(([day, log]) => ({ id: id + ':' + day, userId: id, name, date: day,
      gym: Boolean(log.gym), nutrition: Boolean(log.nutrition), reactionCount: day === today ? 2 : 0, reacted: false,
    }))).sort((a, b) => b.date.localeCompare(a.date));
  return {
    data: {
      user: { id: 'demo', name: 'Alex Morgan', timezone, gymGoal: 4, nutritionGoal: 6 },
      today, checkins, circles: [circle],
    },
    circle: { circle, members, activity, today, boardToday: today, boardTimezone: timezone, weekDates: week.dates, weekStart: week.dates[0], lastRace },
  };
}
