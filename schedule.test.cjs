'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('./schedule.js');

test('calendar span counts alternate and selected weekday sessions across months', () => {
  const dates = schedule.learningDates({ startDate: '2026-10-26', calendarDays: 14, cadence: { mode: 'alternate' } });
  assert.equal(dates.length, 7);
  assert.equal(dates.at(-1), '2026-11-07');
  assert.deepEqual(schedule.learningDates({ startDate: '2026-10-26', calendarDays: 7, cadence: { mode: 'weekly', weekdays: [1, 3, 5] } }), ['2026-10-26', '2026-10-28', '2026-10-30']);
  assert.deepEqual(schedule.learningDates({ startDate: '2028-02-28', days: 3 }), ['2028-02-28', '2028-02-29', '2028-03-01']);
});

test('reject invalid dates, frequency and fewer than two sessions', () => {
  assert.throws(() => schedule.learningDates({ startDate: '2026-02-30', days: 14 }));
  assert.throws(() => schedule.normalizeCadence({ mode: 'weekly', weekdays: [] }));
  assert.throws(() => schedule.normalizeCadence({ mode: 'weekly', weekdays: [1, 1] }));
  assert.throws(() => schedule.validateScheduleInput({ startDate: '2026-10-10', calendarDays: 2, days: 1 }));
});

test('stored rescheduling can preserve completed off-frequency dates but legacy remains continuous', () => {
  const task = { startDate: '2026-10-10', days: 3, calendarDays: 7, cadence: { mode: 'alternate' }, plan: { days: [{ day: 1, date: '2026-10-10' }, { day: 2, date: '2026-10-11' }, { day: 3, date: '2026-10-16' }] } };
  assert.equal(schedule.validateTimeline(task), task);
  assert.throws(() => schedule.validateTimeline({ ...task, calendarDays: undefined, cadence: undefined }));
  assert.throws(() => schedule.validateTimeline({ ...task, plan: { days: [task.plan.days[0], task.plan.days[0], task.plan.days[2]] } }));
});
