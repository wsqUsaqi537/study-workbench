'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const JSZip = require('jszip');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-workbench-desktop-data-'));
const externalScreenshotDir = process.env.STUDY_TEST_SCREENSHOT_DIR;
const screenshotDir = externalScreenshotDir || fs.mkdtempSync(path.join(os.tmpdir(), 'study-workbench-desktop-shot-'));
const requestedScreenshots = process.env.STUDY_TEST_KEEP_SCREENSHOT === '1';
const appRoot = path.resolve(process.env.STUDY_TEST_APP_ROOT || __dirname);
const schedule = require(path.join(appRoot, 'schedule.js'));
process.env.STUDY_APP_DATA_DIR = dataDir;

const { app, BrowserWindow, safeStorage, dialog } = require('electron');
Object.defineProperty(safeStorage, 'isEncryptionAvailable', { configurable: true, value: () => false });

const apiRecords = [];
let clarifyCount = 0;
function pngChunk(type, data) {
  const chunkType = Buffer.from(type);
  const payload = Buffer.concat([chunkType, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function makeSeedAvatar() {
  const width = 32;
  const height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = 53;
      row[offset + 1] = 111;
      row[offset + 2] = 90;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const seedProfile = {
  nickname: '初始测试用户',
  avatar: makeSeedAvatar()
};
const expectedBrief = {
  goal: '能够独立完成一个可运行的 Python 记账小程序',
  scope: ['变量与数据类型', '条件与循环', '函数'],
  prerequisites: ['熟悉电脑基本操作'],
  outcomes: ['完成并解释记账小程序']
};

function makeQuestions() {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `q${index + 1}`,
    question: `请解释 Python 学习内容中的第 ${index + 1} 个关键点，并说明如何应用。`,
    reference: '回答应解释核心概念，并结合具体例子说明。',
    rubric: '按概念准确性、理由和应用说明评分，每项 0 至 20 分。'
  }));
}

function makeAssessmentQuestions(kind) {
  const count = kind === 'daily' ? 5 : 10;
  return Array.from({ length: count }, (_, index) => {
    const type = kind === 'daily'
      ? ([0, 2].includes(index) ? 'choice' : 'fill')
      : (index === 8 ? 'short' : ([0, 4, 7].includes(index) ? 'choice' : 'fill'));
    return {
      id: `q${index + 1}`,
      type,
      question: type === 'choice' ? `关于第 ${index + 1} 个知识点，哪项正确？` : `请说明第 ${index + 1} 个知识点的用途。`,
      options: type === 'choice' ? ['正确解释', '干扰项甲', '干扰项乙', '干扰项丙'] : [],
      answer: type === 'choice' ? 'A' : `参考要点 ${index + 1}`,
      alternatives: type === 'fill' ? [`合理同义答案 ${index + 1}`] : [],
      reference: `第 ${index + 1} 题参考说明。`,
      rubric: '按核心概念和说明准确性评分。'
    };
  });
}

function makeDailyReadinessQuiz(dayIndex, date, decision = '') {
  const questions = makeAssessmentQuestions('daily');
  const answers = Object.fromEntries(questions.map(question => [question.id, {
    text: question.type === 'choice' ? 'A' : '这是保留的作答。'
  }]));
  const items = questions.map(question => ({
    id: question.id,
    score: question.type === 'choice' ? 20 : 10,
    feedback: '回答包含核心概念并给出解释。'
  }));
  return {
    version: 2,
    mode: 'ai',
    kind: 'daily',
    dayIndex,
    questions,
    generatedDate: date,
    answers,
    resultDate: date,
    result: {
      mode: 'ai',
      score: items.reduce((sum, item) => sum + item.score, 0),
      feedback: '建议先巩固基础，再继续下一步。',
      items,
      weakPoints: ['循环应用'],
      report: {
        summary: '建议先巩固循环的实际应用。',
        strengths: ['能识别主要概念'],
        nextSteps: ['用循环汇总多笔账目'],
        readyForNext: false,
        reason: '第 2 题显示还需要练习循环如何处理多笔账目。',
        extraMinutes: 20,
        extraTasks: ['用循环遍历三笔账目并核对总额']
      }
    },
    ...(decision ? { decision, supplementCompleted: decision === 'extra' } : {})
  };
}

function materialSource(input) {
  const material = input.materials?.[0];
  if (!material) return '主题与学习目标';
  const reference = String(material.text || '').match(/【第\s*(\d+)\s*(页|张幻灯片)】/);
  return reference ? `${material.name} 第 ${reference[1]} ${reference[2]}` : material.name;
}

function makeModelPlan(input) {
  const dates = Array.isArray(input.sessions)
    ? input.sessions.map(session => session.date)
    : schedule.learningDates({
      startDate: input.startDate || '2026-10-08',
      days: Number(input.days) || 2,
      calendarDays: input.calendarDays,
      cadence: input.cadence
    });
  const days = dates.length;
  const source = materialSource(input);
  return {
    summary: '逐步学习 Python 基础，并通过小程序检验掌握情况。',
    difficulty: '入门',
    warnings: [],
    days: dates.map((date, index) => ({
      day: index + 1,
      date,
      title: index === days - 1 ? '小程序综合测试与复盘' : `第 ${index + 1} 天：变量与练习`,
      minutes: Math.min(45, Number(input.minutesPerDay) || 60),
      tasks: [
        index === days - 1 ? '完成小程序测试并复盘' : '理解概念并完成练习',
        '完成 5 题小测，用时 10 分钟',
        ...(index === days - 1 ? ['完成 10 题周期测验，用时 15 分钟'] : [])
      ],
      source
    })),
    knowledge: [
      { title: '变量与数据类型', priority: '重点', explanation: '变量保存需要使用的数据；选择合适的数据类型有助于正确处理输入和计算。', source },
      { title: '循环结构', priority: '了解', explanation: '循环可以重复执行操作，适合处理多笔记账记录。', source }
    ]
  };
}

function makePlanOutline(input) {
  const plan = makeModelPlan({ ...input, days: Math.min(Number(input.days) || 2, 2) });
  return {
    summary: plan.summary,
    difficulty: plan.difficulty,
    warnings: plan.warnings,
    knowledge: plan.knowledge
  };
}

function makePlanBatch(payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const source = payload.allowedSources?.[0] || payload.knowledge?.[0]?.source || payload.materials?.[0]?.name || '主题与学习目标';
  const totalDays = Number(payload.totalDays ?? payload.days) || 0;
  return {
    days: sessions.map(session => ({
      day: session.day,
      date: session.date,
      title: `第 ${session.day} 天：变量与练习`,
      minutes: Math.min(45, Number(payload.minutesPerDay) || 60),
      tasks: [
        '理解概念并完成练习',
        '完成 5 题小测，用时 10 分钟',
        ...(Number(session.day) === totalDays ? ['完成 10 题周期测验，用时 15 分钟'] : [])
      ],
      source
    }))
  };
}

function makeCadenceBatch(payload) {
  return {
    days: (Array.isArray(payload.sessions) ? payload.sessions : []).map(session => ({
      day: session.day,
      date: session.date,
      title: `第 ${session.day} 天：循环巩固与练习`,
      minutes: Math.min(45, Number(payload.minutesPerDay) || 60),
      tasks: [
        '用循环处理多笔账目并复核结果；安排 5 题小测，用时 10 分钟',
      ...(Number(session.day) === Number(payload.totalDays ?? payload.days) ? ['完成 10 题周期测验，用时 15 分钟'] : [])
      ],
      source: payload.allowedSources?.[0] || '主题与学习目标'
    }))
  };
}

function responseFor(purpose, payload) {
  if (payload.outputLanguage === 'en') {
    if (purpose === '生成学习计划') {
      const plan = makeModelPlan(payload);
      plan.summary = 'Learn variables and loops, then apply them in a small project.';
      plan.knowledge = plan.knowledge.map((item, index) => ({ ...item, title: index ? 'Loops' : 'Variables and types', explanation: index ? 'Repeat an operation for each record.' : 'Store values using appropriate types.' }));
      plan.days = plan.days.map((day, index) => ({ ...day, title: index ? 'Practice and review' : 'Variables and examples', tasks: ['Practice the concepts', 'Take a 5-question daily quiz (10 minutes)', ...(index === plan.days.length - 1 ? ['Take a 10-question final test (15 minutes)'] : [])] }));
      return plan;
    }
    if (purpose === '讲解当前日学习内容') return { text: 'Concept: variables store values.\nExample: record a purchase.\nCommon pitfall: mixing text and numbers.\nExercise: create a record.', sources: payload.allowedSources.slice(0, 1), limitations: [] };
    if (purpose === '生成每日小测' || purpose === '生成周期测验') {
      return { questions: makeAssessmentQuestions(purpose === '生成每日小测' ? 'daily' : 'final').map(q => ({ ...q, question: q.type === 'choice' ? 'Which explanation is correct?' : 'Explain how to use this concept.', options: q.type === 'choice' ? ['Correct explanation', 'Distractor one', 'Distractor two', 'Distractor three'] : [], answer: q.type === 'choice' ? 'A' : 'Use the concept in practice.', alternatives: q.type === 'fill' ? ['Apply it to a practical example.'] : [], reference: 'Explain the concept with a concrete example.', rubric: 'Assess accuracy and application.' })) };
    }
    if (purpose === '评分并生成学习报告') {
      const result = responseFor(purpose, { ...payload, outputLanguage: 'zh-CN' });
      result.feedback = 'You understood the main concepts. Review the prerequisite before continuing.';
      result.items = result.items.map(item => ({ ...item, feedback: 'Your response identifies the key concept.' }));
      result.weakPoints = result.weakPoints.map(item => typeof item === 'string' ? 'Review the prerequisite.' : ({ ...item, point: 'Apply the concept independently.' }));
      result.report = { ...result.report, summary: 'You completed the daily assessment.', strengths: ['You can identify the key concepts.'], nextSteps: ['Review the prerequisite.'], reason: payload.nextDay ? 'q4 shows a prerequisite gap for the next day.' : 'The report covers the recorded assessments.', extraTasks: payload.nextDay ? ['Practice the prerequisite with one more example.'] : [] };
      return result;
    }
  }
  if (purpose === '澄清学习需求') {
    clarifyCount += 1;
    return clarifyCount === 1
      ? { reply: '你希望覆盖变量、循环和函数，并完成记账小程序，对吗？', ready: false, brief: null }
      : { reply: '学习范围已经整理好，请确认。', ready: true, brief: expectedBrief };
  }
  if (purpose === '讲解当前日学习内容') return { text: '概念：变量保存信息。\n例子：记录一笔账目。\n易错点：混淆数字与文本。\n练习：写出一笔记录。', sources: payload.allowedSources.slice(0, 1), limitations: [] };
  if (purpose === '解释当前测验题和评分反馈') return { text: '把记录拆分后，先校验输入，再汇总数值；用一个简单例子逐步检查。', sources: payload.allowedSources.slice(0, 1), limitations: [] };
  if (purpose === '生成学习计划概要与知识清单') return makePlanOutline(payload);
  if (purpose === '生成学习计划每日安排') return makePlanBatch(payload);
  if (purpose === '按学习频率重拟未来计划') return makeCadenceBatch(payload);
  if (purpose === '生成学习计划') return makeModelPlan(payload);
  if (purpose === '生成每日小测') return { questions: makeAssessmentQuestions('daily') };
  if (purpose === '生成周期测验') return { questions: makeAssessmentQuestions('final') };
  if (purpose === '评分并生成学习报告') {
    const quiz = payload.currentQuiz || [];
    const items = quiz.filter(question => question.type !== 'choice').map(question => ({
      id: question.id,
      score: question.type === 'short' ? 8 : (payload.nextDay ? 20 : 10),
      feedback: '回答包含核心概念并给出解释。'
    }));
    const daily = Boolean(payload.nextDay);
    return {
      feedback: '主要内容已经掌握，继续练习完整应用流程。',
      items,
      weakPoints: daily ? ['综合运用'] : [],
      report: {
        summary: daily ? '建议先巩固循环的实际应用。' : '本周期的知识点掌握良好。',
        strengths: ['能解释变量用途'],
        nextSteps: daily ? ['用循环汇总多笔账目'] : ['继续按计划复习'],
        readyForNext: daily ? false : null,
        reason: daily ? '第 2 题回答没有说明循环如何处理多笔账目。' : '本周期测验已经完成。',
        extraMinutes: daily ? 25 : 0,
        extraTasks: daily ? ['用循环遍历三笔账目并核对总额'] : []
      }
    };
  }
  if (purpose === '调整后续学习规划') {
    const upcoming = payload.upcoming || [];
    const lastDay = upcoming.at(-1)?.day;
    return {
      summary: '先巩固循环，再继续完成后续目标。',
      days: upcoming.map(day => ({
        ...day,
        title: `第 ${day.day} 天：循环巩固与练习`,
        tasks: day.day === lastDay
          ? ['安排 5 题小测，用时 10 分钟；完成 10 题周期测验，用时 15 分钟；复核账目结果']
          : ['安排 5 题小测，用时 10 分钟；用循环处理多笔账目并复核结果'],
        source: payload.allowedSources?.[0] || '主题与学习目标'
      }))
    };
  }
  if (purpose.includes('生成') && /测验|题/.test(purpose)) return { questions: makeQuestions() };
  if (purpose.includes('评阅') || purpose.includes('评分')) {
    const quiz = payload.quiz || [];
    const items = quiz.map(question => ({ id: question.id, score: 16, feedback: '回答包含核心概念并给出解释。' }));
    return { score: items.reduce((sum, item) => sum + item.score, 0), feedback: '主要内容已经掌握，继续练习完整应用流程。', items, weakPoints: ['综合运用'] };
  }
  if (purpose === '连接测试') return { ok: true };
  throw new Error(`未识别的 mock API purpose: ${purpose}`);
}

const apiServer = http.createServer(async (request, response) => {
  let body = '';
  try {
    for await (const chunk of request) body += chunk;
    const requestBody = JSON.parse(body);
    const content = requestBody.messages?.[1]?.content || '';
    let payload;
    try { payload = JSON.parse(content); } catch { payload = null; }
    const purpose = payload?.purpose || (content.includes('连接测试') ? '连接测试' : '');
    const record = { path: request.url, authorization: request.headers.authorization, requestBody, purpose, payload, responseAborted: false };
    response.once('close', () => {
      if (!response.writableFinished) record.responseAborted = true;
    });
    apiRecords.push(record);
    if (nextPlanGate && nextPlanGate.purpose === purpose) {
      const gate = nextPlanGate;
      nextPlanGate = null;
      gate.resolveObserved(payload);
      await gate.released;
    }
    const result = responseFor(purpose, payload || {});
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    if (response.destroyed) return;
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
const apiStarted = new Promise((resolve, reject) => {
  apiServer.once('error', reject);
  apiServer.listen(0, '127.0.0.1', resolve);
});
let nextPlanGate = null;

function delayNextPlanResponse(purpose = '生成学习计划') {
  let resolveObserved;
  let releaseResponse;
  const observed = new Promise(resolve => { resolveObserved = resolve; });
  const released = new Promise(resolve => { releaseResponse = resolve; });
  nextPlanGate = { purpose, resolveObserved, released };
  return { observed, release: () => releaseResponse() };
}

function legacyTask() {
  const questions = makeQuestions();
  const today = '2026-10-08';
  return {
    id: 'legacy-python-task',
    title: '旧版 Python 计划',
    goal: '理解 Python 基础语法并完成简单练习。',
    level: 'beginner',
    startDate: today,
    days: 2,
    minutesPerDay: 45,
    materials: [],
    plan: {
      mode: 'basic', summary: '旧版基础计划。', difficulty: '入门', warnings: [],
      days: [0, 1].map(index => ({
        day: index + 1,
        date: index ? '2026-10-09' : today,
        title: index ? '旧版综合测试' : '旧版变量练习',
        minutes: 30,
        tasks: [index ? '完成测试并复盘' : '练习变量与类型'],
        source: '旧版基础计划',
        completed: false
      }))
    },
    createdAt: '2026-10-08T00:00:00.000Z',
    quiz: {
      mode: 'basic', questions,
      answers: Object.fromEntries(questions.map(question => [question.id, { text: '这是旧版历史答案。', rating: 12 }])),
      result: {
        mode: 'basic', score: 60, feedback: '旧版测验结果保留为历史记录。',
        items: questions.map(question => ({ id: question.id, score: 12, feedback: '旧版历史反馈。' })), weakPoints: []
      },
      resultDate: today
    }
  };
}

function legacyAITask() {
  const task = legacyTask();
  task.id = 'legacy-python-ai-ungraded';
  task.title = '旧版 AI Python 测验';
  task.plan.summary = '带未评分旧版 AI 测验的历史计划。';
  task.quiz = { mode: 'ai', questions: makeQuestions() };
  return task;
}

const originalLegacyTask = legacyTask();
const originalLegacyAITask = legacyAITask();
const initialTasksText = JSON.stringify({ tasks: [originalLegacyTask, originalLegacyAITask] }, null, 2);
fs.writeFileSync(path.join(dataDir, 'tasks.json'), initialTasksText);
fs.writeFileSync(path.join(dataDir, 'profile.json'), JSON.stringify(seedProfile, null, 2));
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }));
require(path.join(appRoot, 'main.cjs'));

let currentStage = '启动 Electron';
let successfulRun = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForWindow(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (window) {
      window.webContents.setBackgroundThrottling?.(false);
      return window;
    }
    await delay(50);
  }
  throw new Error(`Electron 主窗口未在 ${timeoutMs}ms 内创建`);
}

async function waitForJS(window, expression, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error('Electron 窗口意外关闭');
    const result = await window.webContents.executeJavaScript(`(async () => Boolean(await (${expression})))()`);
    if (result) return result;
    await delay(80);
  }
  throw new Error(`等待超时：${description}`);
}

async function click(window, selector, description = selector) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `无法点击 ${description}`);
}

async function clickAction(window, action, taskId, extra = {}) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const element = [...document.querySelectorAll('[data-action]')].find(candidate =>
      candidate.dataset.action === ${JSON.stringify(action)} &&
      (!${JSON.stringify(taskId)} || candidate.dataset.taskId === ${JSON.stringify(taskId)}) &&
      ${extra.dayIndex === undefined ? 'true' : `candidate.dataset.dayIndex === ${JSON.stringify(String(extra.dayIndex))}`} &&
      ${extra.kind === undefined ? 'true' : `candidate.dataset.kind === ${JSON.stringify(extra.kind)}`}
    );
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `无法点击操作 ${action}`);
}

