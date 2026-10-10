'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const api = window.studyApp;
  const schedule = window.StudySchedule;
  const viewHost = $('#appView');
  const state = {
    tasks: [],
    settings: { endpoint: '', model: '', hasKey: false, configured: false },
    profile: { nickname: '', avatar: '' },
    preferences: { language: window.studyI18n.systemLanguage(navigator.language) }
  };
  const t = window.studyI18n.createTranslator(() => state.preferences.language);
  let currentView = 'overview';
  let selectedTaskId = null;
  let createMaterials = [];
  let createExamDescription = '';
  let createExamMaterials = [];
  let examDraft = null;
  let examDialogSessionId = 0;
  let materialImportBusy = false;
  let activeMaterialImport = null;
  let editingTaskId = null;
  let toastTimer = null;
  let assessmentSelector = { kind: 'final' };
  let proposedAdjustment = null;
  let stateLoaded = false;
  let configEpoch = 0;
  let settingsRequestId = 0;
  let createSessionId = 0;
  let createActivity = null;
  let planProgressUnsubscribe = null;
  let materialProgressUnsubscribe = null;
  let cadenceContext = null;
  let cadenceActivity = null;
  let cadenceSessionId = 0;
  let cadenceApplyBusy = false;
  let discussionMessages = [];
  let discussionBrief = null;
  let confirmedBrief = null;
  let discussionReady = false;
  let profileAvatar = '';
  let profileSession = 0;
  let profileBusy = false;
  let previewedMaterial = null;
  const assessmentGradeRequests = new Set();
  const quizRequests = new Map();
  const quizDrafts = new Map();
  const assessmentBusyKeys = new Set();
  const taskSaveQueues = new Map();
  const sessionConsent = new Set();
  let tutoringContext = null;
  const tutoringRequests = new Set();

  const viewNames = {
    overview: '学习概览', today: '今日安排', plans: '全部计划', 'plan-detail': '计划详情',
    materials: '材料库', quiz: '学习测评'
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sameValue(left, right) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
  }

  function mergeTaskChanges(base, proposed, latest, path = 'task') {
    if (sameValue(base, proposed)) return latest === undefined ? undefined : clone(latest);
    if (Array.isArray(base) && Array.isArray(proposed) && Array.isArray(latest)
      && base.length === proposed.length && proposed.length === latest.length) {
      return proposed.map((item, index) => mergeTaskChanges(base[index], item, latest[index], `${path}[${index}]`));
    }
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (isObject(base) && isObject(proposed)) {
      const merged = isObject(latest) ? clone(latest) : {};
      const keys = new Set([...Object.keys(base), ...Object.keys(proposed)]);
      for (const key of keys) {
        const hasBase = Object.prototype.hasOwnProperty.call(base, key);
        const hasProposed = Object.prototype.hasOwnProperty.call(proposed, key);
        const hasLatest = isObject(latest) && Object.prototype.hasOwnProperty.call(latest, key);
        if (!hasProposed) {
          if (hasBase) delete merged[key];
          continue;
        }
        if (!hasBase) {
          if (hasLatest && !sameValue(latest[key], proposed[key])) {
            if (isObject(proposed[key]) && isObject(latest[key])) {
              merged[key] = mergeTaskChanges({}, proposed[key], latest[key], `${path}.${key}`);
            } else throw new Error(t("这份计划已被同时修改，本次保存已取消，请重新操作。"));
          } else merged[key] = clone(proposed[key]);
          continue;
        }
        merged[key] = mergeTaskChanges(base[key], proposed[key], hasLatest ? latest[key] : undefined, `${path}.${key}`);
      }
      return merged;
    }
    if (!sameValue(latest, base) && !sameValue(latest, proposed)) {
      throw new Error(t("这份计划已被同时修改，本次保存已取消，请重新操作。"));
    }
    return proposed === undefined ? undefined : clone(proposed);
  }

  async function withTaskSaveLock(taskId, operation) {
    const previous = taskSaveQueues.get(taskId);
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    taskSaveQueues.set(taskId, lock);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskSaveQueues.get(taskId) === lock) taskSaveQueues.delete(taskId);
    }
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dateObject(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDate(value, options = {}) {
    const date = dateObject(value);
    return date ? new Intl.DateTimeFormat(state.preferences.language, options).format(date) : t("日期待定");
  }

  function formatToday() {
    return new Intl.DateTimeFormat(state.preferences.language, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  }

  function todayLabel() {
    return new Intl.DateTimeFormat(state.preferences.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  }

  function greet() {
    const hour = new Date().getHours();
    if (state.profile.nickname) return t`${state.profile.nickname}，${hour < 11 ? t("早上好") : hour < 18 ? t("下午好") : t("晚上好")}！`;
    if (hour < 11) return t("早上好，今天从一小步开始");
    if (hour < 18) return t("下午好，给专注留一点空间");
    return t("晚上好，慢慢收好今天的进度");
  }

  function applyStaticTranslations() {
    const language = state.preferences.language;
    document.documentElement.lang = language;
    document.title = t('学习工作台');
    $$('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
    $$('[data-i18n-title]').forEach(element => { element.title = t(element.dataset.i18nTitle); });
    $$('[data-i18n-aria-label]').forEach(element => { element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel)); });
  }

  function displayPriority(value) {
    return value === '重点' || value === '了解' ? t(value) : value;
  }

  function displayDifficulty(value) {
    return ['入门', '进阶', '较难'].includes(value) ? t(value) : value;
  }

  function displaySource(value) {
    if (value === '主题与学习目标') return t(value);
    return value;
  }

  function getTask(id) {
    return state.tasks.find(task => task.id === id);
  }

  function taskMaterials(task) {
    return Array.isArray(task?.materials) ? task.materials : [];
  }

  function materialReadingWarnings(material) {
    return Array.isArray(material?.readingWarnings)
      ? material.readingWarnings.filter(item => typeof item === 'string' && item.trim()).slice(0, 10)
      : [];
  }

  function materialReadingSummaryHTML(material) {
    const warnings = materialReadingWarnings(material);
    if (!warnings.length) return '';
    const translated = warnings.map(warning => t(warning));
    const summary = translated[0];
    const title = translated.join(state.preferences.language === 'en' ? ' · ' : '；');
    return `<small class="material-reading-summary" title="${escapeHTML(title)}"><strong>${t("阅读提示")} · </strong>${escapeHTML(summary)}${warnings.length > 1 ? ` ${t`另有 ${warnings.length - 1} 条`}` : ''}</small>`;
  }

  function planWarningSections(plan) {
    const warnings = Array.isArray(plan?.warnings) ? plan.warnings.filter(item => typeof item === 'string' && item.trim()) : [];
    if (Array.isArray(plan?.studyNotes)) {
      return {
        warnings,
        studyNotes: plan.studyNotes.filter(item => typeof item === 'string' && item.trim())
      };
    }
    const generationWarnings = [];
    const studyNotes = [];
    const studyPattern = /知识点|考点|概念|重点|难点|易错|易混|混淆|辨析|区分|条件|公式|原理|定义|性质|定理|前提|不代表|提醒|definition|property|theorem|assumption|does not imply|prerequisite|concept|key point|difficult|common mistake|confus|distinguish|condition|formula|principle/i;
    const generationPattern = /材料|附件|文件|大纲|考纲|缺少|缺乏|不足|截断|上限|范围|日历|安排|进度|时间|解析|识别|扫描|质量|解析失败|material|attachment|file|outline|syllabus|missing|shortened|truncat|limit|calendar|schedule|scope|parse|scan|quality/i;
    warnings.forEach(item => {
      if (studyPattern.test(item) && !generationPattern.test(item)) studyNotes.push(item);
      else generationWarnings.push(item);
    });
    return { warnings: generationWarnings, studyNotes };
  }

  function examSummaryMarkup(task) {
    const exam = task?.exam;
    if (!exam || typeof exam !== 'object') return '';
    const description = typeof exam.description === 'string' ? exam.description.trim() : '';
    const ids = Array.isArray(exam.materialIds) ? new Set(exam.materialIds) : new Set();
    const names = taskMaterials(task).filter(material => ids.has(material.id)).map(material => material.name || t("未命名材料"));
    if (!description && !names.length) return '';
    const excerpt = description.length > 180 ? `${description.slice(0, 180).trimEnd()}…` : description;
    return `<div class="plan-exam-summary"><strong>${t("考试大纲")}</strong>${excerpt ? `<p>${escapeHTML(excerpt)}</p>` : ''}${names.length ? `<small>${t("大纲文件：")}${names.map(escapeHTML).join(state.preferences.language === 'en' ? ', ' : '、')}</small>` : ''}</div>`;
  }

  function hasMaterialText(task) {
    return taskMaterials(task).some(material => typeof material?.text === 'string' && material.text.trim().length > 0);
  }

  function apiEnabled() {
    return Boolean(state.settings?.configured);
  }

  function needsMaterialConsent(task) {
    return apiEnabled() && hasMaterialText(task);
  }

  function countDays(task) {
    return Array.isArray(task?.plan?.days) ? task.plan.days : [];
  }

  function selectedCadence(form) {
    return {
      mode: form.elements.cadenceMode?.value || 'daily',
      weekdays: $$('[name="cadenceWeekday"]:checked', form).map(input => Number(input.value))
    };
  }

  function cadenceLabel(value) {
    let cadence;
    try { cadence = schedule.normalizeCadence(value); } catch { cadence = { mode: 'daily', weekdays: [] }; }
    if (cadence.mode === 'alternate') return t("隔日");
    if (cadence.mode !== 'weekly') return t("每天");
    const labels = { 0: '星期日', 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六' };
    return `${t("每周")} ${cadence.weekdays.map(day => t(labels[day])).join(state.preferences.language === 'en' ? ', ' : '、')}`;
  }

  function cadenceSnapshot(task) {
    return JSON.stringify(task);
  }

  function beginDelayedLoading(activity, isCurrent, update) {
    activity.showLoading = false;
    activity.loadingTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      activity.showLoading = true;
      update();
    }, 10000);
  }

  function clearDelayedLoading(activity) {
    if (activity?.loadingTimer === undefined || activity.loadingTimer === null) return;
    window.clearTimeout(activity.loadingTimer);
    activity.loadingTimer = null;
  }

  function assessmentKey(taskId, selector) {
    return `${taskId}:${selector.kind}:${selector.kind === 'daily' ? selector.dayIndex : ''}`;
  }

  function assessmentFor(task, selector) {
    return selector.kind === 'daily'
      ? task?.dailyQuizzes?.[String(selector.dayIndex)]
      : task?.quiz;
  }

  function assessmentTaskContext(task) {
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      brief: task.brief,
      learningMode: task.learningMode,
      level: task.level,
      days: task.days,
      minutesPerDay: task.minutesPerDay,
      plan: task.plan,
      materials: task.materials || []
    };
  }

  function assessmentGenerationSnapshot(task, selector) {
    return JSON.stringify({ context: assessmentTaskContext(task), quiz: assessmentFor(task, selector) || null, chats: tutorCacheSnapshot(task, selector.kind === 'daily' ? [selector.dayIndex] : [], selector.kind === 'final', false) });
  }

  function assessmentGradeSnapshot(task, selector) {
    const history = Object.entries(task.dailyQuizzes || {})
      .filter(([dayIndex, quiz]) => quiz?.result && (selector.kind === 'final' || Number(dayIndex) < selector.dayIndex))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([dayIndex, quiz]) => [dayIndex, quiz.result]);
    return JSON.stringify({ context: assessmentTaskContext(task), quiz: assessmentFor(task, selector) || null, history });
  }

  function adjustmentInputSnapshot(task, dayIndex) {
    const selector = { kind: 'daily', dayIndex };
    return JSON.stringify({ context: assessmentTaskContext(task), quiz: assessmentFor(task, selector) || null });
  }

  function adjustmentAssessmentSnapshot(task, dayIndices) {
    return JSON.stringify({
      final: task.quiz || null,
      daily: dayIndices.map(dayIndex => [dayIndex, task.dailyQuizzes?.[String(dayIndex)] || null])
    });
  }

  function selectorFromForm(form) {
    return form.dataset.kind === 'daily'
      ? { kind: 'daily', dayIndex: Number(form.dataset.dayIndex) }
      : { kind: 'final' };
  }

  function assessmentDraftKey(task, selector) {
    const quiz = assessmentFor(task, selector);
    const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
    return `${assessmentKey(task?.id || '', selector)}:${JSON.stringify(questions.map(question => [question.id, question.question]))}`;
  }

  function saveQuizDraft(field) {
    const form = field.closest('#quizForm');
    if (!form || !field.dataset.qid) return;
    const task = getTask(form.dataset.taskId);
    if (!task) return;
    const selector = selectorFromForm(form);
    const quiz = assessmentFor(task, selector);
    if (!quiz?.questions || quiz.result || (field.type === 'radio' && !field.checked)) return;
    const key = assessmentDraftKey(task, selector);
    const drafts = quizDrafts.get(key) || {};
    const answer = { ...(drafts[field.dataset.qid] || {}) };
    if (field.matches('[data-answer]')) answer.text = field.value;
    quizDrafts.set(key, { ...drafts, [field.dataset.qid]: answer });
  }

  function allDays() {
    return state.tasks.flatMap(task => countDays(task).map((day, index) => ({ task, day, index })));
  }

  function todayEntries() {
    const today = localDateString();
    return allDays().filter(entry => entry.day.date === today);
  }

  function stats() {
    const days = allDays();
    const completed = days.filter(entry => entry.day.completed).length;
    const minutes = days.reduce((sum, entry) => sum + (Number(entry.day.minutes) || 0), 0);
    return { plans: state.tasks.length, days: days.length, completed, minutes, rate: days.length ? Math.round(completed / days.length * 100) : 0 };
  }

  function setMessage(element, message, type = 'error') {
    if (!element) return;
    const messageKey = findMessageKey(message);
    if (messageKey) element.dataset.messageKey = messageKey;
    else delete element.dataset.messageKey;
    element.textContent = message;
    element.className = `form-message ${type === 'error' ? 'error-message' : type === 'warning' ? 'warning-message' : ''}`;
    element.hidden = !message;
  }

  function toast(message) {
    const element = $('#toast');
    const messageKey = findMessageKey(message);
    if (messageKey) element.dataset.messageKey = messageKey;
    else delete element.dataset.messageKey;
    element.textContent = message;
    element.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 2800);
  }

  function findMessageKey(message) {
    if (typeof message !== 'string' || !message) return null;
    const catalog = window.studyUIMessages || {};
    if (Object.prototype.hasOwnProperty.call(catalog, message)) return message;
    return Object.keys(catalog).find(key => catalog[key] === message) || null;
  }

  function refreshVisibleMessages() {
    $$('[data-message-key]').forEach(element => { element.textContent = t(element.dataset.messageKey); });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
    if (busy && label) {
      if (!button.hasAttribute('data-resting-label')) button.dataset.restingLabel = button.getAttribute('aria-label') || '';
      button.setAttribute('aria-label', label);
    } else if (!busy && button.hasAttribute('data-resting-label')) {
      const restingLabel = button.dataset.restingLabel;
      if (restingLabel) button.setAttribute('aria-label', restingLabel);
      else button.removeAttribute('aria-label');
      delete button.dataset.restingLabel;
    }
  }

  function updateHeader() {
    renderAvatar($('#profileButton'), state.profile.avatar);
    $('#headerDate').textContent = formatToday();
    const today = todayEntries();
    const done = today.filter(entry => entry.day.completed).length;
    const status = $('#headerStatus');
    if (!apiEnabled()) status.innerHTML = `<span class="status-pulse"></span><span>${t("先配置模型服务")}</span>`;
    else if (today.length) status.innerHTML = `<span class="status-pulse"></span><span>${escapeHTML(t`今日完成 ${done} / ${today.length} 项`)}</span>`;
    else status.innerHTML = `<span class="status-pulse"></span><span>${state.tasks.length ? t("今日暂无安排") : t("等待第一份计划")}</span>`;
    $('#todayBadge').textContent = String(today.length);
    $('#taskCount').textContent = String(state.tasks.length);
    const dot = $('#apiDot');
    dot.classList.toggle('is-ready', apiEnabled());
    dot.setAttribute('aria-label', apiEnabled() ? t("API 已配置") : t("API 未配置"));
    dot.title = apiEnabled() ? t("模型服务已配置") : t("未配置模型服务");
    $('#crumbCurrent').textContent = currentView === 'quiz'
      ? (assessmentSelector.kind === 'daily' ? t("每日小测 / 日报") : t("期末测验 / 周期报告"))
      : t(viewNames[currentView] || '学习概览');
  }

  function renderSidebar() {
    const host = $('#sidebarTasks');
    if (!apiEnabled()) {
      host.innerHTML = `<div class="side-empty">${t("配置模型服务后显示本地计划")}</div>`;
      return;
    }
    if (!state.tasks.length) {
      host.innerHTML = `<div class="side-empty">${t("还没有学习计划")}</div>`;
      return;
    }
    host.innerHTML = state.tasks.map(task => {
      const days = countDays(task);
      const done = days.filter(day => day.completed).length;
      return `<button type="button" class="sidebar-task ${selectedTaskId === task.id ? 'is-selected' : ''}" data-action="open-plan" data-task-id="${escapeHTML(task.id)}" title="${escapeHTML(task.title)}"><span class="task-seed" aria-hidden="true"></span><span class="sidebar-task-title">${escapeHTML(task.title)}</span><span class="sidebar-task-count">${done}/${days.length}</span></button>`;
    }).join('');
  }

  function setNavigation() {
    const activeNav = currentView === 'plan-detail' || currentView === 'quiz' ? 'plans' : currentView;
    $$('[data-nav]').forEach(button => button.classList.toggle('is-active', button.dataset.nav === activeNav));
  }

  function emptyState() {
    return `<section class="empty-state" aria-labelledby="emptyTitle">
      <div class="empty-state-copy">
        <span class="eyebrow">${t("从一张白纸开始")}</span>
        <h2 id="emptyTitle">${t("你的学习桌，已经准备好了。")}</h2>
        <p>${t("写下一个想学会的主题和目标，把计划交给每天的自己，从今天的一小步开始。")}</p>
        <div class="empty-actions"><button class="button button-primary" type="button" data-action="new-task">${t("＋ 创建第一份计划")}</button></div>
      </div>
      <div class="empty-illustration" aria-hidden="true"><span class="empty-spark one">✳</span><span class="empty-spark two">✦</span><div class="empty-page"><i class="empty-sprout"></i></div></div>
    </section>`;
  }

  function focusPanel(entries) {
    const content = entries.length ? `<div class="focus-date"><strong>${escapeHTML(todayLabel())}</strong><span>${t("把注意力放在眼前这一件事")}</span></div><div class="focus-items">${entries.slice(0, 4).map(({ task, day, index }) => {
      const itemText = Array.isArray(day.tasks) && day.tasks.length ? day.tasks.slice(0, 2).join(' · ') : t("按自己的节奏开始学习");
      return `<article class="focus-item ${day.completed ? 'is-done' : ''}"><button class="focus-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? t("标记为未完成") : t("标记为已完成")}${escapeHTML(t("："))}${escapeHTML(day.title)}" aria-pressed="${Boolean(day.completed)}">✓</button><div class="focus-item-copy"><strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(task.title)} · ${escapeHTML(itemText)}</small></div><span class="focus-minutes">${Number(day.minutes) || 0} ${t("分钟")}</span></article>`;
    }).join('')}</div>${entries.length > 4 ? `<button class="text-link" type="button" data-nav="today">${t("还有")} ${entries.length - 4} ${t("项，查看今日安排 →")}</button>` : ''}` : `<div class="empty-inline"><span class="empty-inline-mark" aria-hidden="true">↗</span><div class="empty-inline-copy"><strong>${t("今天还没有安排学习任务")}</strong><p>${state.tasks.length ? t("打开一份计划，看看接下来几天的安排。") : t("先创建一份计划，今天的重点会出现在这里。")}</p></div>${state.tasks.length ? `<button class="button button-small button-outline" type="button" data-nav="plans">${t("查看计划")}</button>` : `<button class="button button-small button-outline" type="button" data-action="new-task">${t("创建计划")}</button>`}</div>`;
    return `<section class="panel focus-panel"><div class="panel-heading"><div><span class="panel-kicker">${t("TODAY / 今日重点")}</span><h2>${t("今天要做的事")}</h2><p>${t("每天一小步，逐渐走近目标。")}</p></div><button class="text-link" type="button" data-nav="today">${t("完整安排 →")}</button></div><div class="focus-content">${content}</div></section>`;
  }

  function statsPanel() {
    const value = stats();
    const hours = value.minutes / 60;
    const hourText = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, '');
    return `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">A LITTLE, EVERY DAY</span><h2>${t("学习的痕迹")}</h2><p>${t("只统计已保存的真实计划与完成状态。")}</p></div></div><div class="stats-grid"><div class="stat-card"><div class="stat-card-top"><span>${t("学习计划")}</span><span class="stat-card-icon">▤</span></div><strong class="stat-value">${value.plans}<span class="stat-unit">${t("份")}</span></strong></div><div class="stat-card"><div class="stat-card-top"><span>${t("已完成天数")}</span><span class="stat-card-icon">✓</span></div><strong class="stat-value">${value.completed}<span class="stat-unit"> / ${value.days} ${t("天")}</span></strong></div><div class="stat-card"><div class="stat-card-top"><span>${t("计划投入")}</span><span class="stat-card-icon">◷</span></div><strong class="stat-value">${hourText}<span class="stat-unit">${t("小时")}</span></strong></div></div></section>`;
  }

  function schedulePanel() {
    const today = localDateString();
    const upcoming = allDays().filter(entry => entry.day.date >= today).sort((a, b) => String(a.day.date).localeCompare(String(b.day.date))).slice(0, 5);
    let content;
    if (!upcoming.length) {
      content = `<p class="schedule-empty">${state.tasks.length ? t("已有计划都已结束。可以重新测试，或创建新的学习计划。") : t("创建计划后，未来的学习安排会沿着时间线展开。")}</p>`;
    } else {
      const grouped = new Map();
      upcoming.forEach(entry => {
        const key = entry.day.date || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
      });
      content = Array.from(grouped.entries()).map(([date, entries]) => `<div class="schedule-day ${date === today ? 'is-today' : ''}"><div class="schedule-day-date">${date === today ? t("今天") : escapeHTML(formatDate(date, { month: 'numeric' }))}<strong>${escapeHTML(formatDate(date, { day: 'numeric' }))}</strong></div><div class="schedule-line">${entries.map(({ task, day }) => `<strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(task.title)} · ${Number(day.minutes) || 0} ${t("分钟 ·")} ${day.completed ? t("已完成") : t("待完成")}</small>`).join('')}</div></div>`).join('');
    }
    return `<section class="panel schedule-panel"><div class="panel-heading"><div><span class="panel-kicker">THE DAYS AHEAD</span><h2>${t("接下来")}</h2><p>${t("从今天起最近的学习安排。")}</p></div><button class="text-link" type="button" data-nav="plans">${t("所有计划 →")}</button></div><div class="schedule-list">${content}</div></section>`;
  }

  function renderOverview() {
    const empty = state.tasks.length === 0;
    const welcome = `<section class="welcome-panel ${empty ? 'is-empty' : ''}"><div class="welcome-copy"><span class="eyebrow">A QUIET PLACE TO LEARN</span><h2>${escapeHTML(greet())}</h2><p>${empty ? t("让目标落在纸上，让每天的行动变得清晰。") : t("不需要一次走很远，只要记得回来，继续下一步。")}</p></div><div class="welcome-deco" aria-hidden="true"><div class="sun-disc"></div><div class="leaf-shape"></div><span>${t("慢慢来")}</span></div></section>`;
    if (empty) return `${welcome}${emptyState()}`;
    return `${welcome}<div class="dashboard-grid"><div class="column-stack">${focusPanel(todayEntries())}${statsPanel()}</div><div class="column-stack">${schedulePanel()}<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">YOUR STUDY PLANS</span><h2>${t("继续学习")}</h2><p>${t("从保存的计划中选择下一步。")}</p></div><button class="text-link" type="button" data-nav="plans">${t("查看全部 →")}</button></div><div class="material-list">${state.tasks.slice(0, 3).map(task => `<article class="material-card"><span class="file-mark" aria-hidden="true">${t("学")}</span><div class="material-card-copy"><strong>${escapeHTML(task.title)}</strong><small>${countDays(task).filter(day => day.completed).length} / ${countDays(task).length} ${t("天已完成")}</small></div><div class="material-card-actions"><button class="button button-small button-outline" type="button" data-action="open-plan" data-task-id="${escapeHTML(task.id)}">${t("打开计划")}</button></div></article>`).join('')}</div></section></div></div>`;
  }

  function renderToday() {
    const entries = todayEntries();
    const header = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">TODAY / ${escapeHTML(localDateString())}</span><h1>${t("今日安排")}</h1><p>${escapeHTML(todayLabel())}${t("。把注意力放在当前这一步。")}</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-nav="plans">${t("查看全部计划")}</button><button class="button button-primary" type="button" data-action="new-task">${t("＋ 新建计划")}</button></div></div>`;
    if (!state.tasks.length) return `${header}${emptyState()}`;
    const todayList = entries.length ? `<div class="plan-list">${entries.map(({ task, day, index }) => {
      const dailyQuiz = assessmentFor(task, { kind: 'daily', dayIndex: index });
      const dailyLabel = dailyQuiz?.result ? t("查看日报") : dailyQuiz?.questions?.length ? t("继续每日小测") : t("每日小测");
      return `<article class="plan-card"><div class="plan-card-head"><div class="plan-card-title"><h3>${escapeHTML(day.title)}</h3><p>${escapeHTML(task.title)} · ${Number(day.minutes) || 0} ${t("分钟")}</p></div><div class="plan-card-actions"><button class="button button-small button-outline" type="button" data-action="edit-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}">${t("编辑今日内容")}</button></div></div><div class="plan-days"><div class="plan-day-row is-today"><div class="plan-day-date"><strong>${escapeHTML(formatDate(day.date, { month: 'numeric', day: 'numeric' }))}</strong>${escapeHTML(t`第 ${Number(day.day) || index + 1} 天`)}</div><div class="plan-day-info"><strong>${escapeHTML(task.title)}</strong><small>${escapeHTML((day.tasks || []).join(' · '))}</small></div><div class="plan-day-right"><span class="plan-source">${escapeHTML(displaySource(day.source) || t("计划安排"))}</span><button class="tiny-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? t("标记为未完成") : t("标记为已完成")}" aria-pressed="${Boolean(day.completed)}">✓</button><button class="button button-small button-outline" type="button" data-action="open-lesson" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}">${t("学习讲解")}</button><button class="button button-small button-outline day-assessment-action" type="button" data-action="open-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="daily" data-day-index="${index}">${dailyLabel}</button></div></div></div></article>`;
    }).join('')}</div>` : `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">${t("TODAY / 留白")}</span><h2>${t("今天没有安排好的学习任务")}</h2><p>${t("已保存的计划还在这里，可以查看接下来的日程。")}</p></div></div><div class="focus-content"><div class="empty-inline"><span class="empty-inline-mark" aria-hidden="true">✳</span><div class="empty-inline-copy"><strong>${t("空出来的时间也可以好好休息")}</strong><p>${t("或者给下一个目标安排一个开始日期。")}</p></div><button class="button button-small button-outline" type="button" data-action="new-task">${t("创建计划")}</button></div></div></section>`;
    return `${header}${todayList}${entries.length ? `<div class="page-head section-head-spaced"><div class="page-head-copy"><span class="eyebrow">NEXT STEPS</span><h2 class="section-page-title">${t("接下来几天")}</h2><p>${t("提前看看，不必一次完成所有事情。")}</p></div></div>` + renderUpcomingRows() : ''}`;
  }

  function renderUpcomingRows() {
    const today = localDateString();
    const upcoming = allDays().filter(entry => entry.day.date > today).sort((a, b) => String(a.day.date).localeCompare(String(b.day.date))).slice(0, 5);
    if (!upcoming.length) return '';
    return `<section class="panel"><div class="plan-days">${upcoming.map(({ task, day, index }) => dayRow(task, day, index, false)).join('')}</div></section>`;
  }

  function dayRow(task, day, index, editable = true) {
    const isToday = day.date === localDateString();
    const dayTasks = Array.isArray(day.tasks) ? day.tasks : [];
    const tasksPreview = (editable ? dayTasks : dayTasks.slice(0, 3)).join(' · ');
    const quiz = assessmentFor(task, { kind: 'daily', dayIndex: index });
    return `<div class="plan-day-row ${isToday ? 'is-today' : ''}"><div class="plan-day-date"><strong>${escapeHTML(formatDate(day.date, { month: 'numeric', day: 'numeric' }))}</strong>${escapeHTML(t`第 ${Number(day.day) || index + 1} 天`)}</div><div class="plan-day-info"><strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(tasksPreview)}</small></div><div class="plan-day-right"><span class="plan-source">${escapeHTML(displaySource(day.source) || t("计划安排"))}</span><button class="tiny-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? t("标记为未完成") : t("标记为已完成")}${escapeHTML(t("："))}${escapeHTML(day.title)}" aria-pressed="${Boolean(day.completed)}">✓</button><button class="button button-small button-outline" type="button" data-action="open-lesson" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}">${t("学习讲解")}</button><button class="button button-small button-outline day-assessment-action" type="button" data-action="open-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="daily" data-day-index="${index}">${quiz?.result ? t("查看日报") : quiz?.questions?.length ? t("继续每日小测") : t("每日小测")}</button>${editable ? `<button class="row-edit" type="button" data-action="edit-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${escapeHTML(t("编辑"))} ${escapeHTML(day.title)}" title="${escapeHTML(t("编辑这一天"))}">✎</button>` : ''}</div></div>`;
  }

  function planCard(task, expanded = true) {
    const days = countDays(task);
    const completed = days.filter(day => day.completed).length;
    const calendarDays = Number(task.calendarDays) || Number(task.days) || days.length;
    const summary = task.plan?.summary || task.goal || '';
    const mode = task.plan?.mode === 'ai' ? 'ai' : 'history';
    const modeLabel = task.plan?.mode === 'ai' ? t("AI 计划") : t("历史计划");
    const { warnings, studyNotes } = planWarningSections(task.plan);
    const knowledge = Array.isArray(task.plan?.knowledge) && task.plan.knowledge.length
      ? `<section class="plan-knowledge" aria-label="${escapeHTML(t("知识清单"))}"><div class="knowledge-heading"><span class="panel-kicker">${t("KNOWLEDGE / 知识清单")}</span><strong>${task.plan.knowledge.length} ${t("个知识点")}</strong></div><div class="knowledge-list">${task.plan.knowledge.map(item => `<article class="knowledge-item"><div class="knowledge-item-heading"><strong>${escapeHTML(item.title || t("未命名知识点"))}</strong><span class="knowledge-priority ${item.priority === '重点' ? 'is-focus' : ''}">${escapeHTML(displayPriority(item.priority) || t("了解"))}</span></div><p>${escapeHTML(item.explanation || '')}</p>${item.source ? `<small>${t("来源：")}${escapeHTML(displaySource(item.source))}</small>` : ''}</article>`).join('')}</div></section>`
      : `<section class="plan-knowledge plan-knowledge-history"><span class="panel-kicker">${t("KNOWLEDGE / 知识清单")}</span><p>${t("这份旧计划没有单独保存知识清单，原有学习日程仍可查看。")}</p></section>`;
    const body = expanded ? `${knowledge}<div class="plan-days">${days.map((day, index) => dayRow(task, day, index)).join('')}</div>` : '';
    const warningMarkup = warnings.length ? `<div class="plan-warnings" role="note"><strong>${t("生成提示")}</strong><ul>${warnings.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : '';
    const studyNotesMarkup = studyNotes.length ? `<div class="plan-study-notes" role="note"><strong>${t("重点、难点与易错点")}</strong><ul>${studyNotes.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : '';
    const examMarkup = examSummaryMarkup(task);
    const finalLabel = task.quiz?.result ? t("查看周期报告") : task.quiz?.version === 2 && task.quiz?.questions?.length ? t("继续期末测验") : task.quiz && task.quiz.mode === 'ai' && !task.quiz.version ? t("继续旧版测验") : t("生成10题期末测验");
    const finalRetake = Boolean(task.quiz && task.quiz.mode !== 'ai' && !task.quiz.result);
    const finalHistory = Array.isArray(task.finalQuizHistory) ? task.finalQuizHistory.filter(quiz => quiz?.result) : [];
    const historyAction = finalHistory.length ? `<button class="button button-small button-outline" type="button" data-action="view-final-history" data-task-id="${escapeHTML(task.id)}">${t("历史周期报告")} · ${finalHistory.length}</button>` : '';
    return `<article class="plan-card"><div class="plan-card-head"><div class="plan-card-title"><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(summary)} · ${calendarDays} ${t("个日历日")} · ${days.length} ${t("次学习")} · ${escapeHTML(cadenceLabel(task.cadence))} · ${escapeHTML(t`已完成 ${completed} / ${days.length} 次`)} · ${t("开始于")} ${escapeHTML(formatDate(task.startDate, { year: 'numeric', month: 'numeric', day: 'numeric' }))} <span class="mode-badge ${mode}">${modeLabel}</span></p></div><div class="plan-card-actions"><button class="button button-small button-outline" type="button" data-action="edit-cadence" data-task-id="${escapeHTML(task.id)}">${t("调整学习频率")}</button>${historyAction}<button class="button button-small button-outline" type="button" data-action="open-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="final" ${finalRetake ? 'data-retake="true"' : ''}>${finalLabel}</button><button class="button button-small button-outline" type="button" data-action="export-task" data-task-id="${escapeHTML(task.id)}">${t("导出 JSON")}</button><button class="button button-small button-quiet" type="button" data-action="delete-task" data-task-id="${escapeHTML(task.id)}">${t("删除")}</button></div></div>${examMarkup}${studyNotesMarkup}${warningMarkup}${body}</article>`;
  }

  function summaryRow() {
    const value = stats();
    const rate = value.days ? `${value.rate}%` : '—';
    return `<div class="plan-summary-row"><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">▤</span><div><strong>${value.plans}</strong><small>${t("份学习计划")}</small></div></div><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">✓</span><div><strong>${value.completed}<small> / ${value.days}</small></strong><small>${t("天已完成 ·")} ${rate}</small></div></div><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">◷</span><div><strong>${(value.minutes / 60).toFixed(1).replace(/\.0$/, '')}<small> ${t("小时")}</small></strong><small>${t("计划投入时长")}</small></div></div></div>`;
  }

  function renderPlans(onlySelected = false) {
    const selected = onlySelected ? getTask(selectedTaskId) : null;
    const tasks = selected ? [selected] : onlySelected ? [] : state.tasks;
    const title = selected ? selected.title : t("全部计划");
    const description = selected ? (selected.goal || selected.plan?.summary || t("每天的安排可以按你的节奏调整。")) : t("查看每天的内容、来源和完成情况。");
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">YOUR LEARNING MAP</span><h1>${escapeHTML(title)}</h1><p>${escapeHTML(description)}</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-nav="materials">${t("材料库")}</button><button class="button button-primary" type="button" data-action="new-task">${t("＋ 新建计划")}</button></div></div>`;
    if (!state.tasks.length) return `${head}${emptyState()}`;
    if (onlySelected && !selected) return renderPlans(false);
    return `${head}${summaryRow()}<div class="plan-list">${tasks.map(task => planCard(task, true)).join('')}</div>`;
  }

  function collectMaterials() {
    const materials = new Map();
    state.tasks.forEach(task => taskMaterials(task).forEach(material => {
      const key = material.id || `${material.name || '材料'}:${material.chars || ''}`;
      if (!materials.has(key)) materials.set(key, { ...material, attachedTo: [] });
      const item = materials.get(key);
      if (!item.attachedTo.some(title => title === task.title)) item.attachedTo.push(task.title);
    }));
    return Array.from(materials.entries()).map(([id, material]) => ({ ...material, id }));
  }

  function renderMaterials() {
    const materials = collectMaterials();
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">YOUR READING DESK</span><h1>${t("材料库")}</h1><p>${t("查看随学习计划保存的文字材料。内容仅在本机保存，发送给模型前会再次征求同意。")}</p></div><div class="page-head-actions"><button class="button button-primary" type="button" data-action="new-task">${t("＋ 添加材料")}</button></div></div>`;
    if (!materials.length) return `${head}<section class="empty-state"><div class="empty-state-copy"><span class="eyebrow">NO MATERIALS YET</span><h2>${t("材料会跟着计划，一起留在这里。")}</h2><p>${t("创建学习计划时，可以从本机选择 PDF、DOCX、PPTX、MD 或 TEX 文件，之后随时预览文字内容。")}</p><div class="empty-actions"><button class="button button-primary" type="button" data-action="new-task">${t("创建计划并添加材料")}</button></div></div><div class="empty-illustration" aria-hidden="true"><span class="empty-spark one">✳</span><span class="empty-spark two">✦</span><div class="empty-page"><i class="empty-sprout"></i></div></div></section>`;
    return `${head}<div class="materials-grid"><section class="panel"><div class="panel-heading"><div><span class="panel-kicker">SAVED TEXTS</span><h2>${t("已导入的材料")}</h2><p>${materials.length} ${t("份文件 · 来自已保存的计划")}</p></div></div><div class="material-list">${materials.map(material => {
      const ext = String(material.name || '').split('.').pop().slice(0, 4).toUpperCase();
      return `<article class="material-card"><span class="file-mark" aria-hidden="true">${escapeHTML(ext || t("文档"))}</span><div class="material-card-copy"><strong>${escapeHTML(material.name || t("未命名材料"))}</strong><small>${Number(material.units) || 0} ${t("个章节 ·")} ${Number(material.chars) || 0} ${t("字 ·")} ${escapeHTML(material.attachedTo.join(state.preferences.language === 'en' ? ', ' : '、'))}</small>${materialReadingSummaryHTML(material)}</div><div class="material-card-actions"><button class="button button-small button-outline" type="button" data-action="preview-library-material" data-material-id="${escapeHTML(material.id)}">${t("预览文字")}</button></div></article>`;
    }).join('')}</div></section><aside class="panel source-card"><span class="panel-kicker">ON YOUR DEVICE</span><h3>${t("一页一页，慢慢读。")}</h3><p>${t("导入的材料会附在对应的学习计划中。只有你勾选同意后，已配置的模型服务才会收到本次计划或测验使用的材料文字。")}</p><div class="source-card-ornament" aria-hidden="true">${t("页 · 章 · 节")}</div></aside></div>`;
  }

  function weakPointsText(value) {
    if (Array.isArray(value)) return value.map(item => String(item)).join(state.preferences.language === 'en' ? ', ' : '、');
    return String(value || t("目前没有记录需要重点补充的内容。"));
  }

  function renderResult(quiz) {
    if (!quiz?.result) return '';
    const result = quiz.result;
    const score = Number.isFinite(Number(result.score)) ? Number(result.score) : '—';
    const items = Array.isArray(result.items) ? result.items : [];
    const refDate = quiz.resultDate ? formatDate(quiz.resultDate, { year: 'numeric', month: 'long', day: 'numeric' }) : t("时间未记录");
    const isAI = result.mode === 'ai' || quiz.mode === 'ai';
    return `<section class="result-panel" aria-live="polite"><div class="result-panel-head"><div><span class="panel-kicker">${isAI ? t("AI 参考反馈") : t("历史已提交结果")}</span><h3>${isAI ? t("把反馈当作下一次学习的线索") : t("旧版测验结果留作历史记录")}</h3></div><div class="result-score">${escapeHTML(score)}<small>${t("满分 100")}</small></div></div><p class="result-feedback">${escapeHTML(result.feedback || t("本次反馈已保存。"))}</p><p class="result-feedback">${isAI ? t("AI 反馈仅供参考") : t("此结果仅供查看，旧版题目不再接受新的回答")} · ${escapeHTML(refDate)}</p>${items.length ? `<div class="result-items">${items.map((item, index) => `<div class="result-item"><strong>${index + 1}</strong><p>${escapeHTML(item.feedback || t("已记录"))}</p><span>${Number.isFinite(Number(item.score)) ? `${escapeHTML(item.score)} ${t("分")}` : ''}</span></div>`).join('')}</div>` : ''}<div class="weak-points"><strong>${t("接下来可以补一补")}</strong><p>${escapeHTML(weakPointsText(result.weakPoints))}</p></div></section>`;
  }

  function quizConsentCard(task) {
    if (!needsMaterialConsent(task)) return '';
    const checked = sessionConsent.has(task.id);
    return `<div class="quiz-side-card"><h3>${t("材料隐私确认")}</h3><p>${t("请求会发送本计划相关学习内容与作答；旧版计划必要时可能包含材料文字。")}</p><label class="consent-row"><input type="checkbox" data-action="quiz-consent" data-task-id="${escapeHTML(task.id)}" ${checked ? 'checked' : ''}><span><strong>${t("我同意本次向服务发送相关内容")}</strong><small>${t("同意状态只保存在当前应用会话中。")}</small></span></label></div>`;
  }

  function reportList(title, values) {
    const entries = Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
    return entries.length ? `<div class="report-list"><strong>${escapeHTML(title)}</strong><ul>${entries.map(value => `<li>${escapeHTML(value)}</li>`).join('')}</ul></div>` : '';
  }

  function canAdjustAfter(task, dayIndex, quiz) {
    const today = localDateString();
    return !quiz?.readinessStale && quiz?.result?.report?.readyForNext === false && countDays(task).some((day, index) => index > dayIndex && day.date >= today && !day.completed);
  }

  function renderAssessmentReport(task, selector, quiz, options = {}) {
    const result = quiz.result;
    const report = result.report && typeof result.report === 'object' ? result.report : {};
    const isDaily = selector.kind === 'daily';
    const readinessStale = Boolean(quiz.readinessStale);
    const readiness = readinessStale ? t("判断已过期") : report.readyForNext === true ? t("可以继续下一步") : report.readyForNext === false ? t("建议先补齐基础") : t("本次不判断准备程度");
    const staleNotice = options.readOnly
      ? t("学习安排已变更，这份历史报告的准备程度已失效；成绩和作答仍保留。")
      : t("下一日任务已变更，这份报告的继续学习判断需重新评估。成绩和作答仍保留；重新生成并提交测评后会更新判断。");
    const decisionText = options.readOnly || readinessStale ? '' : quiz.decision === 'adjusted'
      ? `<p class="result-feedback">${t("后续未完成日程已按你确认的调整方案更新。")}</p>`
      : quiz.decision === 'extra'
        ? `<p class="result-feedback">${t("本次选择了补学方案，")}${quiz.supplementCompleted ? t("已标记完成。") : t("尚未标记完成。")}</p>`
        : '';
    const decisionActions = options.readOnly || readinessStale ? '' : quiz.decision === 'extra'
      ? `<button class="button button-small button-outline" type="button" data-action="toggle-supplement" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}>${quiz.supplementCompleted ? t("撤销补学完成") : t("标记补学完成")}</button>`
      : quiz.decision === 'adjusted' ? '' : report.readyForNext === false ? `<button class="button button-small button-outline" type="button" data-action="choose-extra" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}>${t("按补学任务继续")}</button>${canAdjustAfter(task, selector.dayIndex, quiz) ? `<button class="button button-small button-primary" type="button" data-action="propose-adjustment" data-task-id="${escapeHTML(task.id)}" data-day-index="${selector.dayIndex}">${t("预览调整后续计划")}</button>` : ''}` : '';
    const feedbackMarkup = result.feedback && result.feedback !== report.summary ? `<p class="result-feedback">${escapeHTML(result.feedback)}</p>` : '';
    const actions = options.readOnly ? '' : `<div class="report-actions"><button class="button button-small button-outline" type="button" data-action="export-report" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}>${t("导出纯文本报告")}</button>${decisionActions}</div>`;
    return `<section class="learning-report" aria-live="polite"><div class="result-panel-head"><div><span class="panel-kicker">${isDaily ? t("每日学习报告") : t(options.readOnly ? "历史周期报告" : "周期学习报告")}</span><h3>${isDaily ? t("本日掌握情况") : t("阶段学习回顾")}</h3></div><div class="result-score">${escapeHTML(result.score)}<small>${t("满分 100")}</small></div></div><p class="result-feedback">${escapeHTML(report.summary || result.feedback || t("本次反馈已保存。"))}</p>${feedbackMarkup}<div class="report-readiness ${readinessStale ? 'readiness-stale' : ''}"><strong>${t("准备程度：")}${readiness}</strong>${readinessStale ? `<p>${staleNotice}</p>` : report.reason ? `<p>${escapeHTML(report.reason)}</p>` : ''}</div>${reportList(t("薄弱点"), result.weakPoints)}${reportList(t("本次表现"), report.strengths)}${reportList(t("下一步建议"), report.nextSteps)}${report.extraMinutes ? `<div class="report-list"><strong>${t("建议补学 ·")} ${Number(report.extraMinutes) || 0} ${t("分钟")}</strong><ul>${(Array.isArray(report.extraTasks) ? report.extraTasks : []).map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}${decisionText}${actions}</section>`;
  }

  function openFinalHistory(taskId) {
    const task = getTask(taskId);
    if (!task) return;
    const history = Array.isArray(task.finalQuizHistory) ? task.finalQuizHistory.filter(quiz => quiz?.result) : [];
    if (!history.length) return;
    $('#finalHistoryTitle').textContent = task.title;
    $('#finalHistoryContent').innerHTML = history.map((quiz, index) => {
      const date = quiz.resultDate ? formatDate(quiz.resultDate, { year: 'numeric', month: 'long', day: 'numeric' }) : t("时间未记录");
      return `<article class="final-history-entry"><div class="final-history-entry-head"><strong>${t("历史周期报告")} ${index + 1}</strong><span>${escapeHTML(date)}</span></div>${renderAssessmentReport(task, { kind: 'final' }, quiz, { readOnly: true })}</article>`;
    }).join('');
    $('#finalHistoryDialog').showModal();
  }

  function renderQuiz(task) {
    if (!task) return emptyState();
    const selector = assessmentSelector;
    const quiz = assessmentFor(task, selector);
    const key = assessmentKey(task.id, selector);
    const isDaily = selector.kind === 'daily';
    const day = isDaily ? countDays(task)[selector.dayIndex] : null;
    if (isDaily && !day) return `${emptyState()}`;
    const count = selector.kind === 'daily' ? 5 : 10;
    const label = isDaily ? t("每日小测") : t("期末测验");
    const reportLabel = isDaily ? t("日报") : t("周期报告");
    const busy = assessmentBusyKeys.has(key);
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">${isDaily ? t("DAILY / 每日检验") : t("FINAL / 周期检验")}</span><h1>${escapeHTML(isDaily ? day.title : task.title)}</h1><p>${escapeHTML(isDaily ? `${task.title} · ${formatDate(day.date, { month: 'long', day: 'numeric' })}` : t("覆盖本计划知识清单，回顾整个学习周期。"))}</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-action="open-plan" data-task-id="${escapeHTML(task.id)}">${t("返回计划")}</button></div></div>`;
    if (busy) return `${head}<section class="panel quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">${t("正在准备")}</span><h2>${t("正在生成")}${label}…</h2><p>${t("保存完成后会在这里复用题目。")}</p></div></section>`;
    const consentRequired = needsMaterialConsent(task) && !sessionConsent.has(task.id);
    if (!quiz?.questions?.length) {
      const description = isDaily ? t("根据当天任务生成 5 道选择或填空题。") : t("根据整份计划生成 10 道选择或填空题，最多包含 2 道简答。");
      return `${head}<div class="quiz-layout"><div class="quiz-main"><section class="quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">${count} ${t("QUESTIONS / AI 测评")}</span><h2>${t("开始")}${label}</h2><p>${description}</p></div></section>${consentRequired ? `<div class="form-message warning-message">${t("本计划包含材料文字。请先在右侧勾选同意，之后才会向模型服务发送请求。")}</div>` : ''}<div class="quiz-submit-row"><span class="quiz-submit-hint">${t("题目会保存到本计划，之后可直接查看和作答。")}</span><button class="button button-primary" type="button" data-action="generate-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}>${t("生成")}${count}${t("题")}${label}</button></div></div><aside class="quiz-side"><section class="quiz-side-card"><h3>${t("这份测评")}</h3><p>${t("共")} ${count} ${t("道题。答案和反馈会在提交后显示。")}</p></section>${quizConsentCard(task)}</aside></div>`;
    }
    const submitted = Boolean(quiz.result);
    const isVersion2 = quiz.version === 2;
    const isLegacyAI = !isVersion2 && quiz.mode === 'ai';
    const isLegacy = !isVersion2;
    if (isLegacy && !isLegacyAI && !submitted) {
      return `${head}<section class="panel legacy-quiz-note"><span class="panel-kicker">${t("历史题目")}</span><h2>${t("这份旧版测验只能查看")}</h2><p>${t("重新生成 10 题期末测验后，可以继续作答并获得周期报告。")}</p><button class="button button-primary" type="button" data-action="generate-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="final">${t("生成10题期末测验")}</button></section>${quizConsentCard(task)}`;
    }
    const questions = Array.isArray(quiz.questions) ? quiz.questions.slice(0, isVersion2 ? count : 5) : [];
    if (isVersion2 && questions.length !== count) {
      return `${head}<div class="form-message error-message">${t("保存的题目数量与")}${label}${t("要求不符。请明确选择重新生成。")}</div><button class="button button-outline" type="button" data-action="retake-assessment" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}>${t("重新生成")}</button>`;
    }
    const answerMap = quiz.answers || {};
    const draftMap = submitted ? {} : quizDrafts.get(assessmentDraftKey(task, selector)) || {};
    const questionFields = questions.map((question, index) => {
      const answer = submitted ? (answerMap[question.id] || {}) : (draftMap[question.id] || answerMap[question.id] || {});
      const questionType = isVersion2 ? question.type : 'short';
      let input;
      if (questionType === 'choice') {
        const selected = answer.text || '';
        input = `<fieldset class="quiz-options" aria-label="${escapeHTML(t("第"))} ${index + 1} ${escapeHTML(t("题选项"))}"><legend>${t("请选择一项")}</legend>${question.options.map((option, optionIndex) => {
          const letter = 'ABCD'[optionIndex];
          const optionText = String(option).replace(/^[A-D][.、)）]\s*/, '');
          return `<label class="quiz-option"><input type="radio" name="answer-${index}" value="${letter}" data-answer data-qid="${escapeHTML(question.id)}" ${selected === letter ? 'checked' : ''} ${submitted ? 'disabled' : 'required'}><span>${letter}. ${escapeHTML(optionText)}</span></label>`;
        }).join('')}</fieldset>`;
      } else if (questionType === 'fill') {
        input = `<input class="quiz-fill" type="text" maxlength="4000" data-answer data-qid="${escapeHTML(question.id)}" aria-label="${escapeHTML(t("第"))} ${index + 1} ${escapeHTML(t("题答案"))}" placeholder="${escapeHTML(t("填写答案"))}" value="${escapeHTML(answer.text || '')}" ${submitted ? 'readonly' : 'required'}>`;
      } else {
        input = `<textarea maxlength="4000" data-answer data-qid="${escapeHTML(question.id)}" aria-label="${escapeHTML(t("第"))} ${index + 1} ${escapeHTML(t("题答案"))}" placeholder="${escapeHTML(t("用自己的话写下理解…"))}" ${submitted ? 'readonly' : 'required'}>${escapeHTML(answer.text || '')}</textarea>`;
      }
      const reference = submitted ? `<details class="question-reference-details"><summary>${t("查看参考答案与评分标准")}</summary><div class="question-reference">${questionType === 'choice' ? `<strong>${t("正确选项")}</strong><p>${escapeHTML(question.answer || '')}</p>` : ''}${question.reference ? `<strong>${t("参考要点")}</strong><p>${escapeHTML(question.reference)}</p>` : ''}${question.rubric ? `<strong>${t("评分标准")}</strong><small>${escapeHTML(question.rubric)}</small>` : ''}</div></details>` : '';
      const item = submitted ? quiz.result.items?.find(resultItem => resultItem.id === question.id) : null;
      const ask = submitted && isVersion2 && item && item.score < (isDaily ? 20 : 10) ? `<button class="button button-small button-outline" type="button" data-action="ask-question" data-task-id="${escapeHTML(task.id)}" data-kind="${selector.kind}" data-day-index="${isDaily ? selector.dayIndex : ""}" data-question-id="${escapeHTML(question.id)}">${t("问这道题")}</button>` : "";
      return `<article class="quiz-question"><div class="question-head"><span class="question-index">${index + 1}</span><span>${isLegacy ? t("历史题目") : label}</span></div><h3>${escapeHTML(question.question || '')}</h3>${input}${submitted && item ? `<p class="result-feedback">${escapeHTML(item.feedback || '')} · ${Number(item.score) || 0} ${t("分")}</p>` : ''}${reference}${ask}</article>`;
    }).join('');
    const selectorAttrs = `data-kind="${selector.kind}" ${isDaily ? `data-day-index="${selector.dayIndex}"` : ''}`;
    const retake = submitted ? `<button class="button button-small button-outline" type="button" data-action="retake-assessment" data-task-id="${escapeHTML(task.id)}" ${selectorAttrs}>${t("重新生成")}${count}${t("题")}${label}</button>` : '';
    const legacyAction = isLegacyAI && !submitted ? `<button class="button button-small button-outline" type="button" data-action="retake-assessment" data-task-id="${escapeHTML(task.id)}" ${selectorAttrs}>${t("升级为新题型")}</button>` : '';
    const submitAction = `<button class="button button-primary" type="submit" id="submitQuiz">${isLegacyAI ? t("提交旧版测试并评分") : `${t("提交并生成")}${reportLabel}`}</button>`;
    const action = submitted ? retake : isLegacyAI ? `${submitAction}${legacyAction}` : submitAction;
    const materialNotice = !submitted && consentRequired ? `<div class="form-message warning-message">${t("请求会发送本计划相关学习内容与作答；旧版计划必要时可能包含材料文字。请先在右侧勾选同意。")}</div>` : '';
    return `${head}<div class="quiz-layout"><form id="quizForm" class="quiz-main" data-task-id="${escapeHTML(task.id)}" ${selectorAttrs}><section class="quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">${isLegacy ? t("历史测验记录") : `${count} QUESTIONS / ${label}`}</span><h2>${escapeHTML(isDaily ? day.title : displayDifficulty(task.plan?.difficulty) || t("学习测验"))}</h2><p>${isLegacy ? t("显示此前保存的历史答案与结果。") : t("选项在答题时可见；参考答案和评分反馈会在提交后显示。")}</p></div>${quiz.generatedDate ? `<div class="quiz-intro-note">${t("题目生成于")} ${escapeHTML(formatDate(quiz.generatedDate, { year: 'numeric', month: 'long', day: 'numeric' }))}。</div>` : ''}</section>${materialNotice}${questionFields}${submitted && !isVersion2 ? renderResult(quiz) : ''}${submitted && isVersion2 ? renderAssessmentReport(task, selector, quiz) : ''}<div class="quiz-submit-row"><span class="quiz-submit-hint">${submitted ? t("题目与报告已保存在这份学习计划中。") : t("答题草稿只保存在当前应用会话中。")}</span>${action}</div></form><aside class="quiz-side"><section class="quiz-side-card"><h3>${t("本次练习")}</h3><p>${t("主题：")}${escapeHTML(task.title)}<br>${t("测评：")}${label}<br>${t("题目：")}${isLegacy ? t("旧版 5 题") : `${count} ${t("道")}`}</p></section>${quizConsentCard(task)}<section class="quiz-side-card"><h3>${t("回顾与反馈")}</h3><p>${submitted ? `${t("已生成")}${reportLabel}${t("，结果可导出为纯文本。")}` : t("结果保存后关闭页面也可继续查看。")}</p></section></aside></div>`;
  }

  function render() {
    updateHeader();
    renderSidebar();
    setNavigation();
    const locked = !apiEnabled();
    $$('[data-nav]').forEach(button => { button.disabled = locked; });
    $$('[data-action]').forEach(button => { button.disabled = locked && !['settings', 'profile'].includes(button.dataset.action); });
    if (locked) {
      viewHost.innerHTML = `<section class="service-locked"><div class="service-lock-mark" aria-hidden="true">◈</div><span class="eyebrow">MODEL SERVICE REQUIRED</span><h1>${t("先配置模型服务")}</h1><p>${t("配置模型地址、名称和 API Key 后，才能创建学习计划、生成知识清单和进行 AI 测验。")}</p><p class="service-lock-note">${t("本地旧计划会在配置完成后重新显示，不会因为当前未配置而删除。")}</p><button class="button button-primary" type="button" data-action="settings">${t("打开 API 设置")}</button></section>`;
      return;
    }
    if (currentView === 'overview') viewHost.innerHTML = renderOverview();
    else if (currentView === 'today') viewHost.innerHTML = renderToday();
    else if (currentView === 'plans') viewHost.innerHTML = renderPlans(false);
    else if (currentView === 'plan-detail') viewHost.innerHTML = renderPlans(true);
    else if (currentView === 'materials') viewHost.innerHTML = renderMaterials();
    else if (currentView === 'quiz') viewHost.innerHTML = renderQuiz(getTask(selectedTaskId));
    else { currentView = 'overview'; viewHost.innerHTML = renderOverview(); }
  }

  async function reloadState(expectedEpoch = configEpoch) {
    if (!api?.loadState) throw new Error(t("无法连接本地学习服务，请重新打开应用。"));
    const fresh = await api.loadState();
    if (expectedEpoch !== configEpoch) return false;
    state.settings = fresh?.settings || { endpoint: '', model: '', hasKey: false, configured: false };
    state.profile = fresh?.profile || { nickname: '', avatar: '' };
    state.preferences = {
      language: window.studyI18n.normalizeLanguage(fresh?.preferences?.language || state.preferences.language)
    };
    state.tasks = apiEnabled() && Array.isArray(fresh?.tasks) ? fresh.tasks : [];
    stateLoaded = true;
    if (selectedTaskId && !getTask(selectedTaskId)) selectedTaskId = null;
    if (!apiEnabled()) {
      sessionConsent.clear();
      cancelMaterialImport();
      ['examDialog', 'createDialog', 'editDayDialog', 'materialDialog', 'tutoringDialog', 'cadenceDialog', 'finalHistoryDialog'].forEach(id => {
        const dialog = document.getElementById(id);
        if (dialog?.open) dialog.close();
      });
      selectedTaskId = null;
      currentView = 'overview';
    }
    applyStaticTranslations();
    render();
    return true;
  }

  async function saveTask(task, nextView = currentView, expectedEpoch = configEpoch, baseTask = undefined, latestGuard = null, preserveNavigation = false) {
    if (expectedEpoch !== configEpoch || !apiEnabled()) throw new Error(t("模型服务配置已变化，请重新操作。"));
    if (!api?.saveTask) throw new Error(t("学习服务未连接，无法保存任务。"));
    const taskId = task.id;
    const base = baseTask === undefined ? getTask(taskId) : baseTask;
    const baseSnapshot = base ? clone(base) : null;
    const proposed = clone(task);
    return withTaskSaveLock(taskId, async () => {
      if (expectedEpoch !== configEpoch || !apiEnabled()) throw new Error(t("模型服务配置已变化，请重新操作。"));
      const beforeSave = await api.loadState();
      if (expectedEpoch !== configEpoch) return null;
      state.settings = beforeSave?.settings || state.settings;
      if (!apiEnabled()) return null;
      const latest = Array.isArray(beforeSave?.tasks) ? beforeSave.tasks.find(item => item.id === taskId) : null;
      if (baseSnapshot && !latest) throw new Error(t("这份计划已被删除，本次保存已取消。"));
      if (latestGuard && (!latest || !latestGuard(latest))) throw new Error(t("相关学习内容已变化，本次保存已取消，请重新操作。"));
      const saveValue = baseSnapshot && latest
        ? mergeTaskChanges(baseSnapshot, proposed, latest)
        : proposed;
      const saved = await api.saveTask(saveValue);
      if (expectedEpoch !== configEpoch) return null;
      const fresh = await api.loadState();
      if (expectedEpoch !== configEpoch) return null;
      state.settings = fresh?.settings || state.settings;
      state.tasks = apiEnabled() && Array.isArray(fresh?.tasks) ? fresh.tasks : [];
      if (!apiEnabled()) {
        state.tasks = [];
        selectedTaskId = null;
        currentView = 'overview';
        render();
        return null;
      }
      if (!preserveNavigation) { selectedTaskId = saved.id; currentView = nextView; }
      render();
      return saved;
    });
  }

  function resetGoalDiscussion(clearInput = true) {
    discussionMessages = [];
    discussionBrief = null;
    confirmedBrief = null;
    discussionReady = false;
    createActivity = null;
    if (clearInput) $('#clarifyInput').value = '';
    $('#clarifyMessages').innerHTML = '';
    $('#confirmedBrief').innerHTML = '';
    $('#confirmedBrief').hidden = true;
    $('#confirmBrief').hidden = true;
    $('#clarifySubmit').textContent = t("开始讨论目标");
    setMessage($('#clarifyError'), '');
    updateCreateControls();
  }

  function renderGoalDiscussion() {
    const host = $('#clarifyMessages');
    host.innerHTML = discussionMessages.map(message => `<div class="discussion-message is-${message.role}"><span>${message.role === 'user' ? t("你") : t("学习助手")}</span><p>${escapeHTML(message.content)}</p></div>`).join('');
    const brief = $('#confirmedBrief');
    if (discussionBrief) {
      const scope = Array.isArray(discussionBrief.scope) ? discussionBrief.scope : [];
      const prerequisites = Array.isArray(discussionBrief.prerequisites) ? discussionBrief.prerequisites : [];
      const outcomes = Array.isArray(discussionBrief.outcomes) ? discussionBrief.outcomes : [];
      brief.innerHTML = `<div class="brief-heading"><span class="panel-kicker">LEARNING BRIEF</span><strong>${confirmedBrief ? t("学习范围已确认") : t("建议的学习范围")}</strong></div><p class="brief-goal">${escapeHTML(discussionBrief.goal || '')}</p>${scope.length ? `<div class="brief-list"><strong>${t("学习范围")}</strong><ul>${scope.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}${prerequisites.length ? `<div class="brief-list"><strong>${t("先修知识")}</strong><ul>${prerequisites.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}${outcomes.length ? `<div class="brief-list"><strong>${t("预期成果")}</strong><ul>${outcomes.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}`;
      brief.hidden = false;
      $('#confirmBrief').hidden = !discussionReady || Boolean(confirmedBrief);
      $('#confirmBrief').textContent = confirmedBrief ? t("已确认") : t("确认学习范围");
    } else {
      brief.innerHTML = '';
      brief.hidden = true;
      $('#confirmBrief').hidden = true;
    }
    $('#clarifySubmit').textContent = discussionMessages.length ? t("发送补充") : t("开始讨论目标");
    host.scrollTop = host.scrollHeight;
  }

  function updateCreateControls() {
    const busy = Boolean(createActivity);
    const planLoading = createActivity?.type === 'plan' && createActivity.showLoading;
    setBusy($('#createSubmit'), Boolean(planLoading), t("正在生成学习计划"));
    $('#createSubmit').disabled = busy || materialImportBusy;
    $('#createLoadingStatus').hidden = !planLoading;
    $('#createLoadingStatus').textContent = planLoading ? planProgressMessage(createActivity.progress) : '';
    $('#clarifySubmit').disabled = busy || materialImportBusy;
    $('#confirmBrief').disabled = busy || materialImportBusy;
    $('#createExamButton').disabled = busy || materialImportBusy;
    $('#saveExamDraft').disabled = busy || materialImportBusy;
    $('#clarifyInput').disabled = createActivity?.type === 'clarify';
    $$('#createForm input, #createForm select, #createForm textarea').forEach(field => { field.disabled = createActivity?.type === 'plan'; });
    if (createActivity?.type === 'clarify') $('#clarifySubmit').textContent = t("正在讨论…");
    else if ($('#createDialog').open) renderGoalDiscussion();
  }

  function planProgressMessage(progress) {
    const hasCounts = Number.isFinite(Number(progress?.completed)) && Number.isFinite(Number(progress?.total));
    if (progress?.stage === 'days' && hasCounts) {
      return t`正在安排学习日程 ${Number(progress.completed)} / ${Number(progress.total)}`;
    }
    if (progress?.stage === 'outline' && hasCounts) return t`正在梳理学习框架 ${Number(progress.completed)} / ${Number(progress.total)}`;
    if (progress?.stage === 'outline') return t("正在梳理学习框架…");
    return t("正在生成学习计划，请稍候…");
  }

  function updateCreateCadenceControls() {
    const form = $('#createForm');
    const mode = form.elements.cadenceMode.value;
    $('#createWeekdays').hidden = mode !== 'weekly';
    const calendarDays = Number(form.elements.days.value);
    const cadence = selectedCadence(form);
    let sessionCount = 0;
    try {
      sessionCount = schedule.learningDates({ startDate: form.elements.startDate.value, calendarDays, cadence }).length;
    } catch { /* The submit validation displays invalid dates or empty weekday selections. */ }
    $('#createCadenceSummary').textContent = sessionCount
      ? t`${calendarDays} 个日历日 · ${sessionCount} 次学习 · ${cadenceLabel(cadence)}`
      : t("当前频率至少需要安排两次学习。");
  }

  function currentCreateInput() {
    const form = $('#createForm');
    const calendarDays = Number(form.elements.days.value);
    const cadence = selectedCadence(form);
    let days = 0;
    try { days = schedule.learningDates({ startDate: form.elements.startDate.value, calendarDays, cadence }).length; } catch { /* Invalid fields are reported by validateCreateInput. */ }
    return {
      title: form.elements.title.value.trim(),
      goal: form.elements.goal.value.trim(),
      level: form.elements.level.value,
      learningMode: form.elements.learningMode.value,
      startDate: form.elements.startDate.value,
      days,
      calendarDays,
      cadence,
      minutesPerDay: Number(form.elements.minutesPerDay.value),
      materials: clone([...createMaterials, ...createExamMaterials]),
      ...(createExamDescription.trim() || createExamMaterials.length
        ? { exam: { description: createExamDescription.trim(), materialIds: createExamMaterials.map(material => material.id) } }
        : {})
    };
  }

  function createInputSnapshot() {
    const input = currentCreateInput();
    return JSON.stringify({ ...input, materials: input.materials.map(material => ({ id: material.id, name: material.name, chars: material.chars, text: material.text, readingWarnings: material.readingWarnings })) });
  }

  function invalidateGoalDiscussion() {
    resetGoalDiscussion();
  }

  function openCreateDialog() {
    if (!stateLoaded) return toast(t("正在读取本地学习数据，请稍候再创建计划。"));
    if (!apiEnabled()) return openSettings();
    const form = $('#createForm');
    form.reset();
    form.elements.startDate.value = localDateString();
    form.elements.days.value = '14';
    form.elements.minutesPerDay.value = '60';
    form.elements.cadenceMode.value = 'daily';
    $$('[name="cadenceWeekday"]', form).forEach(input => { input.checked = false; });
    createMaterials = [];
    createExamDescription = '';
    createExamMaterials = [];
    examDraft = null;
    examDialogSessionId += 1;
    createSessionId += 1;
    createActivity = null;
    resetGoalDiscussion();
    $('#createConsent').checked = false;
    setMessage($('#createError'), '');
    renderCreateMaterials();
    renderCreateExamSummary();
    updateCreateCadenceControls();
    refreshCreateConsent();
    $('#createDialog').showModal();
    window.setTimeout(() => form.elements.title.focus(), 0);
  }

  function currentCreateMaterials(useExamDraft = false) {
    return [...createMaterials, ...(useExamDraft && examDraft ? examDraft.materials : createExamMaterials)];
  }

  function refreshCreateConsent() {
    const shouldShow = apiEnabled() && currentCreateMaterials().some(material => typeof material.text === 'string' && material.text.trim());
    $('#createConsentWrap').hidden = !shouldShow;
    if (!shouldShow) $('#createConsent').checked = false;
  }

  function renderCreateMaterials() {
    const host = $('#createMaterials');
    if (!createMaterials.length) {
      host.innerHTML = '';
      refreshCreateConsent();
      return;
    }
    host.innerHTML = createMaterials.map((material, index) => `<div class="attachment-item"><div class="attachment-name-wrap"><span class="attachment-name" title="${escapeHTML(material.name)}">${escapeHTML(material.name)} <span>· ${Number(material.chars) || 0} ${t("字")}</span></span>${materialReadingSummaryHTML(material)}</div><span class="attachment-item-actions"><button class="inline-link" type="button" data-action="preview-create-material" data-material-index="${index}">${t("预览")}</button><button class="inline-remove" type="button" data-action="remove-create-material" data-material-index="${index}" aria-label="${escapeHTML(t("移除"))} ${escapeHTML(material.name)}">${t("移除")}</button></span></div>`).join('');
    refreshCreateConsent();
  }

  function renderCreateExamSummary() {
    const host = $('#createExamSummary');
    const description = createExamDescription.trim();
    const fileCount = createExamMaterials.length;
    if (!description && !fileCount) {
      host.innerHTML = '';
      host.hidden = true;
      $('#createExamButton').textContent = t("添加考试大纲");
      return;
    }
    const preview = description.length > 130 ? `${description.slice(0, 130).trimEnd()}…` : description;
    host.innerHTML = `<strong>${t("已添加考试范围")}</strong>${preview ? `<p>${escapeHTML(preview)}</p>` : ''}${fileCount ? `<small>${fileCount} ${t("份大纲文件")}</small>` : ''}`;
    host.hidden = false;
    $('#createExamButton').textContent = t("编辑考试大纲");
  }

  function openExamDialog() {
    if (!$('#createDialog').open) return;
    if (createActivity) return toast(t("当前生成操作完成后再继续。"));
    if (materialImportBusy) return toast(t("正在导入材料，请稍候。"));
    examDialogSessionId += 1;
    examDraft = { description: createExamDescription, materials: clone(createExamMaterials) };
    $('#examDescription').value = examDraft.description;
    $('#examMaterials').innerHTML = '';
    setMessage($('#examError'), '');
    renderExamMaterials();
    $('#examDialog').showModal();
    window.setTimeout(() => $('#examDescription').focus(), 0);
  }

  function saveExamDraft() {
    if (!examDraft || !$('#examDialog').open) return;
    if (materialImportBusy) return setMessage($('#examError'), t("正在导入材料，请稍候。"), 'warning');
    const description = $('#examDescription').value;
    if (description.length > 8000) return setMessage($('#examError'), t("考试范围补充最多 8,000 个字符。"), 'warning');
    const materials = [...createMaterials, ...examDraft.materials];
    const totalChars = materials.reduce((sum, item) => sum + (typeof item.text === 'string' ? item.text.length : Number(item.chars) || 0), 0);
    if (materials.length > 10) return setMessage($('#examError'), t("学习材料与大纲文件合计最多 10 份。"), 'warning');
    if (totalChars > 200000) return setMessage($('#examError'), t("学习材料与大纲文件的文字总量不能超过 200,000 字。"), 'warning');
    createExamDescription = description.trim();
    createExamMaterials = clone(examDraft.materials);
    examDraft = null;
    invalidateGoalDiscussion();
    renderCreateExamSummary();
    refreshCreateConsent();
    setMessage($('#createError'), '');
    $('#examDialog').close();
    toast(t("考试大纲已添加到新建计划。"));
  }

  function renderExamMaterials() {
    const host = $('#examMaterials');
    const materials = examDraft?.materials || [];
    host.innerHTML = materials.map((material, index) => `<div class="attachment-item"><div class="attachment-name-wrap"><span class="attachment-name" title="${escapeHTML(material.name)}">${escapeHTML(material.name)} <span>· ${Number(material.chars) || 0} ${t("字")}</span></span>${materialReadingSummaryHTML(material)}</div><span class="attachment-item-actions"><button class="inline-link" type="button" data-action="preview-exam-material" data-material-index="${index}">${t("预览")}</button><button class="inline-remove" type="button" data-action="remove-exam-material" data-material-index="${index}" aria-label="${escapeHTML(t("移除"))} ${escapeHTML(material.name)}">${t("移除")}</button></span></div>`).join('');
  }

  function materialImportContext(target, requestId) {
    const activity = { requestId, target, epoch: configEpoch, createSessionId };
    if (target === 'exam') activity.examSessionId = examDialogSessionId;
    return activity;
  }

  function materialImportIsCurrent(activity) {
    if (!activity || activeMaterialImport?.requestId !== activity.requestId || activity.epoch !== configEpoch || activity.createSessionId !== createSessionId || !apiEnabled() || !$('#createDialog').open) return false;
    return activity.target === 'exam'
      ? activity.examSessionId === examDialogSessionId && $('#examDialog').open && Boolean(examDraft)
      : activity.target === 'study';
  }

  function materialImportMessage(progress) {
    if (progress?.stage === 'ocr' && Number(progress.total) > 0) {
      const page = Number(progress.page) || Math.max(1, Number(progress.completed) || 1);
      const completed = Math.max(0, Number(progress.completed) || 0);
      return t`正在本地识别 PDF，第 ${page} 页 · 已完成 ${completed} / ${Number(progress.total)} 页 · 不会发送给模型服务。`;
    }
    return t("正在导入材料…");
  }

  function renderMaterialImportStatus() {
    const active = activeMaterialImport;
    const forStudy = materialImportIsCurrent(active) && active.target === 'study';
    const forExam = materialImportIsCurrent(active) && active.target === 'exam';
    $('#createMaterialImportStatus').hidden = !forStudy;
    $('#examMaterialImportStatus').hidden = !forExam;
    if (forStudy) $('#createMaterialImportMessage').textContent = materialImportMessage(active.progress);
    if (forExam) $('#examMaterialImportMessage').textContent = materialImportMessage(active.progress);
  }

  function subscribeMaterialProgress() {
    if (materialProgressUnsubscribe || typeof api?.onMaterialProgress !== 'function') return;
    try {
      const unsubscribe = api.onMaterialProgress(progress => {
        if (!activeMaterialImport || progress?.requestId !== activeMaterialImport.requestId || !materialImportIsCurrent(activeMaterialImport)) return;
        activeMaterialImport.progress = progress;
        renderMaterialImportStatus();
      });
      if (typeof unsubscribe === 'function') materialProgressUnsubscribe = unsubscribe;
    } catch { /* Progress is optional; material import still works without it. */ }
  }

  function cancelMaterialImport(target = null) {
    const active = activeMaterialImport;
    if (!active || (target && active.target !== target)) return;
    activeMaterialImport = null;
    materialImportBusy = false;
    renderMaterialImportStatus();
    updateCreateControls();
    if (typeof api?.cancelMaterialImport === 'function') {
      try { Promise.resolve(api.cancelMaterialImport(active.requestId)).catch(() => {}); } catch { /* Local state is cleared even when cancellation is unavailable. */ }
    }
  }

  function materialTextLength(material) {
    return typeof material?.text === 'string' ? material.text.length : Number(material?.chars) || 0;
  }

  function addImportedMaterials(imported, activity) {
    if (!materialImportIsCurrent(activity)) return;
    if (!Array.isArray(imported) || imported.length === 0) return;
    const existingMaterials = currentCreateMaterials(activity.target === 'exam');
    const existing = new Set(existingMaterials.map(item => item.id));
    const added = [];
    imported.forEach(item => {
      if (!item || existing.has(item.id)) return;
      existing.add(item.id);
      added.push(item);
    });
    if (!added.length) return;
    const totalCount = existingMaterials.length + added.length;
    const totalChars = [...existingMaterials, ...added].reduce((sum, item) => sum + materialTextLength(item), 0);
    if (totalCount > 10) throw new Error(t("学习材料与大纲文件合计最多 10 份。"));
    if (totalChars > 200000) throw new Error(t("学习材料与大纲文件的文字总量不能超过 200,000 字。"));
    if (activity.target === 'exam') {
      examDraft.materials.push(...added);
      renderExamMaterials();
      setMessage($('#examError'), '');
    } else {
      createMaterials.push(...added);
      setMessage($('#createError'), '');
      invalidateGoalDiscussion();
      renderCreateMaterials();
    }
    toast(`${t("已添加")} ${added.length} ${t("份材料，可预览或移除。")}`);
  }

  async function importMaterials(target = 'study', files = null) {
    if (!apiEnabled()) return openSettings();
    if (createActivity) return toast(t("当前操作完成后再添加材料。"));
    if (materialImportBusy) return toast(t("正在导入材料，请稍候。"));
    if (target === 'exam' && (!$('#examDialog').open || !examDraft)) return;
    if (!api?.importMaterials && !files) return toast(t("当前运行环境没有文件导入服务。"));
    if (files && !api?.importDroppedMaterials) return toast(t("当前运行环境没有拖入材料服务。"));
    if (files && currentCreateMaterials(target === 'exam').length + files.length > 10) return setMessage(target === 'exam' ? $('#examError') : $('#createError'), t("学习材料与大纲文件合计最多 10 份。"));
    const activity = materialImportContext(target, makeId());
    activeMaterialImport = activity;
    materialImportBusy = true;
    renderMaterialImportStatus();
    updateCreateControls();
    try {
      const imported = files
        ? await api.importDroppedMaterials(files, activity.requestId)
        : await api.importMaterials(activity.requestId);
      if (!materialImportIsCurrent(activity)) return;
      addImportedMaterials(imported, activity);
    } catch (error) {
      if (materialImportIsCurrent(activity)) setMessage(target === 'exam' ? $('#examError') : $('#createError'), error.message || t("导入材料失败，请检查文件后重试。"));
    } finally {
      if (activeMaterialImport?.requestId === activity.requestId) {
        activeMaterialImport = null;
        materialImportBusy = false;
        renderMaterialImportStatus();
        updateCreateControls();
      }
    }
  }

  async function importDroppedMaterials(files, target = 'study') {
    if (!files.length) return;
    return importMaterials(target, files);
  }

  function showMaterial(material) {
    if (!material) return;
    previewedMaterial = material;
    renderMaterialPreview();
    $('#materialDialog').showModal();
  }

  function renderMaterialPreview() {
    if (!previewedMaterial) return;
    $('#materialTitle').textContent = previewedMaterial.name || t("未命名材料");
    $('#materialMeta').textContent = `${Number(previewedMaterial.units) || 0} ${t("个章节 ·")} ${Number(previewedMaterial.chars) || 0} ${t("字")}`;
    const warnings = materialReadingWarnings(previewedMaterial);
    $('#materialWarnings').innerHTML = warnings.length ? `<strong>${t("阅读提示")}</strong><ul>${warnings.map(item => `<li>${escapeHTML(t(item))}</li>`).join('')}</ul>` : '';
    $('#materialWarnings').hidden = !warnings.length;
    $('#materialText').textContent = typeof previewedMaterial.text === 'string' ? previewedMaterial.text : t("这份材料没有可预览的文字内容。");
  }

  function findMaterial(id) {
    for (const task of state.tasks) {
      const found = taskMaterials(task).find(material => material.id === id);
      if (found) return found;
    }
    return null;
  }

  function validateCreateInput(input, errorElement = $('#createError')) {
    if (!input.title || !input.goal) return setMessage(errorElement, t("请填写学习主题和目标。"), 'warning'), false;
    if (!input.startDate || !dateObject(input.startDate)) return setMessage(errorElement, t("请选择有效的开始日期。")), false;
    if (!Number.isInteger(input.calendarDays) || input.calendarDays < 2 || input.calendarDays > 180) return setMessage(errorElement, t("日历跨度需要在 2 到 180 天之间。")), false;
    try { schedule.validateScheduleInput(input); } catch (error) { return setMessage(errorElement, t(error.message)), false; }
    if (!Number.isInteger(input.minutesPerDay) || input.minutesPerDay < 15 || input.minutesPerDay > 480) return setMessage(errorElement, t("每天投入需要在 15 到 480 分钟之间。")), false;
    if (!['exam', 'balanced', 'deep'].includes(input.learningMode)) return setMessage(errorElement, t("请选择有效的学习方式。")), false;
    return true;
  }

  function hasUnconsentedMaterials(input) {
    return input.materials.some(material => typeof material.text === 'string' && material.text.trim()) && !$('#createConsent').checked;
  }

  async function clarifyGoal() {
    if (!apiEnabled()) return openSettings();
    if (createActivity) return;
    if (materialImportBusy) return setMessage($('#clarifyError'), t("正在导入材料，请稍候。"), 'warning');
    const input = currentCreateInput();
    setMessage($('#clarifyError'), '');
    if (!input.goal) return setMessage($('#clarifyError'), t("请先填写学习目标，再开始讨论。"), 'warning');
    if (!validateCreateInput(input, $('#clarifyError'))) return;
    if (hasUnconsentedMaterials(input)) return setMessage($('#clarifyError'), t("本次计划包含材料文字。请先勾选同意，之后才会发送给模型服务。"), 'warning');

    const sessionId = createSessionId;
    const epoch = configEpoch;
    const snapshot = createInputSnapshot();
    const requestId = makeId();
    const notes = $('#clarifyInput').value.trim();
    const requestMessages = discussionMessages.map(message => ({ ...message }));
    if (!requestMessages.length) requestMessages.push({ role: 'user', content: input.goal });
    else if (!notes) return setMessage($('#clarifyError'), t("请写下补充说明或回复，再继续讨论。"), 'warning');
    if (notes) requestMessages.push({ role: 'user', content: notes });
    if (requestMessages.length + 1 > 20) return setMessage($('#clarifyError'), t("讨论最多保留 20 条消息，请确认学习范围或开始新的讨论。"), 'warning');
    if (requestMessages.some(message => message.content.length > 4000)) return setMessage($('#clarifyError'), t("每条讨论消息最多 4000 个字符。"), 'warning');

    createActivity = { id: requestId, type: 'clarify' };
    updateCreateControls();
    try {
      if (!api?.clarifyGoal) throw new Error(t("当前版本暂不支持学习目标讨论，请直接生成计划。"));
      const result = await api.clarifyGoal({ input, messages: requestMessages });
      if (sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled() || snapshot !== createInputSnapshot() || createActivity?.id !== requestId) return;
      if (!result || typeof result.reply !== 'string' || result.reply.length > 4000) throw new Error(t("服务没有返回有效的讨论回复，请重试。"));
      discussionMessages = [...requestMessages, { role: 'assistant', content: result.reply }];
      discussionReady = Boolean(result.ready && result.brief && typeof result.brief === 'object');
      discussionBrief = discussionReady ? clone(result.brief) : null;
      confirmedBrief = null;
      $('#clarifyInput').value = '';
      renderGoalDiscussion();
    } catch (error) {
      if (sessionId === createSessionId && epoch === configEpoch && createActivity?.id === requestId) setMessage($('#clarifyError'), error.message || t("学习目标讨论失败，请稍后重试。"));
    } finally {
      if (createActivity?.id === requestId) {
        createActivity = null;
        updateCreateControls();
      }
    }
  }

  async function createPlan(event) {
    event?.preventDefault();
    if (!apiEnabled()) return openSettings();
    if (createActivity) return toast(t("当前生成操作完成后再继续。"));
    if (materialImportBusy) return setMessage($('#createError'), t("正在导入材料，请稍候。"), 'warning');
    const form = $('#createForm');
    const error = $('#createError');
    setMessage(error, '');
    const input = currentCreateInput();
    if (!validateCreateInput(input, error)) return;
    if (hasUnconsentedMaterials(input)) return setMessage(error, t("本次计划包含材料文字。请先勾选同意，之后才会发送给模型服务。"), 'warning');
    const sessionId = createSessionId;
    const epoch = configEpoch;
    const snapshot = createInputSnapshot();
    const requestId = makeId();
    createActivity = { id: requestId, type: 'plan', progress: null };
    const briefSnapshot = confirmedBrief ? clone(confirmedBrief) : null;
    beginDelayedLoading(createActivity, () => createActivity?.id === requestId, updateCreateControls);
    updateCreateControls();
    try {
      const requestInput = briefSnapshot ? { ...input, brief: briefSnapshot } : input;
      const plan = await api.generatePlan(requestInput, requestId);
      if (createActivity?.id === requestId) {
        clearDelayedLoading(createActivity);
        createActivity.generationFinished = true;
        createActivity.showLoading = false;
        updateCreateControls();
      }
      if (sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled() || snapshot !== createInputSnapshot() || createActivity?.id !== requestId) return;
      if (!plan || !Array.isArray(plan.days) || plan.days.length !== input.days) throw new Error(t("服务返回的计划天数与学习周期不一致，请重试。"));
      if (!Array.isArray(plan.knowledge) || plan.knowledge.length < 1 || plan.knowledge.length > 30) throw new Error(t("服务没有返回有效的知识清单，请检查模型配置后重试。"));
      const task = { id: makeId(), ...input, ...(briefSnapshot ? { brief: briefSnapshot } : {}), plan, createdAt: new Date().toISOString() };
      if (hasMaterialText(task)) sessionConsent.add(task.id);
      const saved = await saveTask(task, 'plan-detail', epoch);
      if (!saved || sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled()) return;
      $('#createDialog').close();
      toast(t("学习计划已生成并保存。"));
    } catch (errorValue) {
      if (sessionId === createSessionId && epoch === configEpoch) setMessage(error, errorValue.message || t("生成学习计划失败，请稍后重试。"));
    } finally {
      if (createActivity?.id === requestId) {
        clearDelayedLoading(createActivity);
        createActivity = null;
        updateCreateControls();
      }
    }
  }

  function subscribePlanProgress() {
    if (planProgressUnsubscribe || typeof api?.onPlanProgress !== 'function') return;
    try {
      const unsubscribe = api.onPlanProgress(progress => {
        if (!createActivity || createActivity.type !== 'plan' || progress?.requestId !== createActivity.id) return;
        createActivity.progress = progress;
        if (createActivity.showLoading) updateCreateControls();
      });
      if (typeof unsubscribe === 'function') planProgressUnsubscribe = unsubscribe;
    } catch { /* Progress is optional; generation still works without it. */ }
  }

  function cadenceFormValue() {
    const form = $('#cadenceForm');
    return schedule.normalizeCadence(selectedCadence(form));
  }

  function updateCadenceControls() {
    const waiting = Boolean(cadenceActivity);
    const proposal = cadenceContext?.proposal;
    const previewButton = $('#previewCadence');
    const confirmButton = $('#confirmCadence');
    const loading = cadenceActivity?.showLoading;
    setBusy(previewButton, Boolean(loading), t("正在生成新频率预览"));
    previewButton.disabled = waiting || cadenceApplyBusy;
    setBusy(confirmButton, cadenceApplyBusy, t("正在应用新频率"));
    confirmButton.disabled = waiting || cadenceApplyBusy || !proposal;
    confirmButton.hidden = !proposal;
    $$('#cadenceFields input, #cadenceFields select').forEach(field => { field.disabled = waiting || cadenceApplyBusy; });
    $$('#cadenceDialog [data-close]').forEach(button => { button.disabled = cadenceApplyBusy; });
    $('#cadenceLoadingStatus').hidden = !loading;
    $('#cadenceLoadingStatus').textContent = loading ? t("正在生成新的学习安排，请稍候…") : '';
    const mode = $('#cadenceForm').elements.cadenceMode.value;
    $('#cadenceWeekdays').hidden = mode !== 'weekly';
  }

  function renderCadencePreview(context) {
    const proposal = context?.proposal;
    const host = $('#cadencePreview');
    if (!proposal) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    const rows = proposal.days.map((day, index) => `<li><strong>${escapeHTML(formatDate(day.date, { month: 'numeric', day: 'numeric' }))} · ${escapeHTML(t`第 ${Number(day.day) || index + 1} 天`)}</strong><span>${escapeHTML(day.title || t("学习安排"))}</span><small>${Number(day.minutes) || 0} ${t("分钟")} · ${escapeHTML((Array.isArray(day.tasks) ? day.tasks : []).join(' · '))}</small></li>`).join('');
    const preservedCount = Array.isArray(proposal.preserved) ? proposal.preserved.length : 0;
    host.innerHTML = `<div class="cadence-preview-copy"><p>${escapeHTML(proposal.summary || t("以下仅列出未来未完成的学习安排。"))}</p><p><strong>${t`已完成与历史安排会保留，共 ${preservedCount} 项。`}</strong> ${t("已保存的历史周期报告也会保留。")}</p>${proposal.warning ? `<p class="cadence-preview-warning">${escapeHTML(proposal.warning)}</p>` : ''}</div>${rows ? `<ul>${rows}</ul>` : `<p class="empty-inline-copy">${t("当前没有未来未完成的学习安排。")}</p>`}`;
    host.hidden = false;
  }

  function openCadence(taskId) {
    const task = getTask(taskId);
    if (!task) return;
    cadenceSessionId += 1;
    cadenceContext = { taskId, epoch: configEpoch, snapshot: cadenceSnapshot(task), proposal: null };
    cadenceActivity = null;
    cadenceApplyBusy = false;
    const cadence = schedule.normalizeCadence(task.cadence);
    const form = $('#cadenceForm');
    form.elements.cadenceMode.value = cadence.mode;
    $$('[name="cadenceWeekday"]', form).forEach(input => { input.checked = cadence.weekdays.includes(Number(input.value)); });
    setMessage($('#cadenceError'), '');
    renderCadencePreview(null);
    updateCadenceControls();
    $('#cadenceDialog').showModal();
  }

  async function previewCadence() {
    const context = cadenceContext;
    if (!context || cadenceActivity || cadenceApplyBusy) return;
    const task = getTask(context.taskId);
    if (!task || context.epoch !== configEpoch || cadenceSnapshot(task) !== context.snapshot) {
      setMessage($('#cadenceError'), t("计划已更新，请重新打开频率设置。"));
      context.proposal = null;
      renderCadencePreview(null);
      updateCadenceControls();
      return;
    }
    let cadence;
    try { cadence = cadenceFormValue(); } catch (error) { setMessage($('#cadenceError'), t(error.message)); return; }
    setMessage($('#cadenceError'), '');
    context.proposal = null;
    renderCadencePreview(null);
    updateCadenceControls();
    const sessionId = cadenceSessionId;
    const epoch = configEpoch;
    const activity = { id: makeId(), taskId: context.taskId };
    cadenceActivity = activity;
    beginDelayedLoading(activity, () => cadenceActivity === activity && cadenceSessionId === sessionId, updateCadenceControls);
    updateCadenceControls();
    try {
      if (typeof api?.proposeCadence !== 'function') throw new Error(t("当前运行环境尚未提供学习频率预览服务。"));
      const proposal = await api.proposeCadence({ taskId: context.taskId, cadence });
      if (epoch !== configEpoch || sessionId !== cadenceSessionId || cadenceActivity !== activity || !$('#cadenceDialog').open) return;
      const latest = getTask(context.taskId);
      if (!latest || cadenceSnapshot(latest) !== context.snapshot) throw new Error(t("学习计划已变化，请重新生成频率预览。"));
      const today = localDateString();
      const proposedRows = Array.isArray(proposal?.days) ? proposal.days : [];
      const rowsAreUpcoming = proposedRows.every(day => day && schedule.validDate(day.date) && day.date >= today && day.completed !== true);
      if (!proposal || proposal.taskId !== context.taskId || !proposal.id || !Array.isArray(proposal.days) || !Array.isArray(proposal.preserved) || !rowsAreUpcoming || Number(proposal.calendarDays) !== (Number(task.calendarDays) || Number(task.days)) || !sameValue(schedule.normalizeCadence(proposal.cadence), cadence)) {
        throw new Error(t("服务返回的学习频率预览无效，请重试。"));
      }
      context.proposal = clone(proposal);
      renderCadencePreview(context);
      updateCadenceControls();
    } catch (error) {
      if (epoch === configEpoch && sessionId === cadenceSessionId && cadenceActivity === activity) setMessage($('#cadenceError'), error.message || t("生成学习频率预览失败，请重试。"));
    } finally {
      if (cadenceActivity === activity) {
        clearDelayedLoading(activity);
        cadenceActivity = null;
        updateCadenceControls();
      }
    }
  }

  async function applyCadence() {
    const context = cadenceContext;
    const proposal = context?.proposal;
    if (!context || !proposal || cadenceApplyBusy) return;
    const task = getTask(context.taskId);
    if (!task || context.epoch !== configEpoch || cadenceSnapshot(task) !== context.snapshot) {
      setMessage($('#cadenceError'), t("学习计划已变化，请重新生成频率预览。"));
      context.proposal = null;
      renderCadencePreview(null);
      updateCadenceControls();
      return;
    }
    cadenceApplyBusy = true;
    setMessage($('#cadenceError'), '');
    updateCadenceControls();
    try {
      const savedTask = await withTaskSaveLock(context.taskId, async () => {
        if (context.epoch !== configEpoch || !apiEnabled()) return null;
        const fresh = await api.loadState();
        if (context.epoch !== configEpoch) return null;
        state.settings = fresh?.settings || state.settings;
        if (!apiEnabled()) return null;
        const latest = Array.isArray(fresh?.tasks) ? fresh.tasks.find(item => item.id === context.taskId) : null;
        if (!latest || cadenceSnapshot(latest) !== context.snapshot) throw new Error(t("学习计划已变化，请重新生成频率预览。"));
        if (typeof api?.applyCadence !== 'function') throw new Error(t("当前运行环境尚未提供学习频率保存服务。"));
        const applied = await api.applyCadence(proposal.id);
        if (context.epoch !== configEpoch || !apiEnabled()) return null;
        const after = await api.loadState();
        if (context.epoch !== configEpoch) return null;
        state.settings = after?.settings || state.settings;
        if (!apiEnabled()) return null;
        const refreshed = Array.isArray(after?.tasks) ? after.tasks.find(item => item.id === context.taskId) : null;
        const result = refreshed || (applied?.id === context.taskId ? applied : null);
        if (!result) throw new Error(t("学习频率没有保存，请重试。"));
        const existingIndex = state.tasks.findIndex(item => item.id === context.taskId);
        state.tasks = existingIndex < 0
          ? [...state.tasks, result]
          : state.tasks.map(item => item.id === context.taskId ? result : item);
        render();
        return result;
      });
      if (!savedTask || context.epoch !== configEpoch || !apiEnabled()) return;
      $('#cadenceDialog').close();
      toast(t("学习频率已更新，历史记录已保留。"));
    } catch (error) {
      if (context.epoch === configEpoch && apiEnabled()) setMessage($('#cadenceError'), error.message || t("保存学习频率失败，请重试。"));
    } finally {
      cadenceApplyBusy = false;
      updateCadenceControls();
    }
  }

  function makeId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function renderAvatar(element, avatar) {
    element.replaceChildren();
    if (!avatar) { element.textContent = t("学"); return; }
    const image = document.createElement('img');
    image.src = avatar;
    image.alt = t("我的头像");
    element.append(image);
  }

  function updateProfilePreview() {
    renderAvatar($('#profileAvatarPreview'), profileAvatar);
    $('#removeProfileAvatar').hidden = !profileAvatar;
  }

  function setProfileBusy(busy) {
    profileBusy = busy;
    ['saveProfile', 'chooseProfileAvatar', 'removeProfileAvatar', 'profileNickname'].forEach(id => { document.getElementById(id).disabled = busy; });
  }

  function openProfile() {
    if (!stateLoaded) return toast(t("正在读取本地设置，请稍候。"));
    profileSession += 1;
    profileAvatar = state.profile.avatar;
    $('#profileNickname').value = state.profile.nickname;
    $('#profileLanguage').value = state.preferences.language;
    $('#profileAvatarFile').value = '';
    setProfileBusy(false);
    setMessage($('#profileError'), '');
    updateProfilePreview();
    $('#profileDialog').showModal();
    $('#profileNickname').focus();
  }

  async function chooseAvatar() {
    const file = $('#profileAvatarFile').files[0];
    if (!file || profileBusy) return;
    const session = profileSession;
    setProfileBusy(true);
    setMessage($('#profileError'), '');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t("请选择 PNG、JPG 或 WebP 图片。"));
      if (file.size > 5 * 1024 * 1024) throw new Error(t("头像图片不能超过 5 MB。"));
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(t("无法读取这张图片，请重新选择。")));
        reader.readAsDataURL(file);
      });
      const image = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(t("这张图片无法打开，请选择其他图片。")));
        image.src = dataURL;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      canvas.getContext('2d').drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 256, 256);
      if (session !== profileSession) return;
      profileAvatar = canvas.toDataURL('image/png');
      updateProfilePreview();
    } catch (error) {
      if (session === profileSession) setMessage($('#profileError'), error.message || t("无法设置头像，请重试。"));
    } finally {
      if (session === profileSession) {
        $('#profileAvatarFile').value = '';
        setProfileBusy(false);
      }
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (profileBusy) return;
    const session = profileSession;
    setProfileBusy(true);
    setMessage($('#profileError'), '');
    try {
      state.profile = await api.saveProfile({ nickname: $('#profileNickname').value.trim(), avatar: profileAvatar });
      render();
      if (session === profileSession && $('#profileDialog').open) $('#profileDialog').close();
      toast(t("头像和昵称已保存。"));
    } catch (error) {
      if (session === profileSession) setMessage($('#profileError'), error.message || t("保存失败，请重试。"));
    } finally {
      if (session === profileSession) setProfileBusy(false);
    }
  }

  async function saveLanguagePreference(event) {
    const select = event.currentTarget;
    const language = window.studyI18n.normalizeLanguage(select.value);
    if (language === state.preferences.language) return;
    const previousLanguage = state.preferences.language;
    select.disabled = true;
    setMessage($('#profileError'), '');
    try {
      const preferences = await api.savePreferences({ language });
      state.preferences = { language: window.studyI18n.normalizeLanguage(preferences?.language || language) };
      applyStaticTranslations();
      refreshVisibleMessages();
      if (currentView === 'quiz') {
        viewHost.querySelectorAll('[data-answer]').forEach(saveQuizDraft);
      }
      render();
      updateProfilePreview();
      if ($('#createDialog').open) {
        renderCreateMaterials();
        renderCreateExamSummary();
        renderGoalDiscussion();
        updateCreateControls();
      }
      if ($('#examDialog').open) renderExamMaterials();
      if ($('#settingsDialog').open) renderSettingsKeyState();
      if ($('#editDayDialog').open) updateEditDayEyebrow();
      if ($('#materialDialog').open) renderMaterialPreview();
      if ($('#adjustmentDialog').open && proposedAdjustment) renderAdjustmentPreview(proposedAdjustment);
      if ($('#tutoringDialog').open) renderTutoring();
      if ($('#profileDialog').open) $('#profileLanguage').value = state.preferences.language;
    } catch (error) {
      select.value = previousLanguage;
      setMessage($('#profileError'), error.message || t("保存语言设置失败，请重试。"));
    } finally {
      if ($('#profileLanguage')) $('#profileLanguage').disabled = false;
    }
  }

  function renderSettingsKeyState() {
    $('#apiKey').placeholder = state.settings?.hasKey ? t("留空以保留已保存的 Key") : t("填写 API Key");
    $('#keyState').textContent = state.settings?.hasKey ? t("已保存 API Key（内容不会读取或显示）") : t("尚未保存 API Key");
    $('#clearKeyRow').hidden = !state.settings?.hasKey;
  }

  function updateEditDayEyebrow() {
    const task = getTask(editingTaskId);
    const day = task && countDays(task)[Number($('#editDayIndex').value)];
    if (!day) return;
    $('#editDayEyebrow').textContent = t`第 ${Number(day.day) || Number($('#editDayIndex').value) + 1} 天 · ${formatDate(day.date, { month: 'long', day: 'numeric' })}`;
  }

  function openSettings() {
    if (!stateLoaded) return toast(t("正在读取本地设置，请稍候再打开 API 设置。"));
    $('#apiEndpoint').value = state.settings?.endpoint || '';
    $('#apiModel').value = state.settings?.model || '';
    $('#apiKey').value = '';
    $('#apiKey').disabled = false;
    $('#apiKey').placeholder = state.settings?.hasKey ? t("留空以保留已保存的 Key") : t("填写 API Key");
    $('#keyState').textContent = state.settings?.hasKey ? t("已保存 API Key（内容不会读取或显示）") : t("尚未保存 API Key");
    $('#clearKeyRow').hidden = !state.settings?.hasKey;
    $('#clearKey').checked = false;
    setMessage($('#settingsMessage'), '');
    $('#settingsDialog').showModal();
    window.setTimeout(() => $('#apiEndpoint').focus(), 0);
  }

  function settingsPayload() {
    return {
      endpoint: $('#apiEndpoint').value.trim(),
      model: $('#apiModel').value.trim(),
      key: $('#apiKey').value,
      clearKey: $('#clearKey').checked
    };
  }

  async function persistSettings(testAfterSave = false) {
    const message = $('#settingsMessage');
    const saveButton = $('#saveSettings');
    const testButton = $('#testConnection');
    setMessage(message, '');
    const payload = settingsPayload();
    if (testAfterSave && (!payload.endpoint || !payload.model || (!(payload.key.trim()) && !state.settings?.hasKey) || payload.clearKey)) {
      setMessage(message, t("测试连接前请填写 API 地址、模型名称和有效的 API Key。"), 'warning');
      return;
    }
    const requestId = ++settingsRequestId;
    cancelMaterialImport();
    const epoch = ++configEpoch;
    setBusy(saveButton, true);
    setBusy(testButton, true);
    try {
      const result = await api.saveSettings(payload);
      if (requestId !== settingsRequestId || epoch !== configEpoch) return;
      sessionConsent.clear();
      $('#apiKey').value = '';
      $('#apiKey').disabled = false;
      const reloaded = await reloadState(epoch);
      if (!reloaded || requestId !== settingsRequestId || epoch !== configEpoch) return;
      renderSettingsKeyState();
      $('#clearKeyRow').hidden = !state.settings?.hasKey;
      $('#clearKey').checked = false;
      if (!testAfterSave) {
        $('#settingsDialog').close();
        toast(result.keySessionOnly ? t("配置已保存。系统加密当前不可用，Key 仅保存在本次运行内存中，下次启动需要重新填写。") : t("API 设置已保存。"));
        return;
      }
      if (result.keySessionOnly) setMessage(message, t("Key 当前仅保存在本次运行内存中。正在测试连接…"), 'warning');
      else setMessage(message, t("配置已保存，正在测试连接…"), 'success');
      const testResult = await api.testConnection();
      if (requestId !== settingsRequestId || epoch !== configEpoch) return;
      if (!testResult?.ok) throw new Error(testResult?.message || t("连接测试失败，请检查服务返回。"));
      const suffix = result.keySessionOnly ? t(" Key 仅保存在本次运行内存中，下次启动需要重新填写。") : '';
      setMessage(message, `${testResult.message || t("服务连接成功。")}${suffix}`, 'success');
      render();
    } catch (error) {
      if (requestId === settingsRequestId && epoch === configEpoch) setMessage(message, error.message || (testAfterSave ? t("连接测试失败，请检查地址、模型和 Key。") : t("保存 API 设置失败。")));
    } finally {
      if (requestId === settingsRequestId) {
        setBusy(saveButton, false);
        setBusy(testButton, false);
      }
    }
  }

  async function toggleDay(taskId, index) {
    const task = getTask(taskId);
    const day = task && countDays(task)[index];
    if (!task || !day) return;
    const next = clone(task);
    next.plan.days[index].completed = !Boolean(day.completed);
    try {
      const saved = await saveTask(next, currentView, configEpoch, task);
      if (!saved) return;
      toast(next.plan.days[index].completed ? t("已记录这一天的完成。") : t("已将这一天恢复为未完成。"));
    } catch (error) {
      if (apiEnabled()) toast(error.message || t("保存完成状态失败。"));
    }
  }

  function openEditDay(taskId, index) {
    const task = getTask(taskId);
    const day = task && countDays(task)[index];
    if (!task || !day) return;
    editingTaskId = taskId;
    $('#editDayIndex').value = String(index);
    updateEditDayEyebrow();
    $('#editDayName').value = day.title || '';
    $('#editDayTasks').value = Array.isArray(day.tasks) ? day.tasks.join('\n') : '';
    setMessage($('#editDayError'), '');
    $('#editDayDialog').showModal();
    window.setTimeout(() => $('#editDayName').focus(), 0);
  }

  async function saveDayEdit(event) {
    event.preventDefault();
    const task = getTask(editingTaskId);
    const index = Number($('#editDayIndex').value);
    const title = $('#editDayName').value.trim();
    const tasks = $('#editDayTasks').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    if (!task || !countDays(task)[index]) return setMessage($('#editDayError'), t("找不到要编辑的计划日期，请关闭后重试。"));
    if (!title) return setMessage($('#editDayError'), t("请填写当天标题。"));
    if (!tasks.length) return setMessage($('#editDayError'), t("请至少保留一项学习任务。"));
    const day = countDays(task)[index];
    const changed = title !== day.title || JSON.stringify(tasks) !== JSON.stringify(day.tasks || []);
    const dailyQuizExists = Boolean(task.dailyQuizzes?.[String(index)]);
    const finalQuizExists = Boolean(task.quiz);
    const previousQuiz = index > 0 ? task.dailyQuizzes?.[String(index - 1)] : null;
    const previousReportExists = Boolean(previousQuiz?.result);
    if (changed && (dailyQuizExists || finalQuizExists || previousReportExists)) {
      const confirmed = window.confirm(t("修改当天学习内容会清除这一天的每日小测和期末测验；前一日已保存日报会保留成绩与作答，但继续学习判断将标记为需重新评估，并撤销补学决定。其他日期的日报会保留。确定保存修改吗？"));
      if (!confirmed) return;
    }
    const next = clone(task);
    next.plan.days[index].title = title;
    next.plan.days[index].tasks = tasks;
    if (changed) {
      if (next.dailyQuizzes && typeof next.dailyQuizzes === 'object') delete next.dailyQuizzes[String(index)];
      delete next.quiz;
      clearDayTutoring(next, index);
      clearTutorChats(next, 'final');
      const stalePreviousQuiz = index > 0 ? next.dailyQuizzes?.[String(index - 1)] : null;
      if (stalePreviousQuiz?.result) {
        stalePreviousQuiz.readinessStale = true;
        delete stalePreviousQuiz.decision;
        delete stalePreviousQuiz.supplementCompleted;
      }
    }
    const priorTutorCache = tutorCacheSnapshot(task, [index], true);
    const editGuard = latest => {
      const latestDay = countDays(latest)[index];
      const latestPreviousQuiz = index > 0 ? latest.dailyQuizzes?.[String(index - 1)] || null : null;
      return Boolean(latestDay)
        && latestDay.title === day.title
        && sameValue(latestDay.tasks || [], day.tasks || [])
        && sameValue(latest.dailyQuizzes?.[String(index)] || null, task.dailyQuizzes?.[String(index)] || null)
        && sameValue(latest.quiz || null, task.quiz || null)
        && sameValue(latestPreviousQuiz, previousQuiz || null)
        && tutorCacheSnapshot(latest, [index], true) === priorTutorCache;
    };
    try {
      const saved = await saveTask(next, currentView, configEpoch, task, editGuard);
      if (!saved) return;
      $('#editDayDialog').close();
      const impactMessages = [];
      if (changed && (dailyQuizExists || finalQuizExists)) impactMessages.push(t("受影响的测验已清除"));
      if (changed && previousReportExists) impactMessages.push(t("前一日报的继续学习判断已失效"));
      toast(impactMessages.length ? `${t("每日安排已保存；")}${impactMessages.join('；')}。` : t("每日安排已保存。"));
    } catch (error) {
      if (apiEnabled()) setMessage($('#editDayError'), error.message || t("保存每日安排失败，请重试。"));
    }
  }

  async function deleteTask(taskId) {
    if (!apiEnabled()) return openSettings();
    const task = getTask(taskId);
    if (!task) return;
    const confirmed = window.confirm(t`确定删除“${task.title}”吗？

这会删除计划、材料文字、完成记录和测验结果，无法撤销。`);
    if (!confirmed) return;
    const epoch = configEpoch;
    try {
      await withTaskSaveLock(taskId, async () => {
        if (epoch !== configEpoch || !apiEnabled()) return;
        const result = await api.deleteTask(taskId);
        if (epoch !== configEpoch || !apiEnabled()) return;
        if (result !== true) throw new Error(t("删除没有完成，请重试。"));
        const reloaded = await reloadState(epoch);
        if (!reloaded || epoch !== configEpoch || !apiEnabled()) return;
        sessionConsent.delete(taskId);
        toast(t("学习计划已删除。"));
      });
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || t("删除学习计划失败。"));
    }
  }

  function exportTask(taskId) {
    const task = getTask(taskId);
    if (!task) return;
    const exported = clone(task);
    ['settings', 'api', 'apiKey', 'key', 'endpoint', 'model', 'encryptedKey', 'sessionKey'].forEach(field => delete exported[field]);
    const json = JSON.stringify({ format: 'study-workbench-task', exportedAt: new Date().toISOString(), task: exported }, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeTitle = String(task.title || t("学习计划")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 70) || t("学习计划");
    link.href = url;
    link.download = `${safeTitle}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("任务 JSON 已导出，不包含 API 配置。"));
  }

  async function openAssessment(taskId, selector, retake = false) {
    if (!apiEnabled()) return openSettings();
    const task = getTask(taskId);
    if (!task) return;
    assessmentSelector = selector.kind === 'daily'
      ? { kind: 'daily', dayIndex: Number(selector.dayIndex) }
      : { kind: 'final' };
    const quiz = assessmentFor(task, assessmentSelector);
    const legacyBasic = quiz && quiz.version !== 2 && quiz.mode !== 'ai' && !quiz.result;
    if (legacyBasic) retake = true;
    selectedTaskId = task.id;
    currentView = 'quiz';
    if (retake && quiz?.questions?.length) {
      const confirmed = window.confirm(t("重新生成会替换这份测评中已保存的题目、答案和报告。确定继续吗？"));
      if (!confirmed) { render(); return; }
    }
    const mustGenerate = retake || !quiz?.questions?.length;
    if (!mustGenerate) { render(); return; }
    if (needsMaterialConsent(task) && !sessionConsent.has(task.id)) {
      render();
      toast(t("请先确认是否允许发送本计划的材料文字。"));
      return;
    }
    const key = assessmentKey(task.id, assessmentSelector);
    const requestKey = `${key}:generate`;
    if (quizRequests.has(requestKey)) return toast(t("这份测评正在生成，请稍候。"));
    const inputSnapshot = assessmentGenerationSnapshot(task, assessmentSelector);
    const epoch = configEpoch;
    const requestId = makeId();
    const requestedSelector = clone(assessmentSelector);
    quizRequests.set(requestKey, requestId);
    assessmentBusyKeys.add(key);
    render();
    try {
      if (typeof api.generateAssessment !== 'function') throw new Error(t("当前运行环境尚未提供新测评服务。"));
      const generated = await api.generateAssessment(task, requestedSelector);
      if (epoch !== configEpoch || !apiEnabled() || quizRequests.get(requestKey) !== requestId) return;
      const expectedCount = requestedSelector.kind === 'daily' ? 5 : 10;
      if (!generated || generated.version !== 2 || !Array.isArray(generated.questions) || generated.questions.length !== expectedCount) {
        throw new Error(t`服务没有返回符合要求的 ${expectedCount} 道题，请检查配置后重试。`);
      }
      const latest = getTask(taskId);
      if (!latest) { toast(t("计划已删除，生成的题目没有保存。")); return; }
      if (assessmentGenerationSnapshot(latest, requestedSelector) !== inputSnapshot) { toast(t("相关学习内容已更新，旧请求的题目没有保存。")); return; }
      const next = clone(latest);
      const savedQuiz = {
        ...generated,
        version: 2,
        mode: 'ai',
        kind: requestedSelector.kind,
        dayIndex: requestedSelector.kind === 'daily' ? requestedSelector.dayIndex : null,
        generatedDate: localDateString()
      };
      delete savedQuiz.answers;
      delete savedQuiz.result;
      delete savedQuiz.resultDate;
      delete savedQuiz.decision;
      delete savedQuiz.supplementCompleted;
      delete savedQuiz.readinessStale;
      if (requestedSelector.kind === 'daily') {
        if (!next.dailyQuizzes || typeof next.dailyQuizzes !== 'object') next.dailyQuizzes = {};
        next.dailyQuizzes[String(requestedSelector.dayIndex)] = savedQuiz;
      } else next.quiz = savedQuiz;
      clearTutorChats(next, requestedSelector.kind, requestedSelector.dayIndex);
      quizDrafts.delete(assessmentDraftKey(latest, requestedSelector));
      const saved = await saveTask(next, 'quiz', epoch, latest, latestTask => assessmentGenerationSnapshot(latestTask, requestedSelector) === inputSnapshot);
      if (!saved) return;
      quizDrafts.delete(assessmentDraftKey(next, requestedSelector));
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) {
        render();
        toast(error.message || t("生成测评失败，请稍后重试。"));
      }
    } finally {
      if (quizRequests.get(requestKey) === requestId) {
        quizRequests.delete(requestKey);
        assessmentBusyKeys.delete(key);
        render();
      }
    }
  }

  async function submitQuiz(event) {
    event.preventDefault();
    if (!apiEnabled()) return openSettings();
    const form = event.target.closest('#quizForm');
    const taskId = form.dataset.taskId;
    const selector = selectorFromForm(form);
    const task = getTask(taskId);
    const quiz = assessmentFor(task, selector);
    if (!quiz?.questions || quiz.result) return;
    const legacyAI = quiz.version !== 2 && quiz.mode === 'ai';
    if (quiz.version !== 2 && !legacyAI) return;
    const key = assessmentKey(taskId, selector);
    const requestKey = `${key}:grade`;
    if (assessmentGradeRequests.has(requestKey)) return;
    const inputSnapshot = assessmentGradeSnapshot(task, selector);
    const epoch = configEpoch;
    if (needsMaterialConsent(task) && !sessionConsent.has(task.id)) {
      toast(t("请先勾选同意，AI 评分才会向模型服务发送请求。"));
      return;
    }
    const answers = {};
    const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const fields = $$('[data-answer]', form).filter(field => field.dataset.qid === question.id);
      const field = fields.find(item => item.type !== 'radio') || fields.find(item => item.checked);
      const text = String(field?.value || '').trim();
      if (!text) { toast(`${t("请先完成第")} ${index + 1} ${t("题。")}`); return; }
      answers[question.id] = { text };
    }
    const button = $('#submitQuiz', form);
    const requestId = makeId();
    assessmentGradeRequests.add(requestKey);
    quizRequests.set(requestKey, requestId);
    setBusy(button, true, t("正在生成报告"));
    try {
      const result = legacyAI
        ? await api.gradeQuiz({ task, answers })
        : await api.gradeAssessment({ task, selector, answers });
      if (epoch !== configEpoch || !apiEnabled() || quizRequests.get(requestKey) !== requestId) return;
      if (!result || typeof result !== 'object') throw new Error(t("服务没有返回有效的测评结果。"));
      const latest = getTask(taskId);
      if (!latest) { toast(t("计划已删除，本次结果没有保存。")); return; }
      if (assessmentGradeSnapshot(latest, selector) !== inputSnapshot) { toast(t("相关学习内容或题目已更新，旧评分没有保存。")); return; }
      const next = clone(latest);
      const target = selector.kind === 'daily'
        ? next.dailyQuizzes?.[String(selector.dayIndex)]
        : next.quiz;
      if (!target) return;
      target.answers = answers;
      target.result = result;
      target.resultDate = localDateString();
      delete target.readinessStale;
      const saved = await saveTask(next, 'quiz', epoch, latest, latestTask => assessmentGradeSnapshot(latestTask, selector) === inputSnapshot);
      if (!saved) return;
      quizDrafts.delete(assessmentDraftKey(next, selector));
      toast(t("测评结果和报告已保存。"));
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || t("提交测评失败，请重试。"));
    } finally {
      setBusy(button, false);
      if (quizRequests.get(requestKey) === requestId) quizRequests.delete(requestKey);
      assessmentGradeRequests.delete(requestKey);
    }
  }

  function selectorFromButton(button) {
    return button.dataset.kind === 'daily'
      ? { kind: 'daily', dayIndex: Number(button.dataset.dayIndex) }
      : { kind: 'final' };
  }

  async function saveAssessmentDecision(taskId, selector, decision) {
    const task = getTask(taskId);
    const quiz = assessmentFor(task, selector);
    if (!task || !quiz?.result) return;
    if (quiz.readinessStale) return toast(t("下一日安排已变更，请重新测评后再选择补学或调整。"));
    const epoch = configEpoch;
    const snapshot = assessmentGenerationSnapshot(task, selector);
    const next = clone(task);
    const target = assessmentFor(next, selector);
    if (decision === 'extra') {
      if (target.readinessStale) return toast(t("下一日安排已变更，请重新测评后再选择补学。"));
      if (target.result?.report?.readyForNext !== false) return toast(t("当前报告没有补学方案。"));
      target.decision = 'extra';
      target.supplementCompleted = false;
    } else if (decision === 'toggle-extra') {
      if (target.decision !== 'extra') return;
      target.supplementCompleted = !target.supplementCompleted;
    }
    try {
      await saveTask(next, 'quiz', epoch, task, latest => assessmentGenerationSnapshot(latest, selector) === snapshot);
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || t("报告决定没有保存，请重试。"));
    }
  }

  function exportReport(taskId, selector) {
    const task = getTask(taskId);
    const quiz = assessmentFor(task, selector);
    if (!task || !quiz?.result) return;
    const report = quiz.result.report || {};
    const lines = [
      selector.kind === 'daily' ? t("每日学习报告") : t("周期学习报告"),
      `${t("学习计划：")}${task.title}`,
      selector.kind === 'daily' ? `${t("日期：")}${countDays(task)[selector.dayIndex]?.date || ''}` : `${t("完成日期：")}${quiz.resultDate || ''}`,
      `${t("得分：")}${quiz.result.score} / 100`,
      `${t("反馈：")}${quiz.result.feedback || ''}`,
      `${t("报告摘要：")}${report.summary || ''}`,
      `${t("准备程度：")}${quiz.readinessStale ? t("判断已过期（下一日任务已变更，需重新评估）") : report.readyForNext === true ? t("可以继续") : report.readyForNext === false ? t("建议先补学") : t("不判断")}`,
      ...(quiz.readinessStale ? [t("继续学习判断：下一日任务已变更，这份报告需重新评估。")] : []),
      `${t("判断依据：")}${report.reason || ''}`,
      `${t("薄弱点：")}${weakPointsText(quiz.result.weakPoints)}`,
      `${t("表现：")}${(report.strengths || []).join('；')}`,
      `${t("下一步：")}${(report.nextSteps || []).join('；')}`,
      `${t("补学时长：")}${report.extraMinutes || 0} ${t("分钟")}`,
      `${t("补学任务：")}${(report.extraTasks || []).join('；')}`
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selector.kind === 'daily' ? t("每日学习报告") : t("周期学习报告")}-${selector.kind === 'daily' ? countDays(task)[selector.dayIndex]?.date || t("日期") : task.id}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("纯文本报告已导出。"));
  }

  function adjustmentMatchesPlan(task, dayIndex, proposal) {
    const today = localDateString();
    const expected = countDays(task).map((day, index) => ({ day, index })).filter(entry => entry.index > dayIndex && entry.day.date >= today && !entry.day.completed);
    if (!proposal || !Array.isArray(proposal.days) || proposal.days.length !== expected.length) return false;
    return proposal.days.every((item, position) => {
      const current = expected[position];
      return item && item.date === current.day.date
        && Number(item.day) === (Number(current.day.day) || current.index + 1)
        && Number(item.minutes) === Number(current.day.minutes)
        && typeof item.title === 'string' && item.title.trim()
        && Array.isArray(item.tasks) && item.tasks.every(taskText => typeof taskText === 'string' && taskText.trim())
        && typeof item.source === 'string' && item.source.trim();
    });
  }

  async function proposeAdjustment(taskId, dayIndex) {
    const task = getTask(taskId);
    const quiz = assessmentFor(task, { kind: 'daily', dayIndex });
    if (!task || !canAdjustAfter(task, dayIndex, quiz)) return;
    const selector = { kind: 'daily', dayIndex };
    const key = `${assessmentKey(taskId, selector)}:adjust`;
    if (quizRequests.has(key)) return toast(t("调整方案正在生成，请稍候。"));
    const snapshot = adjustmentInputSnapshot(task, dayIndex);
    const epoch = configEpoch;
    const requestId = makeId();
    quizRequests.set(key, requestId);
    try {
      if (typeof api.proposeAdjustment !== 'function') throw new Error(t("当前运行环境尚未提供计划调整服务。"));
      const proposal = await api.proposeAdjustment({ task, dayIndex });
      if (epoch !== configEpoch || !apiEnabled() || quizRequests.get(key) !== requestId) return;
      const latest = getTask(taskId);
      if (!latest || adjustmentInputSnapshot(latest, dayIndex) !== snapshot) return toast(t("相关学习内容已更新，旧调整方案没有显示。"));
      if (!canAdjustAfter(latest, dayIndex, assessmentFor(latest, selector))) return toast(t("这份日报已过期或不再需要调整，请重新测评。"));
      if (!adjustmentMatchesPlan(latest, dayIndex, proposal)) throw new Error(t("服务返回的调整方案与未完成日程不匹配，请稍后重试。"));
      proposedAdjustment = { taskId, dayIndex, snapshot, epoch, proposal };
      renderAdjustmentPreview(proposedAdjustment);
      $('#adjustmentDialog').showModal();
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || t("生成调整方案失败。"));
    } finally {
      if (quizRequests.get(key) === requestId) quizRequests.delete(key);
    }
  }

  function renderAdjustmentPreview(pending) {
    const proposal = pending?.proposal;
    if (!proposal) return;
    $('#adjustmentPreview').innerHTML = `<section class="adjustment-preview"><p>${escapeHTML(proposal.summary || t("以下调整只覆盖所选日期之后未完成的安排。"))}</p><p><strong>${t("确认后会替换")} ${proposal.days.length} ${t("个未完成日程，并清除这些日期的日测和原期末测验。")}</strong></p><ul>${proposal.days.map(item => `<li><strong>${escapeHTML(t`第 ${Number(item.day)} 天`)} · ${escapeHTML(formatDate(item.date, { month: 'numeric', day: 'numeric' }))} · ${Number(item.minutes)} ${t("分钟")}</strong><span>${escapeHTML(item.title)}</span><small>${escapeHTML(item.tasks.join(' · '))}</small><small>${t("来源：")}${escapeHTML(displaySource(item.source))}</small></li>`).join('')}</ul></section>`;
  }

  async function applyAdjustment() {
    const pending = proposedAdjustment;
    if (!pending || pending.epoch !== configEpoch) return;
    const task = getTask(pending.taskId);
    if (!task || adjustmentInputSnapshot(task, pending.dayIndex) !== pending.snapshot || !adjustmentMatchesPlan(task, pending.dayIndex, pending.proposal)) {
      toast(t("计划已更新，请重新生成调整预览。"));
      $('#adjustmentDialog').close();
      return;
    }
    const next = clone(task);
    const today = localDateString();
    const expected = countDays(next).map((day, index) => ({ day, index })).filter(entry => entry.index > pending.dayIndex && entry.day.date >= today && !entry.day.completed);
    const affectedIndices = expected.map(entry => entry.index);
    const readinessIndices = affectedIndices.map(index => index - 1).filter(index => index !== pending.dayIndex && !affectedIndices.includes(index));
    const guardedAssessmentIndices = [...new Set([...affectedIndices, ...readinessIndices])];
    const affectedAssessments = adjustmentAssessmentSnapshot(task, guardedAssessmentIndices);
    const affectedTutorCache = tutorCacheSnapshot(task, affectedIndices, true);
    expected.forEach((entry, position) => {
      const item = pending.proposal.days[position];
      next.plan.days[entry.index] = { ...entry.day, title: item.title, minutes: item.minutes, tasks: item.tasks.slice(), source: item.source, completed: false };
    });
    if (next.dailyQuizzes && typeof next.dailyQuizzes === 'object') {
      expected.forEach(entry => { delete next.dailyQuizzes[String(entry.index)]; });
      readinessIndices.forEach(index => {
        const quiz = next.dailyQuizzes[String(index)];
        if (!quiz?.result) return;
        quiz.readinessStale = true;
        delete quiz.decision;
        delete quiz.supplementCompleted;
      });
    }
    expected.forEach(entry => { clearDayTutoring(next, entry.index); });
    clearTutorChats(next, 'final');
    delete next.quiz;
    const dailyQuiz = next.dailyQuizzes?.[String(pending.dayIndex)];
    if (dailyQuiz) {
      dailyQuiz.decision = 'adjusted';
      delete dailyQuiz.supplementCompleted;
    }
    try {
      const saved = await saveTask(next, 'quiz', pending.epoch, task, latest => adjustmentInputSnapshot(latest, pending.dayIndex) === pending.snapshot && adjustmentAssessmentSnapshot(latest, guardedAssessmentIndices) === affectedAssessments && tutorCacheSnapshot(latest, affectedIndices, true) === affectedTutorCache && adjustmentMatchesPlan(latest, pending.dayIndex, pending.proposal));
      if (!saved) return;
      $('#adjustmentDialog').close();
      toast(t("调整方案已应用到后续未完成日程。"));
    } catch (error) {
      if (pending.epoch === configEpoch && apiEnabled()) {
        if (error.message?.includes(t("相关学习内容已变化，本次保存已取消，请重新操作。"))) {
          $('#adjustmentDialog').close();
          toast(t("受影响的测验已更新，请重新生成调整预览后再确认。"));
        } else toast(error.message || t("调整方案没有保存，请重试。"));
      }
    }
  }

  function tutorQuiz(task, context) {
    return assessmentFor(task, context.kind === 'daily' ? { kind: 'daily', dayIndex: context.dayIndex } : { kind: 'final' });
  }

  function tutorChatKey(context) {
    return context.kind === 'daily' ? `daily:${context.dayIndex}:${context.questionId}` : `final:${context.questionId}`;
  }

  function tutorBasis(task, context) {
    if (context.mode === 'lesson') {
      const day = countDays(task)[context.dayIndex];
      return day ? { dayTitle: day.title, dayTasks: day.tasks, daySource: day.source || '' } : null;
    }
    const quiz = tutorQuiz(task, context);
    const question = quiz?.questions?.find(item => item.id === context.questionId);
    const item = quiz?.result?.items?.find(item => item.id === context.questionId);
    if (quiz?.version !== 2 || !question || !item) return null;
    return { question: question.question, answer: quiz.answers?.[context.questionId]?.text || '', feedback: item.feedback };
  }

  function tutorSnapshot(task, context) {
    return JSON.stringify({ title: task.title, goal: task.goal, level: task.level, knowledge: task.plan?.knowledge, materials: task.materials, basis: tutorBasis(task, context), questionDetails: context.mode === 'question' ? tutorQuiz(task, context)?.questions?.find(item => item.id === context.questionId) : null });
  }

  function tutorCacheSnapshot(task, dayIndices, includeFinal, includeLessons = true) {
    const prefixes = dayIndices.map(index => `daily:${index}:`);
    if (includeFinal) prefixes.push('final:');
    return JSON.stringify({ lessons: includeLessons ? dayIndices.map(index => task.lessons?.[String(index)] || null) : [], chats: Object.entries(task.tutorChats || {}).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))).sort(([a], [b]) => a.localeCompare(b)) });
  }

  function clearTutorChats(task, kind, dayIndex) {
    const prefix = kind === 'daily' ? `daily:${dayIndex}:` : 'final:';
    Object.keys(task.tutorChats || {}).filter(key => key.startsWith(prefix)).forEach(key => { delete task.tutorChats[key]; });
  }

  function clearDayTutoring(task, dayIndex) {
    if (task.lessons) delete task.lessons[String(dayIndex)];
    clearTutorChats(task, 'daily', dayIndex);
  }

  function tutoringRequestKey(context) {
    return `${context.taskId}:${context.mode}:${context.mode === 'lesson' ? `${context.dayIndex}:${context.depth}` : tutorChatKey(context)}`;
  }

  function tutorResponseHTML(response) {
    return `<div class="tutor-text">${escapeHTML(response.text || '')}</div>${response.sources?.length ? `<p class="field-hint">${t("来源：")}${escapeHTML(response.sources.map(displaySource).join(state.preferences.language === 'en' ? '; ' : '；'))}</p>` : ''}${response.limitations?.length ? `<p class="field-hint">${t("说明：")}${escapeHTML(response.limitations.join(state.preferences.language === 'en' ? '; ' : '；'))}</p>` : ''}`;
  }

  function renderTutoring() {
    const context = tutoringContext;
    if (!context || !$('#tutoringDialog').open) return;
    const task = getTask(context.taskId);
    const basis = task && tutorBasis(task, context);
    if (!basis) { $('#tutoringDialog').close(); return; }
    const isLesson = context.mode === 'lesson';
    const busy = tutoringRequests.has(tutoringRequestKey(context));
    $('#tutoringTitle').textContent = isLesson ? t`第 ${context.dayIndex + 1} 天 · 学习讲解` : t("错题与理解追问");
    $('#tutoringIntro').textContent = isLesson ? t("围绕当天任务解释概念、例子和易错点。点击后才生成；已有讲解可直接查看。") : t("围绕这道题继续提问，帮助理解原因和方法。对话保留最近 20 轮。");
    $('#lessonControls').hidden = !isLesson;
    $('#lessonActions').hidden = !isLesson;
    $('#questionFollowUpForm').hidden = isLesson;
    const needsConsent = needsMaterialConsent(task) && !sessionConsent.has(task.id);
    $('#tutoringConsentWrap').hidden = !needsConsent;
    $('#tutoringConsent').checked = !needsConsent;
    if (isLesson) {
      const lesson = task.lessons?.[String(context.dayIndex)]?.[context.depth];
      const valid = lesson && sameValue({ dayTitle: lesson.dayTitle, dayTasks: lesson.dayTasks, daySource: lesson.daySource }, basis);
      $('#tutoringContent').innerHTML = valid ? tutorResponseHTML(lesson) : `<p class="tutor-empty">${t("尚未生成这份讲解。")}</p>`;
      $$('#lessonControls [data-depth]').forEach(button => { button.classList.toggle('is-selected', button.dataset.depth === context.depth); });
      $('#generateLesson').hidden = Boolean(valid);
      $('#generateLesson').disabled = busy;
      $('#generateLesson').textContent = busy ? t("正在生成讲解…") : `${t("生成")}${context.depth === 'brief' ? t("简要") : t("展开")}${t("讲解")}`;
    } else {
      const chat = task.tutorChats?.[tutorChatKey(context)];
      const valid = chat && sameValue({ question: chat.question, answer: chat.answer, feedback: chat.feedback }, basis);
      const history = valid ? chat.messages : [];
      $('#tutoringContent').innerHTML = `<p class="tutor-question">${escapeHTML(basis.question)}</p>${history.map(message => `<article class="tutor-message is-${message.role}"><strong>${message.role === 'user' ? t("你") : t("学习助手")}</strong>${tutorResponseHTML(message)}</article>`).join('')}`;
      $('#sendQuestionFollowUp').disabled = busy;
      $('#questionFollowUpInput').disabled = busy;
      $('#sendQuestionFollowUp').textContent = busy ? t("正在回答…") : t("发送问题");
    }
  }

  function openTutoring(taskId, context) {
    if (!apiEnabled()) return openSettings();
    const task = getTask(taskId);
    if (!task || !tutorBasis(task, context)) return toast(t("当前学习内容无法打开讲解，请先完成测评或重新打开计划。"));
    tutoringContext = { ...context, taskId, depth: 'brief', epoch: configEpoch, session: makeId() };
    setMessage($('#tutoringError'), '');
    $('#questionFollowUpInput').value = '';
    if (!$('#tutoringDialog').open) $('#tutoringDialog').showModal();
    renderTutoring();
  }

  async function requestTutoring(event) {
    event?.preventDefault();
    const context = tutoringContext && clone(tutoringContext);
    if (!context || context.epoch !== configEpoch || !apiEnabled()) return;
    const task = getTask(context.taskId);
    const basis = task && tutorBasis(task, context);
    if (!basis) return;
    const key = tutoringRequestKey(context);
    if (tutoringRequests.has(key)) return;
    if (needsMaterialConsent(task) && !sessionConsent.has(task.id)) {
      if (!$('#tutoringConsent').checked) return setMessage($('#tutoringError'), t("请先同意发送相关学习内容与作答。"), 'warning');
      sessionConsent.add(task.id);
    }
    const isLesson = context.mode === 'lesson';
    const questionText = $('#questionFollowUpInput').value.trim();
    if (!isLesson && !questionText) return setMessage($('#tutoringError'), t("请写下想问的问题。"));
    const oldLesson = task.lessons?.[String(context.dayIndex)]?.[context.depth];
    if (isLesson && oldLesson && sameValue({ dayTitle: oldLesson.dayTitle, dayTasks: oldLesson.dayTasks, daySource: oldLesson.daySource }, basis)) return renderTutoring();
    const previousChat = task.tutorChats?.[tutorChatKey(context)];
    const history = !isLesson && previousChat ? previousChat.messages : [];
    const messages = [...history.slice(-8).map(message => ({ role: message.role, text: message.text })), { role: 'user', text: questionText }];
    const snapshot = tutorSnapshot(task, context);
    tutoringRequests.add(key);
    setMessage($('#tutoringError'), '');
    renderTutoring();
    try {
      const response = isLesson
        ? await api.generateLesson({ task, dayIndex: context.dayIndex, depth: context.depth })
        : await api.answerQuestion({ task, selector: context.kind === 'daily' ? { kind: 'daily', dayIndex: context.dayIndex } : { kind: 'final' }, questionId: context.questionId, messages });
      if (context.epoch !== configEpoch || !apiEnabled()) return;
      const latest = getTask(context.taskId);
      if (!latest || tutorSnapshot(latest, context) !== snapshot) throw new Error(t("相关学习内容已变化，本次讲解没有保存，请重新生成。"));
      const next = clone(latest);
      if (isLesson) {
        next.lessons ||= {};
        next.lessons[String(context.dayIndex)] ||= {};
        next.lessons[String(context.dayIndex)][context.depth] = { ...response, ...basis, generatedDate: localDateString() };
      } else {
        next.tutorChats ||= {};
        next.tutorChats[tutorChatKey(context)] = { kind: context.kind, dayIndex: context.kind === 'daily' ? context.dayIndex : null, questionId: context.questionId, ...basis, messages: [...history.slice(-38), { role: 'user', text: questionText }, { role: 'assistant', ...response }] };
      }
      const saved = await saveTask(next, currentView, context.epoch, latest, current => tutorSnapshot(current, context) === snapshot, true);
      if (!saved) return;
      if (tutoringContext && tutoringRequestKey(tutoringContext) === key) {
        if (!isLesson && tutoringContext.session === context.session) $('#questionFollowUpInput').value = '';
        renderTutoring();
      }
    } catch (error) {
      if (context.epoch === configEpoch && tutoringContext && tutoringRequestKey(tutoringContext) === key) setMessage($('#tutoringError'), error.message || t("讲解生成失败，请重试。"));
    } finally {
      tutoringRequests.delete(key);
      renderTutoring();
    }
  }

  function dragHasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files') || Boolean(event.dataTransfer?.files?.length);
  }

  function eventDropZone(event) {
    return event.target?.closest?.('#materialDropZone, #examMaterialDropZone') || null;
  }

  function dropZoneIsOpen(zone) {
    if (zone?.id === 'materialDropZone') return $('#createDialog').open;
    return zone?.id === 'examMaterialDropZone' && $('#createDialog').open && $('#examDialog').open;
  }

  window.addEventListener('dragenter', event => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    const zone = eventDropZone(event);
    if (dropZoneIsOpen(zone)) zone.classList.add('is-dragging');
  });

  window.addEventListener('dragover', event => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = dropZoneIsOpen(eventDropZone(event)) ? 'copy' : 'none';
  });

  window.addEventListener('dragleave', event => {
    const zone = eventDropZone(event);
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
  });

  window.addEventListener('drop', event => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    const zone = eventDropZone(event);
    $('#materialDropZone')?.classList.remove('is-dragging');
    $('#examMaterialDropZone')?.classList.remove('is-dragging');
    if (dropZoneIsOpen(zone)) importDroppedMaterials(Array.from(event.dataTransfer.files || []), zone.id === 'examMaterialDropZone' ? 'exam' : 'study');
  });

  function openPlan(taskId) {
    if (!apiEnabled()) return openSettings();
    selectedTaskId = taskId;
    currentView = 'plan-detail';
    render();
  }

  function handleNavigation(view) {
    if (!apiEnabled() || !viewNames[view]) return;
    currentView = view;
    if (view === 'plans' || view === 'overview' || view === 'today' || view === 'materials') selectedTaskId = null;
    render();
  }

  document.addEventListener('click', async event => {
    const closeButton = event.target.closest('[data-close]');
    if (closeButton) {
      if (closeButton.disabled) return;
      const dialog = document.getElementById(closeButton.dataset.close);
      if (dialog?.open) dialog.close();
      return;
    }
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      handleNavigation(nav.dataset.nav);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const taskId = button.dataset.taskId;
    if (action === 'cancel-adjustment') {
      $('#adjustmentDialog').close();
      return;
    }
    if (action === 'confirm-adjustment') {
      await applyAdjustment();
      return;
    }
    if (action === 'confirm-cadence') {
      await applyCadence();
      return;
    }
    if (action === 'open-exam-dialog') { openExamDialog(); return; }
    if (action === 'save-exam-draft') { saveExamDraft(); return; }
    if (action === 'import-exam-material') { await importMaterials('exam'); return; }
    if (action === 'cancel-material-import') { cancelMaterialImport(button.dataset.importTarget); return; }
    if (action === 'open-lesson') openTutoring(taskId, { mode: 'lesson', dayIndex: Number(button.dataset.dayIndex) });
    else if (action === 'ask-question') openTutoring(taskId, { mode: 'question', ...selectorFromButton(button), questionId: button.dataset.questionId });
    else if (action === 'lesson-depth' && tutoringContext) { tutoringContext.depth = button.dataset.depth; setMessage($('#tutoringError'), ''); renderTutoring(); }
    else if (action === 'generate-lesson') await requestTutoring();
    else if (action === 'new-task') openCreateDialog();
    else if (action === 'settings') openSettings();
    else if (action === 'profile') openProfile();
    else if (action === 'import-create') await importMaterials();
    else if (action === 'remove-exam-material') {
      examDraft?.materials.splice(Number(button.dataset.materialIndex), 1);
      renderExamMaterials();
    } else if (action === 'preview-exam-material') showMaterial(examDraft?.materials[Number(button.dataset.materialIndex)]);
    else if (action === 'remove-create-material') {
      createMaterials.splice(Number(button.dataset.materialIndex), 1);
      invalidateGoalDiscussion();
      renderCreateMaterials();
    } else if (action === 'preview-create-material') showMaterial(createMaterials[Number(button.dataset.materialIndex)]);
    else if (action === 'preview-library-material') showMaterial(findMaterial(button.dataset.materialId));
    else if (action === 'open-plan') openPlan(taskId);
    else if (action === 'edit-cadence') openCadence(taskId);
    else if (action === 'view-final-history') openFinalHistory(taskId);
    else if (action === 'toggle-day') await toggleDay(taskId, Number(button.dataset.dayIndex));
    else if (action === 'edit-day') openEditDay(taskId, Number(button.dataset.dayIndex));
    else if (action === 'delete-task') await deleteTask(taskId);
    else if (action === 'export-task') exportTask(taskId);
    else if (action === 'open-assessment') await openAssessment(taskId, selectorFromButton(button), button.dataset.retake === 'true');
    else if (action === 'generate-assessment') await openAssessment(taskId, selectorFromButton(button), true);
    else if (action === 'retake-assessment') await openAssessment(taskId, selectorFromButton(button), true);
    else if (action === 'export-report') exportReport(taskId, selectorFromButton(button));
    else if (action === 'choose-extra') await saveAssessmentDecision(taskId, selectorFromButton(button), 'extra');
    else if (action === 'toggle-supplement') await saveAssessmentDecision(taskId, selectorFromButton(button), 'toggle-extra');
    else if (action === 'propose-adjustment') await proposeAdjustment(taskId, Number(button.dataset.dayIndex));
  });

  document.addEventListener('change', event => {
    if (event.target.matches('[data-answer]')) saveQuizDraft(event.target);
    const consent = event.target.closest('[data-action="quiz-consent"]');
    if (consent) {
      if (consent.checked) sessionConsent.add(consent.dataset.taskId);
      else sessionConsent.delete(consent.dataset.taskId);
    }
  });

  $('#createForm').addEventListener('submit', event => createPlan(event));
  $('#createForm').addEventListener('input', event => {
    if (['title', 'goal', 'level', 'learningMode', 'startDate', 'days', 'minutesPerDay', 'cadenceMode', 'cadenceWeekday'].includes(event.target.name)) {
      invalidateGoalDiscussion();
      setMessage($('#createError'), '');
      updateCreateCadenceControls();
    }
  });
  $('#createForm').addEventListener('change', event => {
    if (['title', 'goal', 'level', 'learningMode', 'startDate', 'days', 'minutesPerDay', 'cadenceMode', 'cadenceWeekday'].includes(event.target.name)) {
      invalidateGoalDiscussion();
      setMessage($('#createError'), '');
      updateCreateCadenceControls();
    }
  });
  $('#cadenceForm').addEventListener('submit', event => { event.preventDefault(); previewCadence(); });
  const invalidateCadencePreview = event => {
    if (!['cadenceMode', 'cadenceWeekday'].includes(event.target.name)) return;
    if (cadenceContext) cadenceContext.proposal = null;
    setMessage($('#cadenceError'), '');
    renderCadencePreview(null);
    updateCadenceControls();
  };
  $('#cadenceForm').addEventListener('input', invalidateCadencePreview);
  $('#cadenceForm').addEventListener('change', invalidateCadencePreview);
  $('#clarifySubmit').addEventListener('click', clarifyGoal);
  $('#confirmBrief').addEventListener('click', () => {
    if (createActivity || !discussionReady || !discussionBrief) return;
    confirmedBrief = clone(discussionBrief);
    renderGoalDiscussion();
    toast(t("学习范围已确认，生成计划时会一并提交。"));
  });
  $('#settingsForm').addEventListener('submit', event => { event.preventDefault(); persistSettings(false); });
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#profileLanguage').addEventListener('change', saveLanguagePreference);
  $('#chooseProfileAvatar').addEventListener('click', () => $('#profileAvatarFile').click());
  $('#profileAvatarFile').addEventListener('change', chooseAvatar);
  $('#removeProfileAvatar').addEventListener('click', () => { profileAvatar = ''; updateProfilePreview(); });
  $('#profileDialog').addEventListener('close', () => { profileSession += 1; });
  $('#testConnection').addEventListener('click', () => persistSettings(true));
  $('#editDayForm').addEventListener('submit', saveDayEdit);
  $('#questionFollowUpForm').addEventListener('submit', requestTutoring);
  viewHost.addEventListener('submit', event => {
    if (event.target.matches('#quizForm')) submitQuiz(event);
  });
  viewHost.addEventListener('input', event => {
    if (event.target.matches('[data-answer]')) saveQuizDraft(event.target);
  });
  ['createDialog', 'examDialog', 'settingsDialog', 'profileDialog', 'editDayDialog', 'materialDialog', 'adjustmentDialog', 'tutoringDialog', 'cadenceDialog', 'finalHistoryDialog'].forEach(id => {
    const dialog = document.getElementById(id);
    dialog.addEventListener('click', event => { if (event.target === dialog && !(id === 'cadenceDialog' && cadenceApplyBusy)) dialog.close(); });
  });
  $('#tutoringDialog').addEventListener('close', () => { if (!$('#tutoringDialog').open) tutoringContext = null; });
  $('#adjustmentDialog').addEventListener('close', () => {
    if (!$('#adjustmentDialog').open) proposedAdjustment = null;
  });
  $('#createDialog').addEventListener('close', () => {
    if ($('#createDialog').open) return;
    if ($('#examDialog').open) $('#examDialog').close();
    const activity = createActivity;
    createSessionId += 1;
    $('#materialDropZone').classList.remove('is-dragging');
    $('#examMaterialDropZone').classList.remove('is-dragging');
    cancelMaterialImport();
    clearDelayedLoading(activity);
    if (activity?.type === 'plan' && !activity.generationFinished && typeof api?.cancelPlanGeneration === 'function') {
      try { Promise.resolve(api.cancelPlanGeneration(activity.id)).catch(() => {}); } catch { /* Closing the dialog still clears local loading state. */ }
    }
    createActivity = null;
    resetGoalDiscussion();
    setBusy($('#createSubmit'), false);
    $('#createLoadingStatus').hidden = true;
    $('#createLoadingStatus').textContent = '';
    setMessage($('#createError'), '');
    createMaterials = [];
    createExamDescription = '';
    createExamMaterials = [];
    examDraft = null;
    renderCreateExamSummary();
  });
  $('#examDialog').addEventListener('close', () => {
    if ($('#examDialog').open) return;
    examDialogSessionId += 1;
    $('#examMaterialDropZone').classList.remove('is-dragging');
    examDraft = null;
    cancelMaterialImport('exam');
    setMessage($('#examError'), '');
    renderMaterialImportStatus();
  });
  $('#cadenceDialog').addEventListener('close', () => {
    if ($('#cadenceDialog').open) return;
    cadenceSessionId += 1;
    clearDelayedLoading(cadenceActivity);
    cadenceActivity = null;
    cadenceContext = null;
    cadenceApplyBusy = false;
    renderCadencePreview(null);
    setMessage($('#cadenceError'), '');
    updateCadenceControls();
  });
  $('#cadenceDialog').addEventListener('cancel', event => { if (cadenceApplyBusy) event.preventDefault(); });

  async function initialize() {
    subscribePlanProgress();
    subscribeMaterialProgress();
    applyStaticTranslations();
    if (!api?.loadState) {
      viewHost.innerHTML = `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">${t("启动异常")}</span><h2>${t("暂时无法打开学习工作台")}</h2><p>${t("无法连接本地学习服务，请重新打开应用。")}</p></div></div></section>`;
      updateHeader();
      return;
    }
    try {
      await reloadState();
    } catch (error) {
      viewHost.innerHTML = `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">${t("启动异常")}</span><h2>${t("暂时无法读取学习计划")}</h2><p>${escapeHTML(error.message || t("请重启应用后重试。"))}</p></div></div></section>`;
      updateHeader();
    }
  }

  initialize();
})();
