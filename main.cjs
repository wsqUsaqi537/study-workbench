const { app, BrowserWindow, ipcMain, dialog, safeStorage, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const services = require('./services.cjs');
const assessments = require('./assessment.cjs');

let window;
let state;
let settings;
let profile;
let sessionKey = '';
const appURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
if (process.env.STUDY_APP_DATA_DIR) app.setPath('userData', process.env.STUDY_APP_DATA_DIR);
const file = (name) => path.join(app.getPath('userData'), name);

function readJSON(name, fallback) {
  if (!fs.existsSync(file(name))) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    throw new Error(`${name} 无法读取，请先备份该文件再恢复；应用不会覆盖原有数据。`);
  }
}

function writeJSON(name, value) {
  const content = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(content) > 40 * 1024 * 1024) throw new Error('本地数据超过 40 MB，请导出并删除不再使用的任务。');
  const temp = file(`${name}.tmp`);
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file(name));
}

function validateNickname(value) {
  if (typeof value !== 'string') throw new Error('昵称格式无效。');
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) throw new Error('昵称不能包含控制字符。');
  const nickname = value.trim();
  if ([...nickname].length > 30) throw new Error('昵称最多 30 个字符。');
  return nickname;
}

function validateAvatar(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 400000) throw new Error('头像数据无效或过大。');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) throw new Error('头像必须是有效的 PNG 图片。');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) throw new Error('头像必须是有效的 PNG 图片。');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('头像必须是有效的 PNG 图片。');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 256 || height > 256) throw new Error('头像尺寸必须在 1 到 256 像素之间。');

  let image;
  try {
    image = nativeImage.createFromBuffer(bytes);
  } catch {
    throw new Error('头像图片无法解码。');
  }
  if (image.isEmpty()) throw new Error('头像图片无法解码。');
  const size = image.getSize();
  if (!size.width || !size.height || size.width > 256 || size.height > 256) throw new Error('头像尺寸必须在 1 到 256 像素之间。');
  const canonical = `data:image/png;base64,${image.toPNG().toString('base64')}`;
  if (canonical.length > 400000) throw new Error('头像数据无效或过大。');
  return canonical;
}

function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('本地个人资料格式无效。');
  return {
    nickname: validateNickname(input.nickname === undefined ? '' : input.nickname),
    avatar: validateAvatar(input.avatar === undefined ? '' : input.avatar)
  };
}

function publicSettings() {
  let configured = false;
  try {
    services.endpointUrl(credentials());
    configured = true;
  } catch { /* 未完成配置或无法解密时，只开放设置。 */ }
  return { endpoint: settings.endpoint || '', model: settings.model || '', hasKey: Boolean(settings.encryptedKey || sessionKey), configured };
}

function credentials() {
  let key = sessionKey;
  if (settings.encryptedKey) {
    try {
      key = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
    } catch {
      throw new Error('系统无法解密已保存的 API Key，请在设置中重新填写。');
    }
  }
  return { endpoint: settings.endpoint || '', model: settings.model || '', key };
}

function activeCredentials() {
  try {
    const config = credentials();
    services.endpointUrl(config);
    return config;
  } catch (error) {
    throw new Error(`请先配置有效的 API 地址、模型名称和 API Key。${error.message}`);
  }
}

function validateTask(task) {
  if (!task || typeof task !== 'object') throw new Error('任务数据无效。');
  services.validateInput(task);
  if (typeof task.id !== 'string' || !/^[\w-]{1,80}$/.test(task.id)) throw new Error('任务编号无效。');
  if (!task.plan || !Array.isArray(task.plan.days) || task.plan.days.length !== task.days) throw new Error('计划天数与学习周期不一致。');
  task.plan.days.forEach((day, index) => {
    if (day.day !== index + 1 || !Array.isArray(day.tasks) || !day.tasks.length || day.tasks.length > 20 || day.tasks.some(t => typeof t !== 'string' || t.length > 2000)) throw new Error('每日学习任务格式无效。');
    if (typeof day.title !== 'string' || day.title.length > 300 || !Number.isFinite(day.minutes) || day.minutes < 1 || day.minutes > task.minutesPerDay) throw new Error('每日计划内容或时间无效。');
    if (typeof day.completed !== 'boolean') throw new Error('完成状态无效。');
  });
  assessments.validateAssessmentRecords(task);
  if (JSON.stringify(task).length > 2500000) throw new Error('单个任务数据过大，请减少材料。');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== appURL) throw new Error('请求来源无效。');
    return callback(...args);
  });
}

