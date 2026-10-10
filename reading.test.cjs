'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    received.push(parsed);
    const content = await respond(parsed, received.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {
    settings: { endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock', key: 'test-key' },
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
