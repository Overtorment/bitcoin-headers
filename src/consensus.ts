import { bytesFromHex, bytesToHex, equalBytes } from "./bytes.ts";
import { encodeBlockHeader, decodeBlockHeader, type BlockHeader } from "./header.ts";
import {
  decodeCompactTarget,
  hashToUint256,
  headerHashInternal,
  targetToCompact,
} from "./pow.ts";
import type { HeaderRecord } from "./types.ts";

export type TrustedHeaderCheckpoint = {
  height: number;
  headerBytes: Uint8Array;
  hashDisplay: string;
  /** Consecutive timestamps immediately before the checkpoint. */
  previousTimestamps: readonly number[];
};

export type HeaderConsensusParams = {
  powLimit: bigint;
  targetSpacingSeconds: number;
  targetTimespanSeconds: number;
  retargetInterval: number;
  medianTimeSpan: number;
  maxFutureSeconds: number;
  checkpoint: TrustedHeaderCheckpoint;
};

export type HeaderChainEntry = {
  readonly record: HeaderRecord;
  readonly header: BlockHeader;
  readonly hashInternal: Uint8Array;
  readonly target: bigint;
  readonly work: bigint;
  readonly cumulativeWork: bigint;
};

export type ValidatedHeaderChain = {
  readonly headers: readonly HeaderRecord[];
  readonly tipHeight: number;
  readonly tipHashInternal: Uint8Array;
  readonly tipHashDisplay: string;
  /** Cumulative work represented by this chain, beginning at its checkpoint. */
  readonly chainWork: bigint;
  readonly byHeight: ReadonlyMap<number, HeaderRecord>;
  readonly heightByHashInternal: ReadonlyMap<string, number>;
  readonly entriesByHeight: ReadonlyMap<number, HeaderChainEntry>;
  readonly cumulativeWorkByHeight: ReadonlyMap<number, bigint>;
};

export type ValidatedHeaderBranch = {
  readonly commonAncestorHeight: number;
  /** Replacement records strictly after the common ancestor. */
  readonly headers: readonly HeaderRecord[];
  readonly tipHeight: number;
  readonly tipHashInternal: Uint8Array;
  readonly tipHashDisplay: string;
  /** Checkpoint-relative work including the common chain through the branch tip. */
  readonly chainWork: bigint;
  readonly entriesByHeight: ReadonlyMap<number, HeaderChainEntry>;
  readonly cumulativeWorkByHeight: ReadonlyMap<number, bigint>;
};

export class HeaderConsensusError extends Error {
  readonly height: number;

  constructor(height: number, message: string, options?: ErrorOptions) {
    super(`header consensus failure at height ${height}: ${message}`, options);
    this.name = "HeaderConsensusError";
    this.height = height;
  }
}

function fail(height: number, message: string, cause?: unknown): never {
  throw new HeaderConsensusError(
    height,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateParams(params: HeaderConsensusParams): void {
  if (params.powLimit <= 0n || params.powLimit >= 1n << 256n) {
    throw new RangeError("powLimit must be a positive uint256");
  }
  assertSafePositiveInteger(
    params.targetSpacingSeconds,
    "targetSpacingSeconds",
  );
  assertSafePositiveInteger(
    params.targetTimespanSeconds,
    "targetTimespanSeconds",
  );
  assertSafePositiveInteger(params.retargetInterval, "retargetInterval");
  assertSafePositiveInteger(params.medianTimeSpan, "medianTimeSpan");
  assertSafePositiveInteger(params.maxFutureSeconds, "maxFutureSeconds");
  if (
    !Number.isSafeInteger(params.checkpoint.height) ||
    params.checkpoint.height < 0
  ) {
    throw new RangeError("checkpoint height must be a non-negative safe integer");
  }
  if (params.checkpoint.headerBytes.length !== 80) {
    throw new RangeError("checkpoint header must be exactly 80 bytes");
  }
  if (
    params.checkpoint.previousTimestamps.length !==
    params.medianTimeSpan - 1
  ) {
    throw new RangeError(
      `checkpoint requires exactly ${params.medianTimeSpan - 1} preceding timestamps`,
    );
  }
  for (const timestamp of params.checkpoint.previousTimestamps) {
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > 0xffffffff
    ) {
      throw new RangeError("checkpoint timestamps must be uint32 values");
    }
  }
}

export function storedHeaderFromBlockHeader(
  height: number,
  header: BlockHeader,
): HeaderRecord {
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new RangeError("header height must be a non-negative safe integer");
  }
  const bytes = encodeBlockHeader(header);
  const hashInternal = headerHashInternal(header);
  return {
    height,
    hashDisplay: displayHash(hashInternal),
    hashInternalHex: bytesToHex(hashInternal),
    headerHex: bytesToHex(bytes),
  };
}

