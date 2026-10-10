'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const workerNode = require('tesseract.js/src/worker/node');
const originalSpawnWorker = workerNode.spawnWorker;
let activeWorkerCapture;
workerNode.spawnWorker = options => {
  const workerThread = originalSpawnWorker(options);
  if (activeWorkerCapture) {
    const capture = activeWorkerCapture;
    capture.workerThread = workerThread;
    workerThread.once('error', error => {
      if (!capture.intentionalTermination && typeof capture.onError === 'function') {
        capture.onError(error);
      }
    });
    workerThread.once('exit', code => {
      if (!capture.intentionalTermination && typeof capture.onError === 'function') {
        capture.onError(new Error('OCR worker exited unexpectedly (' + code + ').'));
      }
    });
  }
  return workerThread;
};
let Tesseract;
try {
  Tesseract = require('tesseract.js');
} finally {
  workerNode.spawnWorker = originalSpawnWorker;
}

const CACHE_VERSION = 'tesseract.js-7.0.0+4.0.0_best_int-v1';
const MAX_CACHE_BYTES = 40 * 1024 * 1024;
const MAX_CACHED_DOCUMENTS = 3;
const MAX_RENDER_EDGE = 2300;
const MAX_RENDER_PIXELS = 4_500_000;
const OCR_WARNING = '部分 PDF 页面已通过本地 OCR 恢复文字；公式和特殊符号可能不完整，请复核。';
const OCR_UNAVAILABLE_WARNING = '部分 PDF 页面未识别出可用文字，请核对这些页面的原文或是否为空白页。';
const OCR_RESOURCE_WARNING = '本地 OCR 资源缺失，无法自动恢复异常页面；请重新安装应用。';

