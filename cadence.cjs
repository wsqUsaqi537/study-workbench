'use strict';

const services = require('./services.cjs');
const schedule = require('./schedule.js');

function fail(message) {
  throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function localDate() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

function dayContext(days, today) {
  const source = days.map(day => {
    const preserved = day.date < today || day.completed;
    return {
      day: day.day,
      completed: Boolean(day.completed),
      preserved: Boolean(preserved),
      remaining: !preserved,
      title: day.title,
      tasks: day.tasks.join('；')
    };
  });
  for (let maxChars = 180; maxChars >= 12; maxChars -= 12) {
    const context = source.map(day => ({
      day: day.day,
      title: day.title.slice(0, maxChars),
      tasks: [day.tasks.slice(0, maxChars)],
      completed: day.completed,
      preserved: day.preserved,
      remaining: day.remaining
    }));
    if (JSON.stringify(context).length <= 22000) return context;
  }
  return source.map(day => ({
    day: day.day,
    title: day.title.slice(0, 12),
    tasks: [day.tasks.slice(0, 12)],
    completed: day.completed,
    preserved: day.preserved,
    remaining: day.remaining
  }));
}

function knowledgeFor(task) {
  const existing = task.plan.knowledge;
  if (Array.isArray(existing) && existing.length) {
    services.validateKnowledge(existing, task);
    return clone(existing);
  }
  const outline = task.plan.days.slice(0, 30).map(day => ({
    title: day.title.slice(0, 300),
    priority: '了解',
    explanation: day.tasks.join('；').slice(0, 2000),
    source: task.materials.length || task.plan.mode !== 'basic' ? day.source : '主题与学习目标'
  }));
  services.validateKnowledge(outline, task);
  return outline;
}

function sameLearningDay(left, right) {
  if (!left || !right) return left === right;
  return left.date === right.date && left.title === right.title && left.minutes === right.minutes &&
    left.source === right.source && JSON.stringify(left.tasks) === JSON.stringify(right.tasks);
}

function validateProposal(task, proposal) {
  if (!services.isPlainObject(proposal) || !Array.isArray(proposal.days) || !Array.isArray(proposal.preserved)) {
    fail('学习频率预览格式无效。');
  }
  const cadence = schedule.normalizeCadence(proposal.cadence);
  const calendarDays = task.calendarDays ?? task.days;
  if (proposal.calendarDays !== calendarDays || !schedule.validDate(proposal.today)) fail('学习频率预览日期范围无效。');
  const oldByDate = new Map(task.plan.days.map((day, index) => [day.date, { day, index }]));
  const expectedPreserved = task.plan.days.filter(day => day.date < proposal.today || day.completed);
  if (expectedPreserved.length !== proposal.preserved.length) fail('学习频率预览与保留历史不一致。');

  const rows = [];
  for (const row of proposal.preserved) {
    const old = oldByDate.get(row?.date);
    if (!old || !(old.day.date < proposal.today || old.day.completed) || !sameLearningDay(old.day, row) ||
        old.day.completed !== row.completed) fail('学习频率预览修改了已完成或历史安排。');
    rows.push({ row, oldIndex: old.index });
  }
  const expectedFutureDates = schedule.learningDates({ startDate: task.startDate, calendarDays, cadence })
    .filter(date => date >= proposal.today && !expectedPreserved.some(day => day.date === date));
  if (!expectedFutureDates.length) fail('当前周期内没有可安排的未来学习日期。');
  if (expectedFutureDates.length !== proposal.days.length) fail('学习频率预览与未来日期数量不一致。');
  proposal.days.forEach((row, index) => {
    if (!services.isPlainObject(row) || row.date !== expectedFutureDates[index] || row.completed !== false) {
      fail('学习频率预览中的未来日期无效。');
    }
    rows.push({ row, oldIndex: null });
  });
  rows.sort((left, right) => left.row.date.localeCompare(right.row.date));
  if (rows.length < 2) fail('学习计划至少需要安排两次学习。');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].row;
    if (row.day !== index + 1 || (index > 0 && row.date <= rows[index - 1].row.date)) fail('学习频率预览顺序无效。');
  }
  return { cadence, calendarDays, rows };
}

