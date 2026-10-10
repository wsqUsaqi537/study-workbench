(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudySchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function formatDate(start, offset) {
    if (!validDate(start) || !Number.isInteger(offset)) throw new Error('学习日期无效。');
    const date = new Date(start + 'T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  }

  function normalizeCadence(value) {
    if (value === undefined) return { mode: 'daily', weekdays: [] };
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !['daily', 'alternate', 'weekly'].includes(value.mode) ||
        Object.keys(value).some(key => !['mode', 'weekdays'].includes(key))) throw new Error('学习频率格式无效。');
    const weekdays = value.weekdays === undefined ? [] : value.weekdays;
    if (!Array.isArray(weekdays) || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(weekdays).size !== weekdays.length) throw new Error('请选择有效的学习星期。');
    if (value.mode === 'weekly' && weekdays.length === 0) throw new Error('每周学习至少选择一个星期。');
    return { mode: value.mode, weekdays: value.mode === 'weekly' ? [...weekdays].sort((a, b) => a - b) : [] };
  }

  function validateScheduleInput(input) {
    if (!input || !validDate(input.startDate)) throw new Error('学习开始日期无效。');
    const span = input.calendarDays === undefined ? input.days : input.calendarDays;
    if (!Number.isInteger(span) || span < 2 || span > 180) throw new Error('学习周期必须为 2 至 180 个日历日。');
    if (!Number.isInteger(input.days) || input.days < 2 || input.days > span) throw new Error('所选周期和频率至少需要安排两次学习。');
    normalizeCadence(input.cadence);
    return input;
  }

  function learningDates(input) {
    if (!validDate(input?.startDate)) throw new Error('学习开始日期无效。');
    const span = input.calendarDays === undefined ? input.days : input.calendarDays;
    if (!Number.isInteger(span) || span < 2 || span > 180) throw new Error('学习周期必须为 2 至 180 个日历日。');
    const cadence = normalizeCadence(input.cadence);
    const dates = [];
    for (let offset = 0; offset < span; offset += 1) {
      const date = formatDate(input.startDate, offset);
      if (cadence.mode === 'daily' || (cadence.mode === 'alternate' && offset % 2 === 0) ||
          (cadence.mode === 'weekly' && cadence.weekdays.includes(new Date(date + 'T00:00:00.000Z').getUTCDay()))) dates.push(date);
    }
    return dates;
  }

  function validateTimeline(task) {
    validateScheduleInput(task);
    if (!task.plan || !Array.isArray(task.plan.days) || task.plan.days.length !== task.days) throw new Error('学习计划与学习次数不一致。');
    const end = formatDate(task.startDate, (task.calendarDays === undefined ? task.days : task.calendarDays) - 1);
    let previous = '';
    task.plan.days.forEach((day, index) => {
      if (!day || day.day !== index + 1 || !validDate(day.date) || day.date < task.startDate || day.date > end || day.date <= previous ||
          (task.calendarDays === undefined && task.cadence === undefined && day.date !== formatDate(task.startDate, index))) throw new Error('学习计划日期或顺序无效。');
      previous = day.date;
    });
    return task;
  }

  return { validDate, formatDate, normalizeCadence, validateScheduleInput, learningDates, validateTimeline };
});
