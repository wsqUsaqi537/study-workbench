'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const service = require('./services.cjs');
const { documentReadingRules } = require('./document-reading.cjs');

function material(id = 'lesson', name = 'lesson.pdf', text = '【第 1 页】课程内容') {
  return { id, name, text, units: 1, chars: text.length };
}

function input(extra = {}) {
  return {
    title: '数学复习', goal: '掌握函数与方程', level: 'beginner',
    startDate: '2026-10-10', days: 4, minutesPerDay: 60, materials: [], ...extra
  };
}

function modelPlan(data, studyNotes) {
  const source = data.materials.length ? data.materials[0].name + ' 第 1 页' : '主题与学习目标';
  const result = {
    summary: '按范围学习并完成复习。', difficulty: '入门', warnings: [],
    days: Array.from({ length: data.days }, (_, index) => ({
      day: index + 1,
      date: service.formatDate(data.startDate, index),
      title: index === data.days - 1 ? '综合测试与复盘' : `第 ${index + 1} 天学习`,
      minutes: 45,
      tasks: [index === data.days - 1 ? '完成综合测试并复盘错题' : '学习概念并完成练习'],
      source
    })),
    knowledge: [{ title: '函数', priority: '重点', explanation: '理解函数关系。', source }]
  };
  if (studyNotes !== undefined) result.studyNotes = studyNotes;
  return result;
}

async function mockAPI(t, respond) {
  const received = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const parsed = JSON.parse(options.body);
    received.push(parsed);
    const content = await respond(parsed, received.length);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  t.after(() => { global.fetch = originalFetch; });
  return {
    settings: { endpoint: 'http://localhost/v1', model: 'mock', key: 'test-key' },
    received
  };
}

function userPayload(request) {
  return JSON.parse(request.messages[1].content);
}

