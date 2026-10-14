const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { build } = require("electron-builder");

const NSIS_SIGNATURE = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
const CRC_START = 512;
const SUPPORTED_SECTIONS = new Set([".text", ".rdata", ".data", ".rsrc"]);

function requireRange(buffer, offset, size, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > buffer.length) {
    throw new Error(`Truncated or invalid ${label}.`);
  }
}

function readPeInfo(buffer) {
  requireRange(buffer, 0, 64, "DOS header");
  if (buffer.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid MZ signature.");
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, "PE header");
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("Invalid PE signature.");

  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  requireRange(buffer, optionalOffset, optionalSize, "optional header");
  if (sectionCount === 0) throw new Error("PE has no sections.");

  const magic = buffer.readUInt16LE(optionalOffset);
  const directoryCountOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : -1;
  const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
  if (directoryCountOffset < 0 || optionalSize < directoryCountOffset + 4) throw new Error("Unsupported PE optional header.");
  const directoryCount = buffer.readUInt32LE(optionalOffset + directoryCountOffset);
  let hasCertificate = false;
  if (directoryCount > 4) {
    const certificateOffset = directoriesOffset + 4 * 8;
    if (optionalSize < certificateOffset + 8) throw new Error("Truncated PE security directory.");
    hasCertificate = buffer.readUInt32LE(optionalOffset + certificateOffset) !== 0 || buffer.readUInt32LE(optionalOffset + certificateOffset + 4) !== 0;
  }

  const sectionTable = optionalOffset + optionalSize;
  requireRange(buffer, sectionTable, sectionCount * 40, "section table");
  let nsisOffset = 0;
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionTable + i * 40;
    const name = buffer.toString("ascii", section, section + 8).replace(/\0.*$/, "");
    const rawSize = buffer.readUInt32LE(section + 16);
    const rawPointer = buffer.readUInt32LE(section + 20);
    if (SUPPORTED_SECTIONS.has(name)) {
      requireRange(buffer, rawPointer, rawSize, `PE section ${name}`);
      nsisOffset = Math.max(nsisOffset, rawPointer + rawSize);
    } else if (rawPointer !== 0 && rawSize !== 0) {
      throw new Error(`Unsupported PE section '${name}'.`);
    }
  }
  if (nsisOffset < CRC_START || nsisOffset >= buffer.length) throw new Error("Invalid NSIS offset.");
  return { nsisOffset, hasCertificate };
}

function parseNsisImage(buffer, { checkCrc = true } = {}) {
  const pe = readPeInfo(buffer);
  if (pe.hasCertificate) throw new Error("Signed PE files cannot be patched or validated.");
  const { nsisOffset } = pe;
  requireRange(buffer, nsisOffset, 28, "NSIS header");
  if (!buffer.subarray(nsisOffset + 4, nsisOffset + 20).equals(NSIS_SIGNATURE)) throw new Error("Invalid NSIS signature.");
  const nsisSize = buffer.readUInt32LE(nsisOffset + 24);
  if (nsisSize !== buffer.length - nsisOffset) throw new Error("NSIS size mismatch.");

  const dataEnd = buffer.length - 4;
  const blocks = [];
  let position = nsisOffset + 28;
  while (position < dataEnd) {
    requireRange(buffer.subarray(0, dataEnd), position, 4, "NSIS block size");
    const sizeWord = buffer.readUInt32LE(position);
    position += 4;
    const size = sizeWord & 0x7fffffff;
    if (size === 0) throw new Error("Unexpected empty NSIS block.");
    requireRange(buffer.subarray(0, dataEnd), position, size, "NSIS block data");
    const payload = buffer.subarray(position, position + size);
    position += size;
    if ((sizeWord & 0x80000000) !== 0) {
      const inflated = zlib.inflateRawSync(payload, { info: true });
      if (inflated.engine.bytesWritten !== payload.length) throw new Error("Trailing data in compressed NSIS block.");
      blocks.push(inflated.buffer);
    } else {
      blocks.push(payload);
    }
  }
  if (position !== dataEnd) throw new Error("NSIS blocks do not end before the CRC field.");

  const storedCrc = buffer.readUInt32LE(buffer.length - 4);
  const actualCrc = zlib.crc32(buffer.subarray(CRC_START, buffer.length - 4));
  if (checkCrc && storedCrc !== actualCrc) throw new Error("NSIS CRC mismatch.");
  return { nsisOffset, blocks, storedCrc };
}

