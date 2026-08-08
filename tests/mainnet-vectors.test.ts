import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeBlockHeader,
  decodeCompactTarget,
  equalBytes,
  headerWork,
  hexToBytes,
  MAINNET_HEADER_CONSENSUS,
  validateHeaderChain,
  type HeaderRecord,
} from "../src/index.ts";

type Fixture = {
  fromHeight: number;
  toHeight: number;
  tipHashDisplay: string;
  headers: HeaderRecord[];
};

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../testdata/mainnet-headers.json"),
    "utf8",
  ),
) as Fixture;

describe("mainnet header vectors", () => {
  test("validates 128 contiguous synced mainnet headers with cumulative work", () => {
    const chain = validateHeaderChain(
      fixture.headers,
      MAINNET_HEADER_CONSENSUS,
      1_800_000_000,
    );

    expect(chain.tipHeight).toBe(fixture.toHeight);
    expect(chain.tipHashDisplay).toBe(fixture.tipHashDisplay);
    expect(chain.headers).toHaveLength(fixture.headers.length);
    expect(chain.tipHeight - fixture.fromHeight + 1).toBe(
      fixture.headers.length,
    );

    let expectedWork = 0n;
    for (let i = 0; i < fixture.headers.length; i++) {
      const record = fixture.headers[i]!;
      const header = decodeBlockHeader(hexToBytes(record.headerHex));
      const entry = chain.entriesByHeight.get(record.height);
      expect(entry).toBeDefined();
      expect(entry!.record.hashDisplay).toBe(record.hashDisplay);
      expect(entry!.header.bits).toBe(header.bits);
      // This window sits inside one difficulty period after the 665280 boundary.
      expect(header.bits).toBe(0x170da8a1);
      if (i > 0) {
        expect(record.height).toBe(fixture.headers[i - 1]!.height + 1);
        expect(
          equalBytes(
            entry!.header.previousBlockHash,
            chain.entriesByHeight.get(record.height - 1)!.hashInternal,
          ),
        ).toBe(true);
      }
      expectedWork += headerWork(
        decodeCompactTarget(header.bits, MAINNET_HEADER_CONSENSUS.powLimit),
      );
      expect(chain.cumulativeWorkByHeight.get(record.height)).toBe(expectedWork);
    }
    expect(chain.chainWork).toBe(expectedWork);
  });
});