test('PDF/PPTX reading rules load lazily and stay out of unrelated prompts', () => {
  const originalReadFileSync = fs.readFileSync;
  const loaded = [];
  fs.readFileSync = function trackedRead(filePath, ...args) {
    loaded.push(path.basename(String(filePath)));
    return originalReadFileSync.call(fs, filePath, ...args);
  };
  try {
    assert.equal(documentReadingRules([{ name: 'notes.md' }]), '');
    assert.deepEqual(loaded, []);
    const pdfRules = documentReadingRules([{ name: 'handout.PDF' }]);
    assert.match(pdfRules, /【第 N 页】/);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0], 'pdf-reading.SKILL.md');
    assert.doesNotMatch(pdfRules, /pdf-reading/);
    const pptRules = documentReadingRules([{ name: 'slides.pptx' }]);
    assert.match(pptRules, /演讲者备注/);
    assert.equal(loaded[1], 'ppt-reading.SKILL.md');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('考试范围只引用唯一存在的材料，并在短计划正文中只传一次说明', async t => {
  const lesson = material();
  const data = input({
    materials: [lesson],
    exam: { description: '考试范围唯一标记', materialIds: ['lesson'] }
  });
  assert.deepEqual(service.examContext(data), {
    description: '考试范围唯一标记', materials: [{ id: 'lesson', name: 'lesson.pdf' }]
  });
  assert.equal(service.examContext(input()), null);
  assert.deepEqual(service.examContext(input({ materials: [lesson], exam: { description: '', materialIds: ['lesson'] } })), {
    description: '', materials: [{ id: 'lesson', name: 'lesson.pdf' }]
  });
  for (const exam of [
    { description: '', materialIds: [] },
    { description: '范围', materialIds: ['missing'] },
    { description: '范围', materialIds: ['lesson', 'lesson'] },
    { description: 'x'.repeat(8001), materialIds: [] }
  ]) assert.throws(() => service.validateInput(input({ materials: [lesson], exam })));
  assert.throws(() => service.validateInput(input({ materials: [lesson, { ...lesson }], exam: { description: '范围', materialIds: ['lesson'] } })), /编号不唯一/);

  const { settings, received } = await mockAPI(t, () => modelPlan(data, ['区分考纲内函数概念']));
  const actual = await service.generatePlan(data, settings);
  const payload = userPayload(received[0]);
  assert.deepEqual(payload.examContext, service.examContext(data));
  assert.equal(JSON.stringify(payload).split('考试范围唯一标记').length - 1, 1);
  assert.match(received[0].messages[0].content, /examContext\.description/);
  assert.match(received[0].messages[0].content, /其他学习材料只用于补充理解/);
  assert.match(received[0].messages[0].content, /warnings 只写生成质量/);
  assert.match(received[0].messages[0].content, /studyNotes 单独写学科重点/);
  assert.deepEqual(actual.studyNotes, ['区分考纲内函数概念']);
});

test('旧模型可省略 studyNotes；新 notes 严格校验并经概要检查点恢复', async t => {
  const shortInput = input();
  const legacy = modelPlan(shortInput);
  const legacyApi = await mockAPI(t, () => legacy);
  const legacyPlan = await service.generatePlan(shortInput, legacyApi.settings);
  assert.equal(Object.hasOwn(legacyPlan, 'studyNotes'), false);

  assert.deepEqual(service.validateStudyNotes([]), []);
  assert.throws(() => service.validateStudyNotes(Array(21).fill('重点')));
  assert.throws(() => service.validateStudyNotes(['难点'.repeat(251)]));
  const oldPersistedPlan = {
    mode: 'ai', ...legacy, days: legacy.days.map(day => ({ ...day, completed: false }))
  };
  assert.doesNotThrow(() => service.validatePlan(oldPersistedPlan, shortInput, 'ai'));
  assert.throws(() => service.validatePlan({ ...oldPersistedPlan, unexpected: true }, shortInput, 'ai'));

  const longInput = input({ days: 8, materials: [material()], exam: { description: '限定范围', materialIds: ['lesson'] } });
  const notes = ['优先掌握函数定义域', '注意符号变换中的易错点'];
  let checkpoint;
  const longApi = await mockAPI(t, (request, count) => {
    if (count === 1) return {
      summary: '按考试范围先复习函数，再练习方程。', difficulty: '入门', warnings: [],
      studyNotes: notes,
      knowledge: [{ title: '函数', priority: '重点', explanation: '理解函数关系。', source: 'lesson.pdf 第 1 页' }]
    };
    const payload = userPayload(request);
    assert.deepEqual(payload.examContext, service.examContext(longInput));
    return { days: payload.sessions.map(session => ({
      ...session,
      title: session.day === longInput.days ? '周期测验与复盘' : `第 ${session.day} 天学习`,
      minutes: 45,
      tasks: session.day === longInput.days
        ? ['完成 5 题小测，用时 10 分钟', '完成 10 题周期测验，用时 20 分钟']
        : ['完成 5 题小测，用时 10 分钟'],
      source: 'lesson.pdf 第 1 页'
    })) };
  });
  const plan = await service.generatePlan(longInput, longApi.settings, {
    onCheckpoint: value => { checkpoint = value; }
  });
  assert.deepEqual(plan.studyNotes, notes);
  const requestCount = longApi.received.length;
  const resumed = await service.generatePlan(longInput, {}, { checkpoint });
  assert.deepEqual(resumed.studyNotes, notes);
  assert.equal(longApi.received.length, requestCount);
});

function notesXml(text) {
  return `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
}

test('PPTX 正文超过 200,000 字仍可完整解析', async t => {
  const zip = new JSZip();
  const body = 'Synthetic PPTX lesson. '.repeat(10000);
  zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:cSld></p:sld>`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'study-reading-large-pptx-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'large.pptx');
  await fsp.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const result = await service.parseMaterial(filePath);
  assert.ok(result.chars > 200000);
  assert.equal((result.text.match(/Synthetic PPTX lesson\./g) || []).length, 10000);
  assert.equal(service.validateInput(input({ materials: [{ id: 'large-slides', ...result }] })), true);
});

