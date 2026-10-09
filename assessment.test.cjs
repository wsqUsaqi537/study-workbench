'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const service = require('./services.cjs');
const assessment = require('./assessment.cjs');

const settingsFor = port => ({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'assessment-mock', key: 'test-key' });
const localDate = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
};
const report = (overrides = {}) => ({
  summary: '你能解释核心概念，继续练习把多个步骤组合起来。',
  strengths: ['能说明变量用途'],
  nextSteps: ['用循环汇总多笔账目'],
  readyForNext: true,
  reason: '回答能说明变量与循环的基本作用。',
  extraMinutes: 0,
  extraTasks: [],
  ...overrides
});

function makeTask({ days = 4, completed = [], startDate = '2026-10-08' } = {}) {
  return {
    id: 'assessment-test-task',
    title: 'Python 记账小程序',
    goal: '掌握变量、循环和函数，完成一个记账小程序。',
    level: 'beginner',
    learningMode: 'balanced',
    startDate,
    days,
    minutesPerDay: 60,
    materials: [],
    plan: {
      mode: 'ai',
      summary: '逐步学习 Python 基础。',
      difficulty: '入门',
      warnings: [],
      knowledge: [
        { title: '变量与数据类型', priority: '重点', explanation: '变量保存数据，常见类型表示不同内容。', source: '主题与学习目标' },
        { title: '循环结构', priority: '了解', explanation: '循环用于重复处理一组账目。', source: '主题与学习目标' }
      ],
      days: Array.from({ length: days }, (_, index) => {
        const date = new Date(`${startDate}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + index);
        return {
          day: index + 1,
          date: date.toISOString().slice(0, 10),
          title: index === days - 1 ? '期末综合测试与复盘' : `第 ${index + 1} 天：变量与循环练习`,
          minutes: 45,
          tasks: [index === days - 1 ? '完成周期测试并复盘' : '理解概念并完成练习'],
          source: '主题与学习目标',
          completed: completed.includes(index)
        };
      })
    }
  };
}

function questionsFor(kind) {
  const count = kind === 'daily' ? 5 : 10;
  return Array.from({ length: count }, (_, index) => {
    const id = `q${index + 1}`;
    const type = kind === 'daily'
      ? ([0, 2].includes(index) ? 'choice' : 'fill')
      : (index === 8 ? 'short' : ([0, 4, 7].includes(index) ? 'choice' : 'fill'));
    return {
      id,
      type,
      question: type === 'choice' ? `关于第 ${index + 1} 个知识点，哪项正确？` : `请说明第 ${index + 1} 个知识点的用途。`,
      options: type === 'choice' ? ['正确选项', '干扰项一', '干扰项二', '干扰项三'] : [],
      answer: type === 'choice' ? 'A' : `参考答案 ${index + 1}`,
      alternatives: type === 'fill' ? [`合理同义表达 ${index + 1}`, '核心概念相同的表达'] : [],
      reference: `第 ${index + 1} 题参考说明。`,
      rubric: type === 'short' ? '按概念准确性、理由和示例评分。' : '按是否表达出核心概念评分。'
    };
  });
}

async function mockAPI(t, responses) {
  const received = [];
  const queue = [...responses];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const requestBody = JSON.parse(body);
    const content = requestBody.messages?.[1]?.content || '';
    let payload;
    try { payload = JSON.parse(content); } catch { payload = null; }
    received.push({ url: request.url, authorization: request.headers.authorization, requestBody, payload });
    const next = queue.shift();
    if (!next) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'mock response queue exhausted' } }));
      return;
    }
    response.writeHead(next.status || 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(next.raw || { choices: [{ message: { content: JSON.stringify(next.content) } }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { settings: settingsFor(server.address().port), received };
}

const filledScores = questions => questions.filter(question => question.type !== 'choice').map(question => ({
  id: question.id,
  score: question.type === 'short' ? 8 : 20,
  feedback: '答案表达了核心概念。'
}));
const modelGrade = (questions, reportValue = report()) => ({
  feedback: '主要概念已经掌握，继续练习组合使用。',
  items: filledScores(questions),
  weakPoints: ['综合运用'],
  report: reportValue
});
const attachLessonMaterial = task => {
  const materialText = '【第 1 页】只有附件才有的原文秘密；不得在已有知识清单时重复发送。';
  task.materials = [{ id: 'material-1', name: 'lesson.pdf', units: 1, chars: materialText.length, text: materialText }];
  task.plan.knowledge = task.plan.knowledge.map(item => ({ ...item, source: 'lesson.pdf 第 1 页' }));
  task.plan.days = task.plan.days.map(day => ({ ...day, source: 'lesson.pdf 第 1 页' }));
  return task;
};

test('日测和期末生成分别得到 5/10 道混合题，并复用知识清单而不重发原材料', async t => {
  const daily = attachLessonMaterial(makeTask());
  const dailyQuestions = questionsFor('daily');
  const finalQuestions = questionsFor('final');
  const { settings, received } = await mockAPI(t, [
    { content: { questions: dailyQuestions } },
    { content: { questions: finalQuestions } }
  ]);
  const before = structuredClone(daily);

  const dailyQuiz = await assessment.generateAssessment(daily, { kind: 'daily', dayIndex: 1 }, settings);
  const finalQuiz = await assessment.generateAssessment(daily, { kind: 'final' }, settings);

  assert.equal(dailyQuiz.version, 2);
  assert.equal(dailyQuiz.kind, 'daily');
  assert.equal(dailyQuiz.dayIndex, 1);
  assert.equal(dailyQuiz.questions.length, 5);
  assert.ok(dailyQuiz.questions.some(question => question.type === 'choice'));
  assert.ok(dailyQuiz.questions.some(question => question.type === 'fill'));
  assert.equal(finalQuiz.kind, 'final');
  assert.equal(finalQuiz.dayIndex, null);
  assert.equal(finalQuiz.questions.length, 10);
  assert.ok(finalQuiz.questions.some(question => question.type === 'choice'));
  assert.ok(finalQuiz.questions.some(question => question.type === 'fill'));
  assert.ok(finalQuiz.questions.filter(question => question.type === 'short').length <= 2);
  assert.equal(received.length, 2);
  assert.ok(received.every(record => record.url === '/v1/chat/completions'));
  assert.ok(received.every(record => record.authorization === 'Bearer test-key'));
  for (const record of received) {
    const serialized = JSON.stringify(record.payload);
    assert.match(serialized, /变量与数据类型/);
    assert.doesNotMatch(serialized, /只有附件才有的原文秘密/);
  }
  assert.deepEqual(daily, before, '生成题目不应修改传入任务');
});

test('旧计划没有知识清单时只发送限长材料，并标注题目范围可能不完整', async t => {
  const task = makeTask();
  delete task.plan.knowledge;
  task.materials = [{
    id: 'legacy-material', name: '旧课程.pdf', units: 1,
    chars: '材料原文片段。'.repeat(5000).length,
    text: '材料原文片段。'.repeat(5000)
  }];
  const mock = await mockAPI(t, [{ content: { questions: questionsFor('daily') } }]);

  const quiz = await assessment.generateAssessment(task, { kind: 'daily', dayIndex: 0 }, mock.settings);

  const requestPayload = mock.received[0].payload;
  assert.ok(requestPayload.materials[0].text.length < task.materials[0].text.length);
  assert.ok(JSON.stringify(requestPayload).length <= 10000, '旧材料上下文应服从严格字符预算');
  assert.ok(quiz.questions.every(question => /限长发送的材料/.test(question.reference)));
});

test('缺少完整 API 配置时生成、评分和调整都拒绝，且不产生模型请求', async () => {
  const task = makeTask();
  const pendingQuestions = questionsFor('daily');
  const incompleteReport = report({ readyForNext: false, reason: '第 2 题回答没有说明循环如何重复处理多笔账目。', extraMinutes: 20, extraTasks: ['练习循环'] });
  task.dailyQuizzes = { '0': { version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions: questionsFor('daily') } };
  task.dailyQuizzes['0'].result = null;
  task.plan.days[1].completed = false;
  const answers = Object.fromEntries(pendingQuestions.map(question => [question.id, { text: question.type === 'choice' ? 'A' : '答案' }]));
  delete task.dailyQuizzes['0'].result;
  const partialConfigs = [{}, { endpoint: 'http://127.0.0.1:9/v1' }, { endpoint: 'http://127.0.0.1:9/v1', model: 'mock' }];
  for (const settings of partialConfigs) {
    await assert.rejects(assessment.generateAssessment(task, { kind: 'daily', dayIndex: 0 }, settings), /API|配置|模型/);
    await assert.rejects(assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, settings), /API|配置|模型/);
    const adjustmentTask = structuredClone(task);
    let fillIndex = 0;
    adjustmentTask.dailyQuizzes['0'].result = {
      mode: 'ai', score: 60, feedback: '需要复习。',
      items: pendingQuestions.map(question => ({
        id: question.id,
        score: question.type === 'choice' ? 20 : [7, 7, 6][fillIndex++],
        feedback: '需要继续练习。'
      })),
      weakPoints: ['循环'], report: incompleteReport
    };
    adjustmentTask.dailyQuizzes['0'].answers = answers;
    await assert.rejects(assessment.proposeAdjustment(adjustmentTask, 0, settings), /API|配置|模型/);
  }
});

test('一次评分同时返回逐题分数和报告，选择题按本地正确项计分', async t => {
  const task = attachLessonMaterial(makeTask());
  const questions = questionsFor('daily');
  task.dailyQuizzes = { '0': { version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions } };
  const answers = Object.fromEntries(questions.map((question, index) => [question.id, {
    text: question.type === 'choice' ? (index === 0 ? 'A' : 'B') : `我的回答 ${index + 1}`
  }]));
  const modelItems = filledScores(questions);
  const { settings, received } = await mockAPI(t, [{ content: modelGrade(questions, report()) }]);
  const before = structuredClone(task);

  const result = await assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, settings);

  assert.equal(received.length, 1, '评分和报告应共用一次模型请求');
  assert.equal(result.mode, 'ai');
  assert.equal(result.items.length, 5);
  assert.equal(result.score, result.items.reduce((sum, item) => sum + item.score, 0));
  assert.equal(result.score, 80, '1 道正确选择题 20 分，错误选择题 0 分，3 道填空各 20 分');
  assert.equal(result.items.find(item => item.id === 'q1').score, 20);
  assert.equal(result.items.find(item => item.id === 'q3').score, 0);
  assert.deepEqual(result.report, report());
  const payloadText = JSON.stringify(received[0].payload);
  assert.match(payloadText, /nextDay/);
  assert.match(payloadText, /合理同义表达 2/);
  assert.doesNotMatch(payloadText, /只有附件才有的原文秘密/);
  assert.deepEqual(task, before, '评分不应修改传入任务');
});

test('期末题按每题 10 分评分，报告的下一日准备程度为 null', async t => {
  const task = makeTask({ days: 2 });
  const questions = questionsFor('final');
  task.quiz = { version: 2, mode: 'ai', kind: 'final', dayIndex: null, questions };
  const answers = Object.fromEntries(questions.map(question => [question.id, {
    text: question.type === 'choice' ? question.answer : '我的回答'
  }]));
  const finalReport = report({ readyForNext: null, reason: '已完成本周期测验，可回顾薄弱知识点。' });
  const finalItems = questions.filter(question => question.type !== 'choice').map(question => ({
    id: question.id, score: 10, feedback: '回答符合评分标准。'
  }));
  const mock = await mockAPI(t, [{ content: {
    feedback: '本周期的知识点掌握良好。', items: finalItems, weakPoints: [], report: finalReport
  } }]);
  const result = await assessment.gradeAssessment(task, { kind: 'final' }, answers, mock.settings);
  assert.equal(result.items.length, 10);
  assert.equal(result.score, 100);
  assert.equal(result.report.readyForNext, null);
  assert.equal(mock.received.length, 1);
});

test('可给出可执行的补学报告；缺少证据或补学安排的报告被拒绝', async t => {
  const task = makeTask();
  const questions = questionsFor('daily');
  task.dailyQuizzes = { '0': { version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions } };
  const answers = Object.fromEntries(questions.map(question => [question.id, { text: question.type === 'choice' ? 'A' : '回答' }]));
  const extraReport = report({
    readyForNext: false,
    reason: '第 2 题回答没有解释循环如何重复处理账目；第 4 题也未描述重复处理。',
    extraMinutes: 25,
    extraTasks: ['用循环遍历三笔账目并计算总额']
  });
  const valid = await mockAPI(t, [{ content: modelGrade(questions, extraReport) }]);
  const result = await assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, valid.settings);
  assert.equal(result.report.readyForNext, false);
  assert.match(result.report.reason, /循环/);
  assert.equal(result.report.extraMinutes, 25);
  assert.equal(result.report.extraTasks.length, 1);
  assert.equal(valid.received.length, 1);

  for (const invalidReport of [
    { ...extraReport, reason: '' },
    { ...extraReport, extraMinutes: 0 },
    { ...extraReport, extraTasks: [] },
    { ...extraReport, readyForNext: 'maybe' }
  ]) {
    const invalid = await mockAPI(t, [{ content: modelGrade(questions, invalidReport) }]);
    await assert.rejects(assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, invalid.settings));
  }
});

test('填空合理同义表达会进入评分上下文，选择题分数由本地正确答案决定', async t => {
  const task = makeTask();
  const questions = questionsFor('daily');
  task.dailyQuizzes = { '0': { version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions } };
  const answers = Object.fromEntries(questions.map(question => [question.id, {
    text: question.id === 'q2' ? '核心概念相同的表达' : (question.type === 'choice' ? 'A' : '回答')
  }]));
  const modelItems = filledScores(questions);
  const mock = await mockAPI(t, [{ content: modelGrade(questions, report()) }]);
  const result = await assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, mock.settings);
  assert.equal(mock.received.length, 1);
  assert.equal(result.items.find(item => item.id === 'q1').score, 20);
  assert.equal(result.score, result.items.reduce((sum, item) => sum + item.score, 0));
  assert.match(JSON.stringify(mock.received[0].payload), /核心概念相同的表达/);

  const malicious = await mockAPI(t, [{ content: {
    feedback: '模型尝试自行更改客观题。',
    items: [...modelItems, { id: 'q1', score: 0, feedback: '模型试图覆盖选择题分数。' }],
    weakPoints: [], report: report()
  } }]);
  await assert.rejects(assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, answers, malicious.settings));
  assert.equal(malicious.received.length, 1, '模型尝试给选择题评分时应拒绝本次整体评分');
});

test('selector、题型、答案和报告结构非法时拒绝', async t => {
  const task = makeTask();
  const validQuiz = { version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions: questionsFor('daily') };
  assert.equal(assessment.validateAssessment(validQuiz).kind, 'daily');
  for (const selector of [
    { kind: 'other' }, { kind: 'final', dayIndex: 0 }, { kind: 'daily', dayIndex: -1 },
    { kind: 'daily', dayIndex: 0, extra: true }, { kind: 'daily', dayIndex: 4 }
  ]) {
    const mock = await mockAPI(t, [{ content: { questions: questionsFor('daily') } }]);
    await assert.rejects(assessment.generateAssessment(task, selector, mock.settings));
    assert.equal(mock.received.length, 0, '非法 selector 应在 API 请求前拒绝');
  }
  for (const quiz of [
    { ...validQuiz, questions: validQuiz.questions.map((question, index) => index ? question : { ...question, type: 'essay' }) },
    { ...validQuiz, questions: validQuiz.questions.map((question, index) => index ? question : { ...question, options: ['A', 'B', 'C'] }) },
    { ...validQuiz, questions: validQuiz.questions.map((question, index) => index ? question : { ...question, alternatives: Array(6).fill('x') }) }
  ]) assert.throws(() => assessment.validateAssessment(quiz));

  const invalidGeneration = await mockAPI(t, [{ content: { questions: questionsFor('daily').map((question, index) => index ? question : { ...question, type: 'essay' }) } }]);
  await assert.rejects(assessment.generateAssessment(task, { kind: 'daily', dayIndex: 0 }, invalidGeneration.settings));
  assert.equal(invalidGeneration.received.length, 1);

  const invalidRecordsTask = makeTask();
  invalidRecordsTask.dailyQuizzes = { '4': validQuiz };
  assert.throws(() => assessment.validateAssessmentRecords(invalidRecordsTask));
});

test('编辑下一日后保留旧日报但标记准备度过期，并拒绝据此调整', async t => {
  const task = makeTask({ startDate: localDate() });
  const questions = questionsFor('daily');
  const answers = Object.fromEntries(questions.map(question => [question.id, { text: question.type === 'choice' ? 'B' : '旧计划下的回答' }]));
  let fillIndex = 0;
  const items = questions.map(question => ({
    id: question.id,
    score: question.type === 'choice' ? 0 : [20, 20, 20][fillIndex++],
    feedback: '旧日报反馈。'
  }));
  const quiz = {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions,
    answers,
    result: {
      mode: 'ai', score: 60, feedback: '旧计划下的日报。', items, weakPoints: ['循环'],
      report: report({ readyForNext: false, reason: '第 2 题回答没有说明循环如何重复处理多笔账目。', extraMinutes: 20, extraTasks: ['练习循环'] })
    },
    readinessStale: true
  };
  assert.equal(assessment.validateAssessment(quiz).readinessStale, true);
  const staleTask = structuredClone(task);
  staleTask.dailyQuizzes = { '0': quiz };
  assert.equal(assessment.validateAssessmentRecords(staleTask), true, '失效标记应保留仍有效的历史题目、答案和评分');
  for (const invalid of [
    { ...quiz, kind: 'final', dayIndex: null },
    { ...quiz, result: undefined },
    { ...quiz, decision: 'extra', supplementCompleted: false },
    { ...quiz, supplementCompleted: false }
  ]) assert.throws(() => assessment.validateAssessment(invalid));

  const mock = await mockAPI(t, []);
  await assert.rejects(assessment.proposeAdjustment(staleTask, 0, mock.settings), /过期|重新/);
  assert.equal(mock.received.length, 0, '失效日报不得触发计划调整 API');
});

test('调整只覆盖指定日期之后未完成的天，并验证日期、预算和来源', async t => {
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const task = makeTask({ days: 5, completed: [0, 3], startDate: today });
  task.dailyQuizzes = { '1': {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 1, questions: questionsFor('daily'),
    answers: Object.fromEntries(questionsFor('daily').map(question => [question.id, { text: question.type === 'choice' ? 'B' : '回答' }])),
    result: {
      mode: 'ai', score: 45, feedback: '仍需练习。',
      items: questionsFor('daily').map(question => ({ id: question.id, score: question.type === 'choice' ? 0 : 15, feedback: '需要继续练习。' })),
      weakPoints: ['循环'],
    report: report({ readyForNext: false, reason: '第 2 题回答没有解释循环如何重复处理多笔账目。', extraMinutes: 20, extraTasks: ['练习循环'] })
    }
  } };
  const before = structuredClone(task);
  const proposed = {
    summary: '先巩固循环，再进行后续练习。',
    days: [3, 5].map(dayNumber => ({
      day: dayNumber,
      date: task.plan.days[dayNumber - 1].date,
      title: `第 ${dayNumber} 天循环巩固`,
      minutes: task.plan.days[dayNumber - 1].minutes,
      tasks: dayNumber === 5
        ? ['安排 5 题小测，用时 10 分钟；完成 10 题周期测验，用时 15 分钟；复核账目结果']
        : ['安排 5 题小测，用时 10 分钟；用循环处理多笔账目并复核结果'],
      source: '主题与学习目标'
    }))
  };
  const valid = await mockAPI(t, [{ content: proposed }]);
  const actual = await assessment.proposeAdjustment(task, 1, valid.settings);
  assert.deepEqual(actual.days.map(day => day.day), [3, 5], '已完成的第 4 天不应被纳入调整');
  assert.deepEqual(actual.days.map(day => day.date), [task.plan.days[2].date, task.plan.days[4].date]);
  assert.deepEqual(actual.days.map(day => day.minutes), [task.plan.days[2].minutes, task.plan.days[4].minutes]);
  assert.equal(valid.received.length, 1);
  assert.doesNotMatch(JSON.stringify(valid.received[0].payload), /只有附件才有的原文秘密/);
  assert.deepEqual(task, before, '生成调整建议不应修改原始计划');

  for (const invalidDays of [
    [proposed.days[0]],
    proposed.days.map((day, index) => index ? day : { ...day, date: '2099-01-01' }),
    proposed.days.map((day, index) => index ? day : { ...day, minutes: day.minutes + 1 }),
    proposed.days.map((day, index) => index ? day : { ...day, source: '不存在的附件 第 99 页' }),
    [...proposed.days, { ...proposed.days[0], day: 4, date: task.plan.days[3].date }]
  ]) {
    const invalid = await mockAPI(t, [{ content: { ...proposed, days: invalidDays } }]);
    await assert.rejects(assessment.proposeAdjustment(task, 1, invalid.settings));
  }
});
