'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const tutoring = require('./tutoring.cjs');

const source = '课件.pdf 第 1 页';

function makeTask({ withMaterial = false, rated = true } = {}) {
  const materialText = '【第 1 页】变量用于保存数据，方便后续读取。\n\n' +
    '【第 2 页】' + '其他章节内容。'.repeat(5000);
  const task = {
    id: 'tutor-test', title: 'Python 基础', goal: '理解变量并能用于简单记录。', level: 'beginner',
    learningMode: 'balanced', startDate: '2026-10-09', days: 2, minutesPerDay: 60,
    materials: withMaterial ? [{ id: 'm1', name: '课件.pdf', units: 2, chars: materialText.length, text: materialText }] : [],
    plan: {
      mode: 'ai', summary: '学习变量和循环。', difficulty: '入门', warnings: [],
      days: [
        { day: 1, date: '2026-10-09', title: '变量基础', minutes: 40, tasks: ['理解变量如何保存数据'], source: withMaterial ? source : '主题与学习目标', completed: false },
        { day: 2, date: '2026-10-10', title: '循环复习与测试', minutes: 45, tasks: ['练习循环并完成测验'], source: withMaterial ? source : '主题与学习目标', completed: false }
      ],
      knowledge: [{ title: '变量与数据类型', priority: '重点', explanation: '变量用于保存数据，类型说明数据的用途。', source: withMaterial ? source : '主题与学习目标' }]
    }
  };
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`, type: index === 0 ? 'choice' : 'fill',
    question: index === 0 ? '变量可以用于什么？' : `第 ${index + 1} 题：说明变量的用途。`,
    options: index === 0 ? ['保存数据', '绘制图片', '播放声音', '联网'] : [],
    answer: index === 0 ? 'A' : '保存数据', alternatives: index === 0 ? [] : ['储存数据'],
    reference: '变量可以保存数据，供程序后续使用。', rubric: '说明保存数据的用途。'
  }));
  const answers = Object.fromEntries(questions.map((question, index) => [question.id, { text: index === 0 ? 'B' : '保存数据' }]));
  const items = questions.map((question, index) => ({
    id: question.id, score: index === 0 ? 0 : 20, feedback: index === 0 ? '你选了干扰项，可以复习变量保存数据的作用。' : '回答正确。'
  }));
  const quiz = {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions,
    ...(rated ? {
      answers,
      result: {
        mode: 'ai', score: 80, feedback: '变量基础已掌握，复习选择题的概念。', items,
        weakPoints: ['变量的用途'],
        report: {
          summary: '理解变量的基础用途。', strengths: ['能说明变量用途'], nextSteps: ['复习变量的基本概念'],
          readyForNext: true, reason: '大部分题目回答正确。', extraMinutes: 0, extraTasks: []
        }
      }
    } : {})
  };
  task.dailyQuizzes = { 0: quiz };
  return task;
}

async function mockAPI(t, response) {
  const received = [];
  const server = http.createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    received.push(parsed);
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {
    received,
    settings: { endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-model', key: 'test-key' }
  };
}

test('每日讲解只发送当天引用的材料片段，并命中缓存时不再请求 API', async t => {
  const task = makeTask({ withMaterial: true });
  const model = {
    text: '概念：变量保存数据。\n例子：用 total 保存金额。\n易错点：变量名不是数据类型。\n练习：写出保存金额的变量名。',
    sources: [source], limitations: ['讲解仅依据当天引用的材料片段。']
  };
  const { settings, received } = await mockAPI(t, model);
  const result = await tutoring.generateLesson(task, 0, 'brief', settings);
  const payload = JSON.parse(received[0].messages[1].content);
  assert.match(payload.materials[0].text, /【第 1 页】/);
  assert.doesNotMatch(payload.materials[0].text, /【第 2 页】/);
  assert.ok(payload.materials[0].text.length < 10000);
  assert.deepEqual(payload.day.tasks, task.plan.days[0].tasks);
  assert.equal(received[0].stream, false);

  task.lessons = { 0: { brief: {
    ...result, generatedDate: '2026-10-09', dayTitle: task.plan.days[0].title,
    dayTasks: [...task.plan.days[0].tasks], daySource: task.plan.days[0].source
  } } };
  assert.deepEqual(await tutoring.generateLesson(task, 0, 'brief'), result);
  assert.equal(received.length, 1);
});

test('讲解校验日期、深度及过期缓存；无附件时标记通识补充', async t => {
  const task = makeTask();
  await assert.rejects(tutoring.generateLesson(task, 2, 'brief', {}), /日期/);
  await assert.rejects(tutoring.generateLesson(task, 0, 'long', {}), /深度/);
  const { settings } = await mockAPI(t, { text: '概念：变量。例子：total。易错点：名称和值不同。练习：声明一个变量。', sources: ['主题与学习目标'], limitations: [] });
  const lesson = await tutoring.generateLesson(task, 0, 'detailed', settings);
  assert.match(lesson.text, /通识补充/);
  assert.ok(lesson.limitations.length > 0);
  task.lessons = { 0: { brief: {
    text: '已缓存讲解', sources: ['主题与学习目标'], limitations: [], generatedDate: '2026-10-09',
    dayTitle: '旧标题', dayTasks: ['理解变量如何保存数据'], daySource: '主题与学习目标'
  } } };
  assert.throws(() => tutoring.validateTutoringRecords(task), /不一致/);
});

test('错题追问只发送当前评分题目、反馈、作答及相关知识，不发送原材料', async t => {
  const task = makeTask({ withMaterial: true });
  const model = { text: '变量名只是引用，变量值才是数据。可想象它是贴有名称的盒子。检查答案时先分清名称和值。', sources: [source], limitations: [] };
  const { settings, received } = await mockAPI(t, model);
  const result = await tutoring.answerQuestion(task, { kind: 'daily', dayIndex: 0 }, 'q1', [{ role: 'user', text: '为什么我的选项错了？' }], settings);
  const payload = JSON.parse(received[0].messages[1].content);
  assert.equal(payload.question.id, 'q1');
  assert.equal(payload.standardAnswer.answer, 'A');
  assert.equal(payload.actualAnswer, 'B');
  assert.match(payload.feedback, /干扰项/);
  assert.deepEqual(payload.messages, [{ role: 'user', text: '为什么我的选项错了？' }]);
  assert.doesNotMatch(JSON.stringify(payload), /其他章节内容/);
  assert.deepEqual(payload.materials, [], '追问上下文中的材料字段为空，不携带原文');
  assert.equal(result.text, model.text);
});

test('拒绝无效追问角色、未评分测验、错误题号和损坏的缓存记录', async () => {
  const task = makeTask();
  const settings = {};
  await assert.rejects(tutoring.answerQuestion(task, { kind: 'daily', dayIndex: 0 }, 'q1', [{ role: 'assistant', text: '跳过用户' }], settings), /用户开始/);
  await assert.rejects(tutoring.answerQuestion(task, { kind: 'daily', dayIndex: 0 }, 'q9', [{ role: 'user', text: '解释' }], settings), /不在所选测验/);
  const ungraded = makeTask({ rated: false });
  await assert.rejects(tutoring.answerQuestion(ungraded, { kind: 'daily', dayIndex: 0 }, 'q1', [{ role: 'user', text: '解释' }], settings), /已评分/);
  assert.equal(tutoring.validateTutoringRecords({ days: 2 }), true, '没有新字段的旧任务可通过校验');

  const quiz = task.dailyQuizzes[0];
  task.tutorChats = { 'daily:0:q1': {
    kind: 'daily', dayIndex: 0, questionId: 'q1', question: quiz.questions[0].question,
    answer: '旧作答', feedback: quiz.result.items[0].feedback,
    messages: [{ role: 'user', text: '为什么？' }, { role: 'assistant', text: '解释。' }]
  } };
  assert.throws(() => tutoring.validateTutoringRecords(task), /不一致/);
});
