'use strict';

const services = require('./services.cjs');
const assessment = require('./assessment.cjs');
const { EXAMPASS_RULES } = require('./exampass.cjs');
const { languageInstruction, normalizeLanguage } = require('./i18n.js');

const LESSON_DEPTHS = new Set(['brief', 'detailed']);
const MAX_ATTACHMENT_CONTEXT = 10000;

function fail(message) {
  throw new Error(message);
}

function plain(value) {
  return services.isPlainObject(value);
}

function requireStringList(value, label, maxItems, maxLength, allowEmpty = true) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length < 1)) {
    fail(label + '格式无效。');
  }
  value.forEach((item, index) => services.requireString(item, label + '第 ' + (index + 1) + ' 项', 1, maxLength));
  return value;
}

function canonicalIndex(value) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateLessonRecord(record, task, dayIndex, depth) {
  services.exactKeys(record, ['text', 'sources', 'limitations', 'generatedDate', 'dayTitle', 'dayTasks', 'daySource'], '讲解缓存');
  services.requireString(record.text, '讲解内容', 1, 12000);
  requireStringList(record.sources, '讲解来源', 10, 2000, false);
  requireStringList(record.limitations, '讲解限制', 10, 500);
  record.sources.forEach(source => services.validateSource(source, task, '讲解来源'));
  if (!validDate(record.generatedDate)) fail('讲解缓存生成日期无效。');
  if (!Number.isInteger(task.days) || dayIndex < 0 || dayIndex >= task.days || !plain(task.plan) ||
      !Array.isArray(task.plan.days) || task.plan.days.length !== task.days) fail('讲解缓存对应的学习日期无效。');
  const day = task.plan && task.plan.days && task.plan.days[dayIndex];
  if (!plain(day) || typeof day.title !== 'string' || !Array.isArray(day.tasks) || day.tasks.length < 1 || day.tasks.length > 20 ||
      day.tasks.some(item => typeof item !== 'string' || item.length > 2000) ||
      record.dayTitle !== day.title || !Array.isArray(record.dayTasks) ||
      JSON.stringify(record.dayTasks) !== JSON.stringify(day.tasks) || record.daySource !== day.source) {
    fail('讲解缓存与当前日计划不一致，请清除后重新生成。');
  }
  services.validateSource(day.source, task, '每日来源');
  if (!LESSON_DEPTHS.has(depth)) fail('讲解深度无效。');
  return record;
}

function ratedQuizFor(task, kind, dayIndex) {
  const quiz = kind === 'daily'
    ? task.dailyQuizzes && task.dailyQuizzes[String(dayIndex)]
    : task.quiz;
  if (!quiz) fail('任务中没有对应的测验。');
  assessment.validateAssessment(quiz);
  if (quiz.version !== 2 || quiz.kind !== kind || quiz.dayIndex !== dayIndex || !quiz.result || !quiz.answers) {
    fail('追问仅支持已评分的 version 2 测验。');
  }
  return quiz;
}

function validateTutorMessage(message, index, stored) {
  if (!plain(message) || !['user', 'assistant'].includes(message.role)) fail('追问消息格式无效。');
  const expected = stored
    ? ['role', 'text', ...(Object.hasOwn(message, 'sources') ? ['sources'] : []), ...(Object.hasOwn(message, 'limitations') ? ['limitations'] : [])]
    : ['role', 'text'];
  services.exactKeys(message, expected, '第 ' + (index + 1) + ' 条追问消息');
  services.requireString(message.text, '追问消息', 1, message.role === 'user' ? 2000 : 6000);
  if (stored) {
    if (Object.hasOwn(message, 'sources')) {
      requireStringList(message.sources, '追问来源', 10, 2000);
      message.sources.forEach(source => services.validateSource(source, stored.task, '追问来源'));
    }
    if (Object.hasOwn(message, 'limitations')) requireStringList(message.limitations, '追问限制', 10, 500);
  }
  return message;
}

