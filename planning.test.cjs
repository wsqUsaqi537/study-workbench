'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('./services.cjs');
const schedule = require('./schedule.js');

const settings = { endpoint: 'https://mock.invalid/v1', model: 'planning-mock', key: 'test-key' };

function dateOffset(start, offset) {
  const date = new Date(start + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function input(extra = {}) {
  return {
    title: 'Python 入门',
    goal: '掌握变量、循环和函数，编写一个记账程序',
    level: 'beginner',
    startDate: '2026-10-01',
    days: 3,
    minutesPerDay: 60,
    materials: [],
    ...extra
  };
}

function guide(data, language = 'zh-CN') {
  return {
    summary: language === 'en' ? 'Study Python concepts progressively.' : '逐步学习 Python 基础。',
    difficulty: '入门',
    warnings: [],
    knowledge: [{
      title: '变量',
      priority: '重点',
      explanation: '变量保存数据，供程序后续使用。',
      source: data.materials.length ? data.materials[0].name + ' 第 1 页' : '主题与学习目标'
    }]
  };
}

function generatedDays(payload, language = 'zh-CN', override = {}) {
  return payload.sessions.map(session => {
    const tasks = language === 'en'
      ? ['Complete 5-question quiz (10 minutes).', 'Practice the current concept.']
      : ['完成 5 题小测，用时 10 分钟。', '练习当前知识点。'];
    if (session.day === payload.days) {
      tasks.push(language === 'en'
        ? 'Complete 10-question comprehensive test (20 minutes).'
        : '完成 10 题周期测验，用时 20 分钟。');
    }
    return {
      day: session.day,
      date: session.date,
      title: `第 ${session.day} 天学习`,
      minutes: 45,
      tasks,
      source: payload.allowedSources[0],
      ...override
    };
  });
}

function installFetch(t, respond) {
  const original = global.fetch;
  const requests = [];
  global.fetch = createMockFetch(respond, requests);
  t.after(() => { global.fetch = original; });
  return requests;
}

function createMockFetch(respond, requests = []) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages[1].content);
    requests.push({ url, options, body, payload });
    return respond({ url, options, body, payload, index: requests.length - 1, requests });
  };
}

function response(content, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(content) } }]
    })
  };
}

function legacyPlan(data) {
  const dates = schedule.learningDates(data);
  const source = guide(data).knowledge[0].source;
  return {
    summary: '从变量开始逐步练习，并在末日完成综合测试。',
    difficulty: '入门',
    warnings: [],
    knowledge: guide(data).knowledge,
    days: Array.from({ length: data.days }, (_, index) => ({
      day: index + 1,
      date: dates[index],
      title: index === data.days - 1 ? '综合测试与复习' : `第 ${index + 1} 天学习`,
      minutes: 45,
      tasks: index === data.days - 1
        ? ['完成 5 题小测，用时 10 分钟。', '完成 10 题周期测验，用时 20 分钟。']
        : ['练习变量。', '完成 5 题小测，用时 10 分钟。'],
      source
    }))
  };
}

test('短计划沿用旧 purpose，携带日历频率，并省略 token 输出预算', async t => {
  const data = input({
    days: 4,
    calendarDays: 8,
    cadence: { mode: 'alternate', weekdays: [] }
  });
  const requests = installFetch(t, ({ payload }) => response(legacyPlan(data)));

  const plan = await service.generatePlan(data, settings);

  assert.equal(plan.days.length, 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.purpose, '生成学习计划');
  assert.equal(requests[0].payload.calendarDays, 8);
  assert.deepEqual(requests[0].payload.cadence, { mode: 'alternate', weekdays: [] });
  assert.deepEqual(requests[0].payload.sessions, [0, 2, 4, 6].map((offset, index) => ({
    day: index + 1,
    date: dateOffset(data.startDate, offset)
  })));
  assert.equal(Object.hasOwn(requests[0].body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'max_completion_tokens'), false);
});

