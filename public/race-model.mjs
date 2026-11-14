const raceDays = 7;

function lane(member) {
  const score = Math.max(0, Math.min(raceDays, Math.trunc(member.activeDays) || 0));
  const week = Array.isArray(member.weekMarks) ? member.weekMarks : [];
  const available = week.slice(0, raceDays)
    .filter(mark => mark === 'open' || mark === 'future').length;
  const remaining = Math.min(raceDays - score, available);
  return { id: member.id, name: member.name, score, remaining, max: score + remaining };
}

function closestRival(friends, score) {
  const ahead = friends.filter(friend => friend.score > score)
    .sort((first, second) => first.score - second.score);
  return ahead[0] ?? [...friends].sort((first, second) => second.score - first.score)[0] ?? null;
}

function activeDays(count) {
  return count + ' active ' + (count === 1 ? 'day' : 'days');
}

function describeMatchup(you, rival, gap, canForecast) {
  if (!rival) {
    return {
      title: 'Set your own pace.',
      detail: 'Invite a friend for a head-to-head race.',
      tone: 'neutral',
    };
  }

  if (gap === 0) {
    if (canForecast && !you.remaining && !rival.remaining) {
      return { title: 'You finish level.', detail: 'Both scored ' + activeDays(you.score) + '.', tone: 'tied' };
    }
    if (!you.score) {
      return { title: 'The race is open.', detail: 'The first active day sets the pace.', tone: 'neutral' };
    }
    let detail = 'You share the same score this week.';
    if (canForecast && !you.remaining) detail = 'Your rival can still move ahead.';
    else if (canForecast) detail = rival.remaining
      ? 'One active day puts you ahead if your rival stays put.'
      : 'One more active day puts you ahead of your rival.';
    return { title: 'You’re tied.', detail, tone: 'tied' };
  }

  if (gap > 0) {
    if (canForecast && you.score > rival.max) {
      return {
        title: 'Matchup clinched.',
        detail: 'Your lead of ' + activeDays(gap) + ' is out of reach.',
        tone: 'clinched',
      };
    }
    return {
      title: 'You lead by ' + activeDays(gap) + '.',
      detail: canForecast && you.remaining && you.score === rival.max
        ? 'One more active day would clinch the matchup.'
        : 'Your rival needs ' + activeDays(gap) + ' to tie if your score holds.',
      tone: 'ahead',
    };
  }

  const toTie = -gap;
  const title = 'You’re ' + activeDays(toTie) + ' behind.';
  if (canForecast && you.max < rival.score) {
    return { title, detail: 'This matchup is out of reach. The race resets Monday.', tone: 'chasing' };
  }
  const condition = !canForecast || rival.remaining ? ' if your rival stays put' : '';
  const maximum = canForecast ? you.max : raceDays;
  const nextTarget = maximum === rival.score
    ? activeDays(toTie) + ' to tie'
    : toTie + ' to tie, ' + (toTie + 1) + ' to pass';
  return { title, detail: nextTarget + condition + '.', tone: 'chasing' };
}

export function raceMatchup({ members, userId, rivalId }) {
  const ownMember = members.find(member => member.id === userId);
  if (!ownMember) return null;

  const you = lane(ownMember);
  const friends = members.filter(member => member.id !== userId).map(lane);
  const selected = friends.find(friend => friend.id === rivalId);
  const rival = selected ?? closestRival(friends, you.score);
  const gap = rival ? you.score - rival.score : null;
  const rivalMember = members.find(member => member.id === rival?.id);
  const canForecast = [ownMember.weekMarks, rivalMember?.weekMarks]
    .every(week => Array.isArray(week) && week.length === raceDays);
  return { you, rival, gap, manual: Boolean(selected), ...describeMatchup(you, rival, gap, canForecast) };
}