function validateChatRecord(record, task, key) {
  services.exactKeys(record, ['kind', 'dayIndex', 'questionId', 'question', 'answer', 'feedback', 'messages'], '追问记录');
  const dailyMatch = /^daily:(0|[1-9]\d*):(q(?:[1-9]|10))$/.exec(key);
  const finalMatch = /^final:(q(?:[1-9]|10))$/.exec(key);
  if ((!dailyMatch && !finalMatch) || record.kind !== (dailyMatch ? 'daily' : 'final') ||
      record.questionId !== (dailyMatch ? dailyMatch[2] : finalMatch[1])) fail('追问记录编号与缓存键不一致。');
  if (record.kind === 'daily') {
    const dayIndex = Number(dailyMatch[1]);
    if (!Number.isInteger(task.days) || record.dayIndex !== dayIndex || dayIndex >= task.days) fail('每日追问记录日期无效。');
  } else if (record.dayIndex !== null) {
    fail('期末追问记录的 dayIndex 必须为 null。');
  }

  const quiz = ratedQuizFor(task, record.kind, record.dayIndex);
  const question = quiz.questions.find(item => item.id === record.questionId);
  if (!question) fail('追问题目不在对应测验中。');
  const answer = quiz.answers[record.questionId].text;
  const feedback = quiz.result.items.find(item => item.id === record.questionId).feedback;
  services.requireString(record.question, '追问题干', 1, 2000);
  services.requireString(record.answer, '追问作答', 1, 4000);
  services.requireString(record.feedback, '追问评分反馈', 1, 2000);
  if (record.question !== question.question || record.answer.trim() !== answer.trim() || record.feedback !== feedback) {
    fail('追问记录与当前题目、作答或评分反馈不一致，请清除后重试。');
  }
  if (!Array.isArray(record.messages) || record.messages.length < 2 || record.messages.length > 40) {
    fail('已保存的追问对话必须包含 2 至 40 条消息。');
  }
  record.messages.forEach((message, index) => {
    validateTutorMessage(message, index, { task });
    if (message.role !== (index % 2 === 0 ? 'user' : 'assistant')) fail('已保存的追问消息必须由用户开始并交替排列。');
  });
  if (record.messages.at(-1).role !== 'assistant') fail('已保存的追问对话必须以讲解回复结束。');
}

function validateTutoringRecords(task) {
  if (!plain(task)) fail('任务格式无效。');
  if (task.lessons !== undefined) {
    if (!plain(task.lessons)) fail('每日讲解缓存格式无效。');
    for (const [dayKey, depths] of Object.entries(task.lessons)) {
      if (!canonicalIndex(dayKey) || Number(dayKey) >= task.days || !plain(depths)) fail('每日讲解缓存日期无效。');
      for (const [depth, record] of Object.entries(depths)) {
        if (!LESSON_DEPTHS.has(depth)) fail('讲解深度无效。');
        validateLessonRecord(record, task, Number(dayKey), depth);
      }
    }
  }
  if (task.tutorChats !== undefined) {
    if (!plain(task.tutorChats)) fail('追问记录格式无效。');
    for (const [key, record] of Object.entries(task.tutorChats)) validateChatRecord(record, task, key);
  }
  return true;
}

function validatePlanDay(task, dayIndex) {
  services.validateInput(task);
  if (!plain(task.plan) || !Array.isArray(task.plan.days) || task.plan.days.length !== task.days) fail('学习计划与学习周期不一致。');
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= task.days) fail('讲解日期超出学习周期。');
  const day = task.plan.days[dayIndex];
  if (!plain(day) || day.day !== dayIndex + 1 || day.date !== services.formatDate(task.startDate, dayIndex)) fail('学习计划日期或顺序无效。');
  services.requireString(day.title, '每日标题', 1, 300);
  if (!Array.isArray(day.tasks) || day.tasks.length < 1 || day.tasks.length > 20 ||
      day.tasks.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) fail('每日学习任务格式无效。');
  services.validateSource(day.source, task, '每日来源');
  if (task.plan.knowledge !== undefined) services.validateKnowledge(task.plan.knowledge, task);
  return day;
}

function textTokens(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase();
  const tokens = new Set();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      if (word.length === 1) tokens.add(word);
      for (let index = 0; index < word.length - 1; index += 1) tokens.add(word.slice(index, index + 2));
    } else if (word.length > 1) tokens.add(word);
  }
  return tokens;
}