test('英文短计划分段完整阅读超长附件，不再把已覆盖全文报告为截断', async t => {
  const marker = '【第 1 页】';
  const text = marker + 'x'.repeat(100000 - marker.length);
  const data = input({
    materials: [{ id: 'm1', name: 'lesson.pdf', units: 1, chars: text.length, text }]
  });
  const requests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '阅读材料片段') {
      return response({ summary: 'Full material segment summary.', source: 'lesson.pdf 第 1 页' });
    }
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data, 'en'));
    return response({ days: generatedDays(payload, 'en') });
  });

  const plan = await service.generatePlan(data, { ...settings, language: 'en' });

  assert.equal(plan.warnings.some(warning => warning.includes('Material text was shortened')), false);
  const materialRequests = requests.filter(request => request.payload.purpose === '阅读材料片段');
  assert.equal(materialRequests.length, 3);
  assert.equal(materialRequests.map(request => request.payload.material.text).join(''), text);
  assert.equal(requests.filter(request => request.payload.purpose === '生成学习计划概要与知识清单').length, 1);
  assert.ok(requests.every(request => !Object.hasOwn(request.body, 'max_tokens')));
});

test('60 次学习与 100,000 字材料先完整分段阅读，再按七日分批生成', async t => {
  const startDate = '2026-10-01';
  const marker = '【第 1 页】';
  const sensitive = 'SensitiveMaterialToken';
  const text = marker + sensitive + 'x'.repeat(100000 - marker.length - sensitive.length);
  const data = input({
    startDate,
    days: 60,
    calendarDays: 60,
    materials: [{ id: 'm1', name: '课程.pdf', units: 1, chars: text.length, text }]
  });
  const events = [];
  const requests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '阅读材料片段') {
      return response({ summary: '材料片段覆盖课程正文内容。', source: '课程.pdf 第 1 页' });
    }
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    assert.equal(payload.purpose, '生成学习计划每日安排');
    return response({ days: generatedDays(payload) });
  });

  const plan = await service.generatePlan(data, settings, { onProgress: event => events.push(event) });

  assert.equal(plan.days.length, 60);
  const materialRequests = requests.filter(request => request.payload.purpose === '阅读材料片段');
  assert.equal(materialRequests.length, 3);
  assert.equal(materialRequests.map(request => request.payload.material.text).join(''), text);
  assert.equal(requests.filter(request => request.payload.purpose === '生成学习计划概要与知识清单').length, 1);
  const batches = requests.filter(request => request.payload.purpose === '生成学习计划每日安排');
  assert.equal(batches.length, 9);
  assert.ok(batches.every(request => request.payload.sessions.length <= 7));
  assert.equal(batches.at(-1).payload.sessions.at(-1).day, 60);
  assert.match(plan.days.at(-1).tasks.join(' '), /10 题周期测验/);
  assert.match(JSON.stringify(materialRequests.map(request => request.payload.material.text)), /SensitiveMaterialToken/);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(request.body, 'max_completion_tokens'), false);
  }
  for (const request of batches) {
    assert.doesNotMatch(JSON.stringify(request.payload), /SensitiveMaterialToken|课程正文内容/);
    assert.ok(request.payload.materials.every(material => !Object.hasOwn(material, 'text')));
    assert.ok(request.payload.knowledge[0].explanation.length <= 300);
  }
  assert.deepEqual(events.filter(event => event.stage === 'outline'), [
    { stage: 'outline', completed: 0, total: 1 },
    { stage: 'outline', completed: 1, total: 1 }
  ]);
  assert.equal(events.filter(event => event.stage === 'days').at(-1).completed, 60);
});