async function openAssessmentThroughUI(window, taskId, kind, dayIndex, generate = false) {
  const selector = { kind, ...(kind === 'daily' ? { dayIndex } : {}) };
  const beforeRequests = apiRecords.length;
  await clickAction(window, 'open-assessment', taskId, selector);
  if (!generate) {
    await waitForJS(window, 'document.querySelector("#quizForm") || document.querySelector("[data-action=generate-assessment]")', '已保存测验或生成入口显示');
    assert.equal(apiRecords.length, beforeRequests, '打开测验或报告不应隐式请求模型');
    return;
  }
  await waitForJS(window, 'document.querySelector("#quizForm") || document.querySelector("[data-action=generate-assessment]") || /正在生成|generating/i.test(document.querySelector(".quiz-intro h2")?.textContent || "")', '测验页面入口或已开始的请求');
  const entryState = await window.webContents.executeJavaScript(`({
    title: document.querySelector('#appView h1')?.textContent || '',
    generateButtons: [...document.querySelectorAll('[data-action="generate-assessment"]')].map(button => ({ kind: button.dataset.kind, dayIndex: button.dataset.dayIndex, disabled: button.disabled })),
    form: Boolean(document.querySelector('#quizForm')),
    busy: /正在生成|generating/i.test(document.querySelector('.quiz-intro h2')?.textContent || ''),
    requestStarted: ${apiRecords.length > beforeRequests},
    text: document.querySelector('#appView')?.innerText.slice(0, 400) || ''
  })`);
  if (entryState.generateButtons.length) {
    assert.equal(apiRecords.length, beforeRequests, '显示未生成的测验不应自动请求模型');
    await clickAction(window, 'generate-assessment', taskId, selector);
  } else {
    assert.ok(entryState.busy, `已有材料授权后，打开测验应进入生成流程：${JSON.stringify(entryState)}`);
    const deadline = Date.now() + 10000;
    while (apiRecords.length === beforeRequests && Date.now() < deadline) await delay(80);
    assert.equal(apiRecords.length, beforeRequests + 1, '打开未生成测验后应只启动一次题目生成请求');
  }
  const generated = kind === 'daily'
    ? `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(taskId)})?.dailyQuizzes?.[${JSON.stringify(String(dayIndex))}]?.questions?.length === 5)`
    : `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(taskId)})?.quiz?.version === 2 && s.tasks.find(t => t.id === ${JSON.stringify(taskId)})?.quiz?.questions?.length === 10)`;
  await waitForJS(window, generated, `${kind === 'daily' ? '日测' : '期末测验'}保存完成`);
  await waitForJS(window, 'document.querySelectorAll(".quiz-question").length === ' + (kind === 'daily' ? 5 : 10), '新题型渲染完成');
  assert.equal(apiRecords.length, beforeRequests + 1, '只有明确生成操作才应产生一次模型请求');
}

async function setValue(window, selector, value) {
  const changed = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.value = ${JSON.stringify(String(value))};
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `找不到输入框 ${selector}`);
}

async function setChecked(window, selector, checked) {
  const changed = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.checked = ${Boolean(checked)};
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `找不到复选框 ${selector}`);
}

async function beginCreateLoadingObservation(window) {
  await window.webContents.executeJavaScript(`(() => {
    window.__desktopLoadingStates = [];
    const sample = () => {
      const submit = document.querySelector('#createSubmit');
      const status = document.querySelector('#createLoadingStatus');
      window.__desktopLoadingStates.push({ spinner: Boolean(submit?.classList.contains('is-busy')), status: Boolean(status && !status.hidden) });
    };
    const dialog = document.querySelector('#createDialog');
    window.__desktopLoadingObserver?.disconnect();
    window.__desktopLoadingObserver = new MutationObserver(sample);
    window.__desktopLoadingObserver.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-busy'] });
    sample();
  })()`);
}

async function endCreateLoadingObservation(window) {
  return window.webContents.executeJavaScript(`(() => {
    window.__desktopLoadingObserver?.disconnect();
    return window.__desktopLoadingStates.slice();
  })()`);
}

function testLocalDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function writeMarkdownFixture(name, text) {
  const filePath = path.join(dataDir, name);
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

async function setUiLanguage(window, language) {
  await click(window, '#profileButton', `打开个人资料以切换为 ${language}`);
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open', '个人资料语言对话框');
  await setValue(window, '#profileLanguage', language);
  await waitForJS(window, `document.documentElement.lang === ${JSON.stringify(language)}`, `${language} 界面已应用`);
  await click(window, '[data-close="profileDialog"]', '关闭个人资料语言对话框');
}

async function setVisualViewport(window, width, height) {
  window.setContentSize(width, height);
  if (!window.isVisible()) window.show();
  window.focus();
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 220))))');
  const viewport = await window.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
  assert.ok(viewport.width >= width - 30, `Electron 内容宽度应接近 ${width}px：${JSON.stringify(viewport)}`);
  assert.ok(viewport.height >= height - 80, `Electron 内容高度应接近 ${height}px：${JSON.stringify(viewport)}`);
}

async function chooseRadio(window, selector) {
  await click(window, selector, `选择选项 ${selector}`);
}

async function dispatchActualFileDrop(window, filePath, zoneSelector = '#materialDropZone') {
  const filePaths = Array.isArray(filePath) ? filePath : [filePath];
  const debuggerAPI = window.webContents.debugger;
  const wasAttached = debuggerAPI.isAttached();
  if (!wasAttached) debuggerAPI.attach('1.3');
  try {
    await window.webContents.executeJavaScript(`(() => {
      let input = document.querySelector('#nativeFilePathProbe');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'nativeFilePathProbe';
        input.multiple = true;
        input.hidden = true;
        document.querySelector('#createDialog').appendChild(input);
      }
    })()`);
    const documentRoot = await debuggerAPI.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const query = await debuggerAPI.sendCommand('DOM.querySelector', { nodeId: documentRoot.root.nodeId, selector: '#nativeFilePathProbe' });
    assert.ok(query.nodeId, 'CDP 应能找到用于设置真实本地文件的测试 input');
    await debuggerAPI.sendCommand('DOM.setFileInputFiles', { nodeId: query.nodeId, files: filePaths });
    return await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#nativeFilePathProbe');
      const zone = document.querySelector(${JSON.stringify(zoneSelector)});
      if (!input?.files?.length || !zone) return { prepared: false };
      const transfer = new DataTransfer();
      for (const file of input.files) transfer.items.add(file);
      zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const highlighted = zone.classList.contains('is-dragging');
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      input.remove();
      return { prepared: true, highlighted, fileCount: transfer.files.length };
    })()`);
  } finally {
    if (!wasAttached && debuggerAPI.isAttached()) debuggerAPI.detach();
  }
}

async function readState(window) {
  return window.webContents.executeJavaScript('window.studyApp.loadState()');
}

function makeMinimalPdf() {
  const stream = 'BT /F1 18 Tf 36 90 Td (Native PDF worker smoke) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

async function reloadWindow(window, configured, expectedTasks) {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('页面重载超时')), 15000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  window.webContents.reload();
  await loaded;
  const language = (await readState(window)).preferences.language;
  const expectedLabel = language === 'en'
    ? require('./ui-messages.js')[configured ? 'API 已配置' : 'API 未配置']
    : configured ? 'API 已配置' : 'API 未配置';
  await waitForJS(window,
    `window.studyApp.loadState().then(state => state.settings.configured === ${Boolean(configured)} && state.tasks.length === ${Number(expectedTasks)})`,
    '状态重新加载完成');
  await waitForJS(window,
    `document.querySelector('#apiDot')?.getAttribute('aria-label') === ${JSON.stringify(expectedLabel)}`,
    '设置门禁状态更新');
  return window;
}

async function captureScreenshot(window, name) {
  if (!window.isVisible()) {
    console.log('SKIP_SCREENSHOT hidden test window; capture is disabled while hidden');
    return;
  }
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 650))))`);
  const filePath = path.join(screenshotDir, name);
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(filePath, screenshot.toPNG());
  console.log(`TEMP_SCREENSHOT ${filePath}`);
}

async function inspectVisualLayout(window, dialogSelector = '') {
  return window.webContents.executeJavaScript(`(() => {
    const dialog = ${JSON.stringify(dialogSelector)} ? document.querySelector(${JSON.stringify(dialogSelector)}) : null;
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const buttons = dialog ? [...dialog.querySelectorAll('.dialog-actions button')].filter(visible).map(rect) : [];
    const overlaps = [];
    for (let i = 0; i < buttons.length; i += 1) for (let j = i + 1; j < buttons.length; j += 1) {
      if (Math.min(buttons[i].right, buttons[j].right) - Math.max(buttons[i].left, buttons[j].left) > 1 &&
          Math.min(buttons[i].bottom, buttons[j].bottom) - Math.max(buttons[i].top, buttons[j].top) > 1) overlaps.push([i, j]);
    }
    let alignment = [];
    let close = null;
    let footerSpace = 0;
    let dialogMetrics = null;
    let horizontalDialogOverflow = false;
    let actionOverflow = false;
    let tutoringOverflow = false;
    if (dialog && dialog.open) {
      const box = rect(dialog);
      const blocks = [...dialog.querySelectorAll(':scope > form > .dialog-topline, :scope > form > h2, :scope > form > .dialog-intro, :scope > form > .dialog-actions, :scope > .dialog-topline, :scope > h2, :scope > .dialog-intro, :scope > .material-meta, :scope > .material-text, :scope > .dialog-actions, :scope > #adjustmentPreview, :scope > #finalHistoryContent, :scope > #tutoringContent')].filter(visible).map(element => {
        const value = rect(element);
        return { selector: element.id || element.className || element.tagName, left: value.left - box.left, right: box.right - value.right };
      });
      alignment = blocks;
      const closeButton = dialog.querySelector('.dialog-close');
      close = closeButton && visible(closeButton) ? rect(closeButton) : null;
      const form = dialog.querySelector(':scope > form');
      const actions = [...dialog.querySelectorAll('.dialog-actions')].filter(visible).at(-1);
      const formBottom = form ? parseFloat(getComputedStyle(form).paddingBottom) || 0 : 0;
      const dialogBottom = parseFloat(getComputedStyle(dialog).paddingBottom) || 0;
      const actionsBottom = actions ? parseFloat(getComputedStyle(actions).marginBottom) || 0 : 0;
      footerSpace = Math.max(formBottom, dialogBottom + actionsBottom);
      dialogMetrics = { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
      horizontalDialogOverflow = dialog.scrollWidth > dialog.clientWidth + 1;
      actionOverflow = actions ? actions.scrollWidth > actions.clientWidth + 1 : false;
      const tutoring = dialog.querySelector('.tutoring-content');
      tutoringOverflow = tutoring ? tutoring.scrollWidth > tutoring.clientWidth + 1 : false;
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth },
      pageHorizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      dialogOpen: Boolean(dialog?.open), dialogMetrics, horizontalDialogOverflow, actionOverflow, tutoringOverflow,
      close, footerSpace, alignment, overlaps,
      closeReachable: Boolean(close && close.width > 0 && close.height > 0 && close.left >= 0 && close.top >= 0 && close.right <= innerWidth + 1 && close.bottom <= innerHeight + 1),
      alignmentSpread: alignment.length ? {
        left: Math.max(...alignment.map(item => item.left)) - Math.min(...alignment.map(item => item.left)),
        right: Math.max(...alignment.map(item => item.right)) - Math.min(...alignment.map(item => item.right))
      } : { left: 0, right: 0 }
    };
  })()`);
}

async function captureVisualScreenshot(window, name, dialogSelector = '') {
  assert.equal(window.isVisible(), true, `截图前 Electron 窗口必须可见：${name}`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 180))))');
  const layout = await inspectVisualLayout(window, dialogSelector);
  assert.equal(layout.pageHorizontalOverflow, false, `${name} 不得产生页面横向溢出：${JSON.stringify(layout)}`);
  if (dialogSelector) {
    assert.equal(layout.dialogOpen, true, `${name} 对话框必须由真实 showModal 流程打开`);
    assert.equal(layout.horizontalDialogOverflow, false, `${name} 对话框不得横向溢出：${JSON.stringify(layout)}`);
    assert.equal(layout.actionOverflow, false, `${name} 底部按钮区域不得横向溢出：${JSON.stringify(layout)}`);
    assert.deepEqual(layout.overlaps, [], `${name} 底部按钮不得重叠`);
    assert.equal(layout.closeReachable, true, `${name} 关闭按钮应在当前视口内可触达：${JSON.stringify(layout.close)}`);
    assert.ok(layout.footerSpace >= 12, `${name} 底部应留至少 12px 间距：${JSON.stringify({ footerSpace: layout.footerSpace, dialog: layout.dialogMetrics })}`);
    assert.ok(layout.alignmentSpread.left <= 4 && layout.alignmentSpread.right <= 4, `${name} 对话框正文左右边距应一致：${JSON.stringify(layout.alignment)}`);
    if (dialogSelector === '#tutoringDialog') assert.equal(layout.tutoringOverflow, false, '讲解正文不得横向溢出');
  }
  const screenshot = await window.webContents.capturePage();
  const bytes = screenshot.toPNG();
  assert.ok(bytes.length > 1000, `${name} 必须产生真实 Electron PNG 截图`);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const size = screenshot.getSize();
  assert.ok(size.width > 100 && size.height > 100, `${name} 截图必须包含可见窗口内容`);
  const filePath = path.join(screenshotDir, name);
  fs.writeFileSync(filePath, bytes);
  console.log(`TEMP_SCREENSHOT ${filePath} ${size.width}x${size.height}`);
  return layout;
}

