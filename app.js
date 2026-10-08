'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const api = window.studyApp;
  const viewHost = $('#appView');
  const state = { tasks: [], settings: { endpoint: '', model: '', hasKey: false, configured: false }, profile: { nickname: '', avatar: '' } };
  let currentView = 'overview';
  let selectedTaskId = null;
  let createMaterials = [];
  let editingTaskId = null;
  let toastTimer = null;
  let quizBusyTaskId = null;
  let stateLoaded = false;
  let configEpoch = 0;
  let settingsRequestId = 0;
  let createSessionId = 0;
  let createActivity = null;
  let discussionMessages = [];
  let discussionBrief = null;
  let confirmedBrief = null;
  let discussionReady = false;
  let profileAvatar = '';
  let profileSession = 0;
  let profileBusy = false;
  const quizGradeRequests = new Set();
  const quizRequests = new Map();
  const quizDrafts = new Map();
  const sessionConsent = new Set();

  const viewNames = {
    overview: '学习概览', today: '今日安排', plans: '全部计划', 'plan-detail': '计划详情',
    materials: '材料库', quiz: '阶段测验'
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
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
    return date ? new Intl.DateTimeFormat('zh-CN', options).format(date) : '日期待定';
  }

  function formatToday() {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  }

  function todayLabel() {
    return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  }

  function greet() {
    const hour = new Date().getHours();
    if (state.profile.nickname) return `${state.profile.nickname}，${hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好'}！`;
    if (hour < 11) return '早上好，今天从一小步开始';
    if (hour < 18) return '下午好，给专注留一点空间';
    return '晚上好，慢慢收好今天的进度';
  }

  function getTask(id) {
    return state.tasks.find(task => task.id === id);
  }

  function taskMaterials(task) {
    return Array.isArray(task?.materials) ? task.materials : [];
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

  function quizDraftKey(task) {
    const questions = Array.isArray(task?.quiz?.questions) ? task.quiz.questions : [];
    return `${task?.id || ''}:${JSON.stringify(questions.map(question => [question.id, question.question]))}`;
  }

  function saveQuizDraft(field) {
    const form = field.closest('#quizForm');
    if (!form || !field.dataset.qid) return;
    const task = getTask(form.dataset.taskId);
    if (!task?.quiz?.questions || task.quiz.result) return;
    const key = quizDraftKey(task);
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
    element.textContent = message;
    element.className = `form-message ${type === 'error' ? 'error-message' : type === 'warning' ? 'warning-message' : ''}`;
    element.hidden = !message;
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 2800);
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
    if (!apiEnabled()) status.innerHTML = '<span class="status-pulse"></span><span>先配置模型服务</span>';
    else if (today.length) status.innerHTML = `<span class="status-pulse"></span><span>今日完成 ${done} / ${today.length} 项</span>`;
    else status.innerHTML = `<span class="status-pulse"></span><span>${state.tasks.length ? '今日暂无安排' : '等待第一份计划'}</span>`;
    $('#todayBadge').textContent = String(today.length);
    $('#taskCount').textContent = String(state.tasks.length);
    const dot = $('#apiDot');
    dot.classList.toggle('is-ready', apiEnabled());
    dot.setAttribute('aria-label', apiEnabled() ? 'API 已配置' : 'API 未配置');
    dot.title = apiEnabled() ? '模型服务已配置' : '未配置模型服务';
    $('#crumbCurrent').textContent = viewNames[currentView] || '学习概览';
  }

  function renderSidebar() {
    const host = $('#sidebarTasks');
    if (!apiEnabled()) {
      host.innerHTML = '<div class="side-empty">配置模型服务后显示本地计划</div>';
      return;
    }
    if (!state.tasks.length) {
      host.innerHTML = '<div class="side-empty">还没有学习计划</div>';
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
        <span class="eyebrow">从一张白纸开始</span>
        <h2 id="emptyTitle">你的学习桌，已经准备好了。</h2>
        <p>写下一个想学会的主题和目标，把计划交给每天的自己，从今天的一小步开始。</p>
        <div class="empty-actions"><button class="button button-primary" type="button" data-action="new-task">＋ 创建第一份计划</button></div>
      </div>
      <div class="empty-illustration" aria-hidden="true"><span class="empty-spark one">✳</span><span class="empty-spark two">✦</span><div class="empty-page"><i class="empty-sprout"></i></div></div>
    </section>`;
  }

  function focusPanel(entries) {
    const content = entries.length ? `<div class="focus-date"><strong>${escapeHTML(todayLabel())}</strong><span>把注意力放在眼前这一件事</span></div><div class="focus-items">${entries.slice(0, 4).map(({ task, day, index }) => {
      const itemText = Array.isArray(day.tasks) && day.tasks.length ? day.tasks.slice(0, 2).join(' · ') : '按自己的节奏开始学习';
      return `<article class="focus-item ${day.completed ? 'is-done' : ''}"><button class="focus-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? '标记为未完成' : '标记为已完成'}：${escapeHTML(day.title)}" aria-pressed="${Boolean(day.completed)}">✓</button><div class="focus-item-copy"><strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(task.title)} · ${escapeHTML(itemText)}</small></div><span class="focus-minutes">${Number(day.minutes) || 0} 分钟</span></article>`;
    }).join('')}</div>${entries.length > 4 ? `<button class="text-link" type="button" data-nav="today">还有 ${entries.length - 4} 项，查看今日安排 →</button>` : ''}` : `<div class="empty-inline"><span class="empty-inline-mark" aria-hidden="true">↗</span><div class="empty-inline-copy"><strong>今天还没有安排学习任务</strong><p>${state.tasks.length ? '打开一份计划，看看接下来几天的安排。' : '先创建一份计划，今天的重点会出现在这里。'}</p></div>${state.tasks.length ? '<button class="button button-small button-outline" type="button" data-nav="plans">查看计划</button>' : '<button class="button button-small button-outline" type="button" data-action="new-task">创建计划</button>'}</div>`;
    return `<section class="panel focus-panel"><div class="panel-heading"><div><span class="panel-kicker">TODAY / 今日重点</span><h2>今天要做的事</h2><p>每天一小步，逐渐走近目标。</p></div><button class="text-link" type="button" data-nav="today">完整安排 →</button></div><div class="focus-content">${content}</div></section>`;
  }

  function statsPanel() {
    const value = stats();
    const hours = value.minutes / 60;
    const hourText = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, '');
    return `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">A LITTLE, EVERY DAY</span><h2>学习的痕迹</h2><p>只统计已保存的真实计划与完成状态。</p></div></div><div class="stats-grid"><div class="stat-card"><div class="stat-card-top"><span>学习计划</span><span class="stat-card-icon">▤</span></div><strong class="stat-value">${value.plans}<span class="stat-unit">份</span></strong></div><div class="stat-card"><div class="stat-card-top"><span>已完成天数</span><span class="stat-card-icon">✓</span></div><strong class="stat-value">${value.completed}<span class="stat-unit"> / ${value.days} 天</span></strong></div><div class="stat-card"><div class="stat-card-top"><span>计划投入</span><span class="stat-card-icon">◷</span></div><strong class="stat-value">${hourText}<span class="stat-unit">小时</span></strong></div></div></section>`;
  }

  function schedulePanel() {
    const today = localDateString();
    const upcoming = allDays().filter(entry => entry.day.date >= today).sort((a, b) => String(a.day.date).localeCompare(String(b.day.date))).slice(0, 5);
    let content;
    if (!upcoming.length) {
      content = `<p class="schedule-empty">${state.tasks.length ? '已有计划都已结束。可以重新测试，或创建新的学习计划。' : '创建计划后，未来的学习安排会沿着时间线展开。'}</p>`;
    } else {
      const grouped = new Map();
      upcoming.forEach(entry => {
        const key = entry.day.date || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
      });
      content = Array.from(grouped.entries()).map(([date, entries]) => `<div class="schedule-day ${date === today ? 'is-today' : ''}"><div class="schedule-day-date">${date === today ? '今天' : escapeHTML(formatDate(date, { month: 'numeric' }))}<strong>${escapeHTML(formatDate(date, { day: 'numeric' }))}</strong></div><div class="schedule-line">${entries.map(({ task, day }) => `<strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(task.title)} · ${Number(day.minutes) || 0} 分钟 · ${day.completed ? '已完成' : '待完成'}</small>`).join('')}</div></div>`).join('');
    }
    return `<section class="panel schedule-panel"><div class="panel-heading"><div><span class="panel-kicker">THE DAYS AHEAD</span><h2>接下来</h2><p>从今天起最近的学习安排。</p></div><button class="text-link" type="button" data-nav="plans">所有计划 →</button></div><div class="schedule-list">${content}</div></section>`;
  }

  function renderOverview() {
    const empty = state.tasks.length === 0;
    const welcome = `<section class="welcome-panel ${empty ? 'is-empty' : ''}"><div class="welcome-copy"><span class="eyebrow">A QUIET PLACE TO LEARN</span><h2>${escapeHTML(greet())}</h2><p>${empty ? '让目标落在纸上，让每天的行动变得清晰。' : '不需要一次走很远，只要记得回来，继续下一步。'}</p></div><div class="welcome-deco" aria-hidden="true"><div class="sun-disc"></div><div class="leaf-shape"></div><span>慢慢来</span></div></section>`;
    if (empty) return `${welcome}${emptyState()}`;
    return `${welcome}<div class="dashboard-grid"><div class="column-stack">${focusPanel(todayEntries())}${statsPanel()}</div><div class="column-stack">${schedulePanel()}<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">YOUR STUDY PLANS</span><h2>继续学习</h2><p>从保存的计划中选择下一步。</p></div><button class="text-link" type="button" data-nav="plans">查看全部 →</button></div><div class="material-list">${state.tasks.slice(0, 3).map(task => `<article class="material-card"><span class="file-mark" aria-hidden="true">学</span><div class="material-card-copy"><strong>${escapeHTML(task.title)}</strong><small>${countDays(task).filter(day => day.completed).length} / ${countDays(task).length} 天已完成</small></div><div class="material-card-actions"><button class="button button-small button-outline" type="button" data-action="open-plan" data-task-id="${escapeHTML(task.id)}">打开计划</button></div></article>`).join('')}</div></section></div></div>`;
  }

  function renderToday() {
    const entries = todayEntries();
    const header = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">TODAY / ${escapeHTML(localDateString())}</span><h1>今日安排</h1><p>${escapeHTML(todayLabel())}。把注意力放在当前这一步。</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-nav="plans">查看全部计划</button><button class="button button-primary" type="button" data-action="new-task">＋ 新建计划</button></div></div>`;
    if (!state.tasks.length) return `${header}${emptyState()}`;
    const todayList = entries.length ? `<div class="plan-list">${entries.map(({ task, day, index }) => `<article class="plan-card"><div class="plan-card-head"><div class="plan-card-title"><h3>${escapeHTML(day.title)}</h3><p>${escapeHTML(task.title)} · ${Number(day.minutes) || 0} 分钟</p></div><div class="plan-card-actions"><button class="button button-small button-outline" type="button" data-action="edit-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}">编辑今日内容</button></div></div><div class="plan-days"><div class="plan-day-row is-today"><div class="plan-day-date"><strong>${escapeHTML(formatDate(day.date, { month: 'numeric', day: 'numeric' }))}</strong>第 ${Number(day.day) || index + 1} 天</div><div class="plan-day-info"><strong>${escapeHTML(task.title)}</strong><small>${escapeHTML((day.tasks || []).join(' · '))}</small></div><div class="plan-day-right"><span class="plan-source">${escapeHTML(day.source || '计划安排')}</span><button class="tiny-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? '标记为未完成' : '标记为已完成'}" aria-pressed="${Boolean(day.completed)}">✓</button></div></div></div></article>`).join('')}</div>` : `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">TODAY / 留白</span><h2>今天没有安排好的学习任务</h2><p>已保存的计划还在这里，可以查看接下来的日程。</p></div></div><div class="focus-content"><div class="empty-inline"><span class="empty-inline-mark" aria-hidden="true">✳</span><div class="empty-inline-copy"><strong>空出来的时间也可以好好休息</strong><p>或者给下一个目标安排一个开始日期。</p></div><button class="button button-small button-outline" type="button" data-action="new-task">创建计划</button></div></div></section>`;
    return `${header}${todayList}${entries.length ? '<div class="page-head section-head-spaced"><div class="page-head-copy"><span class="eyebrow">NEXT STEPS</span><h2 class="section-page-title">接下来几天</h2><p>提前看看，不必一次完成所有事情。</p></div></div>' + renderUpcomingRows() : ''}`;
  }

  function renderUpcomingRows() {
    const today = localDateString();
    const upcoming = allDays().filter(entry => entry.day.date > today).sort((a, b) => String(a.day.date).localeCompare(String(b.day.date))).slice(0, 5);
    if (!upcoming.length) return '';
    return `<section class="panel"><div class="plan-days">${upcoming.map(({ task, day, index }) => dayRow(task, day, index, false)).join('')}</div></section>`;
  }

  function dayRow(task, day, index, editable = true) {
    const isToday = day.date === localDateString();
    const tasksPreview = Array.isArray(day.tasks) ? day.tasks.slice(0, 3).join(' · ') : '';
    return `<div class="plan-day-row ${isToday ? 'is-today' : ''}"><div class="plan-day-date"><strong>${escapeHTML(formatDate(day.date, { month: 'numeric', day: 'numeric' }))}</strong>第 ${Number(day.day) || index + 1} 天</div><div class="plan-day-info"><strong>${escapeHTML(day.title)}</strong><small>${escapeHTML(tasksPreview)}</small></div><div class="plan-day-right"><span class="plan-source">${escapeHTML(day.source || '计划安排')}</span><button class="tiny-check" type="button" data-action="toggle-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="${day.completed ? '标记为未完成' : '标记为已完成'}：${escapeHTML(day.title)}" aria-pressed="${Boolean(day.completed)}">✓</button>${editable ? `<button class="row-edit" type="button" data-action="edit-day" data-task-id="${escapeHTML(task.id)}" data-day-index="${index}" aria-label="编辑 ${escapeHTML(day.title)}" title="编辑这一天">✎</button>` : ''}</div></div>`;
  }

  function planCard(task, expanded = true) {
    const days = countDays(task);
    const completed = days.filter(day => day.completed).length;
    const summary = task.plan?.summary || task.goal || '';
    const mode = task.plan?.mode === 'ai' ? 'ai' : 'history';
    const modeLabel = task.plan?.mode === 'ai' ? 'AI 计划' : '历史计划';
    const warnings = Array.isArray(task.plan?.warnings) ? task.plan.warnings.filter(item => typeof item === 'string' && item.trim()) : [];
    const knowledge = Array.isArray(task.plan?.knowledge) && task.plan.knowledge.length
      ? `<section class="plan-knowledge" aria-label="知识清单"><div class="knowledge-heading"><span class="panel-kicker">KNOWLEDGE / 知识清单</span><strong>${task.plan.knowledge.length} 个知识点</strong></div><div class="knowledge-list">${task.plan.knowledge.map(item => `<article class="knowledge-item"><div class="knowledge-item-heading"><strong>${escapeHTML(item.title || '未命名知识点')}</strong><span class="knowledge-priority ${item.priority === '重点' ? 'is-focus' : ''}">${escapeHTML(item.priority || '了解')}</span></div><p>${escapeHTML(item.explanation || '')}</p>${item.source ? `<small>来源：${escapeHTML(item.source)}</small>` : ''}</article>`).join('')}</div></section>`
      : '<section class="plan-knowledge plan-knowledge-history"><span class="panel-kicker">KNOWLEDGE / 知识清单</span><p>这份旧计划没有单独保存知识清单，原有学习日程仍可查看。</p></section>';
    const body = expanded ? `${knowledge}<div class="plan-days">${days.map((day, index) => dayRow(task, day, index)).join('')}</div>` : '';
    const warningMarkup = warnings.length ? `<div class="plan-warnings" role="note"><strong>生成提示</strong><ul>${warnings.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : '';
    const quizNeedsAI = task.quiz && task.quiz.mode !== 'ai' && !task.quiz.result;
    const quizLabel = quizNeedsAI ? '生成 AI 测验' : task.quiz ? '查看测验' : '生成测验';
    const quizAction = quizNeedsAI ? 'retake-quiz' : 'open-test';
    return `<article class="plan-card"><div class="plan-card-head"><div class="plan-card-title"><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(summary)} · ${days.length} 天 · 已完成 ${completed} 天 · 开始于 ${escapeHTML(formatDate(task.startDate, { year: 'numeric', month: 'numeric', day: 'numeric' }))} <span class="mode-badge ${mode}">${modeLabel}</span></p></div><div class="plan-card-actions"><button class="button button-small button-outline" type="button" data-action="${quizAction}" data-task-id="${escapeHTML(task.id)}">${quizLabel}</button><button class="button button-small button-outline" type="button" data-action="export-task" data-task-id="${escapeHTML(task.id)}">导出 JSON</button><button class="button button-small button-quiet" type="button" data-action="delete-task" data-task-id="${escapeHTML(task.id)}">删除</button></div></div>${warningMarkup}${body}</article>`;
  }

  function summaryRow() {
    const value = stats();
    const rate = value.days ? `${value.rate}%` : '—';
    return `<div class="plan-summary-row"><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">▤</span><div><strong>${value.plans}</strong><small>份学习计划</small></div></div><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">✓</span><div><strong>${value.completed}<small> / ${value.days}</small></strong><small>天已完成 · ${rate}</small></div></div><div class="summary-chip"><span class="summary-chip-icon" aria-hidden="true">◷</span><div><strong>${(value.minutes / 60).toFixed(1).replace(/\.0$/, '')}<small> 小时</small></strong><small>计划投入时长</small></div></div></div>`;
  }

  function renderPlans(onlySelected = false) {
    const selected = onlySelected ? getTask(selectedTaskId) : null;
    const tasks = selected ? [selected] : onlySelected ? [] : state.tasks;
    const title = selected ? selected.title : '全部计划';
    const description = selected ? (selected.goal || selected.plan?.summary || '每天的安排可以按你的节奏调整。') : '查看每天的内容、来源和完成情况。';
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">YOUR LEARNING MAP</span><h1>${escapeHTML(title)}</h1><p>${escapeHTML(description)}</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-nav="materials">材料库</button><button class="button button-primary" type="button" data-action="new-task">＋ 新建计划</button></div></div>`;
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
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">YOUR READING DESK</span><h1>材料库</h1><p>查看随学习计划保存的文字材料。内容仅在本机保存，发送给模型前会再次征求同意。</p></div><div class="page-head-actions"><button class="button button-primary" type="button" data-action="new-task">＋ 添加材料</button></div></div>`;
    if (!materials.length) return `${head}<section class="empty-state"><div class="empty-state-copy"><span class="eyebrow">NO MATERIALS YET</span><h2>材料会跟着计划，一起留在这里。</h2><p>创建学习计划时，可以从本机选择 PDF、DOCX 或 PPTX 文件，之后随时预览文字内容。</p><div class="empty-actions"><button class="button button-primary" type="button" data-action="new-task">创建计划并添加材料</button></div></div><div class="empty-illustration" aria-hidden="true"><span class="empty-spark one">✳</span><span class="empty-spark two">✦</span><div class="empty-page"><i class="empty-sprout"></i></div></div></section>`;
    return `${head}<div class="materials-grid"><section class="panel"><div class="panel-heading"><div><span class="panel-kicker">SAVED TEXTS</span><h2>已导入的材料</h2><p>${materials.length} 份文件 · 来自已保存的计划</p></div></div><div class="material-list">${materials.map(material => {
      const ext = String(material.name || '').split('.').pop().slice(0, 4).toUpperCase();
      return `<article class="material-card"><span class="file-mark" aria-hidden="true">${escapeHTML(ext || '文档')}</span><div class="material-card-copy"><strong>${escapeHTML(material.name || '未命名材料')}</strong><small>${Number(material.units) || 0} 个章节 · ${Number(material.chars) || 0} 字 · ${escapeHTML(material.attachedTo.join('、'))}</small></div><div class="material-card-actions"><button class="button button-small button-outline" type="button" data-action="preview-library-material" data-material-id="${escapeHTML(material.id)}">预览文字</button></div></article>`;
    }).join('')}</div></section><aside class="panel source-card"><span class="panel-kicker">ON YOUR DEVICE</span><h3>一页一页，慢慢读。</h3><p>导入的材料会附在对应的学习计划中。只有你勾选同意后，已配置的模型服务才会收到本次计划或测验使用的材料文字。</p><div class="source-card-ornament" aria-hidden="true">页 · 章 · 节</div></aside></div>`;
  }

  function weakPointsText(value) {
    if (Array.isArray(value)) return value.map(item => String(item)).join('、');
    return String(value || '目前没有记录需要重点补充的内容。');
  }

  function renderResult(quiz) {
    if (!quiz?.result) return '';
    const result = quiz.result;
    const score = Number.isFinite(Number(result.score)) ? Number(result.score) : '—';
    const items = Array.isArray(result.items) ? result.items : [];
    const refDate = quiz.resultDate ? formatDate(quiz.resultDate, { year: 'numeric', month: 'long', day: 'numeric' }) : '时间未记录';
    const isAI = result.mode === 'ai' || quiz.mode === 'ai';
    return `<section class="result-panel" aria-live="polite"><div class="result-panel-head"><div><span class="panel-kicker">${isAI ? 'AI 参考反馈' : '历史已提交结果'}</span><h3>${isAI ? '把反馈当作下一次学习的线索' : '旧版测验结果留作历史记录'}</h3></div><div class="result-score">${escapeHTML(score)}<small>满分 100</small></div></div><p class="result-feedback">${escapeHTML(result.feedback || '本次反馈已保存。')}</p><p class="result-feedback">${isAI ? 'AI 反馈仅供参考' : '此结果仅供查看，旧版题目不再接受新的回答'} · ${escapeHTML(refDate)}</p>${items.length ? `<div class="result-items">${items.map((item, index) => `<div class="result-item"><strong>${index + 1}</strong><p>${escapeHTML(item.feedback || '已记录')}</p><span>${Number.isFinite(Number(item.score)) ? `${escapeHTML(item.score)} 分` : ''}</span></div>`).join('')}</div>` : ''}<div class="weak-points"><strong>接下来可以补一补</strong><p>${escapeHTML(weakPointsText(result.weakPoints))}</p></div></section>`;
  }

  function quizConsentCard(task) {
    if (!needsMaterialConsent(task)) return '';
    const checked = sessionConsent.has(task.id);
    return `<div class="quiz-side-card"><h3>材料隐私确认</h3><p>本计划包含材料文字。生成 AI 测验或提交答案前，材料文字会发送到已配置的服务。</p><label class="consent-row"><input type="checkbox" data-action="quiz-consent" data-task-id="${escapeHTML(task.id)}" ${checked ? 'checked' : ''}><span><strong>我同意本次向服务发送材料文字</strong><small>同意状态只保存在当前应用会话中。</small></span></label></div>`;
  }

  function renderQuiz(task) {
    if (!task) return `${emptyState()}`;
    const days = countDays(task);
    const lastDay = days.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
    const beforeEnd = lastDay?.date && localDateString() < lastDay.date;
    const quiz = task.quiz;
    const introNote = quiz?.mode === 'ai'
      ? `${quiz.generatedDate ? `题目生成于 ${formatDate(quiz.generatedDate, { year: 'numeric', month: 'long', day: 'numeric' })}。` : '题目生成日期未记录。'}${beforeEnd ? `计划末日是 ${formatDate(lastDay.date, { year: 'numeric', month: 'long', day: 'numeric' })}，现在可以提前自测。` : ''}AI 题目与反馈仅供参考。`
      : '旧版测验仅作为历史记录保留。';
    const head = `<div class="page-head"><div class="page-head-copy"><span class="eyebrow">RECALL / 复习与检验</span><h1>${escapeHTML(task.title)}</h1><p>任何时候都可以查看或参加测试，测验帮助你发现下一步要补上的内容。</p></div><div class="page-head-actions"><button class="button button-outline" type="button" data-action="open-plan" data-task-id="${escapeHTML(task.id)}">返回计划</button></div></div>`;
    if (quizBusyTaskId === task.id) return `${head}<section class="panel quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">正在准备</span><h2>正在生成阶段测验…</h2><p>题目会依据这份计划生成。</p></div></section>`;
    if (!quiz?.questions?.length) {
      const consentRequired = needsMaterialConsent(task) && !sessionConsent.has(task.id);
      return `${head}<div class="quiz-layout"><div class="quiz-main"><section class="quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">5 QUESTIONS / AI 阶段测验</span><h2>开始一场阶段测验</h2><p>AI 会根据学习计划生成五道题，并在提交后评估你的回答。</p></div><div class="quiz-intro-note">${escapeHTML(introNote)}</div></section>${consentRequired ? `<div class="form-message warning-message">本计划包含材料文字。请先在右侧勾选同意，之后才会向模型服务发送请求；未同意时不会触发远程生成。</div>` : ''}<div class="quiz-submit-row"><span class="quiz-submit-hint">${consentRequired ? '当前还没有请求模型服务。' : '参考答案和评分标准会在提交后显示。'}</span><button class="button button-primary" type="button" data-action="generate-quiz" data-task-id="${escapeHTML(task.id)}">生成阶段测验</button></div></div><aside class="quiz-side"><section class="quiz-side-card"><h3>这份测验</h3><p>共 5 道题，题型可包含计算、代码和论述。所有回答均由模型评分。</p></section>${quizConsentCard(task)}</aside></div>`;
    }
    const questions = quiz.questions.slice(0, 5);
    if (questions.length !== 5) {
      return `${head}<div class="form-message error-message">服务返回了 ${questions.length} 道题，当前测验需要 5 道题。请重新生成测验或检查服务配置。</div><button class="button button-outline" type="button" data-action="retake-quiz" data-task-id="${escapeHTML(task.id)}">重新生成</button>`;
    }
    const submitted = Boolean(quiz.result);
    const isLegacy = quiz.mode !== 'ai';
    if (isLegacy && !submitted) {
      return `${head}<section class="panel legacy-quiz-note"><span class="panel-kicker">历史题目</span><h2>这份旧版测验不能继续作答</h2><p>重新生成 AI 测验后，你就可以作答并获得模型评分。</p><button class="button button-primary" type="button" data-action="retake-quiz" data-task-id="${escapeHTML(task.id)}">生成 AI 测验</button></section>`;
    }
    const answerMap = quiz.answers || {};
    const draftMap = submitted ? {} : quizDrafts.get(quizDraftKey(task)) || {};
    const questionFields = questions.map((question, index) => {
      const answer = submitted ? (answerMap[question.id] || {}) : (draftMap[question.id] || answerMap[question.id] || {});
      const reference = submitted && (question.reference || question.rubric) ? `<details class="question-reference-details"><summary>查看参考要点与评分标准</summary><div class="question-reference">${question.reference ? `<strong>参考要点</strong><p>${escapeHTML(question.reference)}</p>` : ''}${question.rubric ? `<strong>评分标准</strong><small>${escapeHTML(question.rubric)}</small>` : ''}</div></details>` : '';
      return `<article class="quiz-question"><div class="question-head"><span class="question-index">${index + 1}</span><span>${isLegacy ? '历史题目' : 'AI 测验'}</span></div><h3>${escapeHTML(question.question || '')}</h3><textarea name="answer-${index}" maxlength="4000" ${isLegacy ? '' : 'data-answer'} data-qid="${escapeHTML(question.id)}" aria-label="第 ${index + 1} 题答案" placeholder="用自己的话写下理解…" ${submitted || isLegacy ? 'readonly' : 'required'}>${escapeHTML(answer.text || '')}</textarea>${reference}</article>`;
    }).join('');
    const action = isLegacy
      ? `<button class="button button-primary" type="button" data-action="retake-quiz" data-task-id="${escapeHTML(task.id)}">生成 AI 测验</button>`
      : submitted
        ? `<button class="button button-outline" type="button" data-action="retake-quiz" data-task-id="${escapeHTML(task.id)}">重新生成 AI 测验</button>`
        : `<button class="button button-primary" type="submit" id="submitQuiz">提交本次测试</button>`;
    const consentMissing = !isLegacy && needsMaterialConsent(task) && !sessionConsent.has(task.id);
    return `${head}<div class="quiz-layout"><form id="quizForm" class="quiz-main" data-task-id="${escapeHTML(task.id)}"><section class="quiz-intro"><div class="quiz-intro-copy"><span class="panel-kicker">${isLegacy ? '历史测验记录' : 'AI ASSISTED / AI 测验'}</span><h2>${escapeHTML(task.plan?.difficulty || '学习测验')}</h2><p>${isLegacy ? '仅显示此前已提交的历史答案与结果。' : '用自己的表达完成回答，提交后由模型评分。'}</p></div><div class="quiz-intro-note">${escapeHTML(introNote)}</div></section>${consentMissing ? '<div class="form-message warning-message">AI 评分会发送本计划材料文字。请先在右侧勾选同意；未同意时不会提交远程请求。</div>' : ''}${questionFields}${submitted ? renderResult(quiz) : ''}<div class="quiz-submit-row"><span class="quiz-submit-hint">${submitted ? '结果已保存在这份学习计划中。' : '参考答案与评分标准会在提交后显示。'}</span>${action}</div></form><aside class="quiz-side"><section class="quiz-side-card"><h3>本次练习</h3><p>主题：${escapeHTML(task.title)}<br>模式：${isLegacy ? '历史记录' : 'AI 参考反馈'}<br>题目：5 道</p></section>${quizConsentCard(task)}<section class="quiz-side-card"><h3>回顾与反馈</h3><p>所有新测验答案由模型评分。参考答案和评分标准只在提交后显示。</p></section></aside></div>`;
  }

  function render() {
    updateHeader();
    renderSidebar();
    setNavigation();
    const locked = !apiEnabled();
    $$('[data-nav]').forEach(button => { button.disabled = locked; });
    $$('[data-action]').forEach(button => { button.disabled = locked && !['settings', 'profile'].includes(button.dataset.action); });
    if (locked) {
      viewHost.innerHTML = `<section class="service-locked"><div class="service-lock-mark" aria-hidden="true">◈</div><span class="eyebrow">MODEL SERVICE REQUIRED</span><h1>先配置模型服务</h1><p>配置模型地址、名称和 API Key 后，才能创建学习计划、生成知识清单和进行 AI 测验。</p><p class="service-lock-note">本地旧计划会在配置完成后重新显示，不会因为当前未配置而删除。</p><button class="button button-primary" type="button" data-action="settings">打开 API 设置</button></section>`;
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
    if (!api?.loadState) throw new Error('无法连接本地学习服务，请重新打开应用。');
    const fresh = await api.loadState();
    if (expectedEpoch !== configEpoch) return false;
    state.settings = fresh?.settings || { endpoint: '', model: '', hasKey: false, configured: false };
    state.profile = fresh?.profile || { nickname: '', avatar: '' };
    state.tasks = apiEnabled() && Array.isArray(fresh?.tasks) ? fresh.tasks : [];
    stateLoaded = true;
    if (selectedTaskId && !getTask(selectedTaskId)) selectedTaskId = null;
    if (!apiEnabled()) {
      sessionConsent.clear();
      ['createDialog', 'editDayDialog', 'materialDialog'].forEach(id => {
        const dialog = document.getElementById(id);
        if (dialog?.open) dialog.close();
      });
      selectedTaskId = null;
      currentView = 'overview';
    }
    render();
    return true;
  }

  async function saveTask(task, nextView = currentView, expectedEpoch = configEpoch) {
    if (expectedEpoch !== configEpoch || !apiEnabled()) throw new Error('模型服务配置已变化，请重新操作。');
    if (!api?.saveTask) throw new Error('学习服务未连接，无法保存任务。');
    const saved = await api.saveTask(task);
    if (expectedEpoch !== configEpoch || !apiEnabled()) return null;
    const fresh = await api.loadState();
    if (expectedEpoch !== configEpoch || !apiEnabled()) return null;
    state.tasks = Array.isArray(fresh?.tasks) ? fresh.tasks : [];
    state.settings = fresh?.settings || state.settings;
    if (!apiEnabled()) {
      state.tasks = [];
      selectedTaskId = null;
      currentView = 'overview';
      render();
      return null;
    }
    selectedTaskId = saved.id;
    currentView = nextView;
    render();
    return saved;
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
    $('#clarifySubmit').textContent = '开始讨论目标';
    setMessage($('#clarifyError'), '');
    updateCreateControls();
  }

  function renderGoalDiscussion() {
    const host = $('#clarifyMessages');
    host.innerHTML = discussionMessages.map(message => `<div class="discussion-message is-${message.role}"><span>${message.role === 'user' ? '你' : '学习助手'}</span><p>${escapeHTML(message.content)}</p></div>`).join('');
    const brief = $('#confirmedBrief');
    if (discussionBrief) {
      const scope = Array.isArray(discussionBrief.scope) ? discussionBrief.scope : [];
      const prerequisites = Array.isArray(discussionBrief.prerequisites) ? discussionBrief.prerequisites : [];
      const outcomes = Array.isArray(discussionBrief.outcomes) ? discussionBrief.outcomes : [];
      brief.innerHTML = `<div class="brief-heading"><span class="panel-kicker">LEARNING BRIEF</span><strong>${confirmedBrief ? '学习范围已确认' : '建议的学习范围'}</strong></div><p class="brief-goal">${escapeHTML(discussionBrief.goal || '')}</p>${scope.length ? `<div class="brief-list"><strong>学习范围</strong><ul>${scope.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}${prerequisites.length ? `<div class="brief-list"><strong>先修知识</strong><ul>${prerequisites.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}${outcomes.length ? `<div class="brief-list"><strong>预期成果</strong><ul>${outcomes.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}`;
      brief.hidden = false;
      $('#confirmBrief').hidden = !discussionReady || Boolean(confirmedBrief);
      $('#confirmBrief').textContent = confirmedBrief ? '已确认' : '确认学习范围';
    } else {
      brief.innerHTML = '';
      brief.hidden = true;
      $('#confirmBrief').hidden = true;
    }
    $('#clarifySubmit').textContent = discussionMessages.length ? '发送补充' : '开始讨论目标';
    host.scrollTop = host.scrollHeight;
  }

  function updateCreateControls() {
    const busy = Boolean(createActivity);
    setBusy($('#createSubmit'), createActivity?.type === 'plan', '正在生成学习计划');
    $('#createSubmit').disabled = busy;
    $('#clarifySubmit').disabled = busy;
    $('#confirmBrief').disabled = busy;
    $('#clarifyInput').disabled = createActivity?.type === 'clarify';
    if (createActivity?.type === 'clarify') $('#clarifySubmit').textContent = '正在讨论…';
    else if ($('#createDialog').open) renderGoalDiscussion();
  }

  function currentCreateInput() {
    const form = $('#createForm');
    return {
      title: form.elements.title.value.trim(),
      goal: form.elements.goal.value.trim(),
      level: form.elements.level.value,
      learningMode: form.elements.learningMode.value,
      startDate: form.elements.startDate.value,
      days: Number(form.elements.days.value),
      minutesPerDay: Number(form.elements.minutesPerDay.value),
      materials: clone(createMaterials)
    };
  }

  function createInputSnapshot() {
    const input = currentCreateInput();
    return JSON.stringify({ ...input, materials: input.materials.map(material => ({ id: material.id, name: material.name, chars: material.chars, text: material.text })) });
  }

  function invalidateGoalDiscussion() {
    resetGoalDiscussion();
  }

  function openCreateDialog() {
    if (!stateLoaded) return toast('正在读取本地学习数据，请稍候再创建计划。');
    if (!apiEnabled()) return openSettings();
    const form = $('#createForm');
    form.reset();
    form.elements.startDate.value = localDateString();
    form.elements.days.value = '14';
    form.elements.minutesPerDay.value = '60';
    createMaterials = [];
    createSessionId += 1;
    createActivity = null;
    resetGoalDiscussion();
    $('#createConsent').checked = false;
    setMessage($('#createError'), '');
    renderCreateMaterials();
    refreshCreateConsent();
    $('#createDialog').showModal();
    window.setTimeout(() => form.elements.title.focus(), 0);
  }

  function refreshCreateConsent() {
    const shouldShow = apiEnabled() && createMaterials.some(material => typeof material.text === 'string' && material.text.trim());
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
    host.innerHTML = createMaterials.map((material, index) => `<div class="attachment-item"><span class="attachment-name" title="${escapeHTML(material.name)}">${escapeHTML(material.name)} <span>· ${Number(material.chars) || 0} 字</span></span><span class="attachment-item-actions"><button class="inline-link" type="button" data-action="preview-create-material" data-material-index="${index}">预览</button><button class="inline-remove" type="button" data-action="remove-create-material" data-material-index="${index}" aria-label="移除 ${escapeHTML(material.name)}">移除</button></span></div>`).join('');
    refreshCreateConsent();
  }

  async function importMaterials() {
    if (!apiEnabled()) return openSettings();
    if (createActivity) return toast('当前操作完成后再添加材料。');
    if (!api?.importMaterials) return toast('当前运行环境没有文件导入服务。');
    const sessionId = createSessionId;
    const epoch = configEpoch;
    try {
      const imported = await api.importMaterials();
      if (sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled() || !$('#createDialog').open) return;
      if (!Array.isArray(imported) || imported.length === 0) return;
      const existing = new Set(createMaterials.map(item => item.id));
      const added = imported.filter(item => !existing.has(item.id));
      if (!added.length) return;
      createMaterials.push(...added);
      invalidateGoalDiscussion();
      renderCreateMaterials();
      toast(`已添加 ${added.length} 份材料，可预览或移除。`);
    } catch (error) {
      if (sessionId === createSessionId && epoch === configEpoch && $('#createDialog').open) setMessage($('#createError'), error.message || '导入材料失败，请检查文件后重试。');
    }
  }

  function showMaterial(material) {
    if (!material) return;
    $('#materialTitle').textContent = material.name || '未命名材料';
    $('#materialMeta').textContent = `${Number(material.units) || 0} 个章节 · ${Number(material.chars) || 0} 字`;
    $('#materialText').textContent = typeof material.text === 'string' ? material.text : '这份材料没有可预览的文字内容。';
    $('#materialDialog').showModal();
  }

  function findMaterial(id) {
    for (const task of state.tasks) {
      const found = taskMaterials(task).find(material => material.id === id);
      if (found) return found;
    }
    return null;
  }

  function validateCreateInput(input, errorElement = $('#createError')) {
    if (!input.title || !input.goal) return setMessage(errorElement, '请填写学习主题和目标。', 'warning'), false;
    if (!input.startDate || !dateObject(input.startDate)) return setMessage(errorElement, '请选择有效的开始日期。'), false;
    if (!Number.isInteger(input.days) || input.days < 2 || input.days > 180) return setMessage(errorElement, '学习周期需要在 2 到 180 天之间。'), false;
    if (!Number.isInteger(input.minutesPerDay) || input.minutesPerDay < 15 || input.minutesPerDay > 480) return setMessage(errorElement, '每天投入需要在 15 到 480 分钟之间。'), false;
    if (!['exam', 'balanced', 'deep'].includes(input.learningMode)) return setMessage(errorElement, '请选择有效的学习方式。'), false;
    return true;
  }

  function hasUnconsentedMaterials(input) {
    return input.materials.some(material => typeof material.text === 'string' && material.text.trim()) && !$('#createConsent').checked;
  }

  async function clarifyGoal() {
    if (!apiEnabled()) return openSettings();
    if (createActivity) return;
    const input = currentCreateInput();
    setMessage($('#clarifyError'), '');
    if (!input.goal) return setMessage($('#clarifyError'), '请先填写学习目标，再开始讨论。', 'warning');
    if (!validateCreateInput(input, $('#clarifyError'))) return;
    if (hasUnconsentedMaterials(input)) return setMessage($('#clarifyError'), '本次计划包含材料文字。请先勾选同意，之后才会发送给模型服务。', 'warning');

    const sessionId = createSessionId;
    const epoch = configEpoch;
    const snapshot = createInputSnapshot();
    const requestId = makeId();
    const notes = $('#clarifyInput').value.trim();
    const requestMessages = discussionMessages.map(message => ({ ...message }));
    if (!requestMessages.length) requestMessages.push({ role: 'user', content: input.goal });
    else if (!notes) return setMessage($('#clarifyError'), '请写下补充说明或回复，再继续讨论。', 'warning');
    if (notes) requestMessages.push({ role: 'user', content: notes });
    if (requestMessages.length + 1 > 20) return setMessage($('#clarifyError'), '讨论最多保留 20 条消息，请确认学习范围或开始新的讨论。', 'warning');
    if (requestMessages.some(message => message.content.length > 4000)) return setMessage($('#clarifyError'), '每条讨论消息最多 4000 个字符。', 'warning');

    createActivity = { id: requestId, type: 'clarify' };
    updateCreateControls();
    try {
      if (!api?.clarifyGoal) throw new Error('当前版本暂不支持学习目标讨论，请直接生成计划。');
      const result = await api.clarifyGoal({ input, messages: requestMessages });
      if (sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled() || snapshot !== createInputSnapshot() || createActivity?.id !== requestId) return;
      if (!result || typeof result.reply !== 'string' || result.reply.length > 4000) throw new Error('服务没有返回有效的讨论回复，请重试。');
      discussionMessages = [...requestMessages, { role: 'assistant', content: result.reply }];
      discussionReady = Boolean(result.ready && result.brief && typeof result.brief === 'object');
      discussionBrief = discussionReady ? clone(result.brief) : null;
      confirmedBrief = null;
      $('#clarifyInput').value = '';
      renderGoalDiscussion();
    } catch (error) {
      if (sessionId === createSessionId && epoch === configEpoch && createActivity?.id === requestId) setMessage($('#clarifyError'), error.message || '学习目标讨论失败，请稍后重试。');
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
    if (createActivity) return toast('当前生成操作完成后再继续。');
    const form = $('#createForm');
    const error = $('#createError');
    setMessage(error, '');
    const input = currentCreateInput();
    if (!validateCreateInput(input, error)) return;
    if (hasUnconsentedMaterials(input)) return setMessage(error, '本次计划包含材料文字。请先勾选同意，之后才会发送给模型服务。', 'warning');
    const sessionId = createSessionId;
    const epoch = configEpoch;
    const snapshot = createInputSnapshot();
    const requestId = makeId();
    createActivity = { id: requestId, type: 'plan' };
    const briefSnapshot = confirmedBrief ? clone(confirmedBrief) : null;
    updateCreateControls();
    try {
      const requestInput = briefSnapshot ? { ...input, brief: briefSnapshot } : input;
      const plan = await api.generatePlan(requestInput);
      if (sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled() || snapshot !== createInputSnapshot() || createActivity?.id !== requestId) return;
      if (!plan || !Array.isArray(plan.days) || plan.days.length !== input.days) throw new Error('服务返回的计划天数与学习周期不一致，请重试。');
      if (!Array.isArray(plan.knowledge) || plan.knowledge.length < 1 || plan.knowledge.length > 30) throw new Error('服务没有返回有效的知识清单，请检查模型配置后重试。');
      const task = { id: makeId(), ...input, ...(briefSnapshot ? { brief: briefSnapshot } : {}), plan, createdAt: new Date().toISOString() };
      if (hasMaterialText(task)) sessionConsent.add(task.id);
      const saved = await saveTask(task, 'plan-detail', epoch);
      if (!saved || sessionId !== createSessionId || epoch !== configEpoch || !apiEnabled()) return;
      $('#createDialog').close();
      toast('学习计划已生成并保存。');
    } catch (errorValue) {
      if (sessionId === createSessionId && epoch === configEpoch) setMessage(error, errorValue.message || '生成学习计划失败，请稍后重试。');
    } finally {
      if (createActivity?.id === requestId) {
        createActivity = null;
        updateCreateControls();
      }
    }
  }

  function makeId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function renderAvatar(element, avatar) {
    element.replaceChildren();
    if (!avatar) { element.textContent = '学'; return; }
    const image = document.createElement('img');
    image.src = avatar;
    image.alt = '我的头像';
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
    if (!stateLoaded) return toast('正在读取本地设置，请稍候。');
    profileSession += 1;
    profileAvatar = state.profile.avatar;
    $('#profileNickname').value = state.profile.nickname;
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
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
      if (file.size > 5 * 1024 * 1024) throw new Error('头像图片不能超过 5 MB。');
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取这张图片，请重新选择。'));
        reader.readAsDataURL(file);
      });
      const image = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('这张图片无法打开，请选择其他图片。'));
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
      if (session === profileSession) setMessage($('#profileError'), error.message || '无法设置头像，请重试。');
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
      toast('头像和昵称已保存。');
    } catch (error) {
      if (session === profileSession) setMessage($('#profileError'), error.message || '保存失败，请重试。');
    } finally {
      if (session === profileSession) setProfileBusy(false);
    }
  }

  function openSettings() {
    if (!stateLoaded) return toast('正在读取本地设置，请稍候再打开 API 设置。');
    $('#apiEndpoint').value = state.settings?.endpoint || '';
    $('#apiModel').value = state.settings?.model || '';
    $('#apiKey').value = '';
    $('#apiKey').disabled = false;
    $('#apiKey').placeholder = state.settings?.hasKey ? '留空以保留已保存的 Key' : '填写 API Key';
    $('#keyState').textContent = state.settings?.hasKey ? '已保存 API Key（内容不会读取或显示）' : '尚未保存 API Key';
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
      setMessage(message, '测试连接前请填写 API 地址、模型名称和有效的 API Key。', 'warning');
      return;
    }
    const requestId = ++settingsRequestId;
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
      $('#apiKey').placeholder = state.settings?.hasKey ? '留空以保留已保存的 Key' : '填写 API Key';
      $('#keyState').textContent = state.settings?.hasKey ? '已保存 API Key（内容不会读取或显示）' : '尚未保存 API Key';
      $('#clearKeyRow').hidden = !state.settings?.hasKey;
      $('#clearKey').checked = false;
      if (!testAfterSave) {
        $('#settingsDialog').close();
        toast(result.keySessionOnly ? '配置已保存。系统加密当前不可用，Key 仅保存在本次运行内存中，下次启动需要重新填写。' : 'API 设置已保存。');
        return;
      }
      if (result.keySessionOnly) setMessage(message, 'Key 当前仅保存在本次运行内存中。正在测试连接…', 'warning');
      else setMessage(message, '配置已保存，正在测试连接…', 'success');
      const testResult = await api.testConnection();
      if (requestId !== settingsRequestId || epoch !== configEpoch) return;
      if (!testResult?.ok) throw new Error(testResult?.message || '连接测试失败，请检查服务返回。');
      const suffix = result.keySessionOnly ? ' Key 仅保存在本次运行内存中，下次启动需要重新填写。' : '';
      setMessage(message, `${testResult.message || '服务连接成功。'}${suffix}`, 'success');
      render();
    } catch (error) {
      if (requestId === settingsRequestId && epoch === configEpoch) setMessage(message, error.message || (testAfterSave ? '连接测试失败，请检查地址、模型和 Key。' : '保存 API 设置失败。'));
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
      const saved = await saveTask(next, currentView);
      if (!saved) return;
      toast(next.plan.days[index].completed ? '已记录这一天的完成。' : '已将这一天恢复为未完成。');
    } catch (error) {
      if (apiEnabled()) toast(error.message || '保存完成状态失败。');
    }
  }

  function openEditDay(taskId, index) {
    const task = getTask(taskId);
    const day = task && countDays(task)[index];
    if (!task || !day) return;
    editingTaskId = taskId;
    $('#editDayIndex').value = String(index);
    $('#editDayEyebrow').textContent = `第 ${Number(day.day) || index + 1} 天 · ${formatDate(day.date, { month: 'long', day: 'numeric' })}`;
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
    if (!task || !countDays(task)[index]) return setMessage($('#editDayError'), '找不到要编辑的计划日期，请关闭后重试。');
    if (!title) return setMessage($('#editDayError'), '请填写当天标题。');
    if (!tasks.length) return setMessage($('#editDayError'), '请至少保留一项学习任务。');
    const next = clone(task);
    next.plan.days[index].title = title;
    next.plan.days[index].tasks = tasks;
    try {
      const saved = await saveTask(next, currentView);
      if (!saved) return;
      $('#editDayDialog').close();
      toast('每日安排已保存。');
    } catch (error) {
      if (apiEnabled()) setMessage($('#editDayError'), error.message || '保存每日安排失败，请重试。');
    }
  }

  async function deleteTask(taskId) {
    if (!apiEnabled()) return openSettings();
    const task = getTask(taskId);
    if (!task) return;
    const confirmed = window.confirm(`确定删除“${task.title}”吗？\n\n这会删除计划、材料文字、完成记录和测验结果，无法撤销。`);
    if (!confirmed) return;
    const epoch = configEpoch;
    try {
      const result = await api.deleteTask(taskId);
      if (epoch !== configEpoch || !apiEnabled()) return;
      if (result !== true) throw new Error('删除没有完成，请重试。');
      const reloaded = await reloadState(epoch);
      if (!reloaded || epoch !== configEpoch || !apiEnabled()) return;
      sessionConsent.delete(taskId);
      toast('学习计划已删除。');
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || '删除学习计划失败。');
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
    const safeTitle = String(task.title || '学习计划').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 70) || '学习计划';
    link.href = url;
    link.download = `${safeTitle}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('任务 JSON 已导出，不包含 API 配置。');
  }

  async function openTest(taskId, retake = false) {
    if (!apiEnabled()) return openSettings();
    const task = getTask(taskId);
    if (!task) return;
    if (retake && task.quiz?.result) {
      const confirmed = window.confirm('重新测试会替换这份计划中已保存的答案和反馈。确定开始新的测试吗？');
      if (!confirmed) return;
    }
    const mustGenerate = retake || !task.quiz?.questions?.length;
    if (mustGenerate && quizBusyTaskId) return toast('已有测验正在生成，请稍候。');
    selectedTaskId = task.id;
    currentView = 'quiz';
    if (!mustGenerate) {
      render();
      return;
    }
    if (quizRequests.has(task.id)) return toast('这份测验正在生成，请稍候。');
    if (needsMaterialConsent(task) && !sessionConsent.has(task.id)) {
      render();
      toast('请先确认是否允许发送本计划的材料文字。');
      return;
    }
    const previousQuestions = JSON.stringify(task.quiz?.questions || null);
    const previousGeneratedDate = task.quiz?.generatedDate || '';
    const taskSnapshot = JSON.stringify(task);
    const epoch = configEpoch;
    const requestId = makeId();
    quizRequests.set(task.id, requestId);
    quizBusyTaskId = task.id;
    render();
    try {
      const quiz = await api.generateQuiz(task);
      if (epoch !== configEpoch || !apiEnabled() || quizRequests.get(taskId) !== requestId) return;
      if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length !== 5) throw new Error('服务没有返回 5 道题，请检查配置后重试。');
      const latest = getTask(taskId);
      if (!latest) {
        toast('计划已删除，生成的测验没有保存。');
        return;
      }
      if (JSON.stringify(latest) !== taskSnapshot || JSON.stringify(latest.quiz?.questions || null) !== previousQuestions || (latest.quiz?.generatedDate || '') !== previousGeneratedDate) {
        toast('这份计划中的测验已更新，旧请求的结果没有保存。');
        return;
      }
      const next = clone(latest);
      next.quiz = { ...quiz, generatedDate: localDateString() };
      delete next.quiz.answers;
      delete next.quiz.result;
      delete next.quiz.resultDate;
      const saved = await saveTask(next, 'quiz', epoch);
      if (!saved) return;
      quizDrafts.delete(quizDraftKey(latest));
      quizDrafts.delete(quizDraftKey(next));
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) {
        render();
        toast(error.message || '生成测验失败，请稍后重试。');
      }
    } finally {
      if (quizRequests.get(taskId) === requestId) {
        quizRequests.delete(taskId);
        if (quizBusyTaskId === taskId) quizBusyTaskId = null;
        render();
      }
    }
  }

  async function submitQuiz(event) {
    event.preventDefault();
    if (!apiEnabled()) return openSettings();
    const form = event.target.closest('#quizForm');
    const taskId = form.dataset.taskId;
    const task = getTask(taskId);
    if (!task?.quiz?.questions || task.quiz.mode !== 'ai' || task.quiz.result) return;
    if (quizGradeRequests.has(taskId)) return;
    const requestedQuestions = JSON.stringify(task.quiz.questions);
    const requestedGeneratedDate = task.quiz.generatedDate || '';
    const taskSnapshot = JSON.stringify(task);
    const epoch = configEpoch;
    if (needsMaterialConsent(task) && !sessionConsent.has(task.id)) {
      toast('请先勾选同意，AI 评分才会向模型服务发送请求。');
      return;
    }
    const answers = {};
    const questionFields = $$('[data-answer]', form);
    for (let index = 0; index < questionFields.length; index += 1) {
      const answerField = questionFields[index];
      const id = answerField.dataset.qid;
      const text = answerField.value.trim();
      if (!text) return toast(`请先填写第 ${index + 1} 题的回答。`);
      answers[id] = { text };
    }
    const button = $('#submitQuiz', form);
    const requestId = makeId();
    quizGradeRequests.add(taskId);
    quizRequests.set(`grade:${taskId}`, requestId);
    setBusy(button, true, '正在生成反馈');
    try {
      const result = await api.gradeQuiz({ task, answers });
      if (epoch !== configEpoch || !apiEnabled() || quizRequests.get(`grade:${taskId}`) !== requestId) return;
      if (!result || typeof result !== 'object') throw new Error('服务没有返回有效的反馈结果。');
      const latest = getTask(taskId);
      if (!latest) {
        toast('计划已删除，本次反馈没有保存。');
        return;
      }
      if (JSON.stringify(latest) !== taskSnapshot || JSON.stringify(latest.quiz?.questions || null) !== requestedQuestions || (latest.quiz?.generatedDate || '') !== requestedGeneratedDate) {
        toast('这份计划的测验题目已更新，旧评分没有保存。');
        return;
      }
      const next = clone(latest);
      next.quiz.answers = answers;
      next.quiz.result = result;
      next.quiz.resultDate = localDateString();
      const saved = await saveTask(next, 'quiz', epoch);
      if (!saved) return;
      quizDrafts.delete(quizDraftKey(next));
      toast('测试结果和反馈已保存。');
    } catch (error) {
      if (epoch === configEpoch && apiEnabled()) toast(error.message || '提交测试失败，请重试。');
    } finally {
      setBusy(button, false);
      if (quizRequests.get(`grade:${taskId}`) === requestId) quizRequests.delete(`grade:${taskId}`);
      quizGradeRequests.delete(taskId);
    }
  }

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
    if (action === 'new-task') openCreateDialog();
    else if (action === 'settings') openSettings();
    else if (action === 'profile') openProfile();
    else if (action === 'import-create') await importMaterials();
    else if (action === 'remove-create-material') {
      createMaterials.splice(Number(button.dataset.materialIndex), 1);
      invalidateGoalDiscussion();
      renderCreateMaterials();
    } else if (action === 'preview-create-material') showMaterial(createMaterials[Number(button.dataset.materialIndex)]);
    else if (action === 'preview-library-material') showMaterial(findMaterial(button.dataset.materialId));
    else if (action === 'open-plan') openPlan(taskId);
    else if (action === 'toggle-day') await toggleDay(taskId, Number(button.dataset.dayIndex));
    else if (action === 'edit-day') openEditDay(taskId, Number(button.dataset.dayIndex));
    else if (action === 'delete-task') await deleteTask(taskId);
    else if (action === 'export-task') exportTask(taskId);
    else if (action === 'open-test') await openTest(taskId);
    else if (action === 'generate-quiz') await openTest(taskId);
    else if (action === 'retake-quiz') await openTest(taskId, true);
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
    if (['title', 'goal', 'level', 'learningMode', 'startDate', 'days', 'minutesPerDay'].includes(event.target.name)) {
      invalidateGoalDiscussion();
      setMessage($('#createError'), '');
    }
  });
  $('#createForm').addEventListener('change', event => {
    if (['title', 'goal', 'level', 'learningMode', 'startDate', 'days', 'minutesPerDay'].includes(event.target.name)) {
      invalidateGoalDiscussion();
      setMessage($('#createError'), '');
    }
  });
  $('#clarifySubmit').addEventListener('click', clarifyGoal);
  $('#confirmBrief').addEventListener('click', () => {
    if (createActivity || !discussionReady || !discussionBrief) return;
    confirmedBrief = clone(discussionBrief);
    renderGoalDiscussion();
    toast('学习范围已确认，生成计划时会一并提交。');
  });
  $('#settingsForm').addEventListener('submit', event => { event.preventDefault(); persistSettings(false); });
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#chooseProfileAvatar').addEventListener('click', () => $('#profileAvatarFile').click());
  $('#profileAvatarFile').addEventListener('change', chooseAvatar);
  $('#removeProfileAvatar').addEventListener('click', () => { profileAvatar = ''; updateProfilePreview(); });
  $('#profileDialog').addEventListener('close', () => { profileSession += 1; });
  $('#testConnection').addEventListener('click', () => persistSettings(true));
  $('#editDayForm').addEventListener('submit', saveDayEdit);
  viewHost.addEventListener('submit', event => {
    if (event.target.matches('#quizForm')) submitQuiz(event);
  });
  viewHost.addEventListener('input', event => {
    if (event.target.matches('[data-answer]')) saveQuizDraft(event.target);
  });
  ['createDialog', 'settingsDialog', 'profileDialog', 'editDayDialog', 'materialDialog'].forEach(id => {
    const dialog = document.getElementById(id);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  });
  $('#createDialog').addEventListener('close', () => {
    createSessionId += 1;
    createActivity = null;
    resetGoalDiscussion();
    setBusy($('#createSubmit'), false);
    setMessage($('#createError'), '');
  });

  async function initialize() {
    if (!api?.loadState) {
      viewHost.innerHTML = '<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">启动异常</span><h2>暂时无法打开学习工作台</h2><p>无法连接本地学习服务，请重新打开应用。</p></div></div></section>';
      updateHeader();
      return;
    }
    try {
      await reloadState();
    } catch (error) {
      viewHost.innerHTML = `<section class="panel"><div class="panel-heading"><div><span class="panel-kicker">启动异常</span><h2>暂时无法读取学习计划</h2><p>${escapeHTML(error.message || '请重启应用后重试。')}</p></div></div></section>`;
      updateHeader();
    }
  }

  initialize();
})();
