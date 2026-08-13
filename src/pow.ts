import { bytesToHex, equalBytes } from "./bytes.ts";
import { sha256d } from "./hash.ts";
import { encodeBlockHeader, type BlockHeader } from "./header.ts";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAINNET_POW_LIMIT =
  0x00000000ffff0000000000000000000000000000000000000000000000000000n;

/** Positive target → canonical Bitcoin compact `nBits`. */
export function targetToCompact(target: bigint): number {
  if (target <= 0n) throw new RangeError("target must be positive");
  if (target > MAX_UINT256) throw new RangeError("target overflows uint256");

  const byteLength = Math.ceil(target.toString(16).length / 2);
  let compact =
    byteLength <= 3
      ? Number(target << (8n * BigInt(3 - byteLength)))
      : Number(target >> (8n * BigInt(byteLength - 3)));
  let exponent = byteLength;
  if ((compact & 0x00800000) !== 0) {
    compact >>>= 8;
    exponent++;
  }
  return ((exponent << 24) | compact) >>> 0;
}

/**
 * Strict Bitcoin compact target decode. Invalid signs, zero, overflow,
 * non-canonical representations, and targets above the supplied limit fail.
 */
export function decodeCompactTarget(
  bits: number,
  powLimit: bigint = MAINNET_POW_LIMIT,
): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) {
    throw new RangeError("compact target must be a uint32");
  }
  if (powLimit <= 0n || powLimit > MAX_UINT256) {
    throw new RangeError("proof-of-work limit must be a positive uint256");
  }

  const compact = bits >>> 0;
  const exponent = compact >>> 24;
  const word = compact & 0x007fffff;
  if (word !== 0 && (compact & 0x00800000) !== 0) {
    throw new Error("compact target is negative");
  }
  if (
    word !== 0 &&
    (exponent > 34 ||
      (word > 0xff && exponent > 33) ||
      (word > 0xffff && exponent > 32))
  ) {
    throw new Error("compact target overflows uint256");
  }

  const target =
    exponent <= 3
      ? BigInt(word >>> (8 * (3 - exponent)))
      : BigInt(word) << (8n * BigInt(exponent - 3));
  if (target === 0n) throw new Error("compact target is zero");
  if (targetToCompact(target) !== compact) {
    throw new Error("compact target is non-canonical");
  }
  if (target > powLimit) {
    throw new Error("compact target exceeds proof-of-work limit");
  }
  return target;
}

/** Strict mainnet compact `nBits` → 256-bit target. */
export function bitsToTarget(bits: number): bigint {
  return decodeCompactTarget(bits, MAINNET_POW_LIMIT);
}

/** Interpret 32-byte internal (LE) hash as uint256. */
export function hashToUint256(hashInternal: Uint8Array): bigint {
  if (hashInternal.length !== 32) throw new Error("hash must be 32 bytes");
  const view = new DataView(
    hashInternal.buffer,
    hashInternal.byteOffset,
    hashInternal.byteLength,
  );
  return (
    view.getBigUint64(0, true) |
    (view.getBigUint64(8, true) << 64n) |
    (view.getBigUint64(16, true) << 128n) |
    (view.getBigUint64(24, true) << 192n)
  );
}

export function headerHashInternal(header: BlockHeader): Uint8Array {
  return sha256d(encodeBlockHeader(header));
}

export function headerHashDisplay(header: BlockHeader): string {
  const internal = headerHashInternal(header);
  return bytesToHex(internal.slice().reverse());
}

export function meetsTarget(
  hashInternal: Uint8Array,
  bits: number,
  powLimit: bigint = MAINNET_POW_LIMIT,
): boolean {
  if (powLimit <= 0n || powLimit > MAX_UINT256) {
    throw new RangeError("proof-of-work limit must be a positive uint256");
  }
  let target: bigint;
  try {
    target = decodeCompactTarget(bits, powLimit);
  } catch {
    return false;
  }
  return hashToUint256(hashInternal) <= target;
}

export function assertValidHeaderLink(
  header: BlockHeader,
  expectedPrevInternal: Uint8Array,
  powLimit: bigint = MAINNET_POW_LIMIT,
): Uint8Array {
  if (expectedPrevInternal.length !== 32) {
    throw new Error("expected previous hash must be 32 bytes");
  }
  const hash = headerHashInternal(header);
  if (!equalBytes(header.previousBlockHash, expectedPrevInternal)) {
    throw new Error("header previous hash mismatch");
  }
  if (!meetsTarget(hash, header.bits, powLimit)) {
    throw new Error("header proof-of-work does not meet target");
  }
  return hash;
}