test('PPTX 按关系顺序提取讲者备注并保留公式结构，复杂公式附阅读警告', async t => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2" id="256"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><p:cSld><a:p><a:r><a:t>公式：</a:t></a:r><m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath><m:sSup><m:sSupPr/><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath><m:oMath><m:f><m:fPr/><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara></a:p></p:cSld></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><p:cSld><a:p><a:r><a:t>第二页内容；复杂式：</a:t></a:r><m:oMath><m:rad><m:radPr/><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath></a:p></p:cSld></p:sld>');
  for (const [noteNum, slideNum, note] of [[1, 1, '第一页备注'], [2, 2, '第二页备注']]) {
    zip.file(`ppt/notesSlides/notesSlide${noteNum}.xml`, notesXml(note));
    zip.file(`ppt/notesSlides/_rels/notesSlide${noteNum}.xml.rels`, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNum}.xml"/></Relationships>`);
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'study-reading-pptx-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'order.pptx');
  await fsp.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await service.parseMaterial(filePath);
  assert.ok(result.text.indexOf('第二页内容') < result.text.indexOf('公式：'));
  assert.ok(result.text.indexOf('第二页备注') > result.text.indexOf('第二页内容'));
  assert.ok(result.text.indexOf('第一页备注') > result.text.indexOf('公式：'));
  assert.match(result.text, /x\^\(2\) \(a\)\/\(b\)/);
  assert.match(result.text, /【公式结构未能可靠提取】/);
  assert.deepEqual(result.readingWarnings, ['PPTX 包含未能可靠保留结构的公式，请对照原幻灯片核对。']);
  const withMaterial = input({ materials: [{ id: 'slides', ...result }] });
  assert.equal(service.validateInput(withMaterial), true);
  const sent = JSON.parse(service.boundedContext({ purpose: '测试' }, withMaterial.materials, 60000).text);
  assert.deepEqual(sent.materials[0].readingWarnings, result.readingWarnings);
});

test('PPTX 提取关系中的图表标题与数值，并提示混合图文幻灯片的图片文字未识别', async t => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>季度访问量</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame><p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
  zip.file('ppt/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>季度销售额</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>净销售额</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>第一季度</c:v></c:pt><c:pt idx="1"><c:v>第二季度</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>98765</c:v></c:pt><c:pt idx="1"><c:v>12345</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>稀疏系列</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="2"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="1"><c:v>100</c:v></c:pt><c:pt idx="2"><c:v>200</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>');
  zip.file('ppt/media/image1.png', Buffer.from('fixture image bytes'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'study-reading-chart-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'charts.pptx');
  await fsp.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const result = await service.parseMaterial(filePath);
  assert.match(result.text, /季度销售额/);
  assert.match(result.text, /净销售额/);
  assert.match(result.text, /第一季度[^\n]*98765/);
  assert.match(result.text, /第二季度[^\n]*12345/);
  assert.match(result.text, /稀疏系列：A：无缓存值；项目 2：100；B：200/);
  assert.ok(result.readingWarnings.some(warning => /图片.*文字.*未.*识别/.test(warning)));
});

test('英文计划保存已翻译的固定材料阅读提示', async t => {
  const warning = 'PPTX 包含图片，图片内文字未进行 OCR 识别，请对照原幻灯片核对。';
  const lesson = material('slides', 'slides.pptx');
  lesson.readingWarnings = [warning, '部分 PDF 页面已通过本地 OCR 恢复文字；公式和特殊符号可能不完整，请复核。'];
  const data = input({ materials: [lesson] });
  const { settings } = await mockAPI(t, () => modelPlan(data));

  const plan = await service.generatePlan(data, { ...settings, language: 'en' });

  assert.ok(plan.warnings.includes('PPTX contains images. Text inside images was not recognized with OCR; check the original slides.'));
  assert.ok(plan.warnings.includes('Text was recovered from some PDF pages with local OCR; formulas and special symbols may be incomplete. Review them against the source.'));
  assert.ok(!plan.warnings.includes(warning));
});

test('超长材料分片覆盖全文、断点只续读剩余部分，尾部知识和来源进入计划', async t => {
  const firstBody = '前段概念'.repeat(12000);
  const middleBody = '中段练习'.repeat(12000);
  const tail = '尾部唯一章节：极限与导数';
  const sourceText = `【第 1 页】${firstBody}\n【第 2 页】${middleBody}\n【第 3 页】${tail}${'尾部补充'.repeat(2500)}`;
  const lesson = material('large', '微积分.pdf', sourceText);
  lesson.units = 3;
  lesson.readingWarnings = ['OCR 提示：公式和特殊符号可能不完整。'];
  const data = input({ materials: [lesson] });
  const { settings, received } = await mockAPI(t, request => {
    const payload = userPayload(request);
    if (payload.purpose === '阅读材料片段') {
      const pages = payload.material.sourcePages;
      const referencedPages = payload.material.text.includes(tail)
        ? pages.filter(page => page.number === 3)
        : pages.slice(0, 1);
      return {
        summary: payload.material.text.includes(tail) ? '尾部唯一章节讲解极限与导数。' : '本片段介绍微积分概念与练习。',
        source: referencedPages.length
          ? `${payload.material.name} ${referencedPages.map(page => `第 ${page.number} ${page.unit}`).join('；' + payload.material.name + ' ')}`
          : payload.material.name
      };
    }
    if (payload.purpose === '生成学习计划概要与知识清单') {
      const summary = payload.materials[0].text;
      const source = summary.includes('尾部唯一章节') ? '微积分.pdf 第 3 页' : '微积分.pdf 第 1 页';
      return {
        summary: '完整阅读材料后安排学习。', difficulty: '入门', warnings: [],
        knowledge: [{ title: summary.includes('尾部唯一章节') ? '极限与导数' : '微积分基础', priority: '重点', explanation: '掌握材料中的核心概念。', source }]
      };
    }
    if (payload.purpose === '生成学习计划每日安排') {
      return { days: payload.sessions.map(session => ({
        ...session, title: session.day === data.days ? '综合测试与复盘' : `第 ${session.day} 天学习`,
        minutes: 45, tasks: session.day === data.days
          ? ['完成 5 题小测，用时 10 分钟', '完成 10 题周期测验，用时 20 分钟']
          : ['完成 5 题小测，用时 10 分钟'],
        source: '微积分.pdf 第 3 页'
      })) };
    }
    throw new Error('unexpected request purpose: ' + payload.purpose);
  });

  const controller = new AbortController();
  let checkpoint;
  await assert.rejects(service.generatePlan(data, settings, {
    signal: controller.signal,
    onCheckpoint: value => {
      checkpoint = value;
      if (value.stage === 'materials' && value.nextChunk === 1) controller.abort();
    }
  }), /取消/);
  assert.equal(checkpoint.stage, 'materials');
  assert.equal(checkpoint.nextChunk, 1);
  assert.equal(received.filter(request => userPayload(request).purpose === '阅读材料片段').length, 1);
  await assert.rejects(service.generatePlan(data, settings, {
    checkpoint: { ...checkpoint, fingerprint: 'damaged' }
  }), /无法安全恢复/);
  assert.equal(received.filter(request => userPayload(request).purpose === '阅读材料片段').length, 1);

  const plan = await service.generatePlan(data, settings, { checkpoint });
  const chunks = received
    .map(request => userPayload(request))
    .filter(payload => payload.purpose === '阅读材料片段')
    .map(payload => payload.material.text);
  assert.equal(chunks.join(''), sourceText);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.some(chunk => chunk.includes(tail)));
  assert.match(plan.knowledge[0].title, /极限与导数/);
  assert.equal(plan.knowledge[0].source, '微积分.pdf 第 3 页');
  assert.ok(plan.warnings.includes('OCR 提示：公式和特殊符号可能不完整。'));
  assert.equal(received.filter(request => userPayload(request).purpose === '阅读材料片段').length, chunks.length);
});