export function headerWork(target: bigint): bigint {
  if (target <= 0n || target >= 1n << 256n) {
    throw new RangeError("work target must be a positive uint256");
  }
  return (1n << 256n) / (target + 1n);
}

function displayHash(hashInternal: Uint8Array): string {
  return bytesToHex(hashInternal.slice().reverse());
}

function decodeRecord(
  record: HeaderRecord,
  powLimit: bigint,
): Omit<HeaderChainEntry, "cumulativeWork"> {
  let bytes: Uint8Array;
  try {
    bytes = bytesFromHex(record.headerHex, 80, "headerHex");
  } catch (error) {
    fail(record.height, error instanceof Error ? error.message : String(error), error);
  }
  const header = decodeBlockHeader(bytes);
  const hashInternal = headerHashInternal(header);
  if (bytesToHex(hashInternal) !== record.hashInternalHex) {
    fail(record.height, "hashInternalHex does not match serialized header");
  }
  if (displayHash(hashInternal) !== record.hashDisplay) {
    fail(record.height, "display hash does not match serialized header");
  }
  let target: bigint;
  try {
    target = decodeCompactTarget(header.bits, powLimit);
  } catch (error) {
    fail(
      record.height,
      `invalid nBits 0x${header.bits.toString(16).padStart(8, "0")}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
  return {
    record: Object.freeze({ ...record }),
    header: Object.freeze({
      ...header,
      previousBlockHash: header.previousBlockHash.slice(),
      merkleRoot: header.merkleRoot.slice(),
    }),
    hashInternal,
    target,
    work: headerWork(target),
  };
}

function expectedBits(
  height: number,
  previous: HeaderChainEntry,
  entryAt: (height: number) => HeaderChainEntry | undefined,
  params: HeaderConsensusParams,
): number {
  if (height % params.retargetInterval !== 0) return previous.header.bits;

  const periodStartHeight = height - params.retargetInterval;
  const periodStart = entryAt(periodStartHeight);
  if (!periodStart) {
    fail(
      height,
      `missing retarget period start at height ${periodStartHeight}`,
    );
  }
  let actualTimespan =
    previous.header.timestamp - periodStart.header.timestamp;
  const minimumTimespan = Math.floor(params.targetTimespanSeconds / 4);
  const maximumTimespan = params.targetTimespanSeconds * 4;
  actualTimespan = Math.max(
    minimumTimespan,
    Math.min(maximumTimespan, actualTimespan),
  );
  let nextTarget =
    (previous.target * BigInt(actualTimespan)) /
    BigInt(params.targetTimespanSeconds);
  if (nextTarget > params.powLimit) nextTarget = params.powLimit;
  try {
    return targetToCompact(nextTarget);
  } catch (error) {
    fail(
      height,
      `retarget produced an invalid target: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)]!;
}

function assertTimestamp(
  height: number,
  header: BlockHeader,
  timestampAt: (height: number) => number | undefined,
  params: HeaderConsensusParams,
  currentTimeSeconds: number,
): void {
  const prior: number[] = [];
  for (
    let priorHeight = height - params.medianTimeSpan;
    priorHeight < height;
    priorHeight++
  ) {
    const timestamp = timestampAt(priorHeight);
    if (timestamp === undefined) {
      fail(
        height,
        `missing median-time-past timestamp at height ${priorHeight}`,
      );
    }
    prior.push(timestamp);
  }
  const medianTimePast = median(prior);
  if (header.timestamp <= medianTimePast) {
    fail(
      height,
      `timestamp ${header.timestamp} does not exceed median-time-past ${medianTimePast}`,
    );
  }
  if (header.timestamp > currentTimeSeconds + params.maxFutureSeconds) {
    fail(
      height,
      `timestamp ${header.timestamp} is too far in the future`,
    );
  }
}

function assertLink(
  height: number,
  header: BlockHeader,
  previous: HeaderChainEntry,
): void {
  if (!equalBytes(header.previousBlockHash, previous.hashInternal)) {
    fail(height, `previous hash does not match height ${previous.record.height}`);
  }
}

