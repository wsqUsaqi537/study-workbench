'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const workerNode = require('tesseract.js/src/worker/node');
const originalSpawnWorker = workerNode.spawnWorker;
const spawnedWorkers = [];
workerNode.spawnWorker = options => {
  const worker = originalSpawnWorker(options);
  const terminate = worker.terminate.bind(worker);
  const record = { worker, terminationCount: 0, errorCount: 0, exitCodes: [] };
  let markExited;
  record.exitPromise = new Promise(resolve => {
    markExited = resolve;
  });
  worker.once('error', () => {
    record.errorCount += 1;
  });
  worker.once('exit', code => {
    record.exitCodes.push(code);
    markExited(code);
  });
  worker.terminate = (...args) => {
    record.terminationCount += 1;
    return terminate(...args);
  };
  spawnedWorkers.push(record);
  return worker;
};
const { recoverPdfPages } = require('./ocr.cjs');
workerNode.spawnWorker = originalSpawnWorker;
const Tesseract = require('tesseract.js');

function withWorkerFactory(factory, run) {
  const original = Tesseract.createWorker;
  Tesseract.createWorker = factory;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Tesseract.createWorker = original;
    });
}

function parserFor(pages, calls) {
  return {
    async getInfo(options) {
      calls.info.push(options);
      return { pages: [{ pageNumber: options.partial[0], width: 595, height: 842 }] };
    },
    async getScreenshot(options) {
      calls.screenshots.push(options);
      const num = options.partial[0];
      return {
        pages: [{ pageNumber: num, data: Buffer.from(String(num)), width: options.desiredWidth, height: Math.round(options.desiredWidth * 842 / 595) }]
      };
    }
  };
}

test('正常数学、Greek 和中文文本不触发 OCR', async () => {
  let workerCalls = 0;
  const pages = [
    { num: 1, text: '设 X∼N(μ, σ²)，则 α + β = γ。' },
    { num: 2, text: '微积分：∫₀¹ x²dx = 1/3；中文说明。\n第二行。' }
  ];
  const result = await withWorkerFactory(async () => {
    workerCalls += 1;
    throw new Error('正常页面不应启动 OCR');
  }, () => recoverPdfPages({}, pages));

  assert.equal(workerCalls, 0);
  assert.strictEqual(result.pages, pages);
  assert.deepEqual(result.readingWarnings, []);
});

test('只渲染并识别异常页，保留物理页号并报告进度', async () => {
  const calls = { screenshots: [], info: [], recognized: [], terminated: 0 };
  const parser = parserFor([], calls);
  const pages = [
    { num: 3, text: '正常的中文与公式 E[X]=μ。' },
    { num: 7, text: 'A'.repeat(100) + '\u0001\u0002\u0003' },
    { num: 10, text: '' }
  ];
  const progress = [];
  const result = await withWorkerFactory(async (languages, oem, options) => {
    assert.equal(languages, 'eng+chi_sim');
    assert.equal(options.cacheMethod, 'none');
    assert.equal(options.gzip, true);
    assert.equal(typeof options.errorHandler, 'function');
    assert.equal(options.langPath, path.resolve(__dirname));
    assert.ok(path.isAbsolute(options.corePath));
    assert.ok(path.isAbsolute(options.workerPath));
    for (const file of [
      path.join(options.langPath, 'chi_sim.traineddata.gz'),
      path.join(options.langPath, 'eng.traineddata.gz'),
      options.workerPath,
      path.join(options.corePath, 'tesseract-core-lstm.wasm')
    ]) {
      await fs.access(file);
    }
    return {
      async recognize(image) {
        const num = Number(image.toString());
        calls.recognized.push(num);
        return { data: { text: 'OCR 第 ' + num + ' 页中文文字' } };
      },
      async terminate() {
        calls.terminated += 1;
      }
    };
  }, () => recoverPdfPages(parser, pages, { onProgress: event => progress.push(event) }));

  assert.deepEqual(calls.screenshots.map(options => options.partial[0]), [7, 10]);
  assert.deepEqual(calls.info.map(options => options.partial[0]), [7, 10]);
  assert.ok(calls.screenshots.every(options => options.imageBuffer && !options.imageDataUrl));
  assert.ok(calls.screenshots.every(options => options.desiredWidth <= 2300));
  assert.deepEqual(calls.recognized, [7, 10]);
  assert.equal(calls.terminated, 1);
  assert.equal(result.pages[0], pages[0]);
  assert.equal(result.pages[1].num, 7);
  assert.equal(result.pages[1].text, 'OCR 第 7 页中文文字');
  assert.equal(result.pages[2].text, 'OCR 第 10 页中文文字');
  assert.match(result.readingWarnings[0], /公式/);
  assert.ok(progress.some(event => event.stage === 'ocr' && event.page === 7 && event.total === 2));
});