function pngDimensions(dataURL) {
  assert.match(dataURL, /^data:image\/png;base64,/);
  const bytes = Buffer.from(dataURL.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function dispatchAvatarFile(window, mimeType, oversized = false) {
  return window.webContents.executeJavaScript(`(async () => {
    let file;
    if (${Boolean(oversized)}) {
      file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' });
    } else if (${JSON.stringify(mimeType)} === 'text/plain') {
      file = new File(['not an image'], 'invalid.txt', { type: 'text/plain' });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      context.fillStyle = '#356f5a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#f1c46a';
      context.fillRect(35, 20, 90, 140);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, ${JSON.stringify(mimeType)}));
      if (!blob) return false;
      file = new File([blob], 'local-avatar', { type: ${JSON.stringify(mimeType)} });
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('#profileAvatarFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return file.type === ${JSON.stringify(mimeType)} || ${Boolean(oversized)};
  })()`);
}

async function waitForAvatarPreview(window, description) {
  await waitForJS(window,
    `document.querySelector('#profileAvatarPreview img')?.src.startsWith('data:image/png;base64,') && !document.querySelector('#chooseProfileAvatar').disabled`,
    description);
  return window.webContents.executeJavaScript(`document.querySelector('#profileAvatarPreview img').src`);
}

async function saveProfileThroughUI(window, nickname) {
  const beforeRequests = apiRecords.length;
  await click(window, '#profileButton', '打开我的设置');
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open', '我的设置对话框');
  await setValue(window, '#profileNickname', nickname);
  await click(window, '#saveProfile', '保存我的设置');
  await waitForJS(window,
    '!document.querySelector("#profileDialog")?.open || !document.querySelector("#profileError").hidden',
    '个人资料保存或返回校验结果');
  const saveStatus = await window.webContents.executeJavaScript(`({
    open: document.querySelector('#profileDialog').open,
    error: document.querySelector('#profileError').textContent
  })`);
  assert.equal(saveStatus.open, false, `个人资料保存被拒绝：${saveStatus.error}`);
  assert.equal(apiRecords.length, beforeRequests, '保存个人资料不应请求模型服务');
}

async function run() {
  currentStage = '等待 localhost API mock 与 Electron 就绪';
  await apiStarted;
  await app.whenReady();
  assert.equal(app.hasSingleInstanceLock(), true, '应用应持有单实例锁');
  const endpoint = `http://127.0.0.1:${apiServer.address().port}/v1`;

  currentStage = '解析最小 PDF';
  const services = require(path.join(appRoot, 'services.cjs'));
  const pdfPath = path.join(dataDir, 'minimal.pdf');
  fs.writeFileSync(pdfPath, makeMinimalPdf());
  const parsedPdf = await services.parseMaterial(pdfPath);
  assert.equal(parsedPdf.units, 1);
  assert.match(parsedPdf.text, /Native PDF worker smoke/, 'Electron 中的 PDF worker 应能提取最小样本');

  currentStage = '验证未配置门禁并保护磁盘历史';
  let window = await waitForWindow();
  window.hide();
  await waitForJS(window, 'Boolean(window.studyApp && document.querySelector("#apiDot"))', '空状态和本地服务就绪');
  const initial = await readState(window);
  assert.equal(initial.settings.configured, false);
  assert.equal(initial.settings.hasKey, false);
  assert.deepEqual(initial.tasks, [], '未配置时不向 UI 暴露历史任务');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#appView").innerText'), /先配置模型服务/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#apiDot").getAttribute("aria-label")'), 'API 未配置');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-action=new-task]").disabled'), true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), initialTasksText, '门禁不得改写磁盘上的旧任务');

  currentStage = 'API 未配置时使用我的设置并验证资料持久化';
  const profileFilePath = path.join(dataDir, 'profile.json');
  const initialProfileText = fs.readFileSync(profileFilePath, 'utf8');
  assert.equal(initial.profile.nickname, seedProfile.nickname, '启动时应从临时 profile.json 读取昵称');
  assert.deepEqual(pngDimensions(initial.profile.avatar), { width: 32, height: 32 }, '启动时应从临时 profile.json 读取并规范化 PNG 头像');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileButton").disabled'), false, '未配置 API 时我的入口仍可用');
  await click(window, '#profileButton', '打开我的设置');
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open', '我的设置对话框');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileNickname").value'), seedProfile.nickname);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileAvatarPreview img")?.src'), initial.profile.avatar);
  await click(window, '#profileDialog [data-close="profileDialog"]', '取消个人资料修改');
  await waitForJS(window, '!document.querySelector("#profileDialog")?.open', '个人资料对话框关闭');
  assert.equal(fs.readFileSync(profileFilePath, 'utf8'), initialProfileText, '取消个人资料修改不得写盘');
  assert.deepEqual((await readState(window)).profile, initial.profile);

  await click(window, '#profileButton', '重新打开我的设置');
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open', '重新打开我的设置');
  await setValue(window, '#profileNickname', '星禾');
  await dispatchAvatarFile(window, 'text/plain');
  await waitForJS(window, '!document.querySelector("#profileError").hidden && document.querySelector("#profileError").textContent.includes("PNG、JPG 或 WebP")', '拒绝不支持的头像类型');
  await dispatchAvatarFile(window, 'image/png', true);
  await waitForJS(window, '!document.querySelector("#profileError").hidden && document.querySelector("#profileError").textContent.includes("5 MB") && !document.querySelector("#chooseProfileAvatar").disabled', '拒绝超过 5 MB 的头像');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileAvatarPreview img")?.src'), initial.profile.avatar, '无效头像不应替换现有预览');
  let normalizedAvatar = '';
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
    await dispatchAvatarFile(window, mimeType);
    normalizedAvatar = await waitForAvatarPreview(window, `${mimeType} 头像解码并转换完成`);
    assert.deepEqual(pngDimensions(normalizedAvatar), { width: 256, height: 256 }, `${mimeType} 应经 canvas 转为 256×256 PNG`);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileNickname").value'), '星禾', `${mimeType} 头像处理不应改变昵称输入`);
  }
  await click(window, '#saveProfile', '保存昵称和本机头像');
  await waitForJS(window, '!document.querySelector("#profileDialog")?.open', '昵称和头像保存完成');
  await waitForJS(window, `window.studyApp.loadState().then(state => state.profile.nickname === "星禾")`, '确认保存后的昵称状态完成同步');
  let savedProfile = await readState(window);
  assert.equal(savedProfile.profile.nickname, '星禾');
  assert.deepEqual(pngDimensions(savedProfile.profile.avatar), { width: 256, height: 256 }, '保存后头像仍应是 256×256 PNG');
  assert.deepEqual(JSON.parse(fs.readFileSync(profileFilePath, 'utf8')), savedProfile.profile, '个人资料应单独写入 profile.json');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), initialTasksText, '保存个人资料不得写入 tasks.json');
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false, '未配置时保存个人资料不得创建 settings.json');
  assert.equal(apiRecords.length, 0, '未配置 API 时保存个人资料不得发出模型请求');

  currentStage = '验证个人资料 IPC 拒绝非法昵称与头像且不破坏已有内容';
  const previousProfileText = fs.readFileSync(profileFilePath, 'utf8');
  const invalidProfileCalls = await window.webContents.executeJavaScript(`(async () => {
    const validAvatar = ${JSON.stringify(normalizedAvatar)};
    const invalid = [
      { label: '超长昵称', profile: { nickname: '你'.repeat(31), avatar: validAvatar } },
      { label: 'URL 头像', profile: { nickname: '星禾', avatar: 'https://example.invalid/avatar.png' } },
      { label: 'SVG 头像', profile: { nickname: '星禾', avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
      { label: '错误 Base64 头像', profile: { nickname: '星禾', avatar: 'data:image/png;base64,%%%=' } },
      { label: '非 PNG Base64 内容', profile: { nickname: '星禾', avatar: 'data:image/png;base64,SGVsbG8=' } }
    ];
    const results = [];
    for (const item of invalid) {
      try { await window.studyApp.saveProfile(item.profile); results.push({ label: item.label, rejected: false }); }
      catch (error) { results.push({ label: item.label, rejected: true, message: error.message }); }
    }
    return results;
  })()`);
  assert.equal(invalidProfileCalls.length, 5);
  assert.ok(invalidProfileCalls.every(result => result.rejected), `非法 profile IPC 必须拒绝：${JSON.stringify(invalidProfileCalls)}`);
  assert.equal(fs.readFileSync(profileFilePath, 'utf8'), previousProfileText, 'IPC 校验失败不得覆盖先前 profile');
  assert.deepEqual((await readState(window)).profile, savedProfile.profile);
  assert.equal(apiRecords.length, 0, 'profile IPC 校验不得请求模型服务');

  currentStage = '重载 renderer 并恢复已保存的昵称和头像';
  window = await reloadWindow(window, false, 0);
  savedProfile = await readState(window);
  assert.deepEqual(savedProfile.profile, JSON.parse(previousProfileText), 'renderer reload 后应从主进程恢复个人资料');
  await click(window, '#profileButton', '重载后查看已保存资料');
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open && document.querySelector("#profileNickname").value === "星禾" && document.querySelector("#profileAvatarPreview img")?.src.startsWith("data:image/png;base64,")', '重载后昵称和头像预览');
  if (process.env.STUDY_TEST_KEEP_PROFILE_SCREENSHOT === '1') {
    const profileScreenshotPath = path.join(os.tmpdir(), `study-workbench-profile-${process.pid}.png`);
    const profileScreenshot = await window.webContents.capturePage();
    fs.writeFileSync(profileScreenshotPath, profileScreenshot.toPNG());
    console.log(`TEMP_PROFILE_SCREENSHOT ${profileScreenshotPath}`);
  }
  await click(window, '#profileDialog [data-close="profileDialog"]', '关闭已恢复的个人资料');
  await waitForJS(window, '!document.querySelector("#profileDialog")?.open', '个人资料对话框关闭');

  const blockedCalls = await window.webContents.executeJavaScript(`(async () => {
    const calls = [
      ['saveTask', () => window.studyApp.saveTask({})],
      ['deleteTask', () => window.studyApp.deleteTask('legacy-python-task')],
      ['importMaterials', () => window.studyApp.importMaterials()],
      ['importDroppedMaterials', () => window.studyApp.importDroppedMaterials([new File(['no native path'], 'fake.pdf', { type: 'application/pdf' })])],
      ['importDroppedMaterialsPath', () => window.studyApp.importDroppedMaterials(['/tmp/not-a-file-object.pdf'])],
      ['clarifyGoal', () => window.studyApp.clarifyGoal({ input: {}, messages: [] })],
      ['generatePlan', () => window.studyApp.generatePlan({})],
      ['generateQuiz', () => window.studyApp.generateQuiz({})],
      ['gradeQuiz', () => window.studyApp.gradeQuiz({})]
    ];
    const results = [];
    for (const [name, call] of calls) {
      try { await call(); results.push({ name, rejected: false }); }
      catch (error) { results.push({ name, rejected: true, message: error.message }); }
    }
    return results;
  })()`);
  assert.equal(blockedCalls.length, 9);
  assert.ok(blockedCalls.every(result => result.rejected), `所有任务 IPC 在 API 未配置时都应拒绝：${JSON.stringify(blockedCalls)}`);
  assert.equal(apiRecords.length, 0, '未配置时不应发出 mock API 请求');

  currentStage = '未配置API时切换语言及拒绝无效偏好';
  const preferencesBeforeInvalid = fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8');
  const invalidPreferencesRejected = await window.webContents.executeJavaScript(`(async () => {
    const results = [];
    for (const input of [{ language: 'fr' }, { language: 'en', key: 'unexpected' }, null]) {
      try { await window.studyApp.savePreferences(input); results.push(false); }
      catch { results.push(true); }
    }
    return results;
  })()`);
  assert.deepEqual(invalidPreferencesRejected, [true, true, true]);
  assert.equal(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'), preferencesBeforeInvalid);
  await click(window, '#profileButton', '无API时打开语言设置');
  await setValue(window, '#profileLanguage', 'en');
  await waitForJS(window, 'document.documentElement.lang === "en" && Boolean(document.querySelector(".service-locked"))', '未配置时仍可使用英文');
  assert.equal((await readState(window)).settings.configured, false);
  assert.equal(apiRecords.length, 0);
  await setValue(window, '#profileLanguage', 'zh-CN');
  await waitForJS(window, 'document.documentElement.lang === "zh-CN"', '锁定状态切回中文');
  await click(window, '[data-close="profileDialog"]', '关闭语言设置');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), initialTasksText);

  currentStage = '保存部分配置并保持锁定';
  await click(window, '[data-action="settings"]', '打开 API 设置');
  await waitForJS(window, 'document.querySelector("#settingsDialog")?.open', 'API 设置对话框');
  const deepSeekExamples = await window.webContents.executeJavaScript(`({
    endpoint: document.querySelector('#apiEndpoint').placeholder,
    model: document.querySelector('#apiModel').placeholder,
    help: document.querySelector('#settingsDialog').innerText
  })`);
  assert.equal(deepSeekExamples.endpoint, 'https://api.deepseek.com', 'API 设置应展示 DeepSeek API 地址示例');
  assert.equal(deepSeekExamples.model, 'deepseek-flash', 'API 设置应展示 DeepSeek 模型示例');
  assert.match(deepSeekExamples.help, /https:\/\/api\.deepseek\.com/);
  assert.match(deepSeekExamples.help, /deepseek-flash/);
  await setValue(window, '#apiEndpoint', endpoint);
  await setValue(window, '#apiModel', 'desktop-mock');
  await setValue(window, '#apiKey', '');
  await click(window, '#saveSettings', '保存部分设置');
  await waitForJS(window, 'document.querySelector("#settingsDialog") && !document.querySelector("#settingsDialog").open', '部分设置保存完成');
  let state = await readState(window);
  assert.equal(state.settings.endpoint, endpoint);
  assert.equal(state.settings.model, 'desktop-mock');
  assert.equal(state.settings.hasKey, false);
  assert.equal(state.settings.configured, false);
  assert.deepEqual(state.tasks, []);
  await waitForJS(window, 'Boolean(document.querySelector(".service-locked"))', '部分配置仍显示锁定界面');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), initialTasksText, '保存部分配置不应改写任务数据');

  currentStage = '保存完整会话 Key 并恢复历史计划';
  await click(window, '[data-action="settings"]', '重新打开 API 设置');
  await waitForJS(window, 'document.querySelector("#settingsDialog")?.open', '重新打开设置对话框');
  await setValue(window, '#apiKey', 'desktop-session-key');
  await click(window, '#saveSettings', '保存完整 API 配置');
  await waitForJS(window, 'document.querySelector("#settingsDialog") && !document.querySelector("#settingsDialog").open', '完整配置保存完成');
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.settings.configured && s.settings.hasKey && s.tasks.length === 2)', '历史计划恢复显示');
  state = await readState(window);
  assert.equal(state.settings.configured, true);
  assert.equal(state.tasks[0].id, originalLegacyTask.id);
  assert.equal(JSON.stringify(state.settings).includes('desktop-session-key'), false, '公开设置不得泄露 Key');
  const storedSettings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(storedSettings.encryptedKey, undefined, '加密不可用时 Key 不应写到磁盘');
  assert.equal(storedSettings.key, undefined);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#apiDot").getAttribute("aria-label")'), 'API 已配置');
  assert.ok(apiRecords.length === 0, '保存设置不应隐式发起模型请求');

  currentStage = 'API 解锁后显示个性化问候并验证昵称安全处理';
  const welcomeHeading = () => window.webContents.executeJavaScript('document.querySelector("#appView .welcome-panel h2")?.textContent || ""');
  assert.ok((await welcomeHeading()).startsWith('星禾，'), 'API 解锁后欢迎词应使用保存的昵称');
  const tasksTextBeforeProfileEdits = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  const settingsTextBeforeProfileEdits = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  await saveProfileThroughUI(window, '小满');
  assert.ok((await welcomeHeading()).startsWith('小满，'), '更换昵称后欢迎词应立即更新');
  let profileState = await readState(window);
  assert.equal(profileState.profile.nickname, '小满');

  const htmlNickname = '<b>网页文本</b>';
  await saveProfileThroughUI(window, htmlNickname);
  assert.ok((await welcomeHeading()).startsWith(`${htmlNickname}，`), '含 HTML 的昵称应以原文显示');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#appView .welcome-panel h2").querySelector("b, img, svg") === null'), true, '昵称中的 HTML 不得创建 DOM 节点');

  await click(window, '#profileButton', '打开我的设置并移除头像');
  await waitForJS(window, 'document.querySelector("#profileDialog")?.open && !document.querySelector("#removeProfileAvatar").hidden', '显示已保存头像的移除按钮');
  await setValue(window, '#profileNickname', '小满');
  await click(window, '#removeProfileAvatar', '移除头像');
  await click(window, '#saveProfile', '保存保留昵称的个人资料');
  await waitForJS(window,
    '!document.querySelector("#profileDialog")?.open || !document.querySelector("#profileError").hidden',
    '移除头像后的保存或校验结果');
  const removeSaveStatus = await window.webContents.executeJavaScript(`({
    open: document.querySelector('#profileDialog').open,
    error: document.querySelector('#profileError').textContent
  })`);
  assert.equal(removeSaveStatus.open, false, `移除头像后的个人资料保存被拒绝：${removeSaveStatus.error}`);
  profileState = await readState(window);
  assert.deepEqual(profileState.profile, { nickname: '小满', avatar: '' }, '移除头像应保留昵称');
  assert.ok((await welcomeHeading()).startsWith('小满，'));
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileButton img") === null'), true, '移除头像后入口应恢复默认头像');

  await saveProfileThroughUI(window, '');
  profileState = await readState(window);
  assert.deepEqual(profileState.profile, { nickname: '', avatar: '' });
  const defaultGreetings = ['早上好，今天从一小步开始', '下午好，给专注留一点空间', '晚上好，慢慢收好今天的进度'];
  const emptyNicknameGreeting = await welcomeHeading();
  assert.ok(defaultGreetings.includes(emptyNicknameGreeting), `昵称留空后应恢复原问候词，实际为：${emptyNicknameGreeting}`);
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), tasksTextBeforeProfileEdits, '个人资料编辑不得改写任务');
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), settingsTextBeforeProfileEdits, '个人资料编辑不得改写 API 设置');

  currentStage = '通过真实设置界面测试模型连接';
  await click(window, '[data-action="settings"]', '打开 API 设置测试连接');
  await waitForJS(window, 'document.querySelector("#settingsDialog")?.open', '设置窗口打开');
  await click(window, '#testConnection', '保存并测试连接');
  await waitForJS(window, 'document.querySelector("#settingsMessage")?.textContent.includes("API 连接成功")', '界面显示连接成功');
  assert.equal(apiRecords.length, 1);
  assert.equal(apiRecords[0].purpose, '连接测试');
  assert.ok(apiRecords[0].requestBody.max_tokens >= 512, '测试连接应留出足够的输出空间');
  assert.equal(apiRecords[0].requestBody.thinking, undefined, '本机通用兼容服务不应收到 DeepSeek 参数');
  await click(window, '#settingsDialog [data-close="settingsDialog"]', '关闭已测试的设置窗口');

  currentStage = '重载并确认配置与旧历史恢复';
  window = await reloadWindow(window, true, 2);
  state = await readState(window);
  assert.equal(state.tasks[0].id, originalLegacyTask.id);

  currentStage = '查看旧版历史测验并成功重生 AI 测验';
  await clickAction(window, 'open-plan', originalLegacyTask.id);
  await waitForJS(window, 'document.querySelector(".plan-knowledge-history") && document.querySelector("#appView h1")?.textContent === "旧版 Python 计划"', '旧计划历史详情');
  const historyRequests = apiRecords.length;
  await clickAction(window, 'open-assessment', originalLegacyTask.id, { kind: 'final' });
  await waitForJS(window, 'document.querySelector(".result-panel") && document.querySelectorAll(".quiz-question").length === 5', '旧版已提交测验历史');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-rating]").length'), 0);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#quizForm [data-answer]:not([readonly]):not([disabled])").length'), 0, '旧版历史答案只能查看，不能再次编辑');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("#submitQuiz"))'), false, '旧版历史不能再次自评提交');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".quiz-question textarea[readonly]").length'), 5);
  assert.equal(apiRecords.length, historyRequests, '只查看旧历史不应请求模型');
  await window.webContents.executeJavaScript('window.confirm = () => true; true');
  await clickAction(window, 'retake-assessment', originalLegacyTask.id, { kind: 'final' });
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks[0]?.quiz?.version === 2 && s.tasks[0]?.quiz?.kind === 'final')`, '旧版历史成功生成新版期末测验');
  state = await readState(window);
  assert.equal(state.tasks[0].quiz.mode, 'ai');
  assert.equal(state.tasks[0].quiz.questions.length, 10);
  assert.equal(state.tasks[0].quiz.result, undefined, '重生 AI 题目应清除旧版提交结果');
  const afterLegacyRetake = apiRecords.length;
  await clickAction(window, 'open-plan', originalLegacyTask.id);
  await clickAction(window, 'open-assessment', originalLegacyTask.id, { kind: 'final' });
  await waitForJS(window, 'document.querySelectorAll(".quiz-question").length === 10', '重新打开新版期末测验');
  assert.equal(apiRecords.length, afterLegacyRetake, '重新打开已保存的测验不应隐式重生成');

  currentStage = '兼容旧版未评分 AI 五题测验';
  const legacyGradeRequests = apiRecords.filter(record => record.purpose === '按材料和评分标准评阅学习测验').length;
  await clickAction(window, 'open-plan', originalLegacyAITask.id);
  await clickAction(window, 'open-assessment', originalLegacyAITask.id, { kind: 'final' });
  await waitForJS(window, 'document.querySelectorAll(".quiz-question textarea[data-answer]").length === 5 && Boolean(document.querySelector("#submitQuiz"))', '旧版未评分 AI 测验可填写并提交');
  assert.equal(apiRecords.filter(record => record.purpose === '按材料和评分标准评阅学习测验').length, legacyGradeRequests, '仅打开旧版 AI 测验不应自动评分');
  for (let index = 0; index < 5; index += 1) {
    await setValue(window, `#quizForm [data-answer][data-qid="q${index + 1}"]`, `旧版 AI 第 ${index + 1} 题回答`);
  }
  await click(window, '#submitQuiz', '兼容旧版 AI 五题评分');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(originalLegacyAITask.id)})?.quiz?.result?.mode === 'ai')`, '旧版 AI 评分结果保存');
  state = await readState(window);
  const gradedLegacyAI = state.tasks.find(candidate => candidate.id === originalLegacyAITask.id);
  assert.equal(gradedLegacyAI.quiz.version, undefined, '旧版 AI 五题结构继续兼容');
  assert.equal(gradedLegacyAI.quiz.result.score, 80);
  assert.equal(apiRecords.filter(record => record.purpose === '按材料和评分标准评阅学习测验').length, legacyGradeRequests + 1);

  currentStage = '编辑旧计划并验证保存';
  await clickAction(window, 'open-plan', originalLegacyTask.id);
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "旧版 Python 计划"', '返回旧计划详情');
  await clickAction(window, 'toggle-day', originalLegacyTask.id, { dayIndex: 0 });
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.tasks[0]?.plan.days[0]?.completed === true)', '第一天完成状态保存');
  await clickAction(window, 'edit-day', originalLegacyTask.id, { dayIndex: 0 });
  await waitForJS(window, 'document.querySelector("#editDayDialog")?.open', '每日计划编辑对话框');
  await setValue(window, '#editDayName', 'Python 变量与数据类型');
  await setValue(window, '#editDayTasks', '理解变量赋值\n练习字符串和数字类型');
  await click(window, '#editDayForm button[type="submit"]', '保存每日计划修改');
  await waitForJS(window, 'document.querySelector("#editDayDialog") && !document.querySelector("#editDayDialog").open', '每日计划修改保存完成');
  state = await readState(window);
  assert.equal(state.tasks[0].plan.days[0].title, 'Python 变量与数据类型');
  assert.deepEqual(state.tasks[0].plan.days[0].tasks, ['理解变量赋值', '练习字符串和数字类型']);
  assert.equal(state.tasks[0].plan.days[0].completed, true);

  currentStage = '讨论目标、确认简报并创建带知识清单的新计划';
  await click(window, '[data-action="new-task"]', '打开新建计划');
  await waitForJS(window, 'document.querySelector("#createDialog")?.open', '新建计划对话框');
  const learningModes = await window.webContents.executeJavaScript(`Array.from(document.querySelector('#createForm [name="learningMode"]').options, option => [option.value, option.textContent.trim()])`);
  assert.deepEqual(learningModes, [['exam', '备考'], ['balanced', '平衡'], ['deep', '深度学习']], '学习方式只提供备考、平衡和深度学习');
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.body.innerText'), /ExamPass/i, '界面不得提及 ExamPass');
  const dropPdfPath = path.join(dataDir, 'dropped-study-material.pdf');
  fs.writeFileSync(dropPdfPath, makeMinimalPdf());
  const requestsBeforeDrop = apiRecords.length;
  const dropResult = await dispatchActualFileDrop(window, dropPdfPath);
  assert.equal(dropResult.prepared, true);
  assert.equal(dropResult.highlighted, true, '拖入真实本机文件时附件区域应显示高亮');
  await waitForJS(window, 'document.querySelector("#createMaterials").innerText.includes("dropped-study-material.pdf")', '拖入的本机 PDF 已导入');
  assert.equal(apiRecords.length, requestsBeforeDrop, '本机解析并拖入材料不应请求模型服务');
  const mdPath = path.join(dataDir, 'study-notes.md');
  const mdText = "# 变量与公式\n\n- 单价乘数量\n\n```python\ntotal = price * count\n```";
  fs.writeFileSync(mdPath, mdText);
  await dispatchActualFileDrop(window, mdPath);
  await waitForJS(window, 'document.querySelector("#createMaterials").innerText.includes("study-notes.md")', '真实 Markdown 文件已拖入');
  await click(window, '[data-action="preview-create-material"][data-material-index="1"]', '预览 Markdown 文字');
  await waitForJS(window, 'document.querySelector("#materialDialog").open', 'Markdown 预览打开');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#materialText").textContent'), mdText, '预览应保留标题和代码块');
  await click(window, '[data-close="materialDialog"]', '关闭材料预览');
  const texPath = path.join(dataDir, 'formula.tex');
  const texText = String.raw`\section{求和}