function assertProofOfWork(entry: Omit<HeaderChainEntry, "cumulativeWork">): void {
  if (hashToUint256(entry.hashInternal) > entry.target) {
    fail(entry.record.height, "proof-of-work hash exceeds target");
  }
}

function checkpointTimestampAt(
  height: number,
  params: HeaderConsensusParams,
): number | undefined {
  const first =
    params.checkpoint.height - params.checkpoint.previousTimestamps.length;
  const index = height - first;
  return index >= 0 && index < params.checkpoint.previousTimestamps.length
    ? params.checkpoint.previousTimestamps[index]
    : undefined;
}

/**
 * Incrementally validates one candidate without copying or changing the
 * canonical chain. `append` is linear in newly supplied headers.
 */
export class HeaderBranchBuilder {
  readonly #base: ValidatedHeaderChain;
  readonly #params: HeaderConsensusParams;
  readonly #currentTimeSeconds: number;
  readonly #commonAncestorHeight: number;
  readonly #headers: HeaderRecord[] = [];
  readonly #entriesByHeight = new Map<number, HeaderChainEntry>();
  readonly #cumulativeWorkByHeight = new Map<number, bigint>();
  #previous: HeaderChainEntry;

  constructor(
    base: ValidatedHeaderChain,
    commonAncestorHeight: number,
    params: HeaderConsensusParams,
    currentTimeSeconds: number,
  ) {
    validateParams(params);
    if (
      !Number.isSafeInteger(currentTimeSeconds) ||
      currentTimeSeconds < 0
    ) {
      throw new RangeError(
        "currentTimeSeconds must be a non-negative safe integer",
      );
    }
    const ancestor = base.entriesByHeight.get(commonAncestorHeight);
    if (!ancestor) {
      throw new RangeError(
        `common ancestor ${commonAncestorHeight} is not in the canonical chain`,
      );
    }
    this.#base = base;
    this.#params = params;
    this.#currentTimeSeconds = currentTimeSeconds;
    this.#commonAncestorHeight = commonAncestorHeight;
    this.#previous = ancestor;
  }

  get length(): number {
    return this.#headers.length;
  }

  get tipHeight(): number {
    return this.#previous.record.height;
  }

  get tipHashInternal(): Uint8Array {
    return this.#previous.hashInternal.slice();
  }