test('合计超过 200,000 字的多份材料仍按 40,000 字片段完整阅读', async t => {
  const firstText = '【第 1 页】' + 'A'.repeat(120000);
  const secondText = '【第 1 页】' + 'B'.repeat(120000);
  const data = input({ materials: [
    { id: 'first', name: 'first.md', units: 1, chars: firstText.length, text: firstText },
    { id: 'second', name: 'second.md', units: 1, chars: secondText.length, text: secondText }
  ] });
  assert.ok(data.materials.reduce((sum, material) => sum + material.chars, 0) > 200000);
  const requests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '阅读材料片段') {
      return response({ summary: `覆盖 ${payload.material.name} 的当前片段。`, source: `${payload.material.name} 第 1 页` });
    }
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    return response({ days: generatedDays(payload) });
  });

  const plan = await service.generatePlan(data, settings);

  assert.equal(plan.days.length, data.days);
  const materialRequests = requests.filter(request => request.payload.purpose === '阅读材料片段');
  const reconstructed = new Map(data.materials.map(material => [material.id, '']));
  for (const request of materialRequests) {
    const chunk = request.payload.material.text;
    assert.ok(chunk.length <= 40000);
    assert.ok(request.body.messages[0].content.length + request.body.messages[1].content.length <= 60000);
    reconstructed.set(request.payload.material.id, reconstructed.get(request.payload.material.id) + chunk);
  }
  assert.equal(reconstructed.get('first'), firstText);
  assert.equal(reconstructed.get('second'), secondText);
});

test('超过 2.5M 字材料先完整阅读，再分层归纳且取消可续接组缓存', async t => {
  const body = 'x'.repeat(2_550_000);
  const largeText = `【第 1 页】${body.slice(0, 1_300_000)}【第 2 页】${body.slice(1_300_000)}`;
  const otherText = '【第 7 页】另一个材料的合成内容。';
  const data = input({
    days: 8,
    calendarDays: 8,
    materials: [
      { id: 'large', name: 'large.md', units: 1, chars: largeText.length, text: largeText },
      { id: 'other', name: 'other.md', units: 1, chars: otherText.length, text: otherText }
    ]
  });
  assert.ok(data.materials.reduce((sum, material) => sum + material.chars, 0) > 2_500_000);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const allRequests = [];
  let checkpoint;
  let controller = new AbortController();
  const createResponder = (invalidSource, requests) => createMockFetch(({ payload }) => {
    if (payload.purpose === '阅读材料片段') {
      const refs = payload.material.sourcePages.map(page => `第 ${page.number} ${page.unit}`).join(' ');
      return response({ summary: 'R'.repeat(1200), source: [payload.material.name, refs].filter(Boolean).join(' ') });
    }
    if (payload.purpose === '归纳材料提要') {
      if (invalidSource && invalidSource(payload)) {
        return response({ summary: 'C'.repeat(1200), source: invalidSource(payload) });
      }
      const page = payload.material.sourcePages.at(-1);
      const refs = page ? `第 ${page.number} ${page.unit}` : '';
      return response({ summary: 'C'.repeat(1200), source: [payload.material.name, refs].filter(Boolean).join(' ') });
    }
    if (payload.purpose === '生成学习计划概要与知识清单') {
      const result = guide(data);
      result.knowledge[0].source = 'large.md 第 2 页';
      return response(result);
    }
    return response({ days: generatedDays(payload) });
  }, requests);

  const firstRequests = [];
  allRequests.push(firstRequests);
  global.fetch = createResponder(null, firstRequests);
  await assert.rejects(service.generatePlan(data, settings, {
    signal: controller.signal,
    onCheckpoint: value => {
      if (value.stage === 'materials') {
        checkpoint = value;
        if (value.compressions?.length === 1) controller.abort();
      }
    }
  }), error => error.name === 'AbortError');
  assert.equal(checkpoint.notes.length, checkpoint.nextChunk);
  assert.equal(checkpoint.compressions.length, 1);

  const rawSegments = firstRequests.filter(request => request.payload.purpose === '阅读材料片段')
    .map(request => request.payload.material.text);
  assert.equal(rawSegments.join(''), largeText + otherText);
  const firstCompression = firstRequests.find(request => request.payload.purpose === '归纳材料提要');
  assert.equal(firstCompression.payload.range.start, 0);
  assert.ok(firstCompression.body.messages.every(message => message.content.length <= 60000));

  const tampered = JSON.parse(JSON.stringify(checkpoint));
  tampered.notes[0].summary = '不同的已读提要';
  const requestsBeforeTamper = firstRequests.length;
  await assert.rejects(service.generatePlan(data, settings, { checkpoint: tampered }), /归纳输入与已读材料不匹配/);
  assert.equal(firstRequests.length, requestsBeforeTamper);

  const failCrossGroup = payload => payload.purpose === '归纳材料提要' && payload.range.start !== 0
    ? 'large.md 第 2 页'
    : null;
  const crossGroupRequests = [];
  allRequests.push(crossGroupRequests);
  global.fetch = createResponder(failCrossGroup, crossGroupRequests);
  await assert.rejects(service.generatePlan(data, settings, {
    checkpoint,
    onCheckpoint: value => { if (value.stage === 'materials') checkpoint = value; }
  }), /不存在的页码或幻灯片/);
  assert.equal(crossGroupRequests.filter(request => request.payload.purpose === '归纳材料提要').length, 1);
  assert.ok(crossGroupRequests.every(request => request.payload.purpose !== '阅读材料片段'));

  const failUnread = payload => payload.purpose === '归纳材料提要' && payload.range.start !== 0
    ? 'large.md 第 999 页'
    : null;
  const unreadRequests = [];
  allRequests.push(unreadRequests);
  global.fetch = createResponder(failUnread, unreadRequests);
  await assert.rejects(service.generatePlan(data, settings, {
    checkpoint,
    onCheckpoint: value => { if (value.stage === 'materials') checkpoint = value; }
  }), /不存在的页码或幻灯片/);
  assert.equal(unreadRequests.filter(request => request.payload.purpose === '归纳材料提要').length, 1);
  assert.ok(unreadRequests.every(request => request.payload.purpose !== '阅读材料片段'));

  const resumedRequests = [];
  allRequests.push(resumedRequests);
  global.fetch = createResponder(null, resumedRequests);
  const plan = await service.generatePlan(data, settings, {
    checkpoint,
    onCheckpoint: value => { if (value.stage === 'materials') checkpoint = value; }
  });

  assert.equal(plan.days.length, data.days);
  assert.equal(plan.knowledge[0].source, 'large.md 第 2 页');
  assert.equal(checkpoint.compressions.length, 8);
  assert.ok(checkpoint.compressions.some(record => record.source.includes('第 2 页')));
  assert.ok(resumedRequests.every(request => request.payload.purpose !== '阅读材料片段'));
  assert.ok(allRequests.flat().every(request => request.body.messages.every(message => message.content.length <= 60000)));
  assert.ok(allRequests.flat().every(request => !Object.hasOwn(request.body, 'max_tokens')));
  const finalOutline = resumedRequests.find(request => request.payload.purpose === '生成学习计划概要与知识清单');
  assert.match(finalOutline.payload.materials[0].text, /第 2 页/);
  const compressionStartZeroRequests = allRequests.flat()
    .filter(request => request.payload.purpose === '归纳材料提要' && request.payload.range.start === 0);
  assert.equal(compressionStartZeroRequests.length, 1);
  const retriedGroup = allRequests.flat().filter(request => request.payload.purpose === '归纳材料提要' && request.payload.range.start !== 0);
  assert.equal(retriedGroup.length, 9);
});

