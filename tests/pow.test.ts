import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertValidHeaderLink,
  bitsToTarget,
  bytesToHex,
  decodeBlockHeader,
  encodeBlockHeader,
  hashToUint256,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  meetsTarget,
  targetToCompact,
} from "../src/index.ts";

/** Mainnet block 665280 — explorer-verified header bytes and display hash. */
const MAINNET_665280_HEADER_HEX =
  "0000002052d7f05def7bc6826cda74f5bdaf855fe13cd2c8aba50e000000000000000000bbb445df9b50f6555752df7e48d09c4f5dbd8e5c8ebf30aff1b55f8ed44d9e80b5caf95fa1a80d1714764687";
const MAINNET_665280_DISPLAY =
  "00000000000000000009ebabc95533bbe0e40adecee879449db291237b3db350";

const mainnetNext = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../testdata/mainnet-headers.json"),
      "utf8",
    ),
  ) as { headers: { headerHex: string }[] }
).headers[1]!;

describe("header PoW", () => {
  test("hashes a known mainnet header and accepts its proof-of-work", () => {
    const header = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    const hashInternal = headerHashInternal(header);

    expect(headerHashDisplay(header)).toBe(MAINNET_665280_DISPLAY);
    expect(bytesToHex(encodeBlockHeader(header))).toBe(MAINNET_665280_HEADER_HEX);
    expect(meetsTarget(hashInternal, header.bits)).toBe(true);
    expect(hashToUint256(hashInternal) <= bitsToTarget(header.bits)).toBe(true);
  });

  test("meetsTarget rejects a hash above the compact target", () => {
    const header = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    const aboveTarget = new Uint8Array(32);
    aboveTarget[31] = 0xff;
    expect(meetsTarget(aboveTarget, header.bits)).toBe(false);
  });

  test("assertValidHeaderLink accepts the real mainnet successor header", () => {
    const parent = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    const parentHash = headerHashInternal(parent);
    const child = decodeBlockHeader(hexToBytes(mainnetNext.headerHex));

    const linked = assertValidHeaderLink(child, parentHash);
    expect(bytesToHex(linked)).toBe(bytesToHex(headerHashInternal(child)));
  });

  test("assertValidHeaderLink rejects previous-hash and PoW failures", () => {
    const parent = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    const parentHash = headerHashInternal(parent);
    const child = decodeBlockHeader(hexToBytes(mainnetNext.headerHex));

    const unlinked = {
      ...child,
      previousBlockHash: new Uint8Array(32).fill(9),
    };
    expect(() => assertValidHeaderLink(unlinked, parentHash)).toThrow(
      /previous hash mismatch/i,
    );

    const weakPow = {
      ...child,
      nonce: (child.nonce + 1) >>> 0,
    };
    expect(() => assertValidHeaderLink(weakPow, parentHash)).toThrow(
      /proof-of-work/i,
    );

    const padded = new Uint8Array(64);
    padded.set(parentHash);
    expect(() => assertValidHeaderLink(child, padded)).toThrow(/32 bytes/i);
    expect(() => assertValidHeaderLink(child, parentHash.subarray(0, 31))).toThrow(
      /32 bytes/i,
    );
  });

  test("encode/decode round-trips header fields", () => {
    const original = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    const again = decodeBlockHeader(encodeBlockHeader(original));
    expect(again.version).toBe(original.version);
    expect(bytesToHex(again.previousBlockHash)).toBe(
      bytesToHex(original.previousBlockHash),
    );
    expect(bytesToHex(again.merkleRoot)).toBe(bytesToHex(original.merkleRoot));
    expect(again.timestamp).toBe(original.timestamp);
    expect(again.bits).toBe(original.bits);
    expect(again.nonce).toBe(original.nonce);
  });

  test("mainnet retarget at height 667296 matches the real compact target", () => {
    const periodStart = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));
    // Block 667295 timestamp (explorer-verified). Period start is checkpoint 665280.
    const periodEndTimestamp = 1_611_402_924;
    const timespan = 14 * 24 * 60 * 60;
    const actualTimespan = periodEndTimestamp - periodStart.timestamp;
    const clamped = Math.max(
      Math.floor(timespan / 4),
      Math.min(timespan * 4, actualTimespan),
    );
    const next =
      (bitsToTarget(periodStart.bits) * BigInt(clamped)) / BigInt(timespan);
    expect(targetToCompact(next)).toBe(0x170d8457);
  });

  test("hashToUint256 reads 32-byte hashes little-endian", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x01;
    bytes[1] = 0x02;
    expect(hashToUint256(bytes)).toBe(0x0201n);
    expect(() => hashToUint256(new Uint8Array(31))).toThrow(/32 bytes/i);

    const padded = new Uint8Array(40);
    padded[5] = 0x01;
    padded[6] = 0x02;
    expect(hashToUint256(padded.subarray(5, 37))).toBe(0x0201n);
  });

  test("meetsTarget returns false for invalid compact nBits instead of throwing", () => {
    const hash = new Uint8Array(32);
    expect(meetsTarget(hash, 0x00000000)).toBe(false);
    expect(meetsTarget(hash, 0x1d80ffff)).toBe(false);
    expect(meetsTarget(hash, 0x2300ffff)).toBe(false);
    expect(meetsTarget(hash, 0x207fffff)).toBe(false);
    expect(meetsTarget(hash, 0x207fffff, (1n << 256n) - 1n)).toBe(true);
    expect(() => meetsTarget(hash, 0x1d00ffff, 0n)).toThrow(
      /proof-of-work limit/i,
    );
  });

  test("encodeBlockHeader rejects non-integer and out-of-range fields", () => {
    const header = decodeBlockHeader(hexToBytes(MAINNET_665280_HEADER_HEX));

    expect(() => encodeBlockHeader({ ...header, nonce: -1 })).toThrow(/uint32/i);
    expect(() => encodeBlockHeader({ ...header, nonce: 2 ** 32 })).toThrow(
      /uint32/i,
    );
    expect(() => encodeBlockHeader({ ...header, timestamp: 1.9 })).toThrow(
      /uint32/i,
    );
    expect(() => encodeBlockHeader({ ...header, bits: Number.NaN })).toThrow(
      /uint32/i,
    );
    expect(() => encodeBlockHeader({ ...header, version: Infinity })).toThrow(
      /32-bit/i,
    );

    const maxVersion = hexToBytes(MAINNET_665280_HEADER_HEX);
    maxVersion[0] = 0xff;
    maxVersion[1] = 0xff;
    maxVersion[2] = 0xff;
    maxVersion[3] = 0xff;
    const decoded = decodeBlockHeader(maxVersion);
    expect(decoded.version).toBe(-1);
    expect(bytesToHex(encodeBlockHeader(decoded))).toBe(bytesToHex(maxVersion));
  });

  test.each([
    [0x1d80ffff, "negative"],
    [0x00000000, "zero"],
    [0x23000001, "overflow"],
    [0x04001234, "non-canonical"],
    [0x1d010000, "proof-of-work limit"],
  ] as const)("rejects strict compact target edge %#", (bits, reason) => {
    expect(() => bitsToTarget(bits)).toThrow(reason);
  });

  test("canonical compact targets round trip", () => {
    for (const bits of [0x01010000, 0x03009234, 0x170da8a1, 0x1d00ffff]) {
      expect(targetToCompact(bitsToTarget(bits))).toBe(bits);
    }
  });
});