  append(records: readonly HeaderRecord[]): void {
    const entryAt = (height: number): HeaderChainEntry | undefined =>
      this.#entriesByHeight.get(height) ??
      this.#base.entriesByHeight.get(height);
    const timestampAt = (height: number): number | undefined =>
      entryAt(height)?.header.timestamp ??
      checkpointTimestampAt(height, this.#params);

    for (const record of records) {
      if (record.height !== this.#previous.record.height + 1) {
        fail(
          record.height,
          `height is not contiguous after ${this.#previous.record.height}`,
        );
      }
      const decoded = decodeRecord(record, this.#params.powLimit);
      assertLink(record.height, decoded.header, this.#previous);
      const requiredBits = expectedBits(
        record.height,
        this.#previous,
        entryAt,
        this.#params,
      );
      if (decoded.header.bits !== requiredBits) {
        fail(
          record.height,
          `nBits 0x${decoded.header.bits
            .toString(16)
            .padStart(8, "0")} does not equal expected 0x${requiredBits
            .toString(16)
            .padStart(8, "0")}`,
        );
      }
      assertTimestamp(
        record.height,
        decoded.header,
        timestampAt,
        this.#params,
        this.#currentTimeSeconds,
      );
      assertProofOfWork(decoded);
      const entry: HeaderChainEntry = Object.freeze({
        ...decoded,
        cumulativeWork:
          this.#previous.cumulativeWork + decoded.work,
      });
      this.#headers.push(entry.record);
      this.#entriesByHeight.set(entry.record.height, entry);
      this.#cumulativeWorkByHeight.set(
        entry.record.height,
        entry.cumulativeWork,
      );
      this.#previous = entry;
    }
  }

  finish(): ValidatedHeaderBranch {
    return Object.freeze({
      commonAncestorHeight: this.#commonAncestorHeight,
      headers: Object.freeze(this.#headers.slice()),
      tipHeight: this.#previous.record.height,
      tipHashInternal: this.#previous.hashInternal.slice(),
      tipHashDisplay: this.#previous.record.hashDisplay,
      chainWork: this.#previous.cumulativeWork,
      entriesByHeight: new Map(this.#entriesByHeight),
      cumulativeWorkByHeight: new Map(this.#cumulativeWorkByHeight),
    });
  }
}

export function validateHeaderChain(
  records: readonly HeaderRecord[],
  params: HeaderConsensusParams,
  currentTimeSeconds: number,
): ValidatedHeaderChain {
  validateParams(params);
  if (
    !Number.isSafeInteger(currentTimeSeconds) ||
    currentTimeSeconds < 0
  ) {
    throw new RangeError("currentTimeSeconds must be a non-negative safe integer");
  }
  if (records.length === 0) {
    throw new HeaderConsensusError(
      params.checkpoint.height,
      "persisted chain is empty",
    );
  }

  const firstRecord = records[0]!;
  if (firstRecord.height !== params.checkpoint.height) {
    fail(
      firstRecord.height,
      `chain must start at trusted checkpoint ${params.checkpoint.height}`,
    );
  }
  let first: Omit<HeaderChainEntry, "cumulativeWork">;
  try {
    first = decodeRecord(firstRecord, params.powLimit);
  } catch (error) {
    if (error instanceof HeaderConsensusError) throw error;
    fail(firstRecord.height, "cannot decode trusted checkpoint", error);
  }
  if (
    !equalBytes(
      encodeBlockHeader(first.header),
      params.checkpoint.headerBytes,
    ) ||
    first.record.hashDisplay !== params.checkpoint.hashDisplay
  ) {
    fail(firstRecord.height, "trusted checkpoint seed does not match");
  }
  assertProofOfWork(first);
  if (
    first.header.timestamp >
    currentTimeSeconds + params.maxFutureSeconds
  ) {
    fail(firstRecord.height, "trusted checkpoint timestamp is too far in the future");
  }

  const headers: HeaderRecord[] = [first.record];
  const byHeight = new Map<number, HeaderRecord>([
    [first.record.height, first.record],
  ]);
  const heightByHashInternal = new Map<string, number>([
    [first.record.hashInternalHex, first.record.height],
  ]);
  const entriesByHeight = new Map<number, HeaderChainEntry>();
  const cumulativeWorkByHeight = new Map<number, bigint>();
  const firstEntry: HeaderChainEntry = Object.freeze({
    ...first,
    cumulativeWork: first.work,
  });
  entriesByHeight.set(first.record.height, firstEntry);
  cumulativeWorkByHeight.set(first.record.height, firstEntry.cumulativeWork);

  const timestampAt = (height: number): number | undefined =>
    entriesByHeight.get(height)?.header.timestamp ??
    checkpointTimestampAt(height, params);

  let previous = firstEntry;
  for (let index = 1; index < records.length; index++) {
    const record = records[index]!;
    if (record.height !== previous.record.height + 1) {
      fail(
        record.height,
        `height is not contiguous after ${previous.record.height}`,
      );
    }
    const decoded = decodeRecord(record, params.powLimit);
    assertLink(record.height, decoded.header, previous);
    const requiredBits = expectedBits(
      record.height,
      previous,
      (height) => entriesByHeight.get(height),
      params,
    );
    if (decoded.header.bits !== requiredBits) {
      fail(
        record.height,
        `nBits 0x${decoded.header.bits
          .toString(16)
          .padStart(8, "0")} does not equal expected 0x${requiredBits
          .toString(16)
          .padStart(8, "0")}`,
      );
    }
    assertTimestamp(
      record.height,
      decoded.header,
      timestampAt,
      params,
      currentTimeSeconds,
    );
    assertProofOfWork(decoded);

    const entry: HeaderChainEntry = Object.freeze({
      ...decoded,
      cumulativeWork: previous.cumulativeWork + decoded.work,
    });
    headers.push(entry.record);
    byHeight.set(entry.record.height, entry.record);
    heightByHashInternal.set(
      entry.record.hashInternalHex,
      entry.record.height,
    );
    entriesByHeight.set(entry.record.height, entry);
    cumulativeWorkByHeight.set(entry.record.height, entry.cumulativeWork);
    previous = entry;
  }

  return Object.freeze({
    headers: Object.freeze(headers),
    tipHeight: previous.record.height,
    tipHashInternal: previous.hashInternal.slice(),
    tipHashDisplay: previous.record.hashDisplay,
    chainWork: previous.cumulativeWork,
    byHeight,
    heightByHashInternal,
    entriesByHeight,
    cumulativeWorkByHeight,
  });
}