test('第二轮材料提要归纳可取消续接，缺少前轮缓存时拒绝恢复', async t => {
  const marker = '【第 1 页】';
  const text = marker + 'x'.repeat(8_000_000 - marker.length);
  const data = input({
    days: 8,
    calendarDays: 8,
    materials: [{ id: 'large', name: 'large.md', units: 1, chars: text.length, text }]
  });
  const longSource = name => {
    const suffix = ' 第 1 页';
    return name + ' ' + 'x'.repeat(2000 - name.length - 1 - suffix.length) + suffix;
  };
  const responder = requests => createMockFetch(({ payload }) => {
    if (payload.purpose === '阅读材料片段' || payload.purpose === '归纳材料提要') {
      return response({
        summary: (payload.purpose === '阅读材料片段' ? 'R' : 'C').repeat(1200),
        source: longSource(payload.material.name)
      });
    }
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    return response({ days: generatedDays(payload) });
  }, requests);

  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const firstRequests = [];
  global.fetch = responder(firstRequests);
  const controller = new AbortController();
  let checkpoint;
  await assert.rejects(service.generatePlan(data, settings, {
    signal: controller.signal,
    onCheckpoint: value => {
      if (value.stage === 'materials') {
        checkpoint = value;
        if (value.compressions?.some(record => record.round === 2)) controller.abort();
      }
    }
  }), error => error.name === 'AbortError');

  assert.equal(checkpoint.compressions.filter(record => record.round === 1).length, 25);
  assert.equal(checkpoint.compressions.filter(record => record.round === 2).length, 1);
  assert.equal(firstRequests.filter(request => request.payload.purpose === '归纳材料提要' && request.payload.round === 2).length, 1);

  const missingPriorRound = JSON.parse(JSON.stringify(checkpoint));
  const firstRoundCacheIndex = missingPriorRound.compressions.findIndex(record => record.round === 1);
  missingPriorRound.compressions.splice(firstRoundCacheIndex, 1);
  const invalidResumeRequests = [];
  global.fetch = responder(invalidResumeRequests);
  await assert.rejects(service.generatePlan(data, settings, { checkpoint: missingPriorRound }), /不完整的归纳轮次/);
  assert.equal(invalidResumeRequests.length, 0);

  const resumedRequests = [];
  global.fetch = responder(resumedRequests);
  const plan = await service.generatePlan(data, settings, {
    checkpoint,
    onCheckpoint: value => { if (value.stage === 'materials') checkpoint = value; }
  });

  assert.equal(plan.days.length, data.days);
  assert.equal(checkpoint.compressions.filter(record => record.round === 1).length, 25);
  assert.equal(checkpoint.compressions.filter(record => record.round === 2).length, 3);
  assert.ok(resumedRequests.every(request => request.payload.purpose !== '阅读材料片段'));
  assert.ok(resumedRequests.every(request => request.payload.purpose !== '归纳材料提要' || request.payload.round === 2));
  assert.equal(resumedRequests.filter(request => request.payload.purpose === '归纳材料提要').length, 2);
  assert.ok(firstRequests.concat(resumedRequests).every(request =>
    request.body.messages.every(message => message.content.length <= 60000)));
  assert.ok(firstRequests.concat(resumedRequests).every(request => !Object.hasOwn(request.body, 'max_tokens')));
});

