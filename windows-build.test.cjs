const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { applyPatchBlock, repairUninstaller } = require("./windows-build.cjs");

const SIGNATURE = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");

function makePrefix() {
  const prefix = Buffer.alloc(1024, 0x5a);
  const peOffset = 0x80;
  prefix.write("MZ", 0, "ascii");
  prefix.writeUInt32LE(peOffset, 0x3c);
  prefix.write("PE\0\0", peOffset, "ascii");
  prefix.writeUInt16LE(0x8664, peOffset + 4);
  prefix.writeUInt16LE(1, peOffset + 6);
  prefix.writeUInt16LE(240, peOffset + 20);
  const optional = peOffset + 24;
  prefix.fill(0, optional, optional + 240);
  prefix.writeUInt16LE(0x20b, optional);
  prefix.writeUInt32LE(16, optional + 108);
  const section = optional + 240;
  prefix.fill(0, section, section + 8);
  prefix.write(".text", section, "ascii");
  prefix.writeUInt32LE(512, section + 16);
  prefix.writeUInt32LE(512, section + 20);
  return prefix;
}

function makePatchBlock(offset = 600) {
  const patchBytes = Buffer.alloc(128, 0x49);
  const block = Buffer.alloc(4 + 4 + patchBytes.length + 4);
  block.writeUInt32LE(patchBytes.length, 0);
  block.writeUInt32LE(offset, 4);
  patchBytes.copy(block, 8);
  block.writeUInt32LE(0, 8 + patchBytes.length);
  return { block, patchBytes, offset };
}

function makeInner(prefix, patch) {
  const inner = Buffer.alloc(48);
  inner.writeUInt32LE(0x12345678, 0);
  SIGNATURE.copy(inner, 4);
  inner.writeUInt32LE(0x87654321, 20);
  inner.writeUInt32LE(inner.length, 24);
  inner.write("NSIS payload", 28, "ascii");
  const patchedPrefix = Buffer.from(prefix);
  patch.patchBytes.copy(patchedPrefix, patch.offset);
  inner.writeUInt32LE(zlib.crc32(Buffer.concat([patchedPrefix, inner.subarray(0, -4)]).subarray(512)), inner.length - 4);
  return inner;
}

function makeInstaller({ patch = makePatchBlock(), invalidInnerCrc = false, signed = false } = {}) {
  const prefix = makePrefix();
  if (signed) {
    const securityDir = 0x80 + 24 + 112 + 4 * 8;
    prefix.writeUInt32LE(4096, securityDir);
    prefix.writeUInt32LE(32, securityDir + 4);
  }
  const inner = makeInner(prefix, patch);
  if (invalidInnerCrc) inner.writeUInt32LE((inner.readUInt32LE(inner.length - 4) ^ 1) >>> 0, inner.length - 4);
  const patchBlock = patch.block;
  const compressedPatch = zlib.deflateRawSync(patchBlock);
  const patchRecord = Buffer.alloc(4);
  patchRecord.writeUInt32LE((compressedPatch.length | 0x80000000) >>> 0);
  const innerRecord = Buffer.alloc(4);
  const compressedInner = zlib.deflateRawSync(inner);
  innerRecord.writeUInt32LE((compressedInner.length | 0x80000000) >>> 0);

  const nsisHeader = Buffer.alloc(28);
  SIGNATURE.copy(nsisHeader, 4);
  const records = Buffer.concat([patchRecord, compressedPatch, innerRecord, compressedInner, Buffer.alloc(4)]);
  nsisHeader.writeUInt32LE(nsisHeader.length + records.length, 24);
  const stream = Buffer.concat([nsisHeader, records]);
  const installer = Buffer.concat([prefix, stream]);
  installer.writeUInt32LE(zlib.crc32(installer.subarray(512, installer.length - 4)), installer.length - 4);
  return { installer, prefix, inner, patch };
}

function readerOutput(fixture) {
  return Buffer.concat([fixture.prefix, fixture.inner]);
}

test("synthetic reader output misses the preceding icon patch and repaired output matches the stored NSIS CRC", () => {
  const fixture = makeInstaller();
  assert.notEqual(zlib.deflateRawSync(fixture.patch.block).length, fixture.patch.block.length);
  const generated = readerOutput(fixture);
  assert.notEqual(zlib.crc32(generated.subarray(512, generated.length - 4)), generated.readUInt32LE(generated.length - 4));

  const repaired = repairUninstaller(fixture.installer, generated);
  assert.equal(repaired.readUInt32LE(repaired.length - 4), fixture.inner.readUInt32LE(fixture.inner.length - 4));
  assert.equal(zlib.crc32(repaired.subarray(512, repaired.length - 4)), repaired.readUInt32LE(repaired.length - 4));
  assert.deepEqual(repaired.subarray(fixture.patch.offset, fixture.patch.offset + fixture.patch.patchBytes.length), fixture.patch.patchBytes);
});

test("patch records must terminate and stay within the PE stub", () => {
  const prefix = makePrefix();
  const outOfBounds = Buffer.alloc(4 + 4 + 8 + 4);
  outOfBounds.writeUInt32LE(8, 0);
  outOfBounds.writeUInt32LE(prefix.length - 4, 4);
  outOfBounds.write("12345678", 8, "ascii");
  outOfBounds.writeUInt32LE(0, 16);
  assert.throws(() => applyPatchBlock(prefix, outOfBounds), /bounds/);
  assert.throws(() => applyPatchBlock(prefix, Buffer.from([8, 0, 0, 0, 1])), /Truncated/);
  assert.throws(() => applyPatchBlock(prefix, Buffer.from([0, 0, 0, 0, 1])), /Trailing data/);
});

test("repair rejects malformed input, signed PE data, and an incorrect stored uninstaller CRC", () => {
  const fixture = makeInstaller();
  const generated = readerOutput(fixture);
  const badInstaller = Buffer.from(fixture.installer);
  badInstaller[badInstaller.length - 1] ^= 1;
  assert.throws(() => repairUninstaller(badInstaller, generated), /NSIS CRC mismatch/);

  const signedFixture = makeInstaller({ signed: true });
  assert.throws(() => repairUninstaller(signedFixture.installer, readerOutput(signedFixture)), /Signed PE/);

  const badInner = makeInstaller({ invalidInnerCrc: true });
  assert.throws(() => repairUninstaller(badInner.installer, readerOutput(badInner)), /Repaired uninstaller CRC mismatch/);
});