test('异常页 OCR 为空或截图超限时报告未恢复，空原文页识别为空也提示核对', async () => {
  const calls = { screenshots: [], info: [], recognized: [], terminated: 0 };
  const pages = [
    { num: 2, text: 'B'.repeat(100) + '\u0001\u0002\u0003' },
    { num: 3, text: 'C'.repeat(100) + '\u0001\u0002\u0003' },
    { num: 4, text: 'D'.repeat(100) + '\u0001\u0002\u0003' },
    { num: 5, text: '' }
  ];
  const parser = {
    async getInfo(options) {
      calls.info.push(options);
      return { pages: [{ pageNumber: options.partial[0], width: 595, height: 842 }] };
    },
    async getScreenshot(options) {
      const num = options.partial[0];
      calls.screenshots.push(options);
      return {
        pages: [{
          pageNumber: num,
          data: Buffer.from(String(num)),
          width: num === 2 ? 2301 : options.desiredWidth,
          height: num === 2 ? 3000 : Math.round(options.desiredWidth * 842 / 595)
        }]
      };
    }
  };
  const result = await withWorkerFactory(async () => ({
    async recognize(image) {
      const num = Number(image.toString());
      calls.recognized.push(num);
      return { data: { text: num === 4 ? '恢复出的中文内容' : '' } };
    },
    async terminate() {
      calls.terminated += 1;
    }
  }), () => recoverPdfPages(parser, pages));

  assert.deepEqual(calls.recognized, [3, 4, 5]);
  assert.equal(result.pages[0].text, pages[0].text);
  assert.equal(result.pages[1].text, pages[1].text);
  assert.equal(result.pages[2].text, '恢复出的中文内容');
  assert.equal(result.pages[3].text, '');
  assert.equal(calls.terminated, 1);
  assert.ok(result.readingWarnings.some(warning => /已通过本地 OCR/.test(warning)));
  assert.ok(result.readingWarnings.some(warning => /未识别出可用文字/.test(warning)));

  const blankResult = await withWorkerFactory(async () => ({
    async recognize() {
      return { data: { text: '' } };
    },
    async terminate() {}
  }), () => recoverPdfPages(parserFor([], { screenshots: [], info: [], recognized: [], terminated: 0 }), [
    { num: 6, text: '' }
  ]));
  assert.equal(blankResult.readingWarnings.length, 1);
  assert.match(blankResult.readingWarnings[0], /未识别出可用文字/);
});