async function proposeCadence(task, cadenceInput, settings = {}, hooks = {}) {
  if (!services.isPlainObject(task) || !task.plan || !Array.isArray(task.plan.days)) fail('学习计划格式无效。');
  schedule.validateTimeline(task);
  const cadence = schedule.normalizeCadence(cadenceInput);
  const today = hooks.today === undefined ? localDate() : hooks.today;
  if (!schedule.validDate(today)) fail('当前日期无效，无法生成学习频率预览。');
  const calendarDays = task.calendarDays ?? task.days;
  const preservedSource = task.plan.days.filter(day => day.date < today || day.completed);
  const preservedDates = new Set(preservedSource.map(day => day.date));
  const futureDates = schedule.learningDates({ startDate: task.startDate, calendarDays, cadence })
    .filter(date => date >= today && !preservedDates.has(date));
  if (!futureDates.length) fail('当前周期内没有可安排的未来学习日期。');

  const outline = [
    ...preservedSource.map(day => ({ day: day.day, date: day.date, title: day.title, tasks: day.tasks, preserved: true })),
    ...futureDates.map(date => ({ date, preserved: false }))
  ].sort((left, right) => left.date.localeCompare(right.date));
  outline.forEach((item, index) => { item.day = index + 1; });
  if (outline.length < 2) fail('学习计划至少需要安排两次学习。');

  const sessions = outline.filter(item => !item.preserved).map(item => ({ day: item.day, date: item.date }));
  const input = {
    title: task.title,
    goal: task.goal,
    ...(task.brief !== undefined ? { brief: task.brief } : {}),
    ...(task.exam !== undefined ? { exam: clone(task.exam) } : {}),
    learningMode: task.learningMode,
    level: task.level,
    startDate: task.startDate,
    days: outline.length,
    calendarDays,
    cadence,
    minutesPerDay: task.minutesPerDay,
    materials: task.materials
  };
  const hasKnowledge = Array.isArray(task.plan.knowledge) && task.plan.knowledge.length > 0;
  const knowledge = knowledgeFor(task);
  const warning = hasKnowledge ? undefined : (settings.language === 'en'
    ? 'The older plan had no knowledge list; this preview uses a short outline derived from its saved daily tasks.'
    : '旧计划没有知识清单；本次预览依据已保存的每日任务整理简要提纲。');
  const generated = await services.generateDayBatches(input, settings, {
    summary: task.plan.summary || task.goal,
    difficulty: ['入门', '进阶', '较难'].includes(task.plan.difficulty) ? task.plan.difficulty : '入门',
    warnings: Array.isArray(task.plan.warnings) ? task.plan.warnings : [],
    ...(task.plan.studyNotes !== undefined ? { studyNotes: task.plan.studyNotes } : {}),
    knowledge,
    context: dayContext(task.plan.days, today)
  }, sessions, hooks);
  const days = generated;
  const preserved = outline.filter(item => item.preserved).map(item => {
    const source = preservedSource.find(day => day.date === item.date);
    return { ...clone(source), day: item.day };
  });
  const proposal = {
    days,
    preserved,
    calendarDays,
    cadence,
    today,
    summary: settings.language === 'en'
      ? `Keep ${preserved.length} completed or past sessions and reschedule ${days.length} future sessions.`
      : `保留 ${preserved.length} 次已完成或历史学习，重新安排 ${days.length} 次未来学习。`,
    ...(warning ? { warning } : {})
  };
  validateProposal(task, proposal);
  return proposal;
}

function applyCadence(task, proposal) {
  schedule.validateTimeline(task);
  const { cadence, calendarDays, rows } = validateProposal(task, proposal);
  const days = rows.map(({ row }) => clone(row));
  const next = clone(task);
  next.days = days.length;
  next.calendarDays = calendarDays;
  next.cadence = cadence;
  next.plan = { ...next.plan, days };
  if (proposal.warning) {
    const warnings = Array.isArray(next.plan.warnings) ? [...next.plan.warnings] : [];
    if (warnings.length >= 50) warnings[49] = proposal.warning;
    else warnings.push(proposal.warning);
    next.plan.warnings = warnings;
  }

  const oldIndexByDate = new Map(task.plan.days.map((day, index) => [day.date, index]));
  const newIndexByOldIndex = new Map();
  rows.forEach(({ row, oldIndex }) => {
    if (oldIndex !== null) newIndexByOldIndex.set(oldIndex, row.day - 1);
  });
  // Look up retained rows again by their unique dates; this keeps the mapping independent of proposal array order.
  for (const row of proposal.preserved) {
    const oldIndex = oldIndexByDate.get(row.date);
    if (oldIndex !== undefined) newIndexByOldIndex.set(oldIndex, row.day - 1);
  }

  if (task.dailyQuizzes !== undefined) {
    const remapped = {};
    for (const [key, original] of Object.entries(task.dailyQuizzes)) {
      const oldIndex = Number(key);
      const newIndex = newIndexByOldIndex.get(oldIndex);
      if (newIndex === undefined) continue;
      const quiz = clone(original);
      quiz.dayIndex = newIndex;
      if (quiz.result) {
        const oldNext = task.plan.days[oldIndex + 1] || null;
        const newNext = days[newIndex + 1] || null;
        if (quiz.readinessStale || !sameLearningDay(oldNext, newNext)) {
          quiz.readinessStale = true;
          delete quiz.decision;
          delete quiz.supplementCompleted;
        }
      }
      remapped[String(newIndex)] = quiz;
    }
    next.dailyQuizzes = remapped;
  }

  if (task.lessons !== undefined) {
    const remapped = {};
    for (const [key, records] of Object.entries(task.lessons)) {
      const newIndex = newIndexByOldIndex.get(Number(key));
      if (newIndex !== undefined) remapped[String(newIndex)] = clone(records);
    }
    next.lessons = remapped;
  }

  if (task.tutorChats !== undefined) {
    const remapped = {};
    for (const [key, original] of Object.entries(task.tutorChats)) {
      const match = /^daily:(0|[1-9]\d*):(q(?:[1-9]|10))$/.exec(key);
      if (!match) continue;
      const newIndex = newIndexByOldIndex.get(Number(match[1]));
      if (newIndex === undefined) continue;
      const record = clone(original);
      record.dayIndex = newIndex;
      remapped[`daily:${newIndex}:${match[2]}`] = record;
    }
    next.tutorChats = remapped;
  }

  if (task.quiz) {
    if (task.quiz.result) {
      const history = Array.isArray(task.finalQuizHistory) ? clone(task.finalQuizHistory) : [];
      history.push(clone(task.quiz));
      next.finalQuizHistory = history;
    }
    delete next.quiz;
  }
  return next;
}

module.exports = { proposeCadence, applyCadence };