test('短计划整体输出 length 后转概要分批', async t => {
  const data = input({ days: 4, calendarDays: 4 });
  const requests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '生成学习计划') return response({}, 'length');
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    return response({ days: generatedDays(payload) });
  });

  const plan = await service.generatePlan(data, settings);

  assert.equal(plan.days.length, 4);
  assert.deepEqual(requests.map(request => request.payload.purpose), [
    '生成学习计划', '生成学习计划概要与知识清单', '生成学习计划每日安排'
  ]);
  assert.ok(requests.every(request => !Object.hasOwn(request.body, 'max_tokens')));
});

test('分批输出 length 时缩小失败批次并完成', async t => {
  const data = input({ days: 14, calendarDays: 14 });
  let oversized = true;
  const requests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '生成学习计划') {
      return response({ ...legacyPlan(data), days: [] }, 'length');
    }
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    if (oversized && payload.sessions.length > 1) {
      oversized = false;
      return response({}, 'length');
    }
    return response({ days: generatedDays(payload) });
  });

  const plan = await service.generatePlan(data, settings);

  assert.equal(plan.days.length, 14);
  const batches = requests.filter(request => request.payload.purpose === '生成学习计划每日安排');
  assert.ok(batches.some(request => request.payload.sessions.length === 7));
  assert.ok(batches.some(request => request.payload.sessions.length < 7));
  assert.ok(requests.every(request => !Object.hasOwn(request.body, 'max_tokens')));
});

test('英文长计划输出英语任务并验证每天及末日测验', async t => {
  const data = input({ days: 8, calendarDays: 8 });
  installFetch(t, ({ payload }) => payload.purpose === '生成学习计划概要与知识清单'
    ? response(guide(data, 'en'))
    : response({ days: generatedDays(payload, 'en') }));

  const plan = await service.generatePlan(data, { ...settings, language: 'en' });

  assert.equal(plan.days.length, 8);
  assert.match(plan.days[0].tasks.join(' '), /5-question quiz/);
  assert.match(plan.days.at(-1).tasks.join(' '), /10-question comprehensive test/);
});