function applyPatchBlock(prefix, patchBlock) {
  const patched = Buffer.from(prefix);
  let position = 0;
  let patches = 0;
  while (true) {
    requireRange(patchBlock, position, 4, "icon patch size");
    const size = patchBlock.readUInt32LE(position);
    position += 4;
    if (size === 0) {
      if (position !== patchBlock.length) throw new Error("Trailing data after icon patch terminator.");
      if (patches === 0) throw new Error("Icon patch block is empty.");
      return patched;
    }
    requireRange(patchBlock, position, 4, "icon patch offset");
    const offset = patchBlock.readUInt32LE(position);
    position += 4;
    requireRange(patchBlock, position, size, "icon patch bytes");
    if (offset + size > patched.length) throw new Error("Icon patch exceeds the PE stub bounds.");
    patchBlock.copy(patched, offset, position, position + size);
    position += size;
    patches++;
  }
}

function repairUninstaller(installer, generatedUninstaller) {
  const parsed = parseNsisImage(installer);
  const innerIndexes = [];
  for (let i = 0; i < parsed.blocks.length; i++) {
    const block = parsed.blocks[i];
    if (block.length >= 20 && block.subarray(4, 20).equals(NSIS_SIGNATURE)) innerIndexes.push(i);
  }
  if (innerIndexes.length !== 1) throw new Error(`Expected one uninstaller NSIS block, found ${innerIndexes.length}.`);
  const innerIndex = innerIndexes[0];
  if (innerIndex === 0) throw new Error("Uninstaller NSIS block has no preceding icon patch block.");

  const innerBlock = parsed.blocks[innerIndex];
  const original = Buffer.from(generatedUninstaller);
  if (original.length !== parsed.nsisOffset + innerBlock.length || !original.subarray(0, parsed.nsisOffset).equals(installer.subarray(0, parsed.nsisOffset)) || !original.subarray(parsed.nsisOffset).equals(innerBlock)) {
    throw new Error("Original reader output does not match the located uninstaller block.");
  }
  const prefix = applyPatchBlock(original.subarray(0, parsed.nsisOffset), parsed.blocks[innerIndex - 1]);
  const repaired = Buffer.concat([prefix, innerBlock]);
  const storedCrc = repaired.readUInt32LE(repaired.length - 4);
  const actualCrc = zlib.crc32(repaired.subarray(CRC_START, repaired.length - 4));
  if (storedCrc !== actualCrc) throw new Error("Repaired uninstaller CRC mismatch.");
  return repaired;
}

function isUninstallerBlock(block) {
  if (block.length < 64 || block.toString("ascii", 0, 2) !== "MZ") return false;
  try {
    const { nsisOffset } = readPeInfo(block);
    return block.subarray(nsisOffset + 4, nsisOffset + 20).equals(NSIS_SIGNATURE);
  } catch {
    return false;
  }
}

function verifyInstallerArtifact(buffer) {
  const parsed = parseNsisImage(buffer);
  const uninstallers = parsed.blocks.filter(isUninstallerBlock);
  if (uninstallers.length !== 1) throw new Error(`Expected one embedded uninstaller, found ${uninstallers.length}.`);
  parseNsisImage(uninstallers[0]);
}

function installDarwinReaderPatch() {
  if (process.platform !== "darwin") return () => {};
  const { UninstallerReader } = require("app-builder-lib/out/targets/nsis/nsisUtil");
  const originalExec = UninstallerReader.exec;
  const patchedExec = async function (installerPath, uninstallerPath) {
    await originalExec.call(this, installerPath, uninstallerPath);
    const [installer, generated] = await Promise.all([fs.readFile(installerPath), fs.readFile(uninstallerPath)]);
    await fs.writeFile(uninstallerPath, repairUninstaller(installer, generated));
  };
  UninstallerReader.exec = patchedExec;
  return () => {
    if (UninstallerReader.exec === patchedExec) UninstallerReader.exec = originalExec;
  };
}

async function buildWindows() {
  const restoreReader = installDarwinReaderPatch();
  try {
    const artifacts = await build({
      projectDir: __dirname,
      win: ["nsis"],
      x64: true,
      publish: "never",
    });
    const installers = artifacts.filter((artifact) => artifact.toLowerCase().endsWith(".exe"));
    if (installers.length !== 1) throw new Error(`Expected one Windows installer, found ${installers.length}.`);
    const installer = await fs.readFile(installers[0]);
    verifyInstallerArtifact(installer);
    console.log(`Verified NSIS installer and embedded uninstaller CRC: ${path.basename(installers[0])}`);
  } finally {
    restoreReader();
  }
}

if (require.main === module) {
  buildWindows().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { applyPatchBlock, parseNsisImage, repairUninstaller, verifyInstallerArtifact };
