import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeBlockHeader,
  decodeCompactTarget,
  encodeBlockHeader,
  hashToUint256,
  headerHashDisplay,
  headerHashInternal,
  headerWork,
  HeaderBranchBuilder,
  hexToBytes,
  MAINNET_HEADER_CONSENSUS,
  storedHeaderFromBlockHeader,
  targetToCompact,
  validateHeaderChain,
  type BlockHeader,
  type HeaderConsensusParams,
  type HeaderRecord,
} from "../src/index.ts";

const EASY_BITS = 0x207fffff;
const HARD_BITS = 0x201fffff;
const EASY_LIMIT = decodeCompactTarget(EASY_BITS, (1n << 256n) - 1n);

type MainnetFixture = {
  headers: HeaderRecord[];
};

const mainnetFixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../testdata/mainnet-headers.json"),
    "utf8",
  ),
) as MainnetFixture;

function mineHeader(options: {
  previousHash?: Uint8Array;
  bits: number;
  timestamp: number;
  marker: number;
  validPow?: boolean;
  powLimit?: bigint;
}): BlockHeader {
  const target = decodeCompactTarget(
    options.bits,
    options.powLimit ?? EASY_LIMIT,
  );
  const header: BlockHeader = {
    version: options.marker,
    previousBlockHash: options.previousHash?.slice() ?? new Uint8Array(32),
    merkleRoot: new Uint8Array(32).fill(options.marker & 0xff),
    timestamp: options.timestamp,
    bits: options.bits,
    nonce: 0,
  };
  const wantValid = options.validPow ?? true;
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    header.nonce = nonce;
    const valid = hashToUint256(headerHashInternal(header)) <= target;
    if (valid === wantValid) return header;
  }
  throw new Error("unable to mine deterministic test header");
}

function record(height: number, header: BlockHeader): HeaderRecord {
  return storedHeaderFromBlockHeader(height, header);
}

function fixture(bits = EASY_BITS): {
  params: HeaderConsensusParams;
  records: HeaderRecord[];
  tip: BlockHeader;
} {
  const checkpoint = mineHeader({
    bits,
    timestamp: 1_000,
    marker: 1,
    powLimit: EASY_LIMIT,
  });
  return {
    params: {
      powLimit: EASY_LIMIT,
      targetSpacingSeconds: 10,
      targetTimespanSeconds: 40,
      retargetInterval: 4,
      medianTimeSpan: 11,
      maxFutureSeconds: 7_200,
      checkpoint: {
        height: 0,
        headerBytes: encodeBlockHeader(checkpoint),
        hashDisplay: headerHashDisplay(checkpoint),
        previousTimestamps: [
          890, 900, 910, 920, 930, 940, 950, 960, 970, 980,
        ],
      },
    },
    records: [record(0, checkpoint)],
    tip: checkpoint,
  };
}

function append(
  state: ReturnType<typeof fixture>,
  timestamp: number,
  bits = state.tip.bits,
  marker = state.records.length + 1,
): BlockHeader {
  const next = mineHeader({
    previousHash: headerHashInternal(state.tip),
    bits,
    timestamp,
    marker,
    powLimit: state.params.powLimit,
  });
  state.records.push(record(state.records.length, next));
  state.tip = next;
  return next;
}

/** Independently computed expected nBits for the synthetic retarget params. */
function expectedRetarget(
  previousBits: number,
  actualTimespan: number,
  params: HeaderConsensusParams,
): number {
  const clamped = Math.max(
    params.targetTimespanSeconds / 4,
    Math.min(params.targetTimespanSeconds * 4, actualTimespan),
  );
  const target =
    (decodeCompactTarget(previousBits, params.powLimit) * BigInt(clamped)) /
    BigInt(params.targetTimespanSeconds);
  return targetToCompact(target > params.powLimit ? params.powLimit : target);
}