async function importMaterialPaths(paths) {
  if (!Array.isArray(paths) || paths.length > 10 || paths.some(filePath => typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 4096)) {
    throw new Error('每次最多添加 10 份有效的本机材料。');
  }
  const materials = [];
  for (const filePath of paths) materials.push({ id: randomUUID(), ...await services.parseMaterial(filePath) });
  return materials;
}

function registerHandlers() {
  handle('state:load', () => {
    const visibleSettings = publicSettings();
    return { tasks: visibleSettings.configured ? state.tasks : [], settings: visibleSettings, profile };
  });
  handle('profile:save', (input) => {
    const next = normalizeProfile(input);
    writeJSON('profile.json', next);
    profile = next;
    return profile;
  });
  handle('task:save', (task) => {
    activeCredentials();
    validateTask(task);
    const index = state.tasks.findIndex(t => t.id === task.id);
    const next = [...state.tasks];
    if (index < 0) {
      if (next.length >= 100) throw new Error('最多保存 100 个任务，请先导出并删除旧任务。');
      next.unshift(task);
    } else next[index] = task;
    writeJSON('tasks.json', { tasks: next });
    state = { tasks: next };
    return task;
  });
  handle('task:delete', (id) => {
    activeCredentials();
    const next = state.tasks.filter(t => t.id !== id);
    writeJSON('tasks.json', { tasks: next });
    state = { tasks: next };
    return true;
  });
  handle('materials:import', async () => {
    activeCredentials();
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '添加学习材料', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '学习材料（文字内容）', extensions: ['pdf', 'docx', 'pptx', 'doc', 'ppt'] }]
    });
    if (canceled) return [];
    return importMaterialPaths(filePaths);
  });
  handle('materials:drop', (paths) => { activeCredentials(); return importMaterialPaths(paths); });
  handle('learning:clarify', (payload) => services.clarifyGoal(payload, activeCredentials()));
  handle('plan:generate', (input) => services.generatePlan(input, activeCredentials()));
  handle('assessment:generate', (payload) => {
    const config = activeCredentials();
    validateTask(payload?.task);
    return assessments.generateAssessment(payload.task, payload.selector, config);
  });
  handle('assessment:grade', (payload) => {
    const config = activeCredentials();
    validateTask(payload?.task);
    return assessments.gradeAssessment(payload.task, payload.selector, payload.answers, config);
  });
  handle('plan:adjust', (payload) => {
    const config = activeCredentials();
    validateTask(payload?.task);
    return assessments.proposeAdjustment(payload.task, payload.dayIndex, config);
  });
  handle('quiz:generate', (task) => { const config = activeCredentials(); validateTask(task); return services.generateQuiz(task, config); });
  handle('quiz:grade', (payload) => { const config = activeCredentials(); validateTask(payload?.task); return services.gradeQuiz(payload.task, payload.answers, config); });
  handle('settings:save', (input) => {
    if (!input || typeof input.endpoint !== 'string' || typeof input.model !== 'string' || (input.key !== undefined && typeof input.key !== 'string')) throw new Error('API 配置格式无效。');
    const endpoint = input.endpoint.trim();
    const model = input.model.trim();
    if (endpoint.length > 2000 || model.length > 200 || (input.key || '').length > 4000) throw new Error('API 配置过长。');
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API 必须使用 HTTPS；本机服务可以使用 HTTP。');
    }
    const next = { ...settings, endpoint, model };
    let nextSessionKey = sessionKey;
    if (input.clearKey) { delete next.encryptedKey; nextSessionKey = ''; }
    else if (input.key && input.key.trim()) {
      const key = input.key.trim();
      if (/[\r\n]/.test(key)) throw new Error('API Key 不能包含换行。');
      if (safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text')) {
        next.encryptedKey = safeStorage.encryptString(key).toString('base64');
        nextSessionKey = '';
      } else {
        delete next.encryptedKey;
        nextSessionKey = key;
      }
    }
    writeJSON('settings.json', next);
    settings = next;
    sessionKey = nextSessionKey;
    return { ...publicSettings(), keySessionOnly: Boolean(sessionKey) };
  });
  handle('settings:test', () => services.testConnection(credentials()));
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else if (app.isReady()) createWindow();
});

if (hasInstanceLock) app.whenReady().then(() => {
  try {
    state = readJSON('tasks.json', { tasks: [] });
    settings = readJSON('settings.json', {});
    profile = normalizeProfile(readJSON('profile.json', { nickname: '', avatar: '' }));
    if (!state || !Array.isArray(state.tasks) || !settings || typeof settings !== 'object') throw new Error('本地存储格式无效，请备份后恢复。');
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox('无法打开学习工作台', error.message);
    app.quit();
  }
});

function createWindow() {
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 850, minHeight: 650,
    title: '学习工作台', backgroundColor: '#f5f3ed', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