公式：$S=\sum_{i=1}^{n}i$
\input{unavailable.tex}`;
  fs.writeFileSync(texPath, texText);
  const docxPath = path.join(dataDir, 'selected-notes.docx');
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX native selection</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(docxPath, await docx.generateAsync({ type: 'nodebuffer' }));
  const pptxPath = path.join(dataDir, 'selected-slides.pptx');
  const pptx = new JSZip();
  pptx.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>PPTX native selection</a:t></a:r></a:p></p:cSld></p:sld>');
  fs.writeFileSync(pptxPath, await pptx.generateAsync({ type: 'nodebuffer' }));
  const originalOpenDialog = dialog.showOpenDialog;
  let pickerOptions;
  try {
    dialog.showOpenDialog = async (_owner, options) => {
      pickerOptions = options;
      return { canceled: false, filePaths: [texPath, docxPath, pptxPath] };
    };
    await click(window, '[data-action="import-create"]', '从选择器导入 TEX、DOCX、PPTX 文件');
    await waitForJS(window, 'document.querySelector("#createMaterials").innerText.includes("formula.tex") && document.querySelector("#createMaterials").innerText.includes("selected-notes.docx") && document.querySelector("#createMaterials").innerText.includes("selected-slides.pptx")', '三种真实本机文件经选择对话框导入');
  } finally {
    dialog.showOpenDialog = originalOpenDialog;
  }
  for (const extension of ['pdf', 'docx', 'pptx', 'md', 'tex']) {
    assert.ok(pickerOptions.filters[0].extensions.includes(extension), `文件选择器应允许 ${extension.toUpperCase()} 材料`);
  }
  assert.equal(apiRecords.length, requestsBeforeDrop, 'PDF、DOCX、PPTX、MD、TEX 导入与预览均在本机完成，不应请求 API');
  await setValue(window, '#createForm [name="title"]', 'Python 记账小程序');
  await setValue(window, '#createForm [name="goal"]', '我想学会 Python 基础并完成一个记账小程序。');
  await setValue(window, '#createForm [name="learningMode"]', 'deep');
  await setValue(window, '#createForm [name="days"]', 3);
  await setValue(window, '#createForm [name="minutesPerDay"]', 60);
  await setChecked(window, '#createConsent', true);
  await setValue(window, '#clarifyInput', '我希望重点练习变量、循环和函数。');
  await click(window, '#clarifySubmit', '发送第一轮学习目标讨论');
  await waitForJS(window, 'document.querySelectorAll("#clarifyMessages .discussion-message.is-assistant").length === 1', '模型返回第一轮追问');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#confirmBrief").hidden'), true, 'ready=false 时不能确认范围');
  await setValue(window, '#clarifyInput', '对，最后请我独立完成记账小程序。');
  await click(window, '#clarifySubmit', '发送补充说明');
  await waitForJS(window, '!document.querySelector("#confirmBrief").hidden && !document.querySelector("#confirmBrief").disabled && document.querySelector("#confirmedBrief")?.innerText.includes("循环")', '模型整理出可确认的学习范围');
  assert.equal(clarifyCount, 2);
  await click(window, '#confirmBrief', '确认学习范围');
  await waitForJS(window, 'document.querySelector("#confirmBrief").textContent === "已确认"', '学习范围确认状态');
  assert.equal(apiRecords.filter(record => record.purpose === '生成学习计划').length, 0, '确认范围之前不应生成计划');
  await click(window, '#createSubmit', '使用确认简报生成计划');
  await waitForJS(window, 'document.querySelector("#createDialog") && !document.querySelector("#createDialog").open', '新计划已保存');
  state = await readState(window);
  assert.equal(state.tasks.length, 3);
  const newTask = state.tasks.find(candidate => candidate.title === 'Python 记账小程序');
  assert.ok(newTask);
  assert.equal(newTask.learningMode, 'deep');
  assert.deepEqual(newTask.brief, expectedBrief);
  assert.equal(newTask.plan.mode, 'ai');
  assert.equal(newTask.plan.days.length, 3);
  assert.equal(newTask.materials.length, 5);
  assert.equal(newTask.materials[1].text, mdText);
  assert.equal(newTask.materials[2].text, texText);
  assert.match(newTask.materials[3].text, /DOCX native selection/);
  assert.match(newTask.materials[4].text, /PPTX native selection/);
  assert.equal(newTask.plan.knowledge.length, 2);
  const planPayload = apiRecords.find(record => record.purpose === '生成学习计划')?.payload;
  assert.equal(planPayload.learningMode, 'deep');
  assert.equal(planPayload.materials.find(item => item.name === 'study-notes.md')?.text, mdText);
  assert.equal(planPayload.materials.find(item => item.name === 'formula.tex')?.text, texText);
  assert.match(planPayload.materials.find(item => item.name === 'selected-notes.docx')?.text || '', /DOCX native selection/);
  assert.match(planPayload.materials.find(item => item.name === 'selected-slides.pptx')?.text || '', /PPTX native selection/);
  assert.deepEqual(planPayload.brief, expectedBrief);
  assert.equal(apiRecords.filter(record => record.purpose === '澄清学习需求').length, 2);

  currentStage = '展示知识清单并保存新版知识视图截图';
  await waitForJS(window, 'document.querySelectorAll(".plan-knowledge .knowledge-item").length === 2', '计划详情展示知识清单');
  const knowledgeText = await window.webContents.executeJavaScript('document.querySelector(".plan-knowledge").innerText');
  assert.match(knowledgeText, /变量与数据类型/);
  assert.match(knowledgeText, /重点/);
  const planFonts = await window.webContents.executeJavaScript(`[
    '.plan-day-info strong', '.plan-day-info small', '.knowledge-item-heading > strong', '.knowledge-item p'
  ].map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize))`);
  assert.ok(planFonts.every(size => size >= 16), `计划标题、任务和知识说明字号应至少为 16px：${planFonts.join(', ')}`);
  await captureScreenshot(window, 'knowledge-list-0.2.png');

  currentStage = '延迟计划请求期间锁定未确认简报';
  await click(window, '[data-action="new-task"]', '打开第二份计划');
  await waitForJS(window, 'document.querySelector("#createDialog")?.open', '第二份计划对话框');
  await setValue(window, '#createForm [name="title"]', 'Python 循环复习');
  await setValue(window, '#createForm [name="goal"]', '掌握循环并能处理多笔记账记录。');
  await setValue(window, '#createForm [name="days"]', 2);
  await click(window, '#clarifySubmit', '开始第二轮目标讨论');
  await waitForJS(window, 'document.querySelectorAll("#clarifyMessages .discussion-message.is-assistant").length === 1', '第二轮讨论返回追问');
  await setValue(window, '#clarifyInput', '对，练习使用循环汇总金额。');
  await click(window, '#clarifySubmit', '补充第二份计划范围');
  await waitForJS(window, '!document.querySelector("#confirmBrief").hidden && !document.querySelector("#confirmBrief").disabled && document.querySelector("#confirmedBrief")?.innerText.includes("循环")', '第二份计划出现待确认范围');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#confirmBrief").disabled'), false);
  const delayedPlan = delayNextPlanResponse();
  await click(window, '#createSubmit', '提交未确认简报的计划');
  const delayedPlanPayload = await delayedPlan.observed;
  await waitForJS(window, '!document.querySelector("#confirmBrief").hidden && document.querySelector("#confirmBrief").disabled', '计划请求期间禁止修改简报确认状态');
  assert.equal(delayedPlanPayload.brief, null, '未确认简报不应进入计划请求');
  delayedPlan.release();
  await waitForJS(window, 'document.querySelector("#createDialog") && !document.querySelector("#createDialog").open', '延迟计划响应后保存完成');
  state = await readState(window);
  const unconfirmedTask = state.tasks.find(candidate => candidate.title === 'Python 循环复习');
  assert.ok(unconfirmedTask);
  assert.equal(unconfirmedTask.brief, undefined, '未确认简报不应写入任务');
  assert.equal(state.tasks.length, 4);
  assert.equal(apiRecords.filter(record => record.purpose === '澄清学习需求').length, 4);

  currentStage = '日测题型、草稿隔离、日报补学与期末报告';
  await click(window, '[data-nav="plans"]', '打开全部计划');
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "全部计划"', '全部计划列表');
  await clickAction(window, 'open-plan', newTask.id);
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "Python 记账小程序"', '回到带知识清单的计划');

  const dailyDraft0 = '循环可以重复处理多笔账目并汇总总额。';
  await openAssessmentThroughUI(window, newTask.id, 'daily', 0, true);
  state = await readState(window);
  let activeTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.equal(activeTask.materials.length, 5, '通过拖拽和选择导入的五种材料应保存到新计划');
  assert.equal(activeTask.dailyQuizzes['0'].questions.length, 5);
  assert.equal(activeTask.dailyQuizzes['0'].questions.filter(question => question.type === 'choice').length, 2);
  assert.equal(activeTask.dailyQuizzes['0'].questions.filter(question => question.type === 'fill').length, 3);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#quizForm .quiz-options").length === 2 && document.querySelectorAll("#quizForm .quiz-fill").length === 3 && document.querySelectorAll("#quizForm textarea[data-answer]").length === 0'), true, '日测应使用选择控件和填空控件');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".question-reference-details"))'), false, '参考答案在提交前隐藏');
  const quizFonts = await window.webContents.executeJavaScript(`['body', '.quiz-fill', '.quiz-option', '.quiz-intro-copy p'].map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize))`);
  assert.ok(quizFonts.every(size => size >= 15), `正文和主要题目字号都应至少 15px：${quizFonts.join(', ')}`);
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', dailyDraft0);

  await clickAction(window, 'open-plan', newTask.id);
  const dailyDraft1 = '使用函数拆分记账和汇总步骤。';
  await openAssessmentThroughUI(window, newTask.id, 'daily', 1, true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#quizForm [data-qid=q2]").value'), '', '不同日期的测验草稿不能串用');
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', dailyDraft1);
  const requestsAfterDaily1 = apiRecords.length;
  await click(window, '[data-nav="overview"]', '离开日测查看概览');
  await clickAction(window, 'open-plan', newTask.id);
  await openAssessmentThroughUI(window, newTask.id, 'daily', 1, false);
  assert.equal(apiRecords.length, requestsAfterDaily1, '重新打开已生成的日测不应请求模型');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#quizForm [data-qid=q2]").value'), dailyDraft1);
  await clickAction(window, 'open-plan', newTask.id);
  await openAssessmentThroughUI(window, newTask.id, 'daily', 0, false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#quizForm [data-qid=q2]").value'), dailyDraft0, '按日期保存的草稿重新打开后仍应恢复');

  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q1"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', dailyDraft0);
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q3"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q4"]', '用循环访问每笔记录并累加金额。');
  await setValue(window, '#quizForm [data-answer][data-qid="q5"]', '函数可以把重复步骤整理成可复用操作。');
  const gradesBeforeDaily0 = apiRecords.filter(record => record.purpose === '评分并生成学习报告').length;
  await click(window, '#submitQuiz', '提交日测并生成日报');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.result?.report?.readyForNext === false)`, '日测报告已保存');
  await waitForJS(window, 'Boolean(document.querySelector(".learning-report .report-readiness"))', '学习报告显示准备程度');
  state = await readState(window);
  activeTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.equal(activeTask.dailyQuizzes['0'].result.score, 100);
  assert.equal(activeTask.dailyQuizzes['0'].result.report.readyForNext, false, '准备程度应按先修证據判断，不能由高总分直接推断');
  assert.deepEqual(activeTask.dailyQuizzes['0'].answers.q1, { text: 'A' });
  assert.equal(apiRecords.filter(record => record.purpose === '评分并生成学习报告').length, gradesBeforeDaily0 + 1);
  const dailyGradePayload = apiRecords.findLast(record => record.purpose === '评分并生成学习报告')?.payload;
  assert.equal(JSON.stringify(dailyGradePayload).includes('Native PDF worker smoke'), false, '评分已提供知识清单时不得重复发送原始附件文字');
  await captureScreenshot(window, 'daily-report-0.3.png');

  const reportRequestCount = apiRecords.length;
  await clickAction(window, 'choose-extra', newTask.id, { kind: 'daily', dayIndex: 0 });
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.decision === 'extra' && s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.supplementCompleted === false)`, '按补学方案继续的选择已保存');
  await clickAction(window, 'toggle-supplement', newTask.id, { kind: 'daily', dayIndex: 0 });
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.supplementCompleted === true)`, '补学完成状态已保存');
  assert.equal(apiRecords.length, reportRequestCount, '选择或完成补学只应保存本地状态');

  await clickAction(window, 'open-plan', newTask.id);
  await clickAction(window, 'toggle-day', newTask.id, { dayIndex: 0 });
  state = await readState(window);
  const pastDayBeforeAdjustment = structuredClone(state.tasks.find(candidate => candidate.id === newTask.id).plan.days[0]);
  assert.equal(pastDayBeforeAdjustment.completed, true);

  await openAssessmentThroughUI(window, newTask.id, 'daily', 2, true);
  await clickAction(window, 'open-plan', newTask.id);
  await openAssessmentThroughUI(window, newTask.id, 'final', undefined, true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#quizForm .quiz-options").length === 3 && document.querySelectorAll("#quizForm .quiz-fill").length === 6 && document.querySelectorAll("#quizForm textarea[data-answer]").length === 1'), true, '期末测验应为 10 道混合题且最多两道简答');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".question-reference-details"))'), false);
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q1"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', '整数适合保存没有小数的数量。');
  await setValue(window, '#quizForm [data-answer][data-qid="q3"]', '字符串用于表示文本输入。');
  await setValue(window, '#quizForm [data-answer][data-qid="q4"]', '循环可以重复处理记录。');
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q5"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q6"]', '函数让常用操作可以重复调用。');
  await setValue(window, '#quizForm [data-answer][data-qid="q7"]', '先校验输入再计算账目总额。');
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q8"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q9"]', '我会拆分记录、验证输入并用循环汇总。');
  await setValue(window, '#quizForm [data-answer][data-qid="q10"]', '测试多笔记录和空输入。');
  await click(window, '#submitQuiz', '提交期末测验并生成周期报告');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.quiz?.result?.report?.readyForNext === null)`, '期末报告保存并不判断下一日准备程度');
  assert.equal(apiRecords.filter(record => record.purpose === '评分并生成学习报告').length, gradesBeforeDaily0 + 2);


  currentStage = '按需讲解、缓存复用与两轮错题追问';
  await clickAction(window, 'ask-question', newTask.id, { kind: 'final' });
  await waitForJS(window, 'document.querySelector("#tutoringDialog")?.open && !document.querySelector("#questionFollowUpForm").hidden', '打开错题追问，不自动调用API');
  const beforeHelp = apiRecords.length;
  await setValue(window, '#questionFollowUpInput', '为什么需要先检查输入？');
  await click(window, '#sendQuestionFollowUp');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.tutorChats?.['final:q9']?.messages?.length === 2)`, '首轮追问持久化');
  await waitForJS(window, '!document.querySelector("#sendQuestionFollowUp").disabled', '追问按钮恢复');
  await setValue(window, '#questionFollowUpInput', '可以换一个更简单的例子吗？');
  await click(window, '#sendQuestionFollowUp');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.tutorChats?.['final:q9']?.messages?.length === 4)`, '第二轮追问保留上下文');
  assert.equal(apiRecords.length, beforeHelp + 2);
  const followUpPayload = apiRecords.at(-1).payload;
  assert.equal(followUpPayload.messages.length, 3);
  assert.deepEqual(followUpPayload.question, {
    id: 'q9',
    type: 'short',
    question: '请说明第 9 个知识点的用途。',
    options: []
  }, '追问请求只应包含当前错题');
  assert.deepEqual(followUpPayload.materials, [], '错题追问不得重新发送原材料');
  await click(window, '#tutoringDialog [data-close]');
  await clickAction(window, 'open-plan', newTask.id);
  await clickAction(window, 'open-lesson', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#tutoringDialog")?.open', '打开每日讲解');
  const beforeLessons = apiRecords.length;
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#tutoringContent").innerText.includes("尚未生成")'), true);
  await click(window, '#generateLesson');
  await waitForJS(window, `window.studyApp.loadState().then(s => Boolean(s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.lessons?.['1']?.brief))`, '简要讲解保存');
  assert.equal(apiRecords.at(-1).purpose, '讲解当前日学习内容');
  assert.equal(apiRecords.at(-1).payload.depth, 'brief');
  await click(window, '#tutoringDialog [data-close]');
  await clickAction(window, 'open-lesson', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#generateLesson").hidden', '再次查看直接使用缓存');
  assert.equal(apiRecords.length, beforeLessons + 1);
  await click(window, '#lessonControls [data-depth="detailed"]');
  await click(window, '#generateLesson');
  await waitForJS(window, `window.studyApp.loadState().then(s => Boolean(s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.lessons?.['1']?.detailed))`, '展开讲解单独缓存');
  assert.equal(apiRecords.at(-1).purpose, '讲解当前日学习内容');
  assert.equal(apiRecords.at(-1).payload.depth, 'detailed');
  assert.equal(apiRecords.length, beforeLessons + 2);
  await click(window, '#tutoringDialog [data-close]');
  await clickAction(window, 'open-lesson', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#tutoringDialog")?.open', '重新打开已缓存的每日讲解');
  await click(window, '#lessonControls [data-depth="detailed"]');
  await waitForJS(window, 'document.querySelector("#generateLesson").hidden', '重新打开后直接使用展开讲解缓存');
  assert.equal(apiRecords.length, beforeLessons + 2, '重新打开已缓存的展开讲解不应再次请求模型');
  await click(window, '#tutoringDialog [data-close]');

  currentStage = '编辑第二天内容后将前一日报准备度标为过期';
  await clickAction(window, 'open-plan', newTask.id);
  await window.webContents.executeJavaScript('window.confirm = () => true; true');
  await clickAction(window, 'edit-day', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#editDayDialog")?.open', '打开第二天编辑对话框');
  await setValue(window, '#editDayName', '第二天：循环与汇总练习');
  await setValue(window, '#editDayTasks', '比较循环和逐项处理\n用循环汇总多笔账目');
  await click(window, '#editDayForm button[type="submit"]', '保存第二天内容修改');
  await waitForJS(window, 'document.querySelector("#editDayDialog") && !document.querySelector("#editDayDialog").open', '第二天修改保存');
  state = await readState(window);
  activeTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.equal(activeTask.lessons?.['1'], undefined, '改日程必须清除受影响的两种讲解');
  assert.equal(activeTask.tutorChats?.['final:q9'], undefined, '期末失效同时清除对应追问');
  assert.equal(activeTask.dailyQuizzes['0'].readinessStale, true, '修改次日内容后应标记前一日报的准备度过期');
  assert.equal(activeTask.dailyQuizzes['0'].result.score, 100, '过期时应保留旧日报成绩');
  assert.deepEqual(activeTask.dailyQuizzes['0'].answers.q1, { text: 'A' }, '过期时应保留旧日报作答');
  assert.equal(activeTask.dailyQuizzes['0'].decision, undefined, '过期报告不能保留补学决定');
  assert.equal(activeTask.dailyQuizzes['0'].supplementCompleted, undefined, '过期报告不能保留补学完成状态');
  assert.equal(activeTask.dailyQuizzes['1'], undefined, '修改当天应清除当天旧日测');
  assert.equal(activeTask.dailyQuizzes['2'].questions.length, 5, '修改一天应保留其他日期的日测');
  assert.equal(activeTask.quiz, undefined, '修改学习内容应清除旧期末测验');

  await openAssessmentThroughUI(window, newTask.id, 'daily', 0, false);
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".report-readiness.readiness-stale"))'), true, '页面应明确展示过期准备度');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("[data-action=choose-extra], [data-action=propose-adjustment]"))'), false, '过期报告不得继续补学或请求调整');
  await window.webContents.executeJavaScript('window.confirm = () => true; true');
  const daily0Regenerations = apiRecords.filter(record => record.purpose === '生成每日小测').length;
  await clickAction(window, 'retake-assessment', newTask.id, { kind: 'daily', dayIndex: 0 });
  await waitForJS(window, `window.studyApp.loadState().then(s => { const q = s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']; return q?.questions?.length === 5 && !q.readinessStale && !q.result; })`, '明确重做后生成新的日报题目');
  assert.equal(apiRecords.filter(record => record.purpose === '生成每日小测').length, daily0Regenerations + 1, '只有明确重做才应替换题目');
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q1"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', dailyDraft0);
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q3"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q4"]', '用循环逐项访问并累加金额。');
  await setValue(window, '#quizForm [data-answer][data-qid="q5"]', '函数可以封装重复操作。');
  const gradesBeforeDaily0Retake = apiRecords.filter(record => record.purpose === '评分并生成学习报告').length;
  await click(window, '#submitQuiz', '重新评分并刷新日报准备度');
  await waitForJS(window, `window.studyApp.loadState().then(s => { const q = s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']; return q?.result?.report?.readyForNext === false && !q.readinessStale; })`, '新日报替换过期准备度');
  assert.equal(apiRecords.filter(record => record.purpose === '评分并生成学习报告').length, gradesBeforeDaily0Retake + 1);
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".report-readiness.readiness-stale"))'), false);
  await clickAction(window, 'choose-extra', newTask.id, { kind: 'daily', dayIndex: 0 });
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.decision === 'extra')`, '重新测评后重新选择补学');
  await clickAction(window, 'toggle-supplement', newTask.id, { kind: 'daily', dayIndex: 0 });
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['0']?.supplementCompleted === true)`, '重新测评后的补学状态保存');

  await clickAction(window, 'open-plan', newTask.id);
  await openAssessmentThroughUI(window, newTask.id, 'daily', 1, true);
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q1"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q2"]', dailyDraft1);
  await chooseRadio(window, '#quizForm input[type="radio"][data-qid="q3"][value="A"]');
  await setValue(window, '#quizForm [data-answer][data-qid="q4"]', '逐条处理记录并计算总和。');
  await setValue(window, '#quizForm [data-answer][data-qid="q5"]', '用函数封装可复用的汇总逻辑。');
  const gradesBeforeDaily1 = apiRecords.filter(record => record.purpose === '评分并生成学习报告').length;
  await click(window, '#submitQuiz', '提交第二天日测');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['1']?.result?.report?.readyForNext === false)`, '第二天日报已保存');
  assert.equal(apiRecords.filter(record => record.purpose === '评分并生成学习报告').length, gradesBeforeDaily1 + 1);
  state = await readState(window);
  const taskBeforeProposal = structuredClone(state.tasks.find(candidate => candidate.id === newTask.id));
  const adjustmentsBefore = apiRecords.filter(record => record.purpose === '调整后续学习规划').length;
  await clickAction(window, 'propose-adjustment', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#adjustmentDialog")?.open && document.querySelectorAll("#adjustmentPreview .adjustment-preview li").length === 1', '显示仅包含未来未完成日的调整预览');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#adjustmentPreview").innerText'), /第 3 天/);
  assert.equal(apiRecords.filter(record => record.purpose === '调整后续学习规划').length, adjustmentsBefore + 1);
  assert.deepEqual((await readState(window)).tasks.find(candidate => candidate.id === newTask.id), taskBeforeProposal, '查看预览时不能改动已保存计划');
  await clickAction(window, 'cancel-adjustment');
  await waitForJS(window, '!document.querySelector("#adjustmentDialog")?.open', '取消调整预览');
  assert.deepEqual((await readState(window)).tasks.find(candidate => candidate.id === newTask.id), taskBeforeProposal, '取消后所有已保存日期、预算和测验历史保持原样');

  await clickAction(window, 'propose-adjustment', newTask.id, { dayIndex: 1 });
  await waitForJS(window, 'document.querySelector("#adjustmentDialog")?.open', '重新明确请求调整预览');
  await clickAction(window, 'confirm-adjustment');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['1']?.decision === 'adjusted' && !s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.dailyQuizzes?.['2'] && !s.tasks.find(t => t.id === ${JSON.stringify(newTask.id)})?.quiz)`, '确认后保存计划并清除被调整日程的旧测验');
  state = await readState(window);
  const adjustedTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.deepEqual(adjustedTask.plan.days[0], pastDayBeforeAdjustment, '应用调整不得改写已完成的过去日期');
  assert.deepEqual(adjustedTask.plan.days[1], taskBeforeProposal.plan.days[1], '报告当天的计划内容应保留');
  assert.equal(adjustedTask.plan.days[2].date, taskBeforeProposal.plan.days[2].date);
  assert.equal(adjustedTask.plan.days[2].minutes, taskBeforeProposal.plan.days[2].minutes);
  assert.equal(adjustedTask.plan.days[2].completed, false);
  assert.match(adjustedTask.plan.days[2].tasks.join(' '), /5 题小测/);
  assert.match(adjustedTask.plan.days[2].tasks.join(' '), /10 题周期测验/);
  assert.equal(adjustedTask.dailyQuizzes['0'].decision, 'extra');
  assert.equal(adjustedTask.dailyQuizzes['0'].supplementCompleted, true);
  assert.equal(adjustedTask.dailyQuizzes['1'].decision, 'adjusted');
  assert.equal(adjustedTask.dailyQuizzes['2'], undefined);
  assert.equal(adjustedTask.quiz, undefined, '应用调整后应清除原期末测验');
  assert.equal(apiRecords.filter(record => record.purpose === '评分并生成学习报告').length, gradesBeforeDaily1 + 1);

  currentStage = '调整跳过已完成日期时让后一日准备度过期';
  const sourceForRegression = (await readState(window)).tasks.find(candidate => candidate.id === newTask.id);
  const regressionTask = structuredClone(sourceForRegression);
  const now = new Date();
  const regressionStartDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const regressionDateAt = offset => {
    const date = new Date(`${regressionStartDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const regressionTitle = '五日计划跳过已完成日回归';
  regressionTask.id = 'adjustment-skip-completed-regression';
  regressionTask.title = regressionTitle;
  regressionTask.goal = '已完成日之后的日程调整应使日报准备度重新评估。';
  regressionTask.startDate = regressionStartDate;
  regressionTask.days = 5;
  regressionTask.calendarDays = 5;
  regressionTask.cadence = { mode: 'daily', weekdays: [] };
  regressionTask.minutesPerDay = 45;
  regressionTask.plan.summary = regressionTask.goal;
  const regressionSource = sourceForRegression.plan.days[0].source;
  regressionTask.plan.days = Array.from({ length: 5 }, (_, index) => ({
    day: index + 1,
    date: regressionDateAt(index),
    title: `回归第 ${index + 1} 天`,
    minutes: 30,
    tasks: [`验证第 ${index + 1} 天的计划安排`],
    source: regressionSource,
    completed: index === 2
  }));
  regressionTask.dailyQuizzes = {
    '0': makeDailyReadinessQuiz(0, regressionStartDate),
    '2': makeDailyReadinessQuiz(2, regressionDateAt(2), 'extra')
  };
  delete regressionTask.quiz;
  delete regressionTask.lessons;
  delete regressionTask.tutorChats;
  await window.webContents.executeJavaScript(`window.studyApp.saveTask(${JSON.stringify(regressionTask)})`);
  window = await reloadWindow(window, true, 5);
  await clickAction(window, 'open-plan', regressionTask.id);
  await waitForJS(window, `document.querySelector('#appView h1')?.textContent === ${JSON.stringify(regressionTitle)}`, '打开五日回归计划');
  await openAssessmentThroughUI(window, regressionTask.id, 'daily', 0, false);
  const requestsBeforeRegression = apiRecords.length;
  await clickAction(window, 'propose-adjustment', regressionTask.id, { dayIndex: 0 });
  await waitForJS(window, 'document.querySelector("#adjustmentDialog")?.open && document.querySelectorAll("#adjustmentPreview .adjustment-preview li").length === 3', '显示跳过 D3 的三日调整预览');
  const regressionPreview = await window.webContents.executeJavaScript('document.querySelector("#adjustmentPreview").innerText');
  assert.match(regressionPreview, /第 2 天 ·/);
  assert.match(regressionPreview, /第 4 天 ·/);
  assert.match(regressionPreview, /第 5 天 ·/);
  assert.doesNotMatch(regressionPreview, /第 3 天 ·/, '调整预览不得包含已完成的 D3');
  assert.equal(apiRecords.length, requestsBeforeRegression + 1);
  const regressionAdjustmentRequest = apiRecords.at(-1);
  assert.equal(regressionAdjustmentRequest.purpose, '调整后续学习规划');
  assert.equal(regressionAdjustmentRequest.payload.title, regressionTitle);
  assert.deepEqual(regressionAdjustmentRequest.payload.upcoming.map(day => day.day), [2, 4, 5], '调整请求应跳过已完成的 D3');
  await clickAction(window, 'confirm-adjustment');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ${JSON.stringify(regressionTask.id)})?.dailyQuizzes?.['2']?.readinessStale === true)`, '应用调整后 D3 报告准备度过期');
  state = await readState(window);
  const adjustedRegressionTask = state.tasks.find(candidate => candidate.id === regressionTask.id);
  assert.equal(adjustedRegressionTask.dailyQuizzes['2'].result.score, regressionTask.dailyQuizzes['2'].result.score, 'D3 成绩应保留');
  assert.deepEqual(adjustedRegressionTask.dailyQuizzes['2'].answers, regressionTask.dailyQuizzes['2'].answers, 'D3 作答应保留');
  assert.equal(adjustedRegressionTask.dailyQuizzes['2'].readinessStale, true);
  assert.equal(adjustedRegressionTask.dailyQuizzes['2'].decision, undefined, 'D3 旧补学决定应清除');
  assert.equal(adjustedRegressionTask.dailyQuizzes['2'].supplementCompleted, undefined, 'D3 旧补学完成状态应清除');
  assert.equal(adjustedRegressionTask.dailyQuizzes['0'].decision, 'adjusted', '发起调整的 D1 应记录为 adjusted');
  assert.equal(adjustedRegressionTask.plan.days[2].title, '回归第 3 天', '已完成的 D3 计划应保留');
  assert.equal(adjustedRegressionTask.plan.days[2].completed, true, '已完成的 D3 状态应保留');
  for (const dayIndex of [1, 3, 4]) {
    assert.match(adjustedRegressionTask.plan.days[dayIndex].title, /循环巩固/, `D${dayIndex + 1} 应应用新调整`);
  }
  await clickAction(window, 'open-plan', regressionTask.id);
  await waitForJS(window, `document.querySelector('#appView h1')?.textContent === ${JSON.stringify(regressionTitle)}`, '返回五日回归计划');
  await clickAction(window, 'open-assessment', regressionTask.id, { kind: 'daily', dayIndex: 2 });
  await waitForJS(window, 'Boolean(document.querySelector(".report-readiness.readiness-stale"))', 'D3 日报页面显示准备度过期');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-action=choose-extra], [data-action=toggle-supplement], [data-action=propose-adjustment]").length'), 0, '过期的 D3 日报不得提供补学或调整操作');
  await window.webContents.executeJavaScript(`window.studyApp.deleteTask(${JSON.stringify(regressionTask.id)})`);
  window = await reloadWindow(window, true, 4);

  currentStage = '切回新版概览并保存截图';
  await click(window, '[data-nav="overview"]', '切换到学习概览');
  await waitForJS(window, 'Boolean(document.querySelector("#appView .welcome-panel"))', '学习概览内容');
  await captureScreenshot(window, 'overview-0.2.png');

  currentStage = '关闭窗口并恢复已编辑的计划';
  if (process.platform === 'darwin') {
    const closed = new Promise(resolve => window.once('closed', resolve));
    window.close();
    await closed;
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    app.emit('second-instance', {}, [], process.cwd());
    window = await waitForWindow();
    window.hide();
    await waitForJS(window, 'window.studyApp.loadState().then(s => s.settings.configured && s.tasks.length === 4)', '第二实例恢复窗口和本地状态');
    state = await readState(window);
    const restoredLegacy = state.tasks.find(candidate => candidate.id === originalLegacyTask.id);
    const restoredNew = state.tasks.find(candidate => candidate.id === newTask.id);
    assert.equal(restoredLegacy.plan.days[0].title, 'Python 变量与数据类型');
    assert.equal(restoredLegacy.plan.days[0].completed, true);
    assert.equal(restoredNew.dailyQuizzes['0'].result.report.readyForNext, false);
    assert.equal(restoredNew.dailyQuizzes['0'].supplementCompleted, true);
    assert.equal(restoredNew.dailyQuizzes['1'].decision, 'adjusted');
    assert.equal(restoredNew.quiz, undefined);
    await clickAction(window, 'open-plan', originalLegacyTask.id);
    await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "旧版 Python 计划"', '恢复后的旧计划');
  } else {
    window = await reloadWindow(window, true, 4);
    state = await readState(window);
    assert.equal(state.tasks.find(candidate => candidate.id === originalLegacyTask.id).plan.days[0].title, 'Python 变量与数据类型');
  }

  currentStage = 'English偏好持久化、旧内容保留与新学习流程';
  const callsBeforeLanguage = apiRecords.length;
  const tasksBeforeLanguage = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  const profileBeforeLanguage = fs.readFileSync(path.join(dataDir, 'profile.json'), 'utf8');
  await click(window, '#profileButton', '打开语言设置');
  await setValue(window, '#profileNickname', 'Unsaved nickname draft');
  await setValue(window, '#profileLanguage', 'en');
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.preferences.language === "en")', 'English偏好已保存');
  await waitForJS(window, 'document.documentElement.lang === "en" && document.title === "Study Workbench"', '英文界面已应用');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#profileNickname").value'), 'Unsaved nickname draft', '切语言不丢昵称草稿');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), tasksBeforeLanguage, '切语言不重写原任务');
  assert.equal(fs.readFileSync(path.join(dataDir, 'profile.json'), 'utf8'), profileBeforeLanguage, '切语言不改个人资料');
  assert.equal(apiRecords.length, callsBeforeLanguage, '切语言不发翻译请求');
  await click(window, '[data-close="profileDialog"]', '关闭语言设置');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("button[data-nav=overview]").innerText'), /overview/i);
  await clickAction(window, 'open-plan', originalLegacyTask.id);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#appView h1").textContent'), '旧版 Python 计划', '旧计划标题保留原文');
  const legacyDay = await window.webContents.executeJavaScript(`({
    title: document.querySelector('.plan-day-info strong')?.textContent,
    tasks: document.querySelector('.plan-day-info small')?.textContent
  })`);
  assert.equal(legacyDay.title, 'Python 变量与数据类型', '旧日程标题切换语言后保留原文');
  assert.equal(legacyDay.tasks, '理解变量赋值 · 练习字符串和数字类型', '旧日程任务切换语言后保留原文');
  window = await reloadWindow(window, true, 4);
  assert.equal((await readState(window)).preferences.language, 'en');
  await waitForJS(window, 'document.documentElement.lang === "en"', '重开仍是English');
  await click(window, '[data-action="new-task"]', '新建English计划');
  await waitForJS(window, 'document.querySelector("#createDialog").open', '英文新建对话框');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#createTitle").textContent'), /plan/i);
  await setValue(window, '#createForm [name="title"]', 'English study plan');
  await setValue(window, '#createForm [name="goal"]', 'Learn variables and loops with examples.');
  await setValue(window, '#createForm [name="days"]', 2);
  await click(window, '#createSubmit', '生成English学习内容');
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.tasks.some(t => t.title === "English study plan"))', '英文计划保存');
  await waitForJS(window, '!document.querySelector("#createDialog").open', '英文创建弹窗已关闭');
  state = await readState(window);
  const englishTask = state.tasks.find(task => task.title === 'English study plan');
  assert.match(englishTask.plan.summary, /Learn variables/);
  const enPlanRequest = apiRecords.findLast(record => record.purpose === '生成学习计划');
  assert.equal(enPlanRequest.payload.outputLanguage, 'en');
  assert.match(enPlanRequest.requestBody.messages[0].content, /in English/);
  await click(window, '[data-action="open-lesson"][data-day-index="0"]', '打开英文讲解');
  await click(window, '#generateLesson', '生成英文讲解');
  await waitForJS(window, `window.studyApp.loadState().then(s => Boolean(s.tasks.find(t => t.id === ${JSON.stringify(englishTask.id)})?.lessons?.['0']?.brief))`, '英文讲解保存');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#tutoringContent").innerText'), /Concept: variables/);
  await click(window, '[data-close="tutoringDialog"]', '关闭英文讲解');
  await openAssessmentThroughUI(window, englishTask.id, 'daily', 0, true);
  for (const [index, q] of makeAssessmentQuestions('daily').entries()) {
    if (q.type === 'choice') await chooseRadio(window, `#quizForm input[type="radio"][data-qid="q${index + 1}"][value="A"]`);
    else await setValue(window, `#quizForm [data-answer][data-qid="q${index + 1}"]`, 'Use the concept in practice.');
  }
  await click(window, '#submitQuiz', '评分并生成英文报告');
  await waitForJS(window, `window.studyApp.loadState().then(s => Boolean(s.tasks.find(t => t.id === ${JSON.stringify(englishTask.id)})?.dailyQuizzes?.['0']?.result))`, '英文报告保存');
  const englishResult = (await readState(window)).tasks.find(task => task.id === englishTask.id).dailyQuizzes['0'].result;
  assert.match(englishResult.report.summary, /daily assessment/);
  assert.doesNotMatch(englishResult.items[0].feedback, /[\u3400-\u9fff]/u, '本地选择题反馈也必须是英文');
  const beforeReturnLanguage = apiRecords.length;
  await click(window, '#profileButton', '切回中文');
  await setValue(window, '#profileLanguage', 'zh-CN');
  await waitForJS(window, 'document.documentElement.lang === "zh-CN"', '已切回中文');
  await click(window, '[data-close="profileDialog"]', '关闭我的');
  assert.equal(apiRecords.length, beforeReturnLanguage, '切回中文不发API请求');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).language, 'zh-CN');

  currentStage = '新建14日日历跨度隔日计划并验证七个真实日期';
  await click(window, '[data-nav="overview"]', '返回学习概览');
  await waitForJS(window, 'Boolean(document.querySelector(".welcome-panel"))', '学习概览就绪');
  async function createCadencePlanThroughUI(title, mode, weekdays = []) {
    await click(window, '[data-action="new-task"]', `打开${title}新建计划`);
    await waitForJS(window, 'document.querySelector("#createDialog")?.open', `${title}新建对话框`);
    await setValue(window, '#createForm [name="title"]', title);
    await setValue(window, '#createForm [name="goal"]', '理解变量和循环，并完成可运行的 Python 练习。');
    await setValue(window, '#createForm [name="days"]', 14);
    await setValue(window, '#createForm [name="cadenceMode"]', mode);
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await setChecked(window, `#createWeekdays [name="cadenceWeekday"][value="${weekday}"]`, weekdays.includes(weekday));
    }
    const startDate = await window.webContents.executeJavaScript('document.querySelector("#createForm [name=startDate]").value');
    const cadence = { mode, weekdays: mode === 'weekly' ? [...weekdays] : [] };
    const expectedDates = schedule.learningDates({ startDate, calendarDays: 14, cadence });
    const summary = await window.webContents.executeJavaScript('document.querySelector("#createCadenceSummary").textContent');
    assert.match(summary, /14.*日历日/);
    assert.match(summary, new RegExp(`${expectedDates.length} 次学习`));
    if (mode === 'alternate') assert.equal(expectedDates.length, 7, '14 个日历日的隔日频率应安排 7 次学习');

    const beforeRequests = apiRecords.length;
    await click(window, '#createSubmit', `生成${title}`);
    await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.some(t => t.title === ${JSON.stringify(title)}))`, `${title}已保存`);
    await waitForJS(window, '!document.querySelector("#createDialog")?.open', `${title}对话框关闭`);
    const saved = (await readState(window)).tasks.find(task => task.title === title);
    assert.ok(saved);
    assert.equal(saved.calendarDays, 14);
    assert.equal(saved.days, expectedDates.length);
    assert.deepEqual(saved.cadence, cadence);
    assert.deepEqual(saved.plan.days.map(day => day.date), expectedDates, `${title}必须保存真实日历日期`);
    const requests = apiRecords.slice(beforeRequests).filter(record => record.purpose === '生成学习计划');
    assert.equal(requests.length, 1, '14 日频率计划应由一次提交触发一次短计划请求');
    assert.deepEqual(requests[0].payload.sessions.map(session => session.date), expectedDates, '模型请求应收到准确的非连续学习日期');
    assert.equal(requests[0].requestBody.max_tokens, undefined, '短计划请求不应设置模型输出预算');
    return saved;
  }
  const alternateTask = await createCadencePlanThroughUI('14日隔日计划', 'alternate');

  currentStage = '新建每周一三五计划并验证日期 weekday';
  const weeklyTask = await createCadencePlanThroughUI('每周一三五计划', 'weekly', [1, 3, 5]);
  assert.deepEqual(weeklyTask.cadence.weekdays, [1, 3, 5]);
  assert.ok(weeklyTask.plan.days.every(day => [1, 3, 5].includes(new Date(`${day.date}T00:00:00.000Z`).getUTCDay())), '每周计划只应安排周一、周三和周五');

  currentStage = '100000字符材料一次提交并自动生成60日批次计划';
  await click(window, '[data-action="new-task"]', '打开60日计划新建对话框');
  await waitForJS(window, 'document.querySelector("#createDialog")?.open', '60日计划新建对话框');
  await setValue(window, '#createForm [name="title"]', '60日 Python 练习计划');
  await setValue(window, '#createForm [name="goal"]', '循序学习 Python 变量、条件、循环和函数。');
  await setValue(window, '#createForm [name="days"]', 60);
  await window.webContents.executeJavaScript(`(() => {
    window.__desktopCreateDialogCloseEvents = [];
    const dialog = document.querySelector('#createDialog');
    dialog.addEventListener('close', () => window.__desktopCreateDialogCloseEvents.push({ open: Boolean(dialog.open) }));
  })()`);
  const longMetadata = 'x'.repeat(100000);
  const longMaterialPath = path.join(dataDir, '100000-character-study-metadata.md');
  fs.writeFileSync(longMaterialPath, longMetadata, 'utf8');
  await dispatchActualFileDrop(window, longMaterialPath);
  await waitForJS(window, 'document.querySelector("#createMaterials").innerText.includes("100000-character-study-metadata.md") && !document.querySelector("#createConsentWrap").hidden', '100000 字符材料已导入并要求授权');
  await setChecked(window, '#createConsent', true);
  await window.webContents.executeJavaScript(`(() => {
    window.__desktopPlanProgress = [];
    window.__desktopPlanProgressOff?.();
    window.__desktopPlanProgressOff = window.studyApp.onPlanProgress(progress => window.__desktopPlanProgress.push(progress));
  })()`);
  await beginCreateLoadingObservation(window);
  const longPlanRequestStart = apiRecords.length;
  await click(window, '#createSubmit', '一次提交60日分批计划');
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.some(t => t.title === "60日 Python 练习计划"))`, '60 日分批计划生成并保存');
  await waitForJS(window, '!document.querySelector("#createDialog")?.open', '60 日计划创建对话框关闭');
  const longPlanLoadingStates = await endCreateLoadingObservation(window);
  assert.ok(longPlanLoadingStates.length > 0 && longPlanLoadingStates.every(item => !item.spinner && !item.status), `10 秒内完成的计划不应显示 spinner 或进度状态：${JSON.stringify(longPlanLoadingStates)}`);
  const longTask = (await readState(window)).tasks.find(task => task.title === '60日 Python 练习计划');
  assert.equal(longTask.calendarDays, 60);
  assert.equal(longTask.days, 60);
  assert.equal(longTask.materials[0].text.length, 100000, '本地任务应完整保存 100000 字符材料 metadata');
  assert.equal(longTask.plan.days.length, 60);
  assert.deepEqual(longTask.plan.days.map(day => day.date), schedule.learningDates({ startDate: longTask.startDate, calendarDays: 60, cadence: { mode: 'daily' } }));
  const longPlannerRecords = apiRecords.slice(longPlanRequestStart).filter(record => ['生成学习计划概要与知识清单', '生成学习计划每日安排'].includes(record.purpose));
  const outlineRecords = longPlannerRecords.filter(record => record.purpose === '生成学习计划概要与知识清单');
  const dayBatchRecords = longPlannerRecords.filter(record => record.purpose === '生成学习计划每日安排');
  assert.equal(outlineRecords.length, 1, '大材料应只发起一次计划概要请求');
  assert.equal(dayBatchRecords.length, Math.ceil(60 / 7), '60 个学习日应按每批最多 7 日生成');
  const outlineRequest = outlineRecords[0].requestBody.messages[1].content;
  assert.ok(outlineRequest.length < 100000 && !outlineRequest.includes(longMetadata), '100000 字符原文只应经上下文预算截取后发送一次');
  const requestedSessions = dayBatchRecords.flatMap(record => record.payload.sessions);
  assert.equal(requestedSessions.length, 60);
  assert.ok(dayBatchRecords.every(record => record.payload.sessions.length <= 7));
  assert.ok(dayBatchRecords.every(record => record.payload.materials.every(material => !Object.hasOwn(material, 'text'))), '日批次只能收到材料描述符，不能重复发送附件原文');
  assert.ok(dayBatchRecords.every(record => !JSON.stringify(record.payload).includes(longMetadata)));
  const progressEvents = await window.webContents.executeJavaScript(`(() => {
    window.__desktopPlanProgressOff?.();
    window.__desktopPlanProgressOff = null;
    return window.__desktopPlanProgress.slice();
  })()`);
  assert.ok(progressEvents.some(event => event.stage === 'outline' && event.completed === 0 && event.total === 1), '界面进度应收到概要阶段开始');
  assert.ok(progressEvents.some(event => event.stage === 'outline' && event.completed === 1 && event.total === 1), '界面进度应收到概要阶段完成');
  assert.equal(progressEvents.filter(event => event.stage === 'days').at(-1)?.completed, 60, '界面进度应在全部60日安排后完成');
  const checkpointPath = path.join(dataDir, 'plan-generation.json');
  assert.equal(fs.existsSync(checkpointPath), true, '60 日计划完成后应持久化计划生成检查点');
  const checkpointContents = fs.readFileSync(checkpointPath, 'utf8');
  const completedCheckpoint = JSON.parse(checkpointContents);
  assert.equal(completedCheckpoint.checkpoint.days.length, 60, '持久检查点应包含完整的60日计划');
  assert.equal(checkpointContents.includes(longMetadata), false, '检查点不得保存材料原文');
  assert.equal(checkpointContents.includes('desktop-session-key'), false, '检查点不得保存 API Key');
  const replayInput = Object.fromEntries(['title', 'goal', 'level', 'learningMode', 'startDate', 'days', 'calendarDays', 'cadence', 'minutesPerDay', 'materials'].map(key => [key, longTask[key]]));
  const requestsBeforeCheckpointReplay = apiRecords.length;
  const replayedPlan = await window.webContents.executeJavaScript(`window.studyApp.generatePlan(${JSON.stringify(replayInput)}, 'completed-checkpoint-reuse-probe')`);
  assert.equal(replayedPlan.days.length, 60, '重新提交相同输入应返回已持久化的完整计划');
  assert.equal(apiRecords.length, requestsBeforeCheckpointReplay, '复用完整检查点不得重复调用模型 API');

  currentStage = '计划生成超过10秒才显示spinner并在取消后清理状态';
  await click(window, '[data-action="new-task"]', '打开待取消计划');
  await waitForJS(window, 'document.querySelector("#createDialog")?.open', '待取消计划对话框');
  await setValue(window, '#createForm [name="title"]', '取消中的计划');
  await setValue(window, '#createForm [name="goal"]', '学习 Python 基础并进行练习。');
  await setValue(window, '#createForm [name="days"]', 14);
  await click(window, '#createExamButton', '为待取消的计划打开考纲');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '待取消计划的考纲对话框');
  await setValue(window, '#examDescription', '仅用于验证异步取消时不保存考纲草稿。');
  await click(window, '#saveExamDraft', '暂存待取消计划的考纲');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open', '考纲已暂存到待取消创建表单');
  const cancelGate = delayNextPlanResponse('生成学习计划概要与知识清单');
  window.show();
  await beginCreateLoadingObservation(window);
  const cancelRequestStart = apiRecords.length;
  const submittedAt = Date.now();
  await click(window, '#createSubmit', '提交待取消的计划');
  const cancelPayload = await cancelGate.observed;
  const cancelRecord = apiRecords.slice(cancelRequestStart).find(record => record.purpose === '生成学习计划概要与知识清单');
  assert.ok(cancelRecord, '延迟请求应到达 localhost mock');
  assert.equal(cancelRecord.requestBody.max_tokens, undefined);
  assert.equal(cancelRecord.payload.examContext.description, '仅用于验证异步取消时不保存考纲草稿。', '创建异步计划请求时应携带已保存的考纲范围');
  let earlyLoading = await window.webContents.executeJavaScript(`({
    disabled: document.querySelector('#createSubmit').disabled,
    spinner: document.querySelector('#createSubmit').classList.contains('is-busy'),
    statusVisible: !document.querySelector('#createLoadingStatus').hidden
  })`);
  assert.equal(earlyLoading.disabled, true, '计划请求启动后立即锁定提交按钮');
  assert.equal(earlyLoading.spinner, false, '10 秒前不显示 spinner');
  assert.equal(earlyLoading.statusVisible, false, '10 秒前不显示进度状态');
  await delay(Math.max(0, 11000 - (Date.now() - submittedAt)));
  const delayedLoading = await window.webContents.executeJavaScript(`({
    spinner: document.querySelector('#createSubmit').classList.contains('is-busy'),
    statusVisible: !document.querySelector('#createLoadingStatus').hidden,
    statusText: document.querySelector('#createLoadingStatus').textContent,
    dialogCloseEvents: window.__desktopCreateDialogCloseEvents
  })`);
  assert.ok(delayedLoading.dialogCloseEvents.some(event => event.open), '重开后的创建对话框应收到迟发 close 事件，以覆盖活动清理竞态');
  assert.equal(delayedLoading.spinner, true, `真实请求超过 10 秒后显示 spinner：${JSON.stringify({ ...delayedLoading, elapsedMs: Date.now() - submittedAt })}`);
  assert.equal(delayedLoading.statusVisible, true, '真实请求超过 10 秒后显示进度状态');
  assert.ok(delayedLoading.statusText.length > 0);
  const delayedLoadingStates = await endCreateLoadingObservation(window);
  assert.ok(delayedLoadingStates.some(item => item.spinner && item.status), 'DOM 变化记录必须观察到延迟状态真正出现');
  await click(window, '#createDialog [data-close="createDialog"]', '取消生成并关闭新建窗口');
  await waitForJS(window, '!document.querySelector("#createDialog")?.open', '取消生成后新建窗口关闭');
  const cancelDeadline = Date.now() + 5000;
  while (!cancelRecord.responseAborted && Date.now() < cancelDeadline) await delay(50);
  cancelGate.release();
  assert.equal(cancelRecord.responseAborted, true, '关闭窗口应取消并中断正在等待的模型 HTTP 请求');
  state = await readState(window);
  assert.equal(state.tasks.some(task => task.title === '取消中的计划'), false, '取消后不得保存半成品任务');
  assert.equal(state.tasks.some(task => task.exam?.description === '仅用于验证异步取消时不保存考纲草稿。'), false, '取消异步创建后不得把待处理考纲写入任何任务');
  await click(window, '[data-action="new-task"]', '重新打开新建计划以检查取消清理');
  await waitForJS(window, 'document.querySelector("#createDialog")?.open', '取消后重新打开新建计划');
  const cleanedCreateState = await window.webContents.executeJavaScript(`({
    enabled: !document.querySelector('#createSubmit').disabled,
    spinner: document.querySelector('#createSubmit').classList.contains('is-busy'),
    statusHidden: document.querySelector('#createLoadingStatus').hidden,
    errorHidden: document.querySelector('#createError').hidden
  })`);
  assert.deepEqual(cleanedCreateState, { enabled: true, spinner: false, statusHidden: true, errorHidden: true }, '取消后不得残留 spinner、状态或错误');
  await click(window, '#createDialog [data-close="createDialog"]', '关闭已清理的新建窗口');
  window.hide();
  assert.ok(cancelPayload && cancelRecord.payload.purpose === '生成学习计划概要与知识清单');

  currentStage = '修改已有计划频率预览取消不改任务并确认保留历史及缓存';
  const cadenceToday = testLocalDate();
  const cadenceStart = schedule.formatDate(cadenceToday, -7);
  const cadenceDates = schedule.learningDates({ startDate: cadenceStart, calendarDays: 14, cadence: { mode: 'daily' } });
  const cadenceDays = cadenceDates.map((date, index) => ({
    day: index + 1,
    date,
    title: `历史计划第 ${index + 1} 天`,
    minutes: 30,
    tasks: [`复习 Python 第 ${index + 1} 天内容`],
    source: '主题与学习目标',
    completed: index === 8
  }));
  const cadenceFixture = {
    id: 'cadence-history-preservation-fixture',
    title: '频率修改历史保留测试',
    goal: '练习 Python 变量和循环。',
    level: 'beginner',
    learningMode: 'balanced',
    startDate: cadenceStart,
    days: 14,
    calendarDays: 14,
    cadence: { mode: 'daily', weekdays: [] },
    minutesPerDay: 45,
    materials: [],
    plan: {
      mode: 'ai', summary: '保留已有学习报告与缓存。', difficulty: '入门', warnings: [],
      knowledge: [{ title: '变量与循环', priority: '重点', explanation: '变量保存值，循环重复处理任务。', source: '主题与学习目标' }],
      days: cadenceDays
    },
    dailyQuizzes: {},
    lessons: {},
    tutorChats: {},
    createdAt: `${cadenceToday}T00:00:00.000Z`
  };
  const retainedCacheIndices = [0, 8];
  for (const dayIndex of retainedCacheIndices) {
    const day = cadenceFixture.plan.days[dayIndex];
    const quiz = makeDailyReadinessQuiz(dayIndex, day.date);
    cadenceFixture.dailyQuizzes[String(dayIndex)] = quiz;
    cadenceFixture.lessons[String(dayIndex)] = {
      brief: {
        text: `第 ${dayIndex + 1} 天的已保存讲解缓存。`,
        sources: ['主题与学习目标'],
        limitations: [],
        generatedDate: cadenceToday,
        dayTitle: day.title,
        dayTasks: day.tasks.slice(),
        daySource: day.source
      }
    };
    cadenceFixture.tutorChats[`daily:${dayIndex}:q1`] = {
      kind: 'daily',
      dayIndex,
      questionId: 'q1',
      question: quiz.questions[0].question,
      answer: quiz.answers.q1.text,
      feedback: quiz.result.items.find(item => item.id === 'q1').feedback,
      messages: [
        { role: 'user', text: '请解释这个已保存的问题。' },
        { role: 'assistant', text: '这个答案对应已保存的参考选项。', sources: ['主题与学习目标'], limitations: [] }
      ]
    };
  }
  const originalCadenceFixture = JSON.parse(JSON.stringify(cadenceFixture));
  await window.webContents.executeJavaScript(`window.studyApp.saveTask(${JSON.stringify(cadenceFixture)})`);
  const seededTaskCount = (await readState(window)).tasks.length;
  window = await reloadWindow(window, true, seededTaskCount);
  await click(window, '[data-nav="plans"]', '打开全部计划列表');
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "全部计划"', '全部计划列表就绪');
  const tasksFileBeforeCadencePreview = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  const cadenceRecordsBeforeCancel = apiRecords.length;
  await clickAction(window, 'edit-cadence', cadenceFixture.id);
  await waitForJS(window, 'document.querySelector("#cadenceDialog")?.open', '已有计划频率对话框');
  await setValue(window, '#cadenceForm [name="cadenceMode"]', 'weekly');
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await setChecked(window, `#cadenceWeekdays [name="cadenceWeekday"][value="${weekday}"]`, [1, 3, 5].includes(weekday));
  }
  await click(window, '#previewCadence', '预览周一三五新频率');
  await waitForJS(window, '!document.querySelector("#cadencePreview").hidden && !document.querySelector("#confirmCadence").hidden', '已有计划新频率预览完成');
  const cancelledCadencePreview = await window.webContents.executeJavaScript('document.querySelector("#cadencePreview").innerText');
  assert.match(cancelledCadencePreview, /已完成与历史安排会保留/);
  assert.equal(apiRecords.slice(cadenceRecordsBeforeCancel).filter(record => record.purpose === '按学习频率重拟未来计划').length, 1, '频率预览应只重拟当前未来日期');
  let stateAfterPreview = await readState(window);
  assert.deepEqual(stateAfterPreview.tasks.find(task => task.id === cadenceFixture.id), originalCadenceFixture, '预览阶段不得修改内存任务');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), tasksFileBeforeCadencePreview, '预览阶段不得写入 tasks.json');
  await click(window, '#cadenceDialog [data-close="cadenceDialog"]', '取消频率预览');
  await waitForJS(window, '!document.querySelector("#cadenceDialog")?.open', '频率预览已取消');
  stateAfterPreview = await readState(window);
  assert.deepEqual(stateAfterPreview.tasks.find(task => task.id === cadenceFixture.id), originalCadenceFixture, '取消预览后原任务必须保持不变');
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), tasksFileBeforeCadencePreview, '取消预览后不得写入任务文件');

  const cadenceRecordsBeforeApplyPreview = apiRecords.length;
  await clickAction(window, 'edit-cadence', cadenceFixture.id);
  await waitForJS(window, 'document.querySelector("#cadenceDialog")?.open', '重新打开频率对话框');
  await setValue(window, '#cadenceForm [name="cadenceMode"]', 'weekly');
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await setChecked(window, `#cadenceWeekdays [name="cadenceWeekday"][value="${weekday}"]`, [1, 3, 5].includes(weekday));
  }
  await click(window, '#previewCadence', '重新预览周一三五频率');
  await waitForJS(window, '!document.querySelector("#cadencePreview").hidden && !document.querySelector("#confirmCadence").hidden', '确认用频率预览完成');
  const cadenceRequest = apiRecords.slice(cadenceRecordsBeforeApplyPreview).find(record => record.purpose === '按学习频率重拟未来计划');
  assert.ok(cadenceRequest);
  assert.deepEqual(cadenceRequest.payload.cadence, { mode: 'weekly', weekdays: [1, 3, 5] });
  const expectedNewDates = schedule.learningDates({ startDate: cadenceStart, calendarDays: 14, cadence: { mode: 'weekly', weekdays: [1, 3, 5] } })
    .filter(date => date >= cadenceToday && !originalCadenceFixture.plan.days.some(day => day.date === date && (day.date < cadenceToday || day.completed)));
  assert.deepEqual(cadenceRequest.payload.sessions.map(session => session.date), expectedNewDates, '频率模型只收到未来且未完成的新日期');
  await click(window, '#confirmCadence', '确认并应用周一三五频率');
  await waitForJS(window, '!document.querySelector("#cadenceDialog")?.open', '新频率已确认并关闭');
  const updatedCadenceTask = (await readState(window)).tasks.find(task => task.id === cadenceFixture.id);
  assert.equal(updatedCadenceTask.cadence.mode, 'weekly');
  assert.deepEqual(updatedCadenceTask.cadence.weekdays, [1, 3, 5]);
  assert.equal(updatedCadenceTask.calendarDays, 14);
  assert.equal(updatedCadenceTask.plan.days.length, updatedCadenceTask.days);
  for (const oldDay of originalCadenceFixture.plan.days.filter(day => day.date < cadenceToday || day.completed)) {
    const kept = updatedCadenceTask.plan.days.find(day => day.date === oldDay.date);
    assert.ok(kept, `历史或已完成日期 ${oldDay.date} 必须保留`);
    assert.deepEqual({ ...kept, day: oldDay.day }, oldDay, `历史或已完成日期 ${oldDay.date} 的内容必须保留`);
  }
  for (const oldIndex of retainedCacheIndices) {
    const oldDay = originalCadenceFixture.plan.days[oldIndex];
    const newIndex = updatedCadenceTask.plan.days.findIndex(day => day.date === oldDay.date);
    assert.ok(newIndex >= 0, `报告日期 ${oldDay.date} 必须保留`);
    const oldQuiz = originalCadenceFixture.dailyQuizzes[String(oldIndex)];
    const keptQuiz = updatedCadenceTask.dailyQuizzes[String(newIndex)];
    assert.deepEqual(keptQuiz.answers, oldQuiz.answers, `日期 ${oldDay.date} 的历史作答必须保留`);
    assert.deepEqual(keptQuiz.result, oldQuiz.result, `日期 ${oldDay.date} 的历史报告必须保留`);
    assert.deepEqual(updatedCadenceTask.lessons[String(newIndex)].brief, originalCadenceFixture.lessons[String(oldIndex)].brief, `日期 ${oldDay.date} 的讲解缓存必须保留`);
    const oldChat = originalCadenceFixture.tutorChats[`daily:${oldIndex}:q1`];
    const keptChat = updatedCadenceTask.tutorChats[`daily:${newIndex}:q1`];
    assert.ok(keptChat, `日期 ${oldDay.date} 的追问缓存必须保留`);
    assert.deepEqual({ ...keptChat, dayIndex: oldChat.dayIndex }, oldChat, `日期 ${oldDay.date} 的追问内容必须保留`);
  }
  const addedCadenceRecords = apiRecords.slice(cadenceRecordsBeforeCancel).filter(record => record.purpose === '按学习频率重拟未来计划');
  assert.equal(addedCadenceRecords.length, 2, '预览取消与预览确认各生成一次模型请求');

  currentStage = '验证可选考试大纲、材料授权、总量限制与测验请求边界';
  window.show();
  assert.equal(fs.statSync(screenshotDir).isDirectory(), true, '指定截图目录应预先存在，测试不会创建目录');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#examDescription").maxLength'), 8000, '考试范围文本输入最多 8,000 字符');

  async function openCreateFixture(title, goal = '理解变量与循环并完成 Python 练习。') {
    await clickAction(window, 'new-task');
    await waitForJS(window, 'document.querySelector("#createDialog")?.open', `${title}新建计划对话框`);
    await setValue(window, '#createForm [name="title"]', title);
    await setValue(window, '#createForm [name="goal"]', goal);
    await setValue(window, '#createForm [name="days"]', 2);
    return testLocalDate();
  }

  async function dropMaterial(filePath, zone, host, fileName) {
    const result = await dispatchActualFileDrop(window, filePath, zone);
    assert.equal(result.prepared, true, `真实 CDP 文件拖放应到达 ${zone}`);
    await waitForJS(window, `document.querySelector(${JSON.stringify(host)})?.innerText.includes(${JSON.stringify(fileName)})`, `材料已加入 ${zone}`);
  }

  async function dropMaterials(filePaths, zone, host, fileNames) {
    const result = await dispatchActualFileDrop(window, filePaths, zone);
    assert.equal(result.prepared, true, `真实 CDP 多文件拖放应到达 ${zone}`);
    assert.equal(result.fileCount, filePaths.length, `CDP 应保留该批次全部 ${filePaths.length} 个材料`);
    const names = JSON.stringify(fileNames);
    const status = zone === '#examMaterialDropZone' ? '#examMaterialImportStatus' : '#createMaterialImportStatus';
    await waitForJS(window, `${names}.every(name => document.querySelector(${JSON.stringify(host)})?.innerText.includes(name)) && document.querySelector(${JSON.stringify(status)}).hidden`, `多批材料已加入 ${zone}`);
  }

  async function saveCreatedPlan(title) {
    const before = apiRecords.length;
    await click(window, '#createSubmit', `${title}提交计划`);
    await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks.some(task => task.title === ${JSON.stringify(title)}))`, `${title}计划保存`);
    await waitForJS(window, '!document.querySelector("#createDialog")?.open', `${title}创建对话框关闭`);
    const saved = (await readState(window)).tasks.find(task => task.title === title);
    assert.ok(saved, `${title}应保存到隔离用户数据`);
    const plannerRequests = apiRecords.slice(before).filter(record => record.purpose === '生成学习计划');
    assert.equal(plannerRequests.length, 1, `${title}一次提交只发出一次计划请求`);
    assert.equal(plannerRequests[0].requestBody.max_tokens, undefined, `${title}计划请求继续省略 max_tokens`);
    return { saved, request: plannerRequests[0] };
  }

  currentStage = '通过隔离 OCR mock 验证候选页进度与取消';
  const mockOcrPath = path.join(dataDir, 'mock-ocr-progress.pdf');
  fs.writeFileSync(mockOcrPath, '% mock OCR fixture; parser is replaced for this test');
  const originalParseMaterial = services.parseMaterial;
  const originalShowOpenDialog = dialog.showOpenDialog;
  let resolveMockParseStarted;
  let resolveMockParseAborted;
  const mockParseStarted = new Promise(resolve => { resolveMockParseStarted = resolve; });
  const mockParseAborted = new Promise(resolve => { resolveMockParseAborted = resolve; });
  let mockParseCalls = 0;
  try {
    services.parseMaterial = (filePath, options = {}) => {
      mockParseCalls += 1;
      resolveMockParseStarted(filePath);
      options.onProgress?.({ stage: 'ocr', page: 150, completed: 3, total: 137 });
      return new Promise((resolve, reject) => {
        const abort = () => {
          resolveMockParseAborted(filePath);
          reject(new Error('材料导入已取消。'));
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [mockOcrPath] });
    await openCreateFixture('OCR 进度与取消 mock');
    const apiRequestsBeforeOcr = apiRecords.length;
    await click(window, '#materialDropZone [data-action="import-create"]', 'mock 选择扫描 PDF');
    await waitForJS(window,
      '!document.querySelector("#createMaterialImportStatus").hidden && document.querySelector("#createMaterialImportMessage").textContent.includes("第 150 页")',
      'OCR 进度通过真实 materials:progress IPC 显示');
    const ocrStatusText = await window.webContents.executeJavaScript('document.querySelector("#createMaterialImportMessage").textContent');
    assert.match(ocrStatusText, /第 150 页/);
    assert.match(ocrStatusText, /已完成 3 \/ 137 页/);
    assert.match(ocrStatusText, /不会发送给模型服务/);
    assert.equal(await mockParseStarted, mockOcrPath, 'main 进程应将隔离 fixture 交给 mock parser');
    assert.equal(mockParseCalls, 1);
    assert.equal(apiRecords.length, apiRequestsBeforeOcr, '本地 OCR 进度与取消不得调用模型服务');
    await click(window, '#createMaterialImportStatus [data-action="cancel-material-import"]', '取消 mock OCR 导入');
    assert.equal(await Promise.race([mockParseAborted, delay(5000).then(() => null)]), mockOcrPath, '取消按钮应通过 materials:cancel 中断当前解析');
    await waitForJS(window, 'document.querySelector("#createMaterialImportStatus").hidden', '取消后 OCR 状态隐藏');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#createMaterials .attachment-item").length'), 0, '取消解析不得添加半成品材料');
    assert.equal(apiRecords.length, apiRequestsBeforeOcr, '取消 OCR 后仍不得请求模型服务');
    await click(window, '#createDialog [data-close="createDialog"]', '关闭 OCR mock 新建对话框');
    await waitForJS(window, '!document.querySelector("#createDialog")?.open', 'OCR mock 对话框已清理');
  } finally {
    services.parseMaterial = originalParseMaterial;
    dialog.showOpenDialog = originalShowOpenDialog;
  }

  currentStage = '验证多批材料达到10份后编辑删1再新增，并拒绝第11份';
  await openCreateFixture('考纲材料10份编辑边界');
  const studyBatchOne = Array.from({ length: 5 }, (_, index) => writeMarkdownFixture(`count-study-a-${index + 1}.md`, `学习资料 A${index + 1}`));
  const studyBatchOneNames = studyBatchOne.map(filePath => path.basename(filePath));
  await dropMaterials(studyBatchOne, '#materialDropZone', '#createMaterials', studyBatchOneNames);
  const studyBatchTwo = Array.from({ length: 4 }, (_, index) => writeMarkdownFixture(`count-study-b-${index + 1}.md`, `学习资料 B${index + 1}`));
  const studyBatchTwoNames = studyBatchTwo.map(filePath => path.basename(filePath));
  await dropMaterials(studyBatchTwo, '#materialDropZone', '#createMaterials', studyBatchTwoNames);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#createMaterials .attachment-item").length'), 9, '前两批普通材料合计应保存9份');

  await click(window, '#createExamButton', '为9份普通材料打开考纲');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '10份上限考纲对话框');
  const oldOutlineName = 'count-outline-old.md';
  await dropMaterial(writeMarkdownFixture(oldOutlineName, '旧考纲。'), '#examMaterialDropZone', '#examMaterials', oldOutlineName);
  await click(window, '#saveExamDraft', '保存第10份考纲附件');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open && document.querySelector("#createExamSummary").innerText.includes("1")', '第10份材料成功暂存');

  await click(window, '#createExamButton', '编辑已有的10份材料考纲');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open && document.querySelectorAll("#examMaterials .attachment-item").length === 1', '原考纲附件重新进入编辑草稿');
  await click(window, '#examMaterials [data-action="remove-exam-material"][data-material-index="0"]', '从10份材料中移除旧考纲');
  await waitForJS(window, 'document.querySelectorAll("#examMaterials .attachment-item").length === 0', '删除考纲附件后草稿空位已释放');
  const replacementOutlineName = 'count-outline-replacement.md';
  await dropMaterial(writeMarkdownFixture(replacementOutlineName, '替换后的考纲。'), '#examMaterialDropZone', '#examMaterials', replacementOutlineName);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#examError").hidden'), true, '删除一份后新增一份不得因旧材料计数而误拒绝');
  await click(window, '#saveExamDraft', '保存替换后的10份材料考纲');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open && document.querySelector("#createExamSummary").innerText.includes("1")', '替换考纲保存后总量仍为10份');

  await click(window, '#createExamButton', '确认替换后的考纲附件');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open && document.querySelectorAll("#examMaterials .attachment-item").length === 1', '替换后的考纲再次进入编辑');
  const replacementState = await window.webContents.executeJavaScript(`({
    text: document.querySelector('#examMaterials').innerText,
    count: document.querySelectorAll('#examMaterials .attachment-item').length
  })`);
  assert.equal(replacementState.count, 1);
  assert.match(replacementState.text, /count-outline-replacement\.md/);
  assert.doesNotMatch(replacementState.text, /count-outline-old\.md/);

  const overflowName = 'count-overflow-11.md';
  const overflowDrop = await dispatchActualFileDrop(window, writeMarkdownFixture(overflowName, '第11份材料。'), '#examMaterialDropZone');
  assert.equal(overflowDrop.prepared, true);
  await waitForJS(window, '!document.querySelector("#examError").hidden', '连续多批材料达到10份后拒绝第11份');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#examError").innerText'), /最多 10 份/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#examMaterials .attachment-item").length'), 1, '超限材料不得进入草稿');
  await click(window, '#examDialog [data-close="examDialog"]', '关闭10份材料边界考纲');
  await click(window, '#createDialog [data-close="createDialog"]', '关闭10份材料边界计划');
  await waitForJS(window, '!document.querySelector("#createDialog")?.open', '10份材料边界测试完成');

  await openCreateFixture('可跳过考纲的自学计划', '自学 Python 基础并练习循环。');
  await setValue(window, '#createForm [name="learningMode"]', 'deep');
  await click(window, '#createExamButton', '打开空白自学计划的考纲草稿');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '空白考纲对话框');
  await setValue(window, '#examDescription', '关闭时应丢弃的未保存考纲草稿。');
  await click(window, '#examDialog [data-close="examDialog"]', '取消未保存的考纲草稿');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open', '未保存考纲已取消');
  await click(window, '#createExamButton', '重新打开考纲以确认取消语义');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '重新打开的空白考纲对话框');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#examDescription").value'), '', '关闭考纲子对话框应丢弃未保存描述');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#examMaterials .attachment-item").length'), 0, '关闭考纲子对话框应丢弃未保存附件');
  await click(window, '#examDialog [data-close="examDialog"]', '关闭空白考纲对话框');
  const blankExamPlan = await saveCreatedPlan('可跳过考纲的自学计划');
  assert.equal(Object.hasOwn(blankExamPlan.saved, 'exam'), false, '完全空白的考纲不得写入 task.exam');
  assert.equal(blankExamPlan.request.payload.examContext, null, '自学计划请求应明确没有考试范围');

  await openCreateFixture('仅文字考试范围计划');
  await click(window, '#createExamButton', '打开仅文字考试范围');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '仅文字考试范围对话框');
  const textOnlyDescription = '重点复习第 2 至 5 章的变量、条件与循环。';
  await setValue(window, '#examDescription', textOnlyDescription);
  await click(window, '#saveExamDraft', '保存仅文字考试范围');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open', '仅文字考试范围已暂存');
  const textOnlyExamPlan = await saveCreatedPlan('仅文字考试范围计划');
  assert.deepEqual(textOnlyExamPlan.saved.exam, { description: textOnlyDescription, materialIds: [] });
  assert.deepEqual(textOnlyExamPlan.request.payload.examContext, { description: textOnlyDescription, materials: [] }, '计划请求只包含一次文字考纲描述');
  assert.equal(textOnlyExamPlan.saved.materials.length, 0);

  await openCreateFixture('仅附件考试范围计划');
  await click(window, '#createExamButton', '打开仅附件考试范围');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '仅附件考试范围对话框');
  const examOnlyMarker = 'EXAM_ONLY_BODY_MARKER_0610';
  const examOnlyName = 'exam-only-outline.md';
  const examOnlyPath = writeMarkdownFixture(examOnlyName, `考试范围文件：${examOnlyMarker}\n变量与循环。`);
  await dropMaterial(examOnlyPath, '#examMaterialDropZone', '#examMaterials', examOnlyName);
  await click(window, '#saveExamDraft', '暂存仅附件考试范围');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open && !document.querySelector("#createConsentWrap").hidden', '仅附件考试范围已合并并要求材料授权');
  const beforeUnconsentedSubmit = apiRecords.length;
  await click(window, '#createSubmit', '尝试在未授权时提交附件计划');
  await waitForJS(window, '!document.querySelector("#createError").hidden', '未授权附件计划显示本地提示');
  assert.equal(apiRecords.length, beforeUnconsentedSubmit, '未授权时不得将考纲附件发给模型');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#createDialog").open'), true, '未授权提交应留在创建对话框');
  await setChecked(window, '#createConsent', true);
  const fileOnlyExamPlan = await saveCreatedPlan('仅附件考试范围计划');
  assert.equal(fileOnlyExamPlan.saved.exam.description, '');
  assert.equal(fileOnlyExamPlan.saved.exam.materialIds.length, 1);
  assert.equal(fileOnlyExamPlan.saved.materials.length, 1, '考纲附件应只在统一材料数组保存一次');
  assert.ok(fileOnlyExamPlan.saved.materials.some(material => material.id === fileOnlyExamPlan.saved.exam.materialIds[0]));
  assert.deepEqual(fileOnlyExamPlan.request.payload.examContext.materials.map(material => material.name), [examOnlyName]);
  const fileOnlyBody = fileOnlyExamPlan.request.requestBody.messages[1].content;
  assert.equal(fileOnlyBody.split(examOnlyMarker).length - 1, 1, '仅附件考纲原文应只发送一次');

  await openCreateFixture('文字和双材料考试范围计划');
  const studyMarker = 'STUDY_MATERIAL_BODY_MARKER_0610';
  const studyMaterialName = 'study-notes.md';
  await dropMaterial(writeMarkdownFixture(studyMaterialName, `学习材料：${studyMarker}\n循环应用练习。`), '#materialDropZone', '#createMaterials', studyMaterialName);
  await click(window, '#createExamButton', '打开组合考试范围');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '组合考试范围对话框');
  const combinedDescription = '考试覆盖循环边界条件，并要求解释代码运行结果。';
  const combinedExamMarker = 'COMBINED_EXAM_BODY_MARKER_0610';
  const combinedExamName = 'combined-exam-scope.md';
  await setValue(window, '#examDescription', combinedDescription);
  await dropMaterial(writeMarkdownFixture(combinedExamName, `考试附件：${combinedExamMarker}\n重点是循环边界。`), '#examMaterialDropZone', '#examMaterials', combinedExamName);
  await click(window, '#saveExamDraft', '暂存文字与附件组合考纲');
  await waitForJS(window, '!document.querySelector("#examDialog")?.open && !document.querySelector("#createConsentWrap").hidden', '组合考纲已合并并要求材料授权');
  await setChecked(window, '#createConsent', true);
  const combinedExamPlan = await saveCreatedPlan('文字和双材料考试范围计划');
  assert.deepEqual(combinedExamPlan.saved.exam, { description: combinedDescription, materialIds: [combinedExamPlan.saved.materials.find(material => material.name === combinedExamName).id] });
  assert.equal(combinedExamPlan.saved.materials.length, 2, '学习材料和考纲附件应共用唯一材料数组');
  assert.equal(new Set(combinedExamPlan.saved.materials.map(material => material.id)).size, 2, '材料合并后编号不得重复');
  const combinedRequest = combinedExamPlan.request;
  assert.deepEqual(combinedRequest.payload.examContext, {
    description: combinedDescription,
    materials: [{ id: combinedExamPlan.saved.exam.materialIds[0], name: combinedExamName }]
  }, '模型计划请求应将考试范围附件与普通学习材料区分');
  const combinedBody = combinedRequest.requestBody.messages[1].content;
  assert.equal(combinedBody.split(combinedDescription).length - 1, 1, '考纲文字应只出现在一次计划输入中');
  assert.equal(combinedBody.split(studyMarker).length - 1, 1, '普通学习材料原文应只发送一次');
  assert.equal(combinedBody.split(combinedExamMarker).length - 1, 1, '考纲附件原文应只发送一次');

  const assessmentRequestsBefore = apiRecords.length;
  await openAssessmentThroughUI(window, combinedExamPlan.saved.id, 'daily', 0, true);
  const generatedAssessmentRequest = apiRecords.slice(assessmentRequestsBefore).find(record => record.purpose === '生成每日小测');
  assert.ok(generatedAssessmentRequest, '含考纲计划的明确测验生成应发送一次 assessment 请求');
  assert.deepEqual(generatedAssessmentRequest.payload.examContext, {
    description: combinedDescription,
    materials: [{ id: combinedExamPlan.saved.exam.materialIds[0], name: combinedExamName }]
  }, '测验生成请求应包含精简后的考纲元数据');
  assert.doesNotMatch(generatedAssessmentRequest.requestBody.messages[1].content, /STUDY_MATERIAL_BODY_MARKER_0610|COMBINED_EXAM_BODY_MARKER_0610/, '已有知识清单时测验请求不得重复携带附件原文');
  for (const [index, question] of makeAssessmentQuestions('daily').entries()) {
    if (question.type === 'choice') await chooseRadio(window, `#quizForm input[type="radio"][data-qid="q${index + 1}"][value="A"]`);
    else await setValue(window, `#quizForm [data-answer][data-qid="q${index + 1}"]`, '用循环逐项检查并汇总数据。');
  }
  const gradeRequestStart = apiRecords.length;
  await click(window, '#submitQuiz', '提交组合考纲计划的每日测验');
  await waitForJS(window, `window.studyApp.loadState().then(s => Boolean(s.tasks.find(task => task.id === ${JSON.stringify(combinedExamPlan.saved.id)})?.dailyQuizzes?.['0']?.result))`, '组合考纲计划的测验报告已保存');
  const gradeRecord = apiRecords.slice(gradeRequestStart).find(record => record.purpose === '评分并生成学习报告');
  assert.ok(gradeRecord);
  assert.equal(Object.hasOwn(gradeRecord.payload, 'exam'), false, '评分请求不应再次发送考纲元数据');
  assert.equal(Object.hasOwn(gradeRecord.payload, 'examContext'), false, '评分请求不应重复发送考试范围上下文');
  assert.doesNotMatch(gradeRecord.requestBody.messages[1].content, /考试覆盖循环边界条件|COMBINED_EXAM_BODY_MARKER_0610/, '评分请求不应重复携带考纲文字或附件');

  currentStage = '阻止考纲与学习材料合计超过200000字';
  await openCreateFixture('学习材料总量边界测试');
  const budgetStudyName = 'budget-study-120001.md';
  await dropMaterial(writeMarkdownFixture(budgetStudyName, 'a'.repeat(120001)), '#materialDropZone', '#createMaterials', budgetStudyName);
  await click(window, '#createExamButton', '打开材料总量边界考纲');
  await waitForJS(window, 'document.querySelector("#examDialog")?.open', '材料总量边界考纲对话框');
  const budgetExamName = 'budget-exam-80001.md';
  const budgetExamDrop = await dispatchActualFileDrop(window, writeMarkdownFixture(budgetExamName, 'b'.repeat(80001)), '#examMaterialDropZone');
  assert.equal(budgetExamDrop.prepared, true, '超限考纲文件仍应通过真实文件拖放流程到达 UI');
  await waitForJS(window, '!document.querySelector("#examError").hidden && document.querySelector("#examMaterialImportStatus").hidden', '超出 200,000 字的合计材料量被拒绝并结束导入');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#examError").textContent'), /200,000/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#examMaterials .attachment-item").length'), 0, '超限考纲附件不得进入草稿');
  await click(window, '#examDialog [data-close="examDialog"]', '取消超限考纲草稿');
  await click(window, '#createDialog [data-close="createDialog"]', '取消材料总量边界计划');
  await waitForJS(window, '!document.querySelector("#createDialog")?.open', '材料总量边界测试已清理');
  assert.equal(apiRecords.some(record => record.purpose === '生成学习计划' && record.payload.title === '学习材料总量边界测试'), false, '超限材料测试不得调用模型');

  currentStage = '分别展示新 studyNotes、旧 warning 分类与材料阅读提示';
  let visualTask = JSON.parse(JSON.stringify((await readState(window)).tasks.find(task => task.id === combinedExamPlan.saved.id)));
  visualTask.plan.studyNotes = ['重点：理解循环边界条件。', '易错点：不要把结束条件写反。'];
  visualTask.plan.warnings = ['生成提示：材料解析有一页未能识别。'];
  const visualExamMaterial = visualTask.materials.find(material => material.id === visualTask.exam.materialIds[0]);
  visualExamMaterial.readingWarnings = ['PDF 中有扫描页，阅读时请对照原文件核查。'];
  const visualFirstDay = visualTask.plan.days[0];
  visualTask.lessons ||= {};
  visualTask.lessons['0'] = { brief: {
    text: '概念：循环重复执行操作。例子：逐项累加账目。易错点：结束条件必须能停止。',
    sources: [combinedExamName], limitations: [], generatedDate: visualFirstDay.date,
    dayTitle: visualFirstDay.title, dayTasks: [...visualFirstDay.tasks], daySource: visualFirstDay.source
  } };
  visualTask.finalQuizHistory = [JSON.parse(JSON.stringify(originalLegacyTask.quiz))];
  const pendingVisualQuiz = makeDailyReadinessQuiz(1, visualTask.plan.days[1].date);
  delete pendingVisualQuiz.answers;
  delete pendingVisualQuiz.result;
  delete pendingVisualQuiz.resultDate;
  visualTask.dailyQuizzes['1'] = pendingVisualQuiz;
  await window.webContents.executeJavaScript(`window.studyApp.saveTask(${JSON.stringify(visualTask)})`);

  const legacyWarningFixture = JSON.parse(JSON.stringify(originalLegacyTask));
  legacyWarningFixture.id = 'desktop-legacy-warning-classification-fixture';
  legacyWarningFixture.title = '旧版警告分类视觉测试';
  legacyWarningFixture.plan.warnings = ['循环概念容易混淆，请先区分条件与重复次数。', '定义不能凭名称猜测含义。', '材料解析缺页，安排范围有限。', '内容可能不完整。'];
  delete legacyWarningFixture.plan.studyNotes;
  legacyWarningFixture.createdAt = `${testLocalDate()}T00:00:00.000Z`;
  await window.webContents.executeJavaScript(`window.studyApp.saveTask(${JSON.stringify(legacyWarningFixture)})`);
  let visualState = await readState(window);
  assert.ok(visualState.tasks.some(task => task.id === legacyWarningFixture.id));
  window = await reloadWindow(window, true, visualState.tasks.length);
  await clickAction(window, 'open-plan', legacyWarningFixture.id);
  await waitForJS(window, `document.querySelector("#appView h1")?.textContent === ${JSON.stringify(legacyWarningFixture.title)}`, '旧计划警告分类详情');
  const legacyWarningSections = await window.webContents.executeJavaScript(`({
    notes: document.querySelector('.plan-study-notes')?.innerText || '',
    warnings: document.querySelector('.plan-warnings')?.innerText || ''
  })`);
  assert.match(legacyWarningSections.notes, /循环概念容易混淆/);
  assert.match(legacyWarningSections.notes, /定义不能凭名称猜测含义/);
  assert.doesNotMatch(legacyWarningSections.notes, /材料解析|内容可能不完整/);
  assert.match(legacyWarningSections.warnings, /材料解析缺页/);
  assert.match(legacyWarningSections.warnings, /内容可能不完整/, '无法安全分类的旧警告应留在生成提示区');

  currentStage = '真实 Electron 双语言双尺寸主视图与对话框布局截图';
  async function capturePage(name, language, width) {
    await captureVisualScreenshot(window, `0.6-ui-${language}-${width}x${width === 850 ? 650 : 800}-${name}.png`);
  }
  async function captureDialog(name, selector, language, width) {
    await captureVisualScreenshot(window, `0.6-ui-${language}-${width}x${width === 850 ? 650 : 800}-${name}.png`, selector);
  }
  async function captureMainViews(language, width) {
    await click(window, '[data-nav="overview"]', '截图：学习概览');
    await waitForJS(window, 'Boolean(document.querySelector("#appView .welcome-panel"))', '概览视图已加载');
    await capturePage('overview', language, width);
    await click(window, '[data-nav="today"]', '截图：今日安排');
    await waitForJS(window, 'Boolean(document.querySelector("#appView .page-head"))', '今日安排视图已加载');
    await capturePage('today', language, width);
    await click(window, '[data-nav="plans"]', '截图：全部计划');
    await waitForJS(window, 'Boolean(document.querySelector("#appView .plan-card"))', '计划列表视图已加载');
    await capturePage('plans', language, width);
    await clickAction(window, 'open-plan', visualTask.id);
    await waitForJS(window, `document.querySelector("#appView h1")?.textContent === ${JSON.stringify(visualTask.title)}`, '考试范围计划详情已加载');
    const planDetail = await window.webContents.executeJavaScript(`({
      notes: document.querySelector('.plan-study-notes')?.innerText || '',
      warnings: document.querySelector('.plan-warnings')?.innerText || '',
      exam: document.querySelector('.plan-exam-summary')?.innerText || ''
    })`);
    assert.match(planDetail.notes, /理解循环边界条件/);
    assert.match(planDetail.warnings, /材料解析有一页未能识别/);
    assert.match(planDetail.exam, /循环边界条件/);
    assert.match(planDetail.exam, /combined-exam-scope\.md/);
    await capturePage('detail', language, width);
    await click(window, '[data-nav="materials"]', '截图：材料库');
    await waitForJS(window, 'Boolean(document.querySelector("#appView .material-card"))', '材料库视图已加载');
    const materialWarning = await window.webContents.executeJavaScript('document.querySelector("#appView .material-reading-summary")?.innerText || ""');
    assert.match(materialWarning, /PDF 中有扫描页/);
    await capturePage('materials', language, width);
    await click(window, '[data-nav="plans"]', '从材料库返回计划');
    await clickAction(window, 'open-plan', visualTask.id);
    await openAssessmentThroughUI(window, visualTask.id, 'daily', 1, false);
    await waitForJS(window, 'document.querySelectorAll("#quizForm .quiz-question").length === 5', '未提交的每日测验界面');
    await capturePage('quiz', language, width);
    await clickAction(window, 'open-plan', visualTask.id);
    await openAssessmentThroughUI(window, visualTask.id, 'daily', 0, false);
    await waitForJS(window, 'Boolean(document.querySelector("#appView .learning-report"))', '已提交的每日报告界面');
    await capturePage('report', language, width);
  }

  async function captureStandardDialogs(language, width) {
    await clickAction(window, 'new-task');
    await waitForJS(window, 'document.querySelector("#createDialog")?.open', '截图：创建对话框已打开');
    await captureDialog('dialog-create', '#createDialog', language, width);
    await click(window, '#createExamButton', '打开截图考纲对话框');
    await waitForJS(window, 'document.querySelector("#examDialog")?.open', '截图：考纲对话框已打开');
    await captureDialog('dialog-exam', '#examDialog', language, width);
    await click(window, '#examDialog [data-close="examDialog"]', '关闭截图考纲对话框');
    await click(window, '#createDialog [data-close="createDialog"]', '关闭截图创建对话框');
    await click(window, '#profileButton', '截图：打开个人资料');
    await waitForJS(window, 'document.querySelector("#profileDialog")?.open', '截图：个人资料对话框已打开');
    await captureDialog('dialog-profile', '#profileDialog', language, width);
    await click(window, '#profileDialog [data-close="profileDialog"]', '关闭截图个人资料');
    await clickAction(window, 'settings');
    await waitForJS(window, 'document.querySelector("#settingsDialog")?.open', '截图：设置对话框已打开');
    await captureDialog('dialog-settings', '#settingsDialog', language, width);
    await click(window, '#settingsDialog [data-close="settingsDialog"]', '关闭截图设置');
    await clickAction(window, 'open-plan', visualTask.id);
    await clickAction(window, 'edit-day', visualTask.id, { dayIndex: 0 });
    await waitForJS(window, 'document.querySelector("#editDayDialog")?.open', '截图：编辑日程对话框已打开');
    await captureDialog('dialog-edit', '#editDayDialog', language, width);
    await click(window, '#editDayDialog [data-close="editDayDialog"]', '关闭截图编辑日程');
    await click(window, '[data-nav="materials"]', '打开材料库以截图预览');
    await click(window, `[data-action="preview-library-material"][data-material-id="${visualExamMaterial.id}"]`, '截图：打开材料预览');
    await waitForJS(window, 'document.querySelector("#materialDialog")?.open', '截图：材料预览对话框已打开');
    const previewWarning = await window.webContents.executeJavaScript('document.querySelector("#materialWarnings")?.innerText || ""');
    assert.match(previewWarning, /PDF 中有扫描页/);
    await captureDialog('dialog-material', '#materialDialog', language, width);
    await click(window, '#materialDialog [data-close="materialDialog"]', '关闭截图材料预览');
    await clickAction(window, 'open-plan', visualTask.id);
    await clickAction(window, 'edit-cadence', visualTask.id);
    await waitForJS(window, 'document.querySelector("#cadenceDialog")?.open', '截图：频率调整对话框已打开');
    await captureDialog('dialog-cadence', '#cadenceDialog', language, width);
    await click(window, '#cadenceDialog [data-close="cadenceDialog"]', '关闭截图频率调整');
    await clickAction(window, 'view-final-history', visualTask.id);
    await waitForJS(window, 'document.querySelector("#finalHistoryDialog")?.open', '截图：历史周期报告对话框已打开');
    await captureDialog('dialog-final-history', '#finalHistoryDialog', language, width);
    await click(window, '#finalHistoryDialog [data-close="finalHistoryDialog"]', '关闭截图历史周期报告');
    await clickAction(window, 'open-lesson', visualTask.id, { dayIndex: 0 });
    await waitForJS(window, 'document.querySelector("#tutoringDialog")?.open', '截图：讲解对话框已打开');
    await captureDialog('dialog-tutoring', '#tutoringDialog', language, width);
    await click(window, '#tutoringDialog [data-close="tutoringDialog"]', '关闭截图讲解对话框');
  }

  const visualAdjustmentRecords = [];
  for (const language of ['zh-CN', 'en']) {
    const imageLanguage = language === 'zh-CN' ? 'zh' : 'en';
    await setUiLanguage(window, language);
    for (const width of [850, 1320]) {
      const height = width === 850 ? 650 : 800;
      await setVisualViewport(window, width, height);
      await captureMainViews(imageLanguage, width);
      await captureStandardDialogs(imageLanguage, width);
      if (width === 850) {
        await clickAction(window, 'open-plan', visualTask.id);
        await openAssessmentThroughUI(window, visualTask.id, 'daily', 0, false);
        const adjustmentBefore = apiRecords.length;
        await clickAction(window, 'propose-adjustment', visualTask.id, { dayIndex: 0 });
        await waitForJS(window, 'document.querySelector("#adjustmentDialog")?.open && !document.querySelector("#adjustmentPreview").hidden', '截图：后续调整预览对话框已打开');
        const adjustmentRecord = apiRecords.slice(adjustmentBefore).find(record => record.purpose === '调整后续学习规划' && record.payload?.title === visualTask.title);
        assert.ok(adjustmentRecord, '真实打开后续调整预览应使用 localhost mock');
        visualAdjustmentRecords.push(adjustmentRecord);
        await captureDialog('dialog-adjustment', '#adjustmentDialog', imageLanguage, 850);
        await setVisualViewport(window, 1320, 800);
        await captureDialog('dialog-adjustment', '#adjustmentDialog', imageLanguage, 1320);
        await click(window, '#adjustmentDialog [data-action="cancel-adjustment"]', '取消截图后续调整预览');
        await waitForJS(window, '!document.querySelector("#adjustmentDialog")?.open', '截图后续调整预览已取消');
      }
    }
  }
  assert.equal(visualAdjustmentRecords.length, 2, '中文和英文讲解布局各使用一次真实后续调整预览');
  assert.deepEqual(visualAdjustmentRecords.map(record => record.payload.outputLanguage), ['zh-CN', 'en']);

  currentStage = '清除 Key、重新锁定并确认任务磁盘内容不变';
  const taskFilePath = path.join(dataDir, 'tasks.json');
  const taskFileBeforeRelock = fs.readFileSync(taskFilePath, 'utf8');
  await click(window, '[data-action="settings"]', '打开设置清除 Key');
  await waitForJS(window, 'document.querySelector("#settingsDialog")?.open && !document.querySelector("#clearKeyRow").hidden', '显示清除 Key 选项');
  await setChecked(window, '#clearKey', true);
  await click(window, '#saveSettings', '清除 API Key');
  await waitForJS(window, 'document.querySelector("#settingsDialog") && !document.querySelector("#settingsDialog").open', 'Key 清除并保存');
  await waitForJS(window, 'window.studyApp.loadState().then(s => !s.settings.configured && !s.settings.hasKey && s.tasks.length === 0)', '清除 Key 后重新锁定');
  state = await readState(window);
  assert.equal(state.settings.endpoint, endpoint);
  assert.equal(state.settings.model, 'desktop-mock');
  assert.deepEqual(state.tasks, []);
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".service-locked"))'), true);
  assert.equal(fs.readFileSync(taskFilePath, 'utf8'), taskFileBeforeRelock, '清除 Key 只应锁定界面，不得改写任务数据');
  const clearedSettings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(clearedSettings.encryptedKey, undefined);
  assert.equal(clearedSettings.key, undefined);
  const regressionAdjustmentRequests = apiRecords.filter(record => record.purpose === '调整后续学习规划' && record.payload?.title === regressionTitle);
  assert.equal(regressionAdjustmentRequests.length, 1, '跳过已完成日回归测试应单独发起一次模拟调整请求');
  const baselineApiRecords = apiRecords.filter(record => !regressionAdjustmentRequests.includes(record));
  assert.deepEqual(baselineApiRecords.filter(record => record.payload?.outputLanguage !== 'en').map(record => record.purpose).filter(purpose => !['讲解当前日学习内容', '解释当前测验题和评分反馈'].includes(purpose)), [
    '连接测试',
    '生成周期测验',
    '按材料和评分标准评阅学习测验',
    '澄清学习需求', '澄清学习需求', '生成学习计划',
    '澄清学习需求', '澄清学习需求', '生成学习计划',
    '生成每日小测', '生成每日小测', '评分并生成学习报告',
    '生成每日小测', '生成周期测验', '评分并生成学习报告',
    '生成每日小测', '评分并生成学习报告',
    '生成每日小测', '评分并生成学习报告',
    '调整后续学习规划', '调整后续学习规划',
    '生成学习计划', '生成学习计划',
    '生成学习计划概要与知识清单',
    ...Array.from({ length: Math.ceil(60 / 7) }, () => '生成学习计划每日安排'),
    '生成学习计划概要与知识清单',
    '按学习频率重拟未来计划', '按学习频率重拟未来计划',
    '生成学习计划', '生成学习计划', '生成学习计划', '生成学习计划',
    '生成每日小测', '评分并生成学习报告',
    '调整后续学习规划'
  ]);
  const plannerPurposes = new Set(['生成学习计划', '生成学习计划概要与知识清单', '生成学习计划每日安排', '按学习频率重拟未来计划']);
  assert.ok(apiRecords.filter(record => plannerPurposes.has(record.purpose)).every(record => record.requestBody.max_tokens === undefined), '所有新旧计划生成与频率重排请求都必须省略 max_tokens');
  assert.ok(apiRecords.find(record => record.purpose === '连接测试').requestBody.max_tokens >= 512, '连接测试仍须留出足够的输出空间');
  console.log(`PASS desktop flow: old history and profile gates restored; native file drop imported; ${newTask.plan.knowledge.length} knowledge points; daily report ${adjustedTask.dailyQuizzes['0'].result.score}/100; future adjustment preserved completed history`);
}

run()
  .then(() => { successfulRun = true; })
  .catch(error => {
    console.error(`FAIL desktop flow at: ${currentStage}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    const removeTempDir = directory => {
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      } catch (error) {
        console.error(`TEMP_CLEANUP_WARNING ${directory}: ${error.message}`);
      }
    };
    app.once('will-quit', event => {
      removeTempDir(dataDir);
      if (!externalScreenshotDir && (!requestedScreenshots || !successfulRun)) removeTempDir(screenshotDir);
      if (apiServer.listening) apiServer.close();
      if (process.exitCode) {
        event.preventDefault();
        app.exit(process.exitCode);
      }
    });
    try {
      app.quit();
    } catch {}
  });
