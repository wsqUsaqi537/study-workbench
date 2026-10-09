'use strict';

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.studyI18n = api;
})(typeof globalThis === 'object' ? globalThis : this, function (load, root) {
  const languages = new Set(['zh-CN', 'en']);
  const core = {
    '学习工作台': 'Study Workbench',
    '无法打开学习工作台': 'Unable to open Study Workbench',
    '语言选项无效。': 'Unsupported language. Choose Simplified Chinese or English.',
    '语言设置格式无效。': 'Invalid language settings.',
    '{0} 无法读取，请先备份该文件再恢复；应用不会覆盖原有数据。': 'Cannot read {0}. Back up the file before restoring it; existing data will not be overwritten.',
    '本地数据超过 40 MB，请导出并删除不再使用的任务。': 'Local data exceeds 40 MB. Export and remove tasks you no longer need.',
    '本地存储格式无效，请备份后恢复。': 'Invalid local storage. Back up your data before restoring it.',
    '昵称格式无效。': 'Invalid nickname.',
    '昵称不能包含控制字符。': 'Your nickname cannot contain control characters.',
    '昵称最多 30 个字符。': 'Your nickname can contain up to 30 characters.',
    '头像数据无效或过大。': 'The profile photo is invalid or too large.',
    '头像必须是有效的 PNG 图片。': 'The profile photo must be a valid PNG image.',
    '头像尺寸必须在 1 到 256 像素之间。': 'Profile photo dimensions must be between 1 and 256 pixels.',
    '头像图片无法解码。': 'The profile photo could not be decoded.',
    '本地个人资料格式无效。': 'Invalid local profile data.',
    '系统无法解密已保存的 API Key，请在设置中重新填写。': 'The saved API key could not be decrypted. Enter it again in API settings.',
    '请先配置有效的 API 地址、模型名称和 API Key。{0}': 'Configure a valid API URL, model name and API key first. {0}',
    '任务数据无效。': 'Invalid task data.',
    '任务编号无效。': 'Invalid task ID.',
    '计划天数与学习周期不一致。': 'The number of planned days does not match the study duration.',
    '每日学习任务格式无效。': 'Invalid daily learning tasks.',
    '每日计划内容或时间无效。': 'Invalid daily plan content or time budget.',
    '完成状态无效。': 'Invalid completion status.',
    '单个任务数据过大，请减少材料。': 'This task is too large. Reduce the attached materials.',
    '请求来源无效。': 'Invalid request origin.',
    '每次最多添加 10 份有效的本机材料。': 'Add up to 10 valid local materials at a time.',
    '最多保存 100 个任务，请先导出并删除旧任务。': 'You can save up to 100 tasks. Export and remove old tasks first.'
  };
  let cachedCatalog;

  function normalizeLanguage(language) {
    return language === 'en' ? 'en' : 'zh-CN';
  }

  function systemLanguage(locale) {
    return /^zh(?:[-_]|$)/i.test(locale || '') ? 'zh-CN' : 'en';
  }

  function validatePreferences(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'language')) {
      throw new Error('语言设置格式无效。');
    }
    if (!languages.has(input.language)) throw new Error('语言选项无效。');
    return { language: input.language };
  }

  function catalog() {
    if (load) {
      cachedCatalog ||= { ...load('./ui-messages.js'), ...load('./service-messages.js'), ...core };
      return cachedCatalog;
    }
    cachedCatalog ||= { ...root.studyUIMessages, ...core };
    return cachedCatalog;
  }

  function interpolate(message, values) {
    return message.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < values.length ? String(values[index]) : placeholder);
  }

  function createTranslator(getLanguage) {
    return function translate(message, ...values) {
      const tagged = Array.isArray(message) && Object.hasOwn(message, 'raw');
      const key = tagged ? message.reduce((text, part, index) => text + part + (index < values.length ? `{${index}}` : ''), '') : String(message);
      const text = normalizeLanguage(getLanguage()) === 'en' ? core[key] || catalog()[key] || key : key;
      return tagged ? interpolate(text, values) : text;
    };
  }

  function escapePattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function translateError(message, language) {
    const original = String(message || '');
    if (normalizeLanguage(language) !== 'en' || !/[\u3400-\u9fff]/u.test(original)) return original;
    const messages = catalog();
    if (messages[original]) return messages[original];
    function matchTemplate(value, depth) {
      if (messages[value]) return messages[value];
      if (depth > 2 || !/[\u3400-\u9fff]/u.test(value)) return null;
      for (const [source, translated] of Object.entries(messages)) {
        if (!/\{\d+\}/.test(source) || source.startsWith('<')) continue;
        const indices = [];
        const parts = source.split(/(\{\d+\})/g).map(part => {
          const match = /^\{(\d+)\}$/.exec(part);
          if (!match) return escapePattern(part);
          indices.push(Number(match[1]));
          return '([\\s\\S]*?)';
        });
        const match = new RegExp('^' + parts.join('') + '$').exec(value);
        if (match) {
          const values = [];
          indices.forEach((index, position) => { values[index] = matchTemplate(match[position + 1], depth + 1) || match[position + 1]; });
          return interpolate(translated, values);
        }
      }
      return null;
    }
    return matchTemplate(original, 0) || 'The operation could not be completed. Check your input and API settings, then try again.';
  }

  function languageInstruction(language) {
    return normalizeLanguage(language) === 'en'
      ? 'Write all natural-language replies, learning content, questions, explanations, feedback and reports in English. Keep the required JSON keys and constrained enum values unchanged, including 入门/进阶/较难 and 重点/了解. Copy source citations and filenames exactly; do not translate them.'
      : '所有面向学习者的回复、学习内容、题目、讲解、反馈和报告使用简体中文；JSON字段、枚举、文件名和来源引用保持规定的原值。';
  }

  return { normalizeLanguage, systemLanguage, validatePreferences, createTranslator, translateError, languageInstruction };
});
