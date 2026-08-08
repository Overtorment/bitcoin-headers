import assert from "node:assert/strict";

const {
  CHECKPOINT_HEIGHT,
  MAINNET_HEADER_CONSENSUS,
  bitsToTarget,
  checkpointSeedRecord,
  validateHeaderChain,
} = await import("../../dist/index.js");

assert.equal(CHECKPOINT_HEIGHT, 665_280);
assert.equal(MAINNET_HEADER_CONSENSUS.checkpoint.height, 665_280);

const seed = checkpointSeedRecord();
const chain = validateHeaderChain(
  [
    {
      height: seed.height,
      hashDisplay: seed.hashDisplay,
      hashInternalHex: seed.hashInternalHex,
      headerHex: seed.headerHex,
    },
  ],
  MAINNET_HEADER_CONSENSUS,
  1_800_000_000,
);
assert.equal(chain.tipHeight, 665_280);
assert.ok(bitsToTarget(seed.header.bits) > 0n);

const rn = await import("../../dist/react-native.js");
assert.equal(rn.CHECKPOINT_HEIGHT, 665_280);
assert.equal(
  rn.validateHeaderChain(
    [
      {
        height: seed.height,
        hashDisplay: seed.hashDisplay,
        hashInternalHex: seed.hashInternalHex,
        headerHex: seed.headerHex,
      },
    ],
    rn.MAINNET_HEADER_CONSENSUS,
    1_800_000_000,
  ).tipHeight,
  665_280,
);

console.log("bitcoin-headers package smoke ok");
