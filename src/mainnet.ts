import { bytesToHex, hexToBytes } from "./bytes.ts";
import type { HeaderConsensusParams } from "./consensus.ts";
import { decodeBlockHeader, encodeBlockHeader } from "./header.ts";
import {
  headerHashDisplay,
  headerHashInternal,
  MAINNET_POW_LIMIT,
  meetsTarget,
} from "./pow.ts";
import type { HeaderRecord } from "./types.ts";

/**
 * Mainnet difficulty-boundary checkpoint. The raw header was independently
 * cross-checked against both explorers:
 * https://mempool.space/api/block/00000000000000000009ebabc95533bbe0e40adecee879449db291237b3db350/header
 * https://blockstream.info/api/block/00000000000000000009ebabc95533bbe0e40adecee879449db291237b3db350/header
 */
export const CHECKPOINT_HEIGHT = 665_280;
export const CHECKPOINT_DISPLAY_HASH =
  "00000000000000000009ebabc95533bbe0e40adecee879449db291237b3db350";
/** Full 80-byte header (wire/internal field order). */
export const CHECKPOINT_HEADER_HEX =
  "0000002052d7f05def7bc6826cda74f5bdaf855fe13cd2c8aba50e000000000000000000bbb445df9b50f6555752df7e48d09c4f5dbd8e5c8ebf30aff1b55f8ed44d9e80b5caf95fa1a80d1714764687";
export const CHECKPOINT_HEADER = hexToBytes(CHECKPOINT_HEADER_HEX);

/**
 * Heights 665270..665279, in ascending order. Cross-checked against:
 *
 * https://blockstream.info/api/blocks/665279
 * https://mempool.space/api/v1/blocks/665279
 */
export const MAINNET_PRE_CHECKPOINT_TIMESTAMPS = Object.freeze([
  1_610_199_116,
  1_610_199_477,
  1_610_199_700,
  1_610_201_389,
  1_610_201_449,
  1_610_201_799,
  1_610_204_487,
  1_610_204_754,
  1_610_204_957,
  1_610_205_491,
]);

export const MAINNET_HEADER_CONSENSUS: HeaderConsensusParams = Object.freeze({
  powLimit: MAINNET_POW_LIMIT,
  targetSpacingSeconds: 10 * 60,
  targetTimespanSeconds: 14 * 24 * 60 * 60,
  retargetInterval: 2_016,
  medianTimeSpan: 11,
  maxFutureSeconds: 2 * 60 * 60,
  checkpoint: Object.freeze({
    height: CHECKPOINT_HEIGHT,
    headerBytes: CHECKPOINT_HEADER.slice(),
    hashDisplay: CHECKPOINT_DISPLAY_HASH,
    previousTimestamps: MAINNET_PRE_CHECKPOINT_TIMESTAMPS,
  }),
});

export function checkpointHeader() {
  const header = decodeBlockHeader(CHECKPOINT_HEADER);
  const display = headerHashDisplay(header);
  if (display !== CHECKPOINT_DISPLAY_HASH) {
    throw new Error(
      `checkpoint header hash mismatch: got ${display}, expected ${CHECKPOINT_DISPLAY_HASH}`,
    );
  }
  if (!meetsTarget(headerHashInternal(header), header.bits)) {
    throw new Error("checkpoint header fails PoW check");
  }
  const encoded = encodeBlockHeader(header);
  for (let i = 0; i < 80; i++) {
    if (encoded[i] !== CHECKPOINT_HEADER[i]) {
      throw new Error("checkpoint header encode mismatch");
    }
  }
  return header;
}

export function checkpointSeedRecord(): HeaderRecord & {
  header: ReturnType<typeof checkpointHeader>;
  hashInternal: Uint8Array;
} {
  const header = checkpointHeader();
  const hashInternal = headerHashInternal(header);
  return {
    height: CHECKPOINT_HEIGHT,
    hashDisplay: CHECKPOINT_DISPLAY_HASH,
    hashInternalHex: bytesToHex(hashInternal),
    headerHex: bytesToHex(CHECKPOINT_HEADER),
    header,
    hashInternal,
  };
}
