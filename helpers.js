// helpers.js — pure functions only (no DOM, no IndexedDB), so these can be
// unit-tested directly in Node. Loaded as a plain script in the browser too.

// Parse a 'YYYY-MM-DD' string as LOCAL midnight, never UTC.
// new Date('YYYY-MM-DD') parses as UTC midnight, which silently shifts the
// displayed day backwards in any positive-UTC-offset timezone (e.g. AEST).
function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayLocalStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLong(dateStr) {
  const d = parseLocalDate(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = parseLocalDate(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Age in whole years + remaining months, as of `onDateStr` (defaults to today).
function calcAge(birthdayStr, onDateStr) {
  if (!birthdayStr) return null;
  const birth = parseLocalDate(birthdayStr);
  const on = onDateStr ? parseLocalDate(onDateStr) : new Date();

  let years = on.getFullYear() - birth.getFullYear();
  let months = on.getMonth() - birth.getMonth();
  if (on.getDate() < birth.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return { years: 0, months: 0 };
  return { years, months };
}

function formatAge(age) {
  if (!age) return '';
  const { years, months } = age;
  if (years === 0 && months === 0) return 'Newborn';
  const parts = [];
  if (years > 0) parts.push(`${years} yr${years === 1 ? '' : 's'}`);
  if (months > 0) parts.push(`${months} mo${months === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// Entries whose month+day matches today's month+day, excluding this year.
function onThisDayEntries(entries, todayDateStr) {
  const today = parseLocalDate(todayDateStr);
  const mm = today.getMonth();
  const dd = today.getDate();
  const thisYear = today.getFullYear();
  return entries.filter((e) => {
    const d = parseLocalDate(e.date);
    return d.getMonth() === mm && d.getDate() === dd && d.getFullYear() !== thisYear;
  });
}

function groupEntriesByMonth(entries) {
  const groups = [];
  const byKey = new Map();
  for (const entry of entries) {
    const d = parseLocalDate(entry.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!byKey.has(key)) {
      const group = {
        key,
        label: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
        entries: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).entries.push(entry);
  }
  // groups follow entries' order, which callers keep newest-first.
  return groups;
}

function kgToLb(kg) {
  return kg * 2.2046226218;
}

function lbToKg(lb) {
  return lb / 2.2046226218;
}

// Build normalized SVG points + a polyline path for a weight chart.
// weights: [{date, weightKg}] sorted ascending by date.
// Returns null if fewer than 1 point.
function buildWeightChartPoints(weights, width, height, padding = 24) {
  if (!weights || weights.length === 0) return null;

  const values = weights.map((w) => w.weightKg);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    // Flat line: pad the range so it doesn't collapse to a single height.
    min -= 1;
    max += 1;
  }

  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const n = weights.length;

  const points = weights.map((w, i) => {
    const x = n === 1 ? width / 2 : padding + (innerW * i) / (n - 1);
    const t = (w.weightKg - min) / (max - min);
    const y = padding + innerH * (1 - t);
    return { x, y, date: w.date, weightKg: w.weightKg };
  });

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  return { points, path, min, max };
}

// Whole days from todayStr to dateStr. Positive = future, negative = past.
function daysUntil(dateStr, todayStr) {
  const target = parseLocalDate(dateStr);
  const today = parseLocalDate(todayStr);
  return Math.round((target - today) / 86400000);
}

// Vaccination-type entries whose nextDueDate is overdue or within `windowDays`,
// soonest/most-overdue first.
function upcomingCareReminders(entries, todayStr, windowDays = 30) {
  return entries
    .filter((e) => e.type === 'vaccination' && e.nextDueDate)
    .map((e) => ({ entry: e, daysUntil: daysUntil(e.nextDueDate, todayStr) }))
    .filter((r) => r.daysUntil <= windowDays)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

// Case-insensitive substring match against caption + tags, plus an optional
// exact type filter ('all' or a specific entry type).
function filterEntries(entries, { query, type } = {}) {
  let result = entries;
  if (type && type !== 'all') {
    result = result.filter((e) => e.type === type);
  }
  const q = (query || '').trim().toLowerCase();
  if (q) {
    result = result.filter((e) => {
      const haystack = [e.caption || '', ...(e.tags || [])].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  return result;
}

// Aggregate totals for 'walk' type entries, optionally restricted to entries
// with date >= sinceDateStr (inclusive).
function walkStats(entries, sinceDateStr) {
  const walks = entries.filter((e) => e.type === 'walk' && (!sinceDateStr || e.date >= sinceDateStr));
  const totalKm = walks.reduce((sum, w) => sum + (w.distanceKm || 0), 0);
  const totalMin = walks.reduce((sum, w) => sum + (w.durationMin || 0), 0);
  return { count: walks.length, totalKm, totalMin };
}

// Everything needed to render a "year in review" card for one dog.
function buildYearRecap(entries, weights, year) {
  const yearEntries = entries.filter((e) => parseLocalDate(e.date).getFullYear() === year);
  const yearWeights = weights
    .filter((w) => parseLocalDate(w.date).getFullYear() === year)
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  const byType = {};
  for (const e of yearEntries) byType[e.type] = (byType[e.type] || 0) + 1;

  const favorites = yearEntries.filter((e) => e.favorite);
  const milestones = yearEntries.filter((e) => e.type === 'milestone');
  const walks = walkStats(yearEntries);

  let weightChange = null;
  if (yearWeights.length >= 2) {
    weightChange = yearWeights[yearWeights.length - 1].weightKg - yearWeights[0].weightKg;
  }

  return {
    year,
    totalEntries: yearEntries.length,
    byType,
    favorites,
    milestones,
    walks,
    weight: {
      first: yearWeights[0] || null,
      last: yearWeights[yearWeights.length - 1] || null,
      change: weightChange,
    },
  };
}

// Distinct years present across entries + weights, newest first. Always
// includes the current year so the recap picker has something to show.
function yearsWithData(entries, weights, todayStr) {
  const years = new Set([parseLocalDate(todayStr).getFullYear()]);
  entries.forEach((e) => years.add(parseLocalDate(e.date).getFullYear()));
  weights.forEach((w) => years.add(parseLocalDate(w.date).getFullYear()));
  return [...years].sort((a, b) => b - a);
}

const api = {
  parseLocalDate,
  todayLocalStr,
  formatDateLong,
  formatDateShort,
  calcAge,
  formatAge,
  onThisDayEntries,
  groupEntriesByMonth,
  kgToLb,
  lbToKg,
  buildWeightChartPoints,
  daysUntil,
  upcomingCareReminders,
  filterEntries,
  walkStats,
  buildYearRecap,
  yearsWithData,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.Helpers = api;
}
