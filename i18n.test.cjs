'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const i18n = require('./i18n.js');

test('语言偏好仅接受两种语言，首次按系统语言选择', () => {
  assert.equal(i18n.systemLanguage('zh-CN'), 'zh-CN');
  assert.equal(i18n.systemLanguage('zh_TW'), 'zh-CN');
  assert.equal(i18n.systemLanguage('en-US'), 'en');
  assert.equal(i18n.systemLanguage('fr-FR'), 'en');
  for (const language of ['zh-CN', 'en']) assert.deepEqual(i18n.validatePreferences({ language }), { language });
  for (const value of [null, [], {}, { language: 'en-US' }, { language: 'en', key: 'unexpected' }]) {
    assert.throws(() => i18n.validatePreferences(value));
  }
});

test('翻译只处理模板固定文字，保留用户插值与中文原文', () => {
  const root = { studyUIMessages: { '第 {0} 天 · {1}': '{1} · Day {0}' } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./i18n.js'), 'utf8'), { globalThis: root });
  let language = 'en';
  const t = root.studyI18n.createTranslator(() => language);
  const title = '用户的中文内容 {0} <img>';
  assert.equal(t`第 ${2} 天 · ${title}`, `${title} · Day 2`);
  language = 'zh-CN';
  assert.equal(t`第 ${2} 天 · ${title}`, `第 2 天 · ${title}`);
  assert.equal(title, '用户的中文内容 {0} <img>');
});

test('错误模板翻译已知标签，但保留用户文件名', () => {
  const root = { studyUIMessages: {
    '{0}长度无效。': 'Invalid length for {0}.',
    '第 {0} 份材料': 'material {0}'
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./i18n.js'), 'utf8'), { globalThis: root });
  assert.equal(root.studyI18n.translateError('第 2 份材料长度无效。', 'en'), 'Invalid length for material 2.');
  assert.equal(root.studyI18n.translateError('课程笔记.tex长度无效。', 'en'), 'Invalid length for 课程笔记.tex.');
  assert.equal(root.studyI18n.translateError('第 2 份材料长度无效。', 'zh-CN'), '第 2 份材料长度无效。');
});
