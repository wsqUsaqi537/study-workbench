'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cadence = require('./cadence.cjs');
const assessment = require('./assessment.cjs');
const tutoring = require('./tutoring.cjs');

const dayOffset = (start, offset) => {
  const date = new Date(`${start}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

function makeTask({ days = 14, startDate = '2026-10-01', completed = [], withMaterial = false } = {}) {
  const source = withMaterial ? '课件.pdf 第 1 页' : '主题与学习目标';
  const materialText = '【第 1 页】私密课程原文，不应发送到服务。';
  return {
    id: 'cadence-test-task',
    title: 'Python 记账小程序',
    goal: '掌握变量、循环和函数，完成一个记账小程序。',
    level: 'beginner',
    learningMode: 'balanced',
    startDate,
    days,
    minutesPerDay: 60,
    materials: withMaterial ? [{ id: 'm1', name: '课件.pdf', units: 1, chars: materialText.length, text: materialText }] : [],
    plan: {
      mode: 'ai',
      summary: '逐步学习 Python 基础。',
      difficulty: '入门',
      warnings: [],
      knowledge: [{ title: '变量与循环', priority: '重点', explanation: '变量保存数据，循环重复执行操作。', source }],
      days: Array.from({ length: days }, (_, index) => ({
        day: index + 1,
        date: dayOffset(startDate, index),
        title: index === days - 1 ? '综合复习' : `第 ${index + 1} 天：变量练习`,
        minutes: 45,
        tasks: [
          index === days - 1 ? '完成 5 题小测，用时 10 分钟；完成 10 题周期测验，用时 20 分钟。' : '理解变量并完成练习。',
          ...(index === days - 1 ? [] : ['完成 5 题小测，用时 10 分钟。'])
        ],
        source,
        completed: completed.includes(index)
      }))
    }
  };
}

function dailyQuestions() {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`,
    type: index === 0 ? 'choice' : 'fill',
    question: index === 0 ? '关于变量，哪项正确？' : `请说明第 ${index + 1} 个概念。`,
    options: index === 0 ? ['正确项', '错误项一', '错误项二', '错误项三'] : [],
    answer: index === 0 ? 'A' : `概念${index + 1}`,
    alternatives: index === 0 ? [] : [],
    reference: '变量保存数据，供程序后续使用。',
    rubric: '说明核心概念。'
  }));
}

function ratedDailyQuiz(dayIndex) {
  const questions = dailyQuestions();
  return {
    version: 2,
    mode: 'ai',
    kind: 'daily',
    dayIndex,
    questions,
    generatedDate: '2026-10-01',
    answers: Object.fromEntries(questions.map(question => [question.id, { text: question.type === 'choice' ? 'A' : question.answer }])),
    resultDate: '2026-10-05',
    result: {
      mode: 'ai', score: 100, feedback: '核心概念掌握良好。',
      items: questions.map(question => ({ id: question.id, score: 20, feedback: '回答正确。' })),
      weakPoints: [],
      report: {
        summary: '能够说明核心概念。', strengths: ['理解变量用途'], nextSteps: ['继续练习'],
        readyForNext: true, reason: '第 1 题体现出对核心概念的理解。', extraMinutes: 0, extraTasks: []
      }
    }
  };
}

function legacyFinalQuiz() {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`,
    question: `请说明第 ${index + 1} 个知识点。`,
    reference: '参考内容。',
    rubric: '说明核心知识。'
  }));
  return {
    mode: 'ai',
    questions,
    answers: Object.fromEntries(questions.map(question => [question.id, { text: '我的回答' }])),
    resultDate: '2026-10-05',
    result: {
      mode: 'ai', score: 100, feedback: '整体掌握良好。', weakPoints: [],
      items: questions.map(question => ({ id: question.id, score: 20, feedback: '回答正确。' }))
    }
  };
}

function legacyBasicTask() {
  const task = makeTask({ days: 4, startDate: '2026-10-01' });
  task.plan.mode = 'basic';
  delete task.plan.knowledge;
  task.plan.days.forEach(day => { day.source = '旧版基础计划'; });
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`,
    question: `请说明第 ${index + 1} 个知识点。`,
    reference: '参考内容。',
    rubric: '说明核心知识。'
  }));
  task.quiz = {
    mode: 'basic',
    questions,
    answers: Object.fromEntries(questions.map((question, index) => [question.id, {
      text: '这是旧版历史答案。',
      ...(index === 0 ? {} : { rating: 12 })
    }])),
    resultDate: '2026-10-02',
    result: {
      mode: 'basic', score: 60, feedback: '旧版基础测验结果保留为历史记录。',
      items: questions.map(question => ({ id: question.id, score: 12, feedback: '旧版历史反馈。' })),
      weakPoints: []
    }
  };
  return task;
}