test('OCR 文本按 PDF 与版本缓存，最多保留最近三个文档', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ocr-cache-'));
  const cachePath = path.join(directory, 'ocr-cache.json');
  const calls = { screenshots: [], info: [], recognized: [], terminated: 0 };
  const parser = parserFor([], calls);
  let workerStarts = 0;
  try {
    for (let index = 1; index <= 5; index += 1) {
      await withWorkerFactory(async () => {
        workerStarts += 1;
        return {
          async recognize(image) {
            return { data: { text: '本地 OCR 缓存页 ' + image.toString() } };
          },
          async terminate() {
            calls.terminated += 1;
          }
        };
      }, () => recoverPdfPages(parser, [{ num: index, text: '' }], {
        cachePath,
        cacheKey: 'pdf-hash-' + index
      }));
    }

    const cacheText = await fs.readFile(cachePath, 'utf8');
    const cache = JSON.parse(cacheText);
    assert.equal(cache.documents.length, 3);
    assert.doesNotMatch(cacheText, /data:image|base64/);
    assert.equal(workerStarts, 5);
    assert.equal(calls.terminated, 5);

    const beforeScreenshots = calls.screenshots.length;
    const beforeWorkers = workerStarts;
    const cached = await withWorkerFactory(async () => {
      workerStarts += 1;
      throw new Error('缓存命中不应创建 worker');
    }, () => recoverPdfPages(parser, [{ num: 5, text: '' }], {
      cachePath,
      cacheKey: 'pdf-hash-5'
    }));
    assert.equal(cached.pages[0].text, '本地 OCR 缓存页 5');
    assert.equal(calls.screenshots.length, beforeScreenshots);
    assert.equal(workerStarts, beforeWorkers);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('取消正在运行的 OCR 会终止 worker 并拒绝当前识别', async () => {
  const calls = { screenshots: [], info: [], recognized: [], terminated: 0 };
  const controller = new AbortController();
  let markRecognizing;
  const recognizing = new Promise(resolve => {
    markRecognizing = resolve;
  });

  const operation = withWorkerFactory(async () => ({
    recognize() {
      markRecognizing();
      return new Promise(() => {});
    },
    async terminate() {
      calls.terminated += 1;
    }
  }), () => recoverPdfPages(parserFor([], calls), [{ num: 4, text: '' }], { signal: controller.signal }));

  await recognizing;
  controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
  assert.equal(calls.terminated, 1);
});

test('初始化期间取消会在 worker 创建后立即终止，避免遗留线程', async () => {
  const calls = { screenshots: [], info: [], recognized: [], terminated: 0 };
  const controller = new AbortController();
  let markInitializing;
  let resolveWorker;
  const initializing = new Promise(resolve => {
    markInitializing = resolve;
  });
  const workerReady = new Promise(resolve => {
    resolveWorker = resolve;
  });
  const operation = withWorkerFactory(() => {
    markInitializing();
    return workerReady;
  }, () => recoverPdfPages(parserFor([], calls), [{ num: 4, text: '' }], { signal: controller.signal }));

  await initializing;
  controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
  resolveWorker({
    async terminate() {
      calls.terminated += 1;
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.terminated, 1);
});

test('初始化资源错误会由 errorHandler 捕获并终止底层线程', { timeout: 15000 }, async () => {
  const originalCreateWorker = Tesseract.createWorker;
  const missingLanguagePath = path.join(os.tmpdir(), 'study-ocr-missing-model-' + process.pid);
  const previousWorkers = spawnedWorkers.length;
  let timedOut = false;
  const operation = withWorkerFactory((languages, oem, options) => originalCreateWorker(
    languages,
    oem,
    { ...options, langPath: missingLanguagePath }
  ), () => recoverPdfPages(
    parserFor([], { screenshots: [], info: [], recognized: [], terminated: 0 }),
    [{ num: 12, text: '' }]
  ));
  let timeout;
  try {
    const result = await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error('等待 Tesseract 初始化错误超时'));
        }, 10000);
      })
    ]);
    assert.equal(timedOut, false);
    assert.ok(result.readingWarnings.some(warning => /未识别出可用文字/.test(warning)));
    assert.equal(spawnedWorkers.length, previousWorkers + 1);
    assert.equal(spawnedWorkers.at(-1).terminationCount, 1);
  } finally {
    clearTimeout(timeout);
    for (const record of spawnedWorkers.slice(previousWorkers)) {
      if (record.terminationCount === 0) await record.worker.terminate();
    }
  }
});

test('真实 worker 启动脚本异常经 Node error/exit 监听转为 warning 并终止线程', { timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ocr-worker-error-'));
  const previousWorkers = spawnedWorkers.length;
  const originalCreateWorker = Tesseract.createWorker;
  let timeout;
  try {
    const scripts = [
      { name: 'worker-throws.js', source: "throw new Error('intentional OCR worker startup failure');\n", error: true },
      { name: 'worker-exits.js', source: 'process.exit(7);\n', error: false }
    ];
    for (let index = 0; index < scripts.length; index += 1) {
      const script = scripts[index];
      const workerScript = path.join(directory, script.name);
      const workerCount = spawnedWorkers.length;
      await fs.writeFile(workerScript, script.source);
      const operation = withWorkerFactory((languages, oem, options) => originalCreateWorker(
        languages,
        oem,
        { ...options, workerPath: workerScript }
      ), () => recoverPdfPages(
        parserFor([], { screenshots: [], info: [], recognized: [], terminated: 0 }),
        [{ num: 13 + index, text: '' }]
      ));
      const result = await Promise.race([
        operation,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('等待 worker 启动脚本异常超时')), 5000);
        })
      ]);
      clearTimeout(timeout);
      timeout = undefined;
      assert.ok(result.readingWarnings.some(warning => /未识别出可用文字/.test(warning)));
      assert.equal(spawnedWorkers.length, workerCount + 1);
      const record = spawnedWorkers.at(-1);
      assert.equal(record.terminationCount, 1);
      assert.equal(record.errorCount, script.error ? 1 : 0);
      const exitCode = await Promise.race([
        record.exitPromise,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('等待 worker exit 事件超时: ' + script.name)), 5000);
        })
      ]);
      clearTimeout(timeout);
      timeout = undefined;
      assert.equal(record.exitCodes.length, 1);
      assert.notEqual(exitCode, 0, script.name);
    }
  } finally {
    clearTimeout(timeout);
    for (const record of spawnedWorkers.slice(previousWorkers)) {
      if (record.terminationCount === 0) await record.worker.terminate();
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