function makeAbortError(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error('PDF OCR 已取消。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError(signal);
}

function isOcrCandidate(text) {
  const value = String(text || '');
  if (!value.trim()) return true;
  if (value.includes('\uFFFD') || /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(value)) {
    return true;
  }

  const characters = Array.from(value).filter(character => !/[\n\r\t\f]/.test(character));
  if (characters.length === 0) return false;
  const controls = characters.filter(character => /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/.test(character));
  return controls.length >= 3 && controls.length / characters.length >= 0.01;
}

function unpackedPath(filePath) {
  return filePath.replace(/\.asar(?=$|[\\/])/, '.asar.unpacked');
}

function resolveTesseractPaths(appRoot = __dirname) {
  const root = unpackedPath(path.resolve(appRoot));
  const nodeModules = path.join(root, 'node_modules');
  return {
    langPath: root,
    corePath: path.join(nodeModules, 'tesseract.js-core'),
    workerPath: path.join(nodeModules, 'tesseract.js', 'src', 'worker-script', 'node', 'index.js')
  };
}

async function hasLocalOcrResources(paths) {
  const required = [
    path.join(paths.langPath, 'chi_sim.traineddata.gz'),
    path.join(paths.langPath, 'eng.traineddata.gz'),
    paths.workerPath,
    path.join(paths.corePath, 'tesseract-core-lstm.js'),
    path.join(paths.corePath, 'tesseract-core-lstm.wasm'),
    path.join(paths.corePath, 'tesseract-core-simd-lstm.js'),
    path.join(paths.corePath, 'tesseract-core-simd-lstm.wasm'),
    path.join(paths.corePath, 'tesseract-core-relaxedsimd-lstm.js'),
    path.join(paths.corePath, 'tesseract-core-relaxedsimd-lstm.wasm')
  ];
  try {
    await Promise.all(required.map(filePath => fs.access(filePath)));
    return true;
  } catch {
    return false;
  }
}

function pageNumber(page, index) {
  return Number.isInteger(page && page.num) && page.num > 0 ? page.num : index + 1;
}

function emptyCache() {
  return { version: 1, documents: [] };
}

async function readCache(cachePath) {
  if (typeof cachePath !== 'string' || !cachePath) return emptyCache();
  try {
    const stat = await fs.stat(cachePath);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return emptyCache();
    const value = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (!value || value.version !== 1 || !Array.isArray(value.documents)) return emptyCache();
    const documents = value.documents
      .filter(document => document && typeof document.id === 'string' && Number.isFinite(document.updatedAt) &&
        document.pages && typeof document.pages === 'object' && !Array.isArray(document.pages))
      .map(document => ({
        id: document.id,
        updatedAt: document.updatedAt,
        pages: Object.fromEntries(Object.entries(document.pages)
          .filter(([num, text]) => /^\d+$/.test(num) && typeof text === 'string'))
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CACHED_DOCUMENTS);
    return { version: 1, documents };
  } catch {
    return emptyCache();
  }
}

async function writeCache(cachePath, cache) {
  if (typeof cachePath !== 'string' || !cachePath) return;
  const documents = [...cache.documents]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CACHED_DOCUMENTS);
  let payload;
  while (documents.length) {
    payload = JSON.stringify({ version: 1, documents });
    if (Buffer.byteLength(payload, 'utf8') <= MAX_CACHE_BYTES) break;
    documents.pop();
  }
  if (!payload || Buffer.byteLength(payload, 'utf8') > MAX_CACHE_BYTES) return;

  const temporaryPath = cachePath + '.tmp-' + process.pid + '-' + randomBytes(6).toString('hex');
  try {
    await fs.writeFile(temporaryPath, payload, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryPath, cachePath);
  } catch {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // Cache failures do not affect document extraction.
    }
  }
}

function getPageDimensions(info) {
  const page = info && Array.isArray(info.pages) ? info.pages[0] : null;
  const width = Number(page && page.width);
  const height = Number(page && page.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function desiredScreenshotWidth(dimensions) {
  if (!dimensions) return 0;
  const { width, height } = dimensions;
  const edgeLimited = MAX_RENDER_EDGE * width / Math.max(width, height);
  const pixelLimited = Math.sqrt(MAX_RENDER_PIXELS * width / height);
  return Math.max(1, Math.floor(Math.min(edgeLimited, pixelLimited)));
}

async function safeTerminate(worker) {
  if (!worker || typeof worker.terminate !== 'function') return;
  try {
    await worker.terminate();
  } catch {
    // A terminated OCR worker may reject while its job is being cancelled.
  }
}

async function recoverPdfPages(parser, pages, hooks = {}) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const candidates = sourcePages
    .map((page, index) => ({ page, index, num: pageNumber(page, index) }))
    .filter(item => isOcrCandidate(item.page && item.page.text));
  if (!candidates.length) return { pages: sourcePages, readingWarnings: [] };

  const signal = hooks.signal;
  throwIfAborted(signal);

  const cache = await readCache(hooks.cachePath);
  const documentId = typeof hooks.cacheKey === 'string' && hooks.cacheKey
    ? CACHE_VERSION + ':' + hooks.cacheKey
    : null;
  const document = documentId ? cache.documents.find(item => item.id === documentId) : null;
  const results = new Map();
  const needsOcr = [];
  let failed = false;
  for (const candidate of candidates) {
    const cachedText = document && document.pages[String(candidate.num)];
    if (typeof cachedText === 'string') {
      results.set(candidate.index, cachedText);
      if (!cachedText) failed = true;
    }
    else needsOcr.push(candidate);
  }
  if (document && results.size) {
    document.updatedAt = Date.now();
    await writeCache(hooks.cachePath, cache);
  }

  let worker;
  const workerCapture = {};
  let workerWasTerminated = false;
  let workerFailed = false;
  let aborted = false;
  let abortReject;
  let rejectWorkerError;
  const abortPromise = new Promise((resolve, reject) => {
    abortReject = reject;
  });
  const workerErrorPromise = new Promise((resolve, reject) => {
    rejectWorkerError = reject;
  });
  // The rejection is consumed by Promise.race only after a worker operation starts.
  abortPromise.catch(() => {});
  workerErrorPromise.catch(() => {});
  const terminate = async () => {
    const target = worker || workerCapture.workerThread;
    if (target && !workerWasTerminated) {
      workerWasTerminated = true;
      workerCapture.intentionalTermination = true;
      await safeTerminate(target);
    }
  };
  const onAbort = () => {
    aborted = true;
    void terminate();
    abortReject(makeAbortError(signal));
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  const notify = async (completed, total, num) => {
    if (typeof hooks.onProgress !== 'function') return;
    try {
      await hooks.onProgress({ stage: 'ocr', completed, total, page: num });
    } catch {
      // Progress reporting is best effort and must not discard extracted text.
    }
  };

  let recovered = [...results.values()].some(Boolean);
  let resourcesMissing = false;
  const errorHandler = error => {
    workerFailed = true;
    failed = true;
    rejectWorkerError(error instanceof Error ? error : new Error(String(error || '本地 OCR 运行失败。')));
    void terminate();
  };
  workerCapture.onError = errorHandler;
  try {
    if (needsOcr.length) {
      const paths = resolveTesseractPaths();
      if (typeof parser.getInfo !== 'function' || typeof parser.getScreenshot !== 'function') {
        failed = true;
      } else if (!(await hasLocalOcrResources(paths))) {
        failed = true;
        resourcesMissing = true;
      } else {
        throwIfAborted(signal);
        let createWorkerPromise;
        const previousCapture = activeWorkerCapture;
        activeWorkerCapture = workerCapture;
        try {
          createWorkerPromise = Tesseract.createWorker('eng+chi_sim', undefined, {
            langPath: paths.langPath,
            corePath: paths.corePath,
            workerPath: paths.workerPath,
            cacheMethod: 'none',
            gzip: true,
            logger: () => {},
            errorHandler
          });
        } finally {
          activeWorkerCapture = previousCapture;
        }
        const initializing = Promise.resolve(createWorkerPromise)
          .then(async createdWorker => {
            worker = createdWorker;
            if (signal && signal.aborted) {
              aborted = true;
              await terminate();
              throw makeAbortError(signal);
            }
            return createdWorker;
          });
        try {
          await Promise.race([initializing, abortPromise, workerErrorPromise]);
        } catch (error) {
          if (signal && signal.aborted) throw makeAbortError(signal);
          failed = true;
          await terminate();
        }
      }
    }

    let completed = 0;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      await notify(completed, candidates.length, candidate.num);
      throwIfAborted(signal);
      if (!results.has(candidate.index) && worker && !workerFailed) {
        try {
          let dimensions;
          if (typeof parser.getInfo === 'function') {
            try {
              const info = await parser.getInfo({ partial: [candidate.num], parsePageInfo: true });
              dimensions = getPageDimensions(info);
            } catch {
              // Skip rendering when page dimensions cannot be bounded safely.
            }
          }
          const desiredWidth = desiredScreenshotWidth(dimensions);
          if (!desiredWidth) {
            failed = true;
            completed += 1;
            await notify(completed, candidates.length, candidate.num);
            continue;
          }
          throwIfAborted(signal);
          const screenshot = await parser.getScreenshot({
            partial: [candidate.num],
            desiredWidth,
            imageBuffer: true,
            imageDataUrl: false
          });
          throwIfAborted(signal);
          const image = screenshot && Array.isArray(screenshot.pages)
            ? screenshot.pages.find(item => item.pageNumber === candidate.num)
            : null;
          if (!image || !image.data || image.data.length === 0 ||
              image.width > MAX_RENDER_EDGE || image.height > MAX_RENDER_EDGE ||
              image.width * image.height > MAX_RENDER_EDGE * MAX_RENDER_EDGE) {
            results.set(candidate.index, '');
            failed = true;
          } else {
            const recognized = await Promise.race([
              worker.recognize(Buffer.from(image.data)),
              abortPromise,
              workerErrorPromise
            ]);
            throwIfAborted(signal);
            const text = recognized && recognized.data && typeof recognized.data.text === 'string'
              ? recognized.data.text.trim()
              : '';
            results.set(candidate.index, text);
            if (text) recovered = true;
            else failed = true;

            if (documentId) {
              let cacheDocument = cache.documents.find(item => item.id === documentId);
              if (!cacheDocument) {
                cacheDocument = { id: documentId, updatedAt: Date.now(), pages: {} };
                cache.documents.push(cacheDocument);
              }
              cacheDocument.pages[String(candidate.num)] = text;
              cacheDocument.updatedAt = Date.now();
              await writeCache(hooks.cachePath, cache);
            }
          }
        } catch (error) {
          if (signal && signal.aborted) throw makeAbortError(signal);
          failed = true;
          if (workerFailed) await terminate();
          // Keep the parser's original page text if rendering or OCR fails.
        }
      }
      completed += 1;
      await notify(completed, candidates.length, candidate.num);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!workerWasTerminated) await terminate();
  }

  const repairedPages = sourcePages.map((page, index) => {
    if (!results.has(index)) return page;
    const text = results.get(index);
    if (!text) return page;
    return { ...page, text };
  });
  const readingWarnings = [];
  if (recovered) readingWarnings.push(OCR_WARNING);
  if (resourcesMissing) readingWarnings.push(OCR_RESOURCE_WARNING);
  else if (failed) readingWarnings.push(OCR_UNAVAILABLE_WARNING);
  return { pages: repairedPages, readingWarnings };
}

module.exports = { recoverPdfPages };