test('材料片段提要不能引用本次请求中不可见的页码', async t => {
  const sourceText = `【第 1 页】${'第一页内容'.repeat(10000)}\n【第 2 页】${'第二页内容'.repeat(10000)}`;
  const lesson = material('visible', '可见页.pdf', sourceText);
  lesson.units = 2;
  const data = input({ materials: [lesson] });
  const { settings, received } = await mockAPI(t, request => {
    const payload = userPayload(request);
    if (payload.purpose === '阅读材料片段') {
      const unseen = payload.material.sourcePages.some(page => page.number === 1) ? 2 : 1;
      return { summary: '片段提要。', source: `${payload.material.name} 第 ${unseen} 页` };
    }
    throw new Error('不可见页码应在概要调用前被拒绝。');
  });
  await assert.rejects(service.generatePlan(data, settings), /不存在的页码|真实的页码/);
  assert.equal(received.length, 1);
});

test('长合成 PDF 与 PPTX 支持英文物理页码格式并完整保存阅读来源', async t => {
  const makeLongMaterial = (id, name, unit) => {
    const text = [1, 2, 3].map(number =>
      `【第 ${number} ${unit}】${number === 1 ? '印刷页码 99；' : ''}${name}合成内容` +
      '合成材料段落。'.repeat(12000)).join('\n');
    return material(id, name, text);
  };
  const pdf = makeLongMaterial('pdf', 'chapter page 2.pdf', '页');
  const pptx = makeLongMaterial('pptx', 'slides3.pptx', '张幻灯片');
  pdf.units = 3;
  pptx.units = 3;
  const data = input({ days: 8, materials: [pdf, pptx] });
  const pdfSource = 'chapter page 2.pdf pages 1/2/3';
  const pptxSource = 'slides3.pptx slides 1-3';
  const { settings: baseSettings, received } = await mockAPI(t, request => {
    const payload = userPayload(request);
    if (payload.purpose === '阅读材料片段') {
      const pages = payload.material.sourcePages.map(page => page.number);
      const pageList = payload.material.name === pdf.name && pages.includes(1) && pages.includes(2)
        ? '1'
        : pages.join('/');
      const location = payload.material.name.endsWith('.pptx') ? 'slides ' + pageList : 'pages ' + pageList;
      return { summary: `Read ${payload.material.name} segment.`, source: `${payload.material.name} ${location}` };
    }
    if (payload.purpose === '生成学习计划概要与知识清单') {
      return {
        summary: 'Read all supplied PDF pages and slides.', difficulty: '入门', warnings: [], studyNotes: [],
        knowledge: [
          { title: 'PDF 内容', priority: '重点', explanation: '根据 PDF 合成内容整理。', source: pdfSource },
          { title: 'PPT 内容', priority: '了解', explanation: '根据幻灯片合成内容整理。', source: pptxSource }
        ]
      };
    }
    if (payload.purpose === '生成学习计划每日安排') {
      return { days: payload.sessions.map(session => ({
        day: session.day,
        date: session.date,
        title: `第 ${session.day} 天学习`,
        minutes: 45,
        tasks: session.day === payload.days
          ? ['完成 5 题小测，用时 10 分钟', '完成 10 题周期测验，用时 20 分钟']
          : ['完成 5 题小测，用时 10 分钟'],
        source: pdfSource
      })) };
    }
    throw new Error('unexpected request purpose: ' + payload.purpose);
  });
  const settings = { ...baseSettings, language: 'en' };
  let checkpoint;
  const controller = new AbortController();
  await assert.rejects(service.generatePlan(data, settings, {
    signal: controller.signal,
    onCheckpoint: value => {
      if (value.stage === 'materials') checkpoint = value;
      if (value.stage === 'materials' && value.nextChunk === 1) controller.abort();
    }
  }), /取消/);
  assert.equal(checkpoint.nextChunk, 1);
  assert.deepEqual(checkpoint.notes[0].sourcePages, [{ number: 1, unit: '页' }]);
  const plan = await service.generatePlan(data, settings, {
    checkpoint,
    onCheckpoint: value => { if (value.stage === 'materials') checkpoint = value; }
  });

  const readingRequests = received.map(userPayload).filter(payload => payload.purpose === '阅读材料片段');
  assert.ok(readingRequests.length > 6);
  for (const sourceMaterial of [pdf, pptx]) {
    const chunks = readingRequests.filter(payload => payload.material.name === sourceMaterial.name).map(payload => payload.material.text);
    assert.equal(chunks.join(''), sourceMaterial.text);
    const savedPages = new Set(checkpoint.notes.filter(note => note.materialId === sourceMaterial.id)
      .flatMap(note => note.sourcePages.map(page => page.number)));
    assert.deepEqual([...savedPages].sort((left, right) => left - right), [1, 2, 3]);
  }
  assert.ok(checkpoint.notes.some(note => note.materialId === pdf.id && note.source === 'chapter page 2.pdf pages 1' &&
    note.sourcePages.length === 1 && note.sourcePages[0].number === 1),
  '页码出现在文件名中时，检查点只保存来源中真正引用的位置');
  assert.equal(new Set(readingRequests.map(payload => `${payload.material.name}:${payload.material.segment}`)).size,
    readingRequests.length, '从检查点续接后没有重读已完成片段');
  assert.match(received.find(request => userPayload(request).purpose === '阅读材料片段').messages[0].content, /不得使用页面上印刷的页码/);
  assert.deepEqual(plan.knowledge.map(item => item.source), [pdfSource, pptxSource]);
  assert.ok(plan.days.every(day => day.source === pdfSource));
});