test('检查点恢复已完成批次而不重发概要，后批携带最近两日上下文', async t => {
  const data = input({ days: 14, calendarDays: 14 });
  let checkpoint;
  let failSecondBatch = true;
  const firstRequests = installFetch(t, ({ payload }) => {
    if (payload.purpose === '生成学习计划概要与知识清单') return response(guide(data));
    if (payload.sessions[0].day > 7 && failSecondBatch) {
      failSecondBatch = false;
      return { ok: false, status: 503, text: async () => '{}' };
    }
    return response({ days: generatedDays(payload) });
  });
  await assert.rejects(service.generatePlan(data, settings, {
    onCheckpoint: value => { checkpoint = value; }
  }), /HTTP 503/);
  assert.equal(checkpoint.days.length, 7);
  assert.equal(Object.hasOwn(checkpoint, 'key'), false);
  const resumedRequests = [];
  global.fetch = createMockFetch(({ payload }) => response({ days: generatedDays(payload) }), resumedRequests);

  const plan = await service.generatePlan(data, settings, { checkpoint });

  assert.equal(plan.days.length, 14);
  assert.equal(resumedRequests.length, 1);
  assert.equal(resumedRequests[0].payload.purpose, '生成学习计划每日安排');
  assert.deepEqual(resumedRequests[0].payload.previousDays.map(day => day.day), [6, 7]);
  assert.equal(firstRequests.filter(request => request.payload.purpose === '生成学习计划概要与知识清单').length, 1);
});

test('频率上下文保留每一天，只将已完成的最近安排作为 previousDays', async t => {
  const data = input({ days: 4, calendarDays: 4 });
  const context = Array.from({ length: 4 }, (_, index) => ({
    day: index + 1,
    date: dateOffset(data.startDate, index),
    title: `旧计划第 ${index + 1} 天`,
    tasks: [`旧安排内容 ${index + 1}`],
    completed: index === 0,
    preserved: index < 2,
    remaining: index >= 2
  }));
  const requests = installFetch(t, ({ payload }) => response({ days: generatedDays(payload) }));

  await service.generateDayBatches(data, settings, { ...guide(data), context }, [
    { day: 3, date: dateOffset(data.startDate, 2) },
    { day: 4, date: dateOffset(data.startDate, 3) }
  ]);

  assert.equal(requests[0].payload.purpose, '按学习频率重拟未来计划');
  assert.equal(requests[0].payload.originalPlan.context.length, 4);
  assert.deepEqual(requests[0].payload.previousDays.map(day => day.day), [1, 2]);
  assert.equal(requests[0].payload.originalPlan.context[2].remaining, true);
  assert.equal(requests[0].payload.originalPlan.context[0].preserved, true);
});

test('拒绝无效日期、未允许来源，并可通过 signal 取消规划', async t => {
  const data = input({ days: 8, calendarDays: 8 });
  const planGuide = guide(data);
  let respond = ({ payload }) => response({ days: generatedDays(payload) });
  const requests = installFetch(t, args => respond(args));
  await assert.rejects(service.generateDayBatches(data, settings, planGuide,
    [{ day: 1, date: '2026-02-30' }]), /日期|无效/);
  assert.equal(requests.length, 0, '无效输入应在 API 请求前拒绝');

  respond = ({ payload }) => response({
    days: generatedDays(payload, 'zh-CN', { date: '2026-02-30' })
  });
  await assert.rejects(service.generateDayBatches(data, settings, planGuide,
    [{ day: 1, date: data.startDate }]), /日期|顺序/);
  assert.equal(requests.length, 1);

  respond = ({ payload }) => response({
    days: generatedDays(payload, 'zh-CN', { source: '未提供的来源' })
  });
  await assert.rejects(service.generateDayBatches(data, settings, planGuide,
    [{ day: 1, date: data.startDate }]), /未提供|引用|来源/);
  assert.equal(requests.length, 2);

  const beforeAbort = global.fetch;
  let started;
  const fetchStarted = new Promise(resolve => { started = resolve; });
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  const pending = service.generatePlan(data, settings, { signal: controller.signal });
  await fetchStarted;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  global.fetch = beforeAbort;
});