function relevanceScore(value, targetTokens) {
  let score = 0;
  for (const token of textTokens(value)) if (targetTokens.has(token)) score += 1;
  return score;
}

function relatedKnowledge(knowledge, target, maxItems = 8) {
  const list = Array.isArray(knowledge) ? knowledge : [];
  const targetTokens = textTokens(target);
  const ranked = list.map((item, index) => ({ item, index, score: relevanceScore(item.title + ' ' + item.explanation, targetTokens) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const relevant = ranked.filter(entry => entry.score > 0).slice(0, maxItems);
  return (relevant.length ? relevant : ranked.slice(0, Math.min(3, maxItems))).map(entry => entry.item);
}

function sourceReferences(source, materialName, materialNames) {
  const refs = new Set();
  for (const citation of source.split(/[;；\n]+/).map(part => part.trim())) {
    if (!citation.startsWith(materialName)) continue;
    const fragment = citation.slice(materialName.length);
    for (const reference of fragment.matchAll(/第\s*(\d+)\s*(页|张幻灯片)/g)) refs.add(reference[1] + '|' + reference[2]);
  }
  return refs;
}

function excerptMaterialText(material, references, target, remaining) {
  const marker = /【第\s*(\d+)\s*(页|张幻灯片)】/g;
  const markers = [...material.text.matchAll(marker)];
  let chunks = [];
  if (references.size) {
    chunks = markers.map((item, index) => ({
      key: item[1] + '|' + item[2],
      text: material.text.slice(item.index, markers[index + 1]?.index ?? material.text.length)
    })).filter(item => references.has(item.key)).map(item => item.text);
  } else if (!markers.length) {
    const targetTokens = textTokens(target);
    chunks = material.text.split(/\n{2,}/).map((text, index) => ({ text, index, score: relevanceScore(text, targetTokens) }))
      .filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 4).sort((left, right) => left.index - right.index).map(item => item.text);
  }
  const text = chunks.join('\n\n');
  if (!text || remaining <= 0) return '';
  return text.length <= remaining ? text : text.slice(0, Math.max(0, remaining - 8)) + '…[截断]';
}

function relevantMaterials(task, sources, target) {
  const citations = [...new Set(sources)];
  const excerpted = [];
  let remaining = MAX_ATTACHMENT_CONTEXT;
  for (const material of task.materials) {
    const refs = new Set(citations.flatMap(source => [...sourceReferences(source, material.name)]));
    if (!refs.size && !citations.some(source => source.split(/[;；\n]+/).some(part => part.trim() === material.name))) continue;
    const text = excerptMaterialText(material, refs, target, remaining);
    if (!text) continue;
    excerpted.push({ id: material.id, name: material.name, units: material.units, chars: material.chars, text });
    remaining -= text.length;
    if (remaining <= 0) break;
  }
  return excerpted;
}

function validateTutoringResponse(value, label, allowedSources, task, maxText) {
  services.exactKeys(value, ['text', 'sources', 'limitations'], label + '响应');
  services.requireString(value.text, label + '内容', 1, maxText);
  requireStringList(value.sources, label + '来源', 10, 2000, false);
  requireStringList(value.limitations, label + '限制', 10, 500);
  value.sources.forEach(source => {
    services.validateSource(source, task, label + '来源');
    if (!allowedSources.includes(source)) fail(label + '引用了未提供的来源。');
  });
  return value;
}

async function generateLesson(task, dayIndex, depth, settings = {}) {
  services.validateInput(task);
  if (!LESSON_DEPTHS.has(depth)) fail('讲解深度必须为 brief 或 detailed。');
  const day = validatePlanDay(task, dayIndex);
  validateTutoringRecords(task);
  const cached = task.lessons && task.lessons[String(dayIndex)] && task.lessons[String(dayIndex)][depth];
  if (cached) return { text: cached.text, sources: cached.sources, limitations: cached.limitations };
  services.requireApiConfiguration(settings, '生成每日讲解');

  const target = [task.title, day.title, ...day.tasks].join('\n');
  const knowledge = relatedKnowledge(task.plan.knowledge, target);
  const sources = [...new Set([day.source, ...knowledge.map(item => item.source)])];
  sources.forEach(source => services.validateSource(source, task, '讲解来源'));
  const materials = relevantMaterials(task, sources, target + '\n' + knowledge.map(item => item.title).join('\n'));
  const supplementLabel = normalizeLanguage(settings.language) === 'en' ? 'General background' : '通识补充';
  const systemMessage = [
    '你是每日学习讲解助手。只讲解给出的当前日任务，不提前讲未来学习内容。',
    EXAMPASS_RULES,
    depth === 'brief' ? '使用简洁讲解，重点帮助学习者快速理解并完成当天任务。' : '使用展开讲解，说明原理、步骤和边界，但严格限定在当天任务。',
    '正文用清晰纯文本分段，必须包含“概念”“例子”“易错点”“练习”四部分，练习恰好一道。',
    '仅返回 JSON：{"text":string,"sources":string[],"limitations":string[]}。sources 只能逐字选用 payload.allowedSources 中的来源。引用材料时必须包含真实文件名和给定页码或幻灯片编号。材料外的基础知识须在正文中标注“' + supplementLabel + '”。',
    '材料证据有限时，在 limitations 中说明；不要声称覆盖了未提供或未发送的内容。不要泄露 API 配置或隐藏信息。',
    languageInstruction(settings.language)
  ].join('\n');
  const payload = {
    purpose: '讲解当前日学习内容',
    outputLanguage: normalizeLanguage(settings.language),
    depth,
    title: task.title,
    day: { day: day.day, date: day.date, title: day.title, tasks: day.tasks, source: day.source },
    knowledge,
    allowedSources: sources
  };
  const context = services.boundedContext(payload, materials, services.contextBudget(systemMessage, settings));
  const content = await services.requestChat(settings, systemMessage, context.text, depth === 'brief' ? 2800 : 5200, false, true);
  const response = validateTutoringResponse(services.parseModelJson(content, '每日讲解'), '讲解', sources, task, 12000);
  const hasLimitation = response.limitations.some(item => normalizeLanguage(settings.language) === 'en'
    ? /\b(limited|excerpt|not sent|not covered|cannot verify|could not verify)\b/i.test(item)
    : /(有限|片段|未发送|未覆盖)/.test(item));
  if (task.materials.length && !hasLimitation) {
    response.limitations.push(normalizeLanguage(settings.language) === 'en'
      ? "This lesson uses today's plan and the cited material excerpts; content that was not sent could not be checked."
      : '本讲解仅依据当天计划和已引用的材料片段，未发送的内容无法核对。');
  }
  if (!task.materials.length) {
    if (!response.text.includes(supplementLabel)) {
      response.text += normalizeLanguage(settings.language) === 'en'
        ? '\n\nGeneral background: No attachments were provided; this explanation is based on the learning goal and planned knowledge.'
        : '\n\n通识补充：未提供附件，基础说明依据学习目标与计划知识。';
    }
    response.limitations.push(normalizeLanguage(settings.language) === 'en'
      ? 'No original course materials were provided, so course-specific definitions and requirements could not be verified.'
      : '未提供原始材料，无法核对课程材料中的特定定义或要求。');
  }
  if (response.text.length > 12000 || response.limitations.length > 10) fail('每日讲解结果超出长度限制。');
  return response;
}

function validateSelector(task, selector) {
  if (!plain(selector)) fail('测验选择格式无效。');
  if (selector.kind === 'daily') {
    services.exactKeys(selector, ['kind', 'dayIndex'], '每日测验选择');
    if (!Number.isInteger(selector.dayIndex) || selector.dayIndex < 0 || selector.dayIndex >= task.days) fail('每日测验日期超出学习周期。');
    return { kind: 'daily', dayIndex: selector.dayIndex };
  }
  if (selector.kind === 'final') {
    services.exactKeys(selector, ['kind'], '期末测验选择');
    return { kind: 'final', dayIndex: null };
  }
  fail('测验选择必须是 daily 或 final。');
}

async function answerQuestion(task, selector, questionId, messages, settings = {}) {
  services.validateInput(task);
  if (!plain(task.plan) || !Array.isArray(task.plan.days) || task.plan.days.length !== task.days) fail('学习计划与学习周期不一致。');
  if (task.plan.knowledge !== undefined) services.validateKnowledge(task.plan.knowledge, task);
  validateTutoringRecords(task);
  selector = validateSelector(task, selector);
  if (typeof questionId !== 'string' || !/^q(?:[1-9]|10)$/.test(questionId)) fail('题目编号无效。');
  const quiz = ratedQuizFor(task, selector.kind, selector.dayIndex);
  const question = quiz.questions.find(item => item.id === questionId);
  if (!question) fail('追问题目不在所选测验中。');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 9) fail('本次追问最多发送 9 条消息。');
  messages.forEach((message, index) => {
    validateTutorMessage(message, index, false);
    if (message.role !== (index % 2 === 0 ? 'user' : 'assistant')) fail('追问消息必须由用户开始并交替排列。');
  });
  if (messages.at(-1).role !== 'user') fail('追问消息必须以用户问题结束。');
  const dayIndex = selector.kind === 'daily' ? selector.dayIndex : task.days - 1;
  const target = question.question + '\n' + question.reference + '\n' + question.answer;
  const knowledge = relatedKnowledge(task.plan.knowledge, target, 6);
  const allowedSources = [...new Set(knowledge.map(item => item.source))];
  if (!allowedSources.length) {
    const day = task.plan.days[dayIndex];
    if (day && day.source) allowedSources.push(day.source);
  }
  allowedSources.forEach(source => services.validateSource(source, task, '追问来源'));
  const answer = quiz.answers[questionId].text;
  const feedback = quiz.result.items.find(item => item.id === questionId).feedback;
  const systemMessage = [
    '你是错题追问辅导助手。回答用户最后一条消息，围绕当前题目解释思路、常见误区并给一个简短例子。',
    EXAMPASS_RULES,
    '不要直接照抄标准答案作为回复；可以解释答案背后的关键概念。只使用给定参考、作答、评分反馈和相关知识，不要索要或声称读取原始材料。',
    '仅返回 JSON：{"text":string,"sources":string[],"limitations":string[]}。回复不超过 6,000 字；sources 只能逐字选用 payload.allowedSources。材料不足时在 limitations 中说明。',
    languageInstruction(settings.language)
  ].join('\n');
  const payload = {
    purpose: '解释当前测验题和评分反馈',
    outputLanguage: normalizeLanguage(settings.language),
    question: { id: question.id, type: question.type, question: question.question, options: question.options },
    reference: question.reference,
    standardAnswer: question.type === 'choice'
      ? { answer: question.answer, text: question.options['ABCD'.indexOf(question.answer)] }
      : question.answer,
    actualAnswer: answer,
    feedback,
    knowledge,
    allowedSources,
    messages
  };
  services.requireApiConfiguration(settings, '错题追问');
  const context = services.boundedContext(payload, [], services.contextBudget(systemMessage, settings));
  const content = await services.requestChat(settings, systemMessage, context.text, 2600, false, true);
  const response = validateTutoringResponse(services.parseModelJson(content, '错题追问'), '追问', allowedSources, task, 6000);
  const hasMaterialLimitation = response.limitations.some(item => normalizeLanguage(settings.language) === 'en'
    ? /\b(not sent|not provided|cannot verify|could not verify|without the original material)\b/i.test(item)
    : /(未发送|未提供|无法核对)/.test(item));
  if (!hasMaterialLimitation) {
    response.limitations.push(normalizeLanguage(settings.language) === 'en'
      ? 'This reply uses only the current question, reference, answer, grading feedback and related knowledge list; the original material was not sent again.'
      : '本次只依据当前题目、参考、作答、评分反馈和相关知识清单，未重新发送原材料。');
  }
  if (response.limitations.length > 10) fail('错题追问结果超出长度限制。');
  return response;
}

module.exports = { generateLesson, answerQuestion, validateTutoringRecords };