describe("header consensus", () => {
  test("validates mainnet checkpoint plus the next real header using MTP context", () => {
    const chain = validateHeaderChain(
      mainnetFixture.headers.slice(0, 2),
      MAINNET_HEADER_CONSENSUS,
      1_800_000_000,
    );

    expect(chain.tipHeight).toBe(665_281);
    expect(chain.tipHashDisplay).toBe(mainnetFixture.headers[1]!.hashDisplay);
    expect(chain.headers).toHaveLength(2);
    expect(chain.chainWork).toBe(
      chain.cumulativeWorkByHeight.get(665_281),
    );
  });

  test("rejects a post-checkpoint header that does not beat median-time-past", () => {
    const seed = mainnetFixture.headers[0]!;
    const next = mainnetFixture.headers[1]!;
    const header = decodeBlockHeader(hexToBytes(next.headerHex));
    // MTP over heights 665270..665280 is 1610201799; equality must fail before PoW.
    header.timestamp = 1_610_201_799;
    const bad = storedHeaderFromBlockHeader(665_281, header);

    expect(() =>
      validateHeaderChain([seed, bad], MAINNET_HEADER_CONSENSUS, 1_800_000_000),
    ).toThrow(/median-time-past/i);
  });

  test("validates constant nBits and a boundary retarget with cumulative work", () => {
    const state = fixture();
    append(state, 1_010);
    append(state, 1_020);
    append(state, 1_040);
    const retargetBits = expectedRetarget(EASY_BITS, 40, state.params);
    append(state, 1_050, retargetBits);

    const chain = validateHeaderChain(state.records, state.params, 10_000);

    expect(chain.tipHeight).toBe(4);
    expect(chain.tipHashDisplay).toBe(state.records[4]!.hashDisplay);
    expect(chain.heightByHashInternal.get(state.records[4]!.hashInternalHex)).toBe(
      4,
    );

    let expectedWork = 0n;
    for (const item of state.records) {
      const bits = decodeHeaderBits(item.headerHex);
      expectedWork += headerWork(
        decodeCompactTarget(bits, state.params.powLimit),
      );
      expect(chain.cumulativeWorkByHeight.get(item.height)).toBe(expectedWork);
    }
    expect(chain.chainWork).toBe(expectedWork);
    expect(chain.entriesByHeight.get(4)?.header.bits).toBe(retargetBits);
  });

  test("retarget clamps an implausibly short timespan to one quarter", () => {
    const state = fixture();
    append(state, 1_001);
    append(state, 1_002);
    append(state, 1_003);
    // Known outcome for this fixture: timespan 3 clamps to 10 → target / 4.
    const expected = targetToCompact(EASY_LIMIT / 4n);
    expect(expectedRetarget(EASY_BITS, 3, state.params)).toBe(expected);
    append(state, 1_004, expected);

    const chain = validateHeaderChain(state.records, state.params, 10_000);
    expect(chain.tipHeight).toBe(4);
    expect(chain.entriesByHeight.get(4)?.header.bits).toBe(expected);
  });

  test("retarget clamps a long timespan to four times and caps at pow limit", () => {
    const state = fixture(HARD_BITS);
    append(state, 1_100);
    append(state, 1_200);
    append(state, 1_300);
    const expected = expectedRetarget(HARD_BITS, 300, state.params);
    append(state, 1_301, expected);

    const chain = validateHeaderChain(state.records, state.params, 10_000);
    expect(chain.entriesByHeight.get(4)?.header.bits).toBe(expected);

    const capped = fixture();
    append(capped, 1_100);
    append(capped, 1_200);
    append(capped, 1_300);
    // After a 4× clamp from easy bits, target would exceed powLimit → stay at limit bits.
    append(capped, 1_301, EASY_BITS);
    expect(
      validateHeaderChain(capped.records, capped.params, 10_000).tipHeight,
    ).toBe(4);
  });

  test("rejects a wrong between-boundary nBits easy-target attack", () => {
    const state = fixture(HARD_BITS);
    append(state, 1_010, EASY_BITS);

    expect(() =>
      validateHeaderChain(state.records, state.params, 10_000),
    ).toThrow(/height 1.*nBits/i);
  });

  test("rejects invalid proof of work", () => {
    const state = fixture();
    const invalid = mineHeader({
      previousHash: headerHashInternal(state.tip),
      bits: EASY_BITS,
      timestamp: 1_010,
      marker: 2,
      validPow: false,
      powLimit: state.params.powLimit,
    });
    state.records.push(record(1, invalid));

    expect(() =>
      validateHeaderChain(state.records, state.params, 10_000),
    ).toThrow(/height 1.*proof-of-work/i);
  });

  test("rejects median-time-past and future-time violations", () => {
    const mtp = fixture();
    append(mtp, 940);
    expect(() =>
      validateHeaderChain(mtp.records, mtp.params, 10_000),
    ).toThrow(/height 1.*median-time-past/i);

    const future = fixture();
    append(future, 17_201);
    expect(() =>
      validateHeaderChain(future.records, future.params, 10_000),
    ).toThrow(/height 1.*future/i);
  });

  test("allows a timestamp exactly at the future skew limit", () => {
    const state = fixture();
    append(state, 1_000 + 7_200);
    expect(
      validateHeaderChain(state.records, state.params, 1_000).tipHeight,
    ).toBe(1);
  });

  test("rejects a broken previous-header link", () => {
    const state = fixture();
    const unlinked = mineHeader({
      previousHash: new Uint8Array(32).fill(0x42),
      bits: EASY_BITS,
      timestamp: 1_010,
      marker: 2,
      powLimit: state.params.powLimit,
    });
    state.records.push(record(1, unlinked));

    expect(() =>
      validateHeaderChain(state.records, state.params, 10_000),
    ).toThrow(/height 1.*previous hash/i);
  });

  test("rejects empty chains, wrong starts, and checkpoint mismatches", () => {
    const state = fixture();

    expect(() => validateHeaderChain([], state.params, 10_000)).toThrow(
      /empty/i,
    );

    const wrongHeight = [{ ...state.records[0]!, height: 1 }];
    expect(() =>
      validateHeaderChain(wrongHeight, state.params, 10_000),
    ).toThrow(/trusted checkpoint/i);

    const wrongHash = [
      {
        ...state.records[0]!,
        hashDisplay: "00".repeat(32),
      },
    ];
    expect(() =>
      validateHeaderChain(wrongHash, state.params, 10_000),
    ).toThrow(/does not match/i);
  });

  test("rejects non-contiguous heights and corrupted record digests", () => {
    const state = fixture();
    append(state, 1_010);
    const gap = [
      state.records[0]!,
      { ...state.records[1]!, height: 2 },
    ];
    expect(() => validateHeaderChain(gap, state.params, 10_000)).toThrow(
      /not contiguous/i,
    );

    const badInternal = [
      state.records[0]!,
      {
        ...state.records[1]!,
        hashInternalHex: "11".repeat(32),
      },
    ];
    expect(() =>
      validateHeaderChain(badInternal, state.params, 10_000),
    ).toThrow(/hashInternalHex/i);

    const badDisplay = [
      state.records[0]!,
      {
        ...state.records[1]!,
        hashDisplay: "22".repeat(32),
      },
    ];
    expect(() =>
      validateHeaderChain(badDisplay, state.params, 10_000),
    ).toThrow(/display hash/i);
  });

  test("HeaderBranchBuilder validates a heavier fork from a common ancestor", () => {
    const state = fixture();
    append(state, 1_010);
    append(state, 1_020);
    append(state, 1_040);
    const canonical = validateHeaderChain(state.records, state.params, 10_000);

    const forkParent = state.records[1]!;
    const forkA = mineHeader({
      previousHash: hexToInternal(forkParent.hashInternalHex),
      bits: EASY_BITS,
      timestamp: 1_030,
      marker: 20,
      powLimit: state.params.powLimit,
    });
    const forkB = mineHeader({
      previousHash: headerHashInternal(forkA),
      bits: EASY_BITS,
      timestamp: 1_041,
      marker: 21,
      powLimit: state.params.powLimit,
    });

    const branch = new HeaderBranchBuilder(
      canonical,
      1,
      state.params,
      10_000,
    );
    branch.append([
      storedHeaderFromBlockHeader(2, forkA),
      storedHeaderFromBlockHeader(3, forkB),
    ]);
    const finished = branch.finish();

    expect(finished.commonAncestorHeight).toBe(1);
    expect(finished.tipHeight).toBe(3);
    expect(finished.headers).toHaveLength(2);
    expect(finished.chainWork > canonical.cumulativeWorkByHeight.get(1)!).toBe(
      true,
    );
    expect(finished.tipHashDisplay).toBe(headerHashDisplay(forkB));
  });

  test("HeaderBranchBuilder rejects an invalid competing header", () => {
    const state = fixture();
    append(state, 1_010);
    const canonical = validateHeaderChain(state.records, state.params, 10_000);
    const branch = new HeaderBranchBuilder(
      canonical,
      0,
      state.params,
      10_000,
    );
    const unlinked = mineHeader({
      previousHash: new Uint8Array(32).fill(1),
      bits: EASY_BITS,
      timestamp: 1_020,
      marker: 9,
      powLimit: state.params.powLimit,
    });

    expect(() =>
      branch.append([storedHeaderFromBlockHeader(1, unlinked)]),
    ).toThrow(/previous hash/i);
  });
});

function hexToInternal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeHeaderBits(headerHex: string): number {
  const bytes = hexToInternal(headerHex);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    72,
    true,
  );
}
