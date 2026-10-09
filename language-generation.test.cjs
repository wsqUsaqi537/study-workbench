'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const services = require('./services.cjs');
const assessment = require('./assessment.cjs');
const tutoring = require('./tutoring.cjs');
const { translateError } = require('./i18n.js');

function dateOffset(offset) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function input(overrides = {}) {
  return {
    title: 'Python fundamentals', goal: 'Build a small expense tracker using variables and loops.',
    level: 'beginner', learningMode: 'balanced', startDate: dateOffset(0), days: 3,
    minutesPerDay: 60, materials: [], ...overrides
  };
}

function modelPlan(data) {
  return {
    summary: 'Learn Python fundamentals and apply them in an expense tracker.',
    difficulty: '入门', warnings: [],
    knowledge: [
      { title: 'Variables', priority: '重点', explanation: 'Variables store values for later use.', source: '主题与学习目标' },
      { title: 'Loops', priority: '了解', explanation: 'Loops repeat a sequence of instructions.', source: '主题与学习目标' }
    ],
    days: Array.from({ length: data.days }, (_, index) => ({
      day: index + 1, date: services.formatDate(data.startDate, index),
      title: index === data.days - 1 ? 'Review and final test' : `Study day ${index + 1}`,
      minutes: 45,
      tasks: [index === data.days - 1 ? 'Complete the final test and review missed questions.' : 'Study the concepts and complete a short practice exercise.'],
      source: '主题与学习目标'
    }))
  };
}

function makeTask(overrides = {}) {
  const data = input(overrides);
  const plan = modelPlan(data);
  return {
    id: 'language-test-task', ...data,
    plan: { mode: 'ai', ...plan, days: plan.days.map(day => ({ ...day, completed: false })) }
  };
}

function questionsFor(kind) {
  const count = kind === 'daily' ? 5 : 10;
  const choiceIndexes = kind === 'daily' ? [0, 2] : [0, 4, 7];
  return Array.from({ length: count }, (_, index) => {
    const choice = choiceIndexes.includes(index);
    return {
      id: `q${index + 1}`, type: choice ? 'choice' : 'fill',
      question: choice ? `Which option best describes concept ${index + 1}?` : `Explain the use of concept ${index + 1}.`,
      options: choice ? ['It stores or processes data.', 'It draws an image.', 'It plays audio.', 'It connects to a network.'] : [],
      answer: choice ? 'A' : `Concept ${index + 1} supports the program.`,
      alternatives: choice ? [] : [`It helps the program use concept ${index + 1}.`],
      reference: `Concept ${index + 1} helps organize program behavior.`,
      rubric: 'Award credit for an accurate explanation.'
    };
  });
}

function report(readyForNext = true) {
  return {
    summary: 'The learner understands the main concepts and can continue.',
    strengths: ['Explains the role of variables'], nextSteps: ['Practice combining loops and conditions'],
    readyForNext, reason: 'The answers show an understanding of the core concepts.',
    extraMinutes: 0, extraTasks: []
  };
}

function dailyResult(questions, answers, ready = true) {
  const items = questions.map(question => ({
    id: question.id,
    score: question.type === 'choice'
      ? (answers[question.id].text === question.answer ? 20 : 0)
      : 20,
    feedback: 'The answer reflects the key idea.'
  }));
  const reportValue = report(ready);
  if (!ready) {
    reportValue.reason = 'The learner missed q1 and should review the variable concept before moving on.';
    reportValue.extraMinutes = 15;
    reportValue.extraTasks = ['Review variables and explain their role.'];
  }
  return {
    mode: 'ai', score: items.reduce((sum, item) => sum + item.score, 0),
    feedback: 'The learner understands the key ideas.', items,
    weakPoints: ready ? [] : ['Review variables'], report: reportValue
  };
}

async function mockAPI(t, responses) {
  const received = [];
  const queue = [...responses];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const payload = JSON.parse(parsed.messages[1].content);
    received.push({ ...parsed, payload });
    const next = typeof queue[0] === 'function' ? await queue.shift()(payload) : queue.shift();
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
  return {
    received,
    settings: { endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'language-mock', key: 'test-key', language: 'en' }
  };
}

function assertEnglishRequest(request, expectedPurpose) {
  assert.equal(request.payload.outputLanguage, 'en');
  assert.equal(request.payload.purpose, expectedPurpose);
  assert.match(request.messages[0].content, /Write all natural-language replies.*in English/);
}

