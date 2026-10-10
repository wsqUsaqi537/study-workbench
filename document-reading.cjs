'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GUIDES = {
  '.pdf': 'pdf-reading.SKILL.md',
  '.pptx': 'ppt-reading.SKILL.md'
};

function guideBody(fileName) {
  const content = fs.readFileSync(path.join(__dirname, fileName), 'utf8');
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

function documentReadingRules(materials) {
  if (!Array.isArray(materials)) return '';
  const extensions = new Set(materials
    .filter(material => material && typeof material.name === 'string')
    .map(material => path.extname(material.name).toLowerCase())
    .filter(extension => Object.hasOwn(GUIDES, extension)));
  return [...extensions].map(extension => guideBody(GUIDES[extension])).join('\n\n');
}

module.exports = { documentReadingRules };
