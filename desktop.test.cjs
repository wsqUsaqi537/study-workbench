'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-workbench-desktop-data-'));
const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-workbench-desktop-shot-'));
const requestedScreenshots = process.env.STUDY_TEST_KEEP_SCREENSHOT === '1';
const appRoot = path.resolve(process.env.STUDY_TEST_APP_ROOT || __dirname);
process.env.STUDY_APP_DATA_DIR = dataDir;

const { app, BrowserWindow, safeStorage } = require('electron');
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

function makeModelPlan(input) {
  const days = Number(input.days) || 2;
  const startDate = input.startDate || '2026-10-08';
  const dates = Array.from({ length: days }, (_, offset) => {
    const date = new Date(`${startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
  return {
    summary: '逐步学习 Python 基础，并通过小程序检验掌握情况。',
    difficulty: '入门',
    warnings: [],
    days: dates.map((date, index) => ({
      day: index + 1,
      date,
      title: index === days - 1 ? '小程序综合测试与复盘' : `第 ${index + 1} 天：变量与练习`,
      minutes: Math.min(45, Number(input.minutesPerDay) || 60),
      tasks: [index === days - 1 ? '完成小程序测试并复盘' : '理解概念并完成练习'],
      source: '主题与学习目标'
    })),
    knowledge: [
      { title: '变量与数据类型', priority: '重点', explanation: '变量保存需要使用的数据；选择合适的数据类型有助于正确处理输入和计算。', source: '主题与学习目标' },
      { title: '循环结构', priority: '了解', explanation: '循环可以重复执行操作，适合处理多笔记账记录。', source: '主题与学习目标' }
    ]
  };
}

function responseFor(purpose, payload) {
  if (purpose === '澄清学习需求') {
    clarifyCount += 1;
    return clarifyCount === 1
      ? { reply: '你希望覆盖变量、循环和函数，并完成记账小程序，对吗？', ready: false, brief: null }
      : { reply: '学习范围已经整理好，请确认。', ready: true, brief: expectedBrief };
  }
  if (purpose === '生成学习计划') return makeModelPlan(payload);
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
    apiRecords.push({ path: request.url, authorization: request.headers.authorization, requestBody, purpose, payload });
    if (purpose === '生成学习计划' && nextPlanGate) {
      const gate = nextPlanGate;
      nextPlanGate = null;
      gate.resolveObserved(payload);
      await gate.released;
    }
    const result = responseFor(purpose, payload || {});
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
const apiStarted = new Promise((resolve, reject) => {
  apiServer.once('error', reject);
  apiServer.listen(0, '127.0.0.1', resolve);
});
let nextPlanGate = null;

function delayNextPlanResponse() {
  let resolveObserved;
  let releaseResponse;
  const observed = new Promise(resolve => { resolveObserved = resolve; });
  const released = new Promise(resolve => { releaseResponse = resolve; });
  nextPlanGate = { resolveObserved, released };
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

const originalLegacyTask = legacyTask();
const initialTasksText = JSON.stringify({ tasks: [originalLegacyTask] }, null, 2);
fs.writeFileSync(path.join(dataDir, 'tasks.json'), initialTasksText);
fs.writeFileSync(path.join(dataDir, 'profile.json'), JSON.stringify(seedProfile, null, 2));
require(path.join(appRoot, 'main.cjs'));

let currentStage = '启动 Electron';
let successfulRun = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForWindow(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (window) return window;
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
      ${extra.dayIndex === undefined ? 'true' : `candidate.dataset.dayIndex === ${JSON.stringify(String(extra.dayIndex))}`}
    );
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `无法点击操作 ${action}`);
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
  const expectedLabel = configured ? 'API 已配置' : 'API 未配置';
  await waitForJS(window,
    `window.studyApp.loadState().then(state => state.settings.configured === ${Boolean(configured)} && state.tasks.length === ${Number(expectedTasks)})`,
    '状态重新加载完成');
  await waitForJS(window,
    `document.querySelector('#apiDot')?.getAttribute('aria-label') === ${JSON.stringify(expectedLabel)}`,
    '设置门禁状态更新');
  return window;
}

async function captureScreenshot(window, name) {
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 650))))`);
  const filePath = path.join(screenshotDir, name);
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(filePath, screenshot.toPNG());
  console.log(`TEMP_SCREENSHOT ${filePath}`);
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
  }
  await click(window, '#saveProfile', '保存昵称和本机头像');
  await waitForJS(window, '!document.querySelector("#profileDialog")?.open', '昵称和头像保存完成');
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
  assert.equal(blockedCalls.length, 7);
  assert.ok(blockedCalls.every(result => result.rejected), `所有任务 IPC 在 API 未配置时都应拒绝：${JSON.stringify(blockedCalls)}`);
  assert.equal(apiRecords.length, 0, '未配置时不应发出 mock API 请求');

  currentStage = '保存部分配置并保持锁定';
  await click(window, '[data-action="settings"]', '打开 API 设置');
  await waitForJS(window, 'document.querySelector("#settingsDialog")?.open', 'API 设置对话框');
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
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.settings.configured && s.settings.hasKey && s.tasks.length === 1)', '历史计划恢复显示');
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
  window = await reloadWindow(window, true, 1);
  state = await readState(window);
  assert.equal(state.tasks[0].id, originalLegacyTask.id);

  currentStage = '查看旧版历史测验并成功重生 AI 测验';
  await clickAction(window, 'open-plan', originalLegacyTask.id);
  await waitForJS(window, 'document.querySelector(".plan-knowledge-history") && document.querySelector("#appView h1")?.textContent === "旧版 Python 计划"', '旧计划历史详情');
  await clickAction(window, 'open-test', originalLegacyTask.id);
  await waitForJS(window, 'document.querySelector(".result-panel") && document.querySelectorAll(".quiz-question").length === 5', '旧版已提交测验历史');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-rating]").length'), 0);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-answer]").length'), 0);
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("#submitQuiz"))'), false, '旧版历史不能再次自评提交');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".quiz-question textarea[readonly]").length'), 5);
  await window.webContents.executeJavaScript('window.confirm = () => true; true');
  await clickAction(window, 'retake-quiz', originalLegacyTask.id);
  await waitForJS(window, `window.studyApp.loadState().then(s => s.tasks[0]?.quiz?.mode === 'ai')`, '旧版测验成功生成 AI 替代题');
  state = await readState(window);
  assert.equal(state.tasks[0].quiz.mode, 'ai');
  assert.equal(state.tasks[0].quiz.result, undefined, '重生 AI 题目应清除旧版提交结果');
  assert.ok(apiRecords.some(record => record.purpose === '根据源材料生成 5 道主观测验题'));

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
  await setValue(window, '#createForm [name="title"]', 'Python 记账小程序');
  await setValue(window, '#createForm [name="goal"]', '我想学会 Python 基础并完成一个记账小程序。');
  await setValue(window, '#createForm [name="learningMode"]', 'deep');
  await setValue(window, '#createForm [name="days"]', 2);
  await setValue(window, '#createForm [name="minutesPerDay"]', 60);
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
  assert.equal(state.tasks.length, 2);
  const newTask = state.tasks.find(candidate => candidate.title === 'Python 记账小程序');
  assert.ok(newTask);
  assert.equal(newTask.learningMode, 'deep');
  assert.deepEqual(newTask.brief, expectedBrief);
  assert.equal(newTask.plan.mode, 'ai');
  assert.equal(newTask.plan.knowledge.length, 2);
  const planPayload = apiRecords.find(record => record.purpose === '生成学习计划')?.payload;
  assert.equal(planPayload.learningMode, 'deep');
  assert.deepEqual(planPayload.brief, expectedBrief);
  assert.equal(apiRecords.filter(record => record.purpose === '澄清学习需求').length, 2);

  currentStage = '展示知识清单并保存新版知识视图截图';
  await waitForJS(window, 'document.querySelectorAll(".plan-knowledge .knowledge-item").length === 2', '计划详情展示知识清单');
  const knowledgeText = await window.webContents.executeJavaScript('document.querySelector(".plan-knowledge").innerText');
  assert.match(knowledgeText, /变量与数据类型/);
  assert.match(knowledgeText, /重点/);
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
  assert.equal(state.tasks.length, 3);
  assert.equal(apiRecords.filter(record => record.purpose === '澄清学习需求').length, 4);

  currentStage = '生成 AI 测验、往返保存草稿并提交评分';
  await click(window, '[data-nav="plans"]', '打开全部计划');
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "全部计划"', '全部计划列表');
  await clickAction(window, 'open-plan', newTask.id);
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "Python 记账小程序"', '回到带知识清单的计划');
  await clickAction(window, 'open-test', newTask.id);
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ' + JSON.stringify(newTask.id) + ')?.quiz?.mode === "ai")', 'AI 五题测验生成完成');
  state = await readState(window);
  const generatedTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.equal(generatedTask.quiz.questions.length, 5);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#quizForm textarea[data-answer][data-qid]").length'), 5);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-rating]").length'), 0);
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".question-reference-details"))'), false, '参考答案在提交前隐藏');

  const draftText = '变量保存数据，循环可以处理多笔记录。';
  await setValue(window, '#quizForm [data-answer][data-qid="q1"]', draftText);
  await click(window, '[data-nav="overview"]', '离开测验查看概览');
  await waitForJS(window, 'document.querySelector("#appView .welcome-panel")', '学习概览显示');
  await clickAction(window, 'open-plan', newTask.id);
  await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "Python 记账小程序"', '返回新版计划详情');
  await clickAction(window, 'open-test', newTask.id);
  await waitForJS(window, 'document.querySelector("#quizForm")', '返回 AI 测验');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#quizForm [data-qid=q1]").value'), draftText, '离开页面后应保留答题草稿');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-rating]").length'), 0);

  const answerTexts = [
    draftText,
    '字符串表示文本，数字可以用于记账金额计算。',
    '使用循环遍历账目列表并计算总额。',
    '把记录和汇总逻辑拆成函数，便于复用。',
    '输入几笔记录后检查总额，再测试空输入。'
  ];
  for (let index = 0; index < answerTexts.length; index += 1) {
    await setValue(window, `#quizForm [data-answer][data-qid="q${index + 1}"]`, answerTexts[index]);
  }
  await click(window, '#submitQuiz', '提交 AI 测验');
  await waitForJS(window, 'window.studyApp.loadState().then(s => s.tasks.find(t => t.id === ' + JSON.stringify(newTask.id) + ')?.quiz?.result?.mode === "ai")', 'AI 评分已保存');
  state = await readState(window);
  const gradedTask = state.tasks.find(candidate => candidate.id === newTask.id);
  assert.equal(gradedTask.quiz.result.score, 80);
  assert.deepEqual(gradedTask.quiz.answers.q1, { text: draftText });
  assert.equal(JSON.stringify(gradedTask.quiz.answers).includes('rating'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[data-rating]").length'), 0);
  assert.equal(apiRecords.filter(record => record.purpose === '按材料和评分标准评阅学习测验').length, 1);
  const gradePayload = apiRecords.find(record => record.purpose === '按材料和评分标准评阅学习测验')?.payload;
  assert.ok(gradePayload.quiz.every(question => typeof question.answer === 'string'));
  assert.equal(JSON.stringify(gradePayload).includes('rating'), false, '发送给模型的评分输入不得带自评分');

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
    await waitForJS(window, 'window.studyApp.loadState().then(s => s.settings.configured && s.tasks.length === 3)', '第二实例恢复窗口和本地状态');
    state = await readState(window);
    const restoredLegacy = state.tasks.find(candidate => candidate.id === originalLegacyTask.id);
    const restoredNew = state.tasks.find(candidate => candidate.id === newTask.id);
    assert.equal(restoredLegacy.plan.days[0].title, 'Python 变量与数据类型');
    assert.equal(restoredLegacy.plan.days[0].completed, true);
    assert.equal(restoredNew.quiz.result.score, 80);
    await clickAction(window, 'open-plan', originalLegacyTask.id);
    await waitForJS(window, 'document.querySelector("#appView h1")?.textContent === "旧版 Python 计划"', '恢复后的旧计划');
  } else {
    window = await reloadWindow(window, true, 3);
    state = await readState(window);
    assert.equal(state.tasks.find(candidate => candidate.id === originalLegacyTask.id).plan.days[0].title, 'Python 变量与数据类型');
  }

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
  assert.deepEqual(apiRecords.map(record => record.purpose), [
    '连接测试',
    '根据源材料生成 5 道主观测验题',
    '澄清学习需求', '澄清学习需求', '生成学习计划',
    '澄清学习需求', '澄清学习需求', '生成学习计划',
    '根据源材料生成 5 道主观测验题',
    '按材料和评分标准评阅学习测验'
  ]);
  console.log(`PASS desktop API-only flow: old history restored; partial configuration stayed locked; discussion created ${newTask.plan.knowledge.length} knowledge points; AI grade ${gradedTask.quiz.result.score}/100`);
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
      if (!requestedScreenshots || !successfulRun) removeTempDir(screenshotDir);
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