async function mockGenerator(t) {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    const payload = JSON.parse(requestBody.messages[1].content);
    requests.push(payload);
    const days = payload.sessions.map(session => ({
      day: session.day,
      date: session.date,
      title: `新安排 ${session.day}`,
      minutes: 45,
      tasks: [
        '完成 5 题小测，用时 10 分钟。',
        ...(session.day === payload.days ? ['完成 10 题周期测验，用时 20 分钟。'] : [])
      ],
      source: payload.allowedSources[0]
    }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ days }) } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  t.after(() => { global.fetch = originalFetch; });
  return {
    requests,
    settings: { endpoint: 'https://mock.invalid/v1', model: 'cadence-mock', key: 'test-key' }
  };
}

test('weekly cadence preserves past/completed rows and remaps dated caches and final history', async t => {
  const task = makeTask({ completed: [9], withMaterial: true });
  task.dailyQuizzes = { '4': ratedDailyQuiz(4), '9': ratedDailyQuiz(9) };
  const retainedDay = task.plan.days[9];
  task.lessons = { '9': { brief: {
    text: '已保存讲解。', sources: ['课件.pdf 第 1 页'], limitations: [], generatedDate: '2026-10-10',
    dayTitle: retainedDay.title, dayTasks: [...retainedDay.tasks], daySource: retainedDay.source
  } } };
  const q1 = task.dailyQuizzes['9'].questions[0];
  task.tutorChats = { 'daily:9:q1': {
    kind: 'daily', dayIndex: 9, questionId: 'q1', question: q1.question, answer: task.dailyQuizzes['9'].answers.q1.text,
    feedback: task.dailyQuizzes['9'].result.items[0].feedback,
    messages: [{ role: 'user', text: '为什么？' }, { role: 'assistant', text: '因为变量保存数据。' }]
  } };
  task.quiz = legacyFinalQuiz();

  const { settings, requests } = await mockGenerator(t);
  const proposal = await cadence.proposeCadence(task, { mode: 'weekly', weekdays: [1, 3, 5] }, settings, { today: '2026-10-06' });

  assert.deepEqual(proposal.preserved.map(day => day.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-10']);
  assert.deepEqual(proposal.days.map(day => day.date), ['2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14']);
  assert.equal(proposal.calendarDays, 14);
  assert.equal(proposal.days.at(-1).day, 10);
  assert.doesNotMatch(JSON.stringify(requests), /私密课程原文/);

  const next = cadence.applyCadence(task, proposal);
  assert.equal(next.days, 10);
  assert.equal(next.calendarDays, 14);
  assert.equal(next.plan.days[7].completed, true);
  assert.equal(next.plan.days[7].date, '2026-10-10');
  assert.equal(next.dailyQuizzes['4'].dayIndex, 4);
  assert.equal(next.dailyQuizzes['4'].readinessStale, true, '日期变化后的下一日判断需失效');
  assert.equal(next.dailyQuizzes['7'].dayIndex, 7);
  assert.equal(next.dailyQuizzes['7'].readinessStale, true);
  assert.ok(next.lessons['7'].brief, '已完成日的讲解缓存按新索引保留');
  assert.equal(next.tutorChats['daily:7:q1'].dayIndex, 7);
  assert.equal(next.finalQuizHistory.length, 1, '旧版已评分期末测验归档');
  assert.equal(next.quiz, undefined, '当前期末测验清空，避免新周期沿用旧题');
  assert.equal(assessment.validateAssessmentRecords(next), true);
  assert.equal(tutoring.validateTutoringRecords(next), true);
});

test('alternate cadence works for a legacy plan without knowledge and uses its original calendar span', async t => {
  const task = makeTask({ days: 4, startDate: '2026-10-01' });
  delete task.plan.knowledge;
  const { settings, requests } = await mockGenerator(t);
  const proposal = await cadence.proposeCadence(task, { mode: 'alternate' }, settings, { today: '2026-10-02' });

  assert.deepEqual(proposal.preserved.map(day => day.date), ['2026-10-01']);
  assert.deepEqual(proposal.days.map(day => day.date), ['2026-10-03']);
  assert.match(proposal.warning, /没有知识清单/);
  assert.match(requests[0].knowledge[0].title, /变量练习/);
  assert.ok(requests[0].knowledge[0].explanation.includes('理解变量并完成练习'));
  assert.ok(JSON.stringify(requests[0].originalPlan.context).includes('理解变量并完成练习'));
  const next = cadence.applyCadence(task, proposal);
  assert.deepEqual(next.plan.days.map(day => day.date), ['2026-10-01', '2026-10-03']);
  assert.equal(next.days, 2);
  assert.equal(next.calendarDays, 4);
  assert.match(next.plan.warnings[0], /没有知识清单/);
  assert.equal(scheduleValid(next), true);
});

test('basic legacy plan and scored quiz remain valid historical data after cadence change', async t => {
  const task = legacyBasicTask();
  const originalQuiz = structuredClone(task.quiz);
  const { settings, requests } = await mockGenerator(t);
  const proposal = await cadence.proposeCadence(task, { mode: 'alternate' }, settings, { today: '2026-10-02' });

  assert.equal(requests[0].knowledge[0].source, '主题与学习目标');
  const next = cadence.applyCadence(task, proposal);
  assert.equal(next.plan.days[0].source, '旧版基础计划', '保留的历史日来源不改写');
  assert.equal(next.quiz, undefined);
  assert.deepEqual(next.finalQuizHistory, [originalQuiz]);
  assert.equal(next.finalQuizHistory[0].mode, 'basic', '历史模式不应升级为 AI');
  assert.equal(next.finalQuizHistory[0].result.mode, 'basic');
  assert.equal(assessment.validateAssessmentRecords(next), true);
  assert.equal(tutoring.validateTutoringRecords(next), true);

  const invalidAiFallback = legacyBasicTask();
  invalidAiFallback.plan.mode = 'ai';
  await assert.rejects(
    cadence.proposeCadence(invalidAiFallback, { mode: 'alternate' }, settings, { today: '2026-10-02' }),
    /没有附件材料时.*必须为“主题与学习目标”/
  );

  const invalidRating = structuredClone(next);
  invalidRating.finalQuizHistory[0].answers.q2.rating = 21;
  assert.throws(() => assessment.validateAssessmentRecords(invalidRating), /历史评分/);

  const strictAi = makeTask({ days: 4, startDate: '2026-10-01' });
  strictAi.finalQuizHistory = [legacyFinalQuiz()];
  strictAi.finalQuizHistory[0].answers.q1.rating = 12;
  assert.throws(() => assessment.validateAssessmentRecords(strictAi), /作答/);
});

test('weekly weekdays are respected and a cadence with no future session is rejected', async t => {
  const task = makeTask({ days: 10, startDate: '2026-10-01' });
  task.calendarDays = 14;
  const { settings, requests } = await mockGenerator(t);
  const proposal = await cadence.proposeCadence(task, { mode: 'weekly', weekdays: [2, 4] }, settings, { today: '2026-10-05' });
  assert.deepEqual(proposal.days.map(day => day.date), ['2026-10-06', '2026-10-08', '2026-10-13']);

  const expired = makeTask({ days: 4, startDate: '2026-10-01' });
  await assert.rejects(cadence.proposeCadence(expired, { mode: 'alternate' }, settings, { today: '2026-10-10' }), /没有可安排的未来学习日期/);
  assert.equal(requests.length, 1, '没有未来日期时不请求模型');
});

function scheduleValid(task) {
  return require('./schedule.js').validateTimeline(task) === task;
}