test('legacy clarification, planning, quiz generation and grading request English while retaining protocol values', async t => {
  const planInput = input();
  const oldTask = makeTask();
  const oldQuestions = Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`, question: `Explain concept ${index + 1}.`,
    reference: `Concept ${index + 1} has a specific role.`, rubric: 'Credit accurate explanations.'
  }));
  oldTask.quiz = { mode: 'ai', questions: oldQuestions };
  const answers = Object.fromEntries(oldQuestions.map(question => [question.id, { text: 'It supports the program.' }]));
  const grade = {
    score: 100, feedback: 'The responses demonstrate a strong understanding.',
    items: oldQuestions.map(question => ({ id: question.id, score: 20, feedback: 'Accurate explanation.' })),
    weakPoints: []
  };
  const brief = { goal: 'Build an expense tracker.', scope: ['Variables', 'Loops'], prerequisites: [], outcomes: ['A working program'] };
  const fixture = await mockAPI(t, [
    { content: modelPlan(planInput) },
    { content: { reply: 'Which part of Python would you like to focus on first?', ready: true, brief } },
    { content: { questions: oldQuestions } },
    { content: grade }
  ]);

  const planned = await services.generatePlan(planInput, fixture.settings);
  assertEnglishRequest(fixture.received[0], '生成学习计划');
  assert.equal(planned.difficulty, '入门');
  assert.equal(planned.knowledge[0].priority, '重点');
  assert.match(fixture.received[0].messages[0].content, /priority.*重点/);

  const clarification = await services.clarifyGoal({
    input: planInput, messages: [{ role: 'user', content: 'I want to build an expense tracker.' }]
  }, fixture.settings);
  assertEnglishRequest(fixture.received[1], '澄清学习需求');
  assert.match(clarification.reply, /^Which/);

  const quiz = await services.generateQuiz(oldTask, fixture.settings);
  assertEnglishRequest(fixture.received[2], '根据源材料生成 5 道主观测验题');
  assert.match(quiz.questions[0].reference, /No attachments were provided/);

  const result = await services.gradeQuiz(oldTask, answers, fixture.settings);
  assertEnglishRequest(fixture.received[3], '按材料和评分标准评阅学习测验');
  assert.match(result.feedback, /No attachments were provided/);
});

test('daily and final assessment generation and grading use English, with local English choice feedback', async t => {
  const task = makeTask();
  const dailyQuestions = questionsFor('daily');
  const finalQuestions = questionsFor('final');
  const dailyAnswers = Object.fromEntries(dailyQuestions.map(question => [question.id, { text: question.id === 'q1' ? 'B' : question.answer }]));
  const finalAnswers = Object.fromEntries(finalQuestions.map(question => [question.id, { text: question.answer }]));
  const dailySubjective = dailyQuestions.filter(question => question.type !== 'choice');
  const finalSubjective = finalQuestions.filter(question => question.type !== 'choice');
  const fixture = await mockAPI(t, [
    { content: { questions: dailyQuestions } },
    { content: {
      feedback: 'Keep practicing how the concepts work together.',
      items: dailySubjective.map(question => ({ id: question.id, score: 20, feedback: 'The explanation is accurate.' })),
      weakPoints: ['Review the missed multiple-choice concept'], report: report(true)
    } },
    { content: { questions: finalQuestions } },
    { content: {
      feedback: 'The final review shows broad understanding.',
      items: finalSubjective.map(question => ({ id: question.id, score: 10, feedback: 'The answer is accurate.' })),
      weakPoints: [], report: report(null)
    } }
  ]);

  const daily = await assessment.generateAssessment(task, { kind: 'daily', dayIndex: 0 }, fixture.settings);
  assertEnglishRequest(fixture.received[0], '生成每日小测');
  assert.equal(daily.questions.length, 5);
  assert.equal(daily.questions[0].answer, 'A');
  task.dailyQuizzes = { 0: { ...daily, answers: dailyAnswers } };
  const dailyGrade = await assessment.gradeAssessment(task, { kind: 'daily', dayIndex: 0 }, dailyAnswers, fixture.settings);
  assertEnglishRequest(fixture.received[1], '评分并生成学习报告');
  assert.equal(dailyGrade.items[0].feedback, 'The correct option is A.');
  assert.equal(dailyGrade.items[2].feedback, 'Correct.');

  const final = await assessment.generateAssessment(task, { kind: 'final' }, fixture.settings);
  assertEnglishRequest(fixture.received[2], '生成周期测验');
  task.quiz = final;
  const finalGrade = await assessment.gradeAssessment(task, { kind: 'final' }, finalAnswers, fixture.settings);
  assertEnglishRequest(fixture.received[3], '评分并生成学习报告');
  assert.match(finalGrade.report.summary, /daily quizzes were recorded/);
});

test('English adjustment requires the question count, quiz type and explicit minutes', async t => {
  const task = makeTask();
  const questions = questionsFor('daily');
  const answers = Object.fromEntries(questions.map(question => [question.id, { text: question.id === 'q1' ? 'B' : question.answer }]));
  const result = dailyResult(questions, answers, false);
  task.dailyQuizzes = { 0: {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions,
    answers, result, readinessStale: false
  } };
  const upcoming = task.plan.days.slice(1);
  const validDays = upcoming.map(day => ({
    day: day.day, date: day.date, title: day.title, minutes: day.minutes,
    tasks: day.day === task.days
      ? ['Complete a 5-question daily quiz in 15 minutes and a 10-question final comprehensive quiz in 30 minutes.']
      : ['Review concepts and complete a five-question daily quiz in 15 minutes.'],
    source: '主题与学习目标'
  }));
  const responses = [
    { content: { summary: 'Reinforce the missed concepts before moving on.', days: validDays } },
    ...['Complete a 5-question quiz in 10 minutes.', "Take today's 5-question quiz (10 minutes)."].map(dailyText => ({ content: {
      summary: 'Reinforce the missed concepts before moving on.',
      days: validDays.map(day => ({ ...day, tasks: [dailyText, ...(day.day === task.days ? ['Complete a 10-question final test in 20 minutes.'] : [])] }))
    } })),
    { content: { summary: 'Missing the question count.', days: validDays.map(day => ({ ...day, tasks: ['Complete a daily quiz in 15 minutes.'] })) } },
    { content: { summary: 'Missing the quiz type.', days: validDays.map(day => ({ ...day, tasks: ['Answer five questions in 15 minutes.'] })) } },
    { content: { summary: 'Missing the time budget.', days: validDays.map(day => ({ ...day, tasks: ['Complete a five-question daily quiz.'] })) } }
  ];
  const fixture = await mockAPI(t, responses);

  const adjusted = await assessment.proposeAdjustment(task, 0, fixture.settings);
  assertEnglishRequest(fixture.received[0], '调整后续学习规划');
  assert.deepEqual(adjusted.days, validDays);
  for (let index = 0; index < 2; index += 1) {
    const naturalAdjustment = await assessment.proposeAdjustment(task, 0, fixture.settings);
    assertEnglishRequest(fixture.received[index + 1], '调整后续学习规划');
    assert.equal(naturalAdjustment.days.length, upcoming.length);
  }
  await assert.rejects(assessment.proposeAdjustment(task, 0, fixture.settings), /保留|保持|五题|5 题/);
  await assert.rejects(assessment.proposeAdjustment(task, 0, fixture.settings), /保留|保持|五题|5 题/);
  await assert.rejects(assessment.proposeAdjustment(task, 0, fixture.settings), /保留|保持|五题|5 题/);
});

test('lesson and follow-up additions are English; cached lesson text remains unchanged and avoids API calls', async t => {
  const task = makeTask();
  const question = questionsFor('daily');
  const answers = Object.fromEntries(question.map(item => [item.id, { text: item.answer }]));
  task.dailyQuizzes = { 0: {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions: question, answers,
    result: dailyResult(question, answers, true)
  } };
  const lessonResponse = {
    text: 'Concept: variables store values.\nExample: use total to add expenses.\nCommon pitfall: names and values are different.\nPractice: define a variable for a price.',
    sources: ['主题与学习目标'], limitations: []
  };
  const followupResponse = {
    text: 'The variable name refers to a stored value, like a labeled container.',
    sources: ['主题与学习目标'], limitations: []
  };
  const fixture = await mockAPI(t, [{ content: lessonResponse }, { content: followupResponse }]);

  const lesson = await tutoring.generateLesson(task, 0, 'brief', fixture.settings);
  assertEnglishRequest(fixture.received[0], '讲解当前日学习内容');
  assert.match(lesson.text, /General background:/);
  assert.match(lesson.limitations[0], /No original course materials/);
  const cachedText = '旧版中文讲解原文';
  task.lessons = { 0: { brief: {
    text: cachedText, sources: ['主题与学习目标'], limitations: [], generatedDate: dateOffset(0),
    dayTitle: task.plan.days[0].title, dayTasks: [...task.plan.days[0].tasks], daySource: task.plan.days[0].source
  } } };
  assert.equal((await tutoring.generateLesson(task, 0, 'brief', fixture.settings)).text, cachedText);
  assert.equal(fixture.received.length, 1);

  const answer = await tutoring.answerQuestion(task, { kind: 'daily', dayIndex: 0 }, 'q1', [{ role: 'user', text: 'Why was my answer wrong?' }], fixture.settings);
  assertEnglishRequest(fixture.received[1], '解释当前测验题和评分反馈');
  assert.match(answer.limitations[0], /original material was not sent again/);
});

test('missing language defaults to Chinese and keeps the model purpose unchanged', async t => {
  const data = input();
  const fixture = await mockAPI(t, [{ content: modelPlan(data) }]);
  delete fixture.settings.language;
  await services.generatePlan(data, fixture.settings);
  assert.equal(fixture.received[0].payload.outputLanguage, 'zh-CN');
  assert.equal(fixture.received[0].payload.purpose, '生成学习计划');
  assert.match(fixture.received[0].messages[0].content, /使用简体中文/);
});

test('backend error catalog translates dynamic service, question and API messages', () => {
  assert.equal(translateError('第 2 份材料名称必须是文字。', 'en'), 'Material 2 name must be text.');
  assert.equal(translateError('第 3 道题题干泄露了正确选项。', 'en'), 'Question 3 reveals the correct option in its prompt.');
  assert.equal(translateError('API 请求失败（HTTP 401）。请检查模型名称和 API Key。', 'en'), 'API request failed (HTTP 401). Check the model name and API key.');
});
