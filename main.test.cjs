'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

function taskFixture() {
  return {
    id: 'backup-task', title: '备份测试', goal: '学习变量与函数', level: 'beginner',
    startDate: '2026-10-11', days: 2, minutesPerDay: 60, materials: [],
    plan: {
      mode: 'ai', summary: '先学习再复盘', difficulty: '入门', warnings: [],
      knowledge: [{ title: '变量', priority: '重点', explanation: '使用变量保存数据', source: '主题与学习目标' }],
      days: [0, 1].map(index => ({ day: index + 1, date: `2026-10-${11 + index}`, title: '变量练习',
        minutes: 60, tasks: ['学习变量并练习'], source: '主题与学习目标', completed: index === 0 }))
    }
  };
}

async function harness(t, tasks = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = { endpoint: 'https://example.test/v1', model: 'mock', encryptedKey: 'test-only' };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks }));
  const handlers = new Map();
  let selected = { canceled: true, filePaths: [] };
  let win;
  const electron = {
    app: { setPath() {}, getPath: () => dir, getLocale: () => 'zh-CN',
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {}, quit() {}, isReady: () => true },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => selected, showErrorBox: (_title, message) => { throw new Error(message); } },
    safeStorage: { decryptString: () => 'not-a-real-key' }, nativeImage: {},
    BrowserWindow: class {
      constructor() {
        win = this;
        this.webContents = { mainFrame: { url: pathToFileURL(path.join(__dirname, 'index.html')).href },
          setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {} } };
      }
      on() {} loadFile() {} isDestroyed() { return false; }
    }
  };
  const realRequire = createRequire(path.join(__dirname, 'main.cjs'));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : realRequire(name),
    __dirname, process: { env: { STUDY_APP_DATA_DIR: dir } }, Buffer, AbortController
  }, { filename: 'main.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(handlers.has('task:import-backup'));
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
  return {
    dir, settings, invoke,
    select(content) {
      const filename = path.join(dir, 'backup.json');
      fs.writeFileSync(filename, typeof content === 'string' ? content : JSON.stringify(content));
      selected = { canceled: false, filePaths: [filename] };
    },
    stored: () => JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'))
  };
}

test('备份恢复保留任务与完成状态，同编号恢复为副本且不覆盖现有计划', async t => {
  const original = taskFixture();
  const h = await harness(t, [original]);
  const imported = { ...original, title: '恢复的计划', apiKey: 'should-not-be-imported', settings: { key: 'private' } };
  h.select({ format: 'study-workbench-task', exportedAt: '2026-10-11T00:00:00.000Z', task: imported });
  const result = await h.invoke('task:import-backup');
  assert.equal(result.copied, true);
  assert.notEqual(result.task.id, original.id);
  assert.equal(result.task.plan.days[0].completed, true);
  assert.equal('apiKey' in result.task, false);
  assert.equal('settings' in result.task, false);
  assert.equal(h.stored().tasks.length, 2);
  assert.deepEqual(h.stored().tasks[1], original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')), h.settings);
});

test('取消或非法备份不改变已保存计划，正确备份可以恢复原编号', async t => {
  const h = await harness(t);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.invoke('task:import-backup'))), { cancelled: true });
  const valid = { format: 'study-workbench-task', task: taskFixture() };
  const invalid = [
    '{"format":', {}, { format: 'other', task: taskFixture() },
    { ...valid, task: { ...taskFixture(), days: 180 } },
    { ...valid, task: { ...taskFixture(), plan: { ...taskFixture().plan,
      knowledge: [{ title: '变量', priority: '重点', explanation: '说明', source: '不存在的材料.pdf 第 99 页' }] } } }
  ];
  for (const backup of invalid) {
    h.select(backup);
    await assert.rejects(h.invoke('task:import-backup'));
    assert.deepEqual(h.stored(), { tasks: [] });
  }
  h.select(valid);
  const restored = await h.invoke('task:import-backup');
  assert.equal(restored.copied, false);
  assert.equal(restored.task.id, valid.task.id);
  assert.equal((await h.invoke('state:load')).tasks.length, 1);
});

test('过大备份被拒绝且不保存', async t => {
  const h = await harness(t);
  h.select(' '.repeat(10 * 1024 * 1024 + 1));
  await assert.rejects(h.invoke('task:import-backup'), /10 MB/);
  assert.deepEqual(h.stored(), { tasks: [] });
});

test('旧报告错误题号不会阻止备份恢复与进度保存，历史追问记录保持可读', async t => {
  const h = await harness(t);
  const task = taskFixture();
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: 'q' + (index + 1), type: index === 0 ? 'choice' : 'fill', question: '第 ' + (index + 1) + ' 题',
    options: index === 0 ? ['正确解释', '干扰一', '干扰二', '干扰三'] : [],
    answer: index === 0 ? 'A' : '参考答案', alternatives: [], reference: '解释概念', rubric: '按准确性评分'
  }));
  const answers = Object.fromEntries(questions.map(question => [question.id, { text: question.answer }]));
  const items = questions.map(question => ({ id: question.id, score: 20, feedback: '本题回答正确' }));
  task.dailyQuizzes = { '0': {
    version: 2, mode: 'ai', kind: 'daily', dayIndex: 0, questions, answers,
    result: { mode: 'ai', score: 100, feedback: '评分结果', items, weakPoints: ['仍需练习'],
      report: { summary: '保留历史成绩', strengths: ['概念'], nextSteps: ['再练习'], readyForNext: false,
        reason: '第 99 题没有解释概念，需要先复习基础知识再继续。', extraMinutes: 20, extraTasks: ['复习概念'] } }
  } };
  task.tutorChats = { 'daily:0:q1': {
    kind: 'daily', dayIndex: 0, questionId: 'q1', question: questions[0].question,
    answer: 'A', feedback: items[0].feedback,
    messages: [{ role: 'user', text: '请讲解' }, { role: 'assistant', text: '这是历史讲解' }]
  } };
  h.select({ format: 'study-workbench-task', task });
  const restored = await h.invoke('task:import-backup');
  assert.equal(restored.task.dailyQuizzes['0'].result.score, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.task.tutorChats)), task.tutorChats);
  restored.task.plan.days[1].completed = true;
  await h.invoke('task:save', restored.task);
  assert.equal(h.stored().tasks[0].plan.days[1].completed, true);
  await assert.rejects(h.invoke('plan:adjust', { task: restored.task, dayIndex: 0 }), /报告引用了不存在的题目/);
});
