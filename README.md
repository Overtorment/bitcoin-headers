# bitcoin-headers

Isomorphic TypeScript **Bitcoin header** PoW and chain-consensus validation.

- **Runtime-neutral** — no Node / Bun / React imports in `src/`
- **Pure JS crypto** — `@noble/hashes` for SHA256d
- **Checkpoint-anchored chains** — validate linkage, compact targets, retargets,
  median time past, future time, and cumulative work
- **Mainnet constants** — difficulty-boundary checkpoint at height `665280`

There is no BIP for this surface: it implements Bitcoin header consensus rules
used by SPV / Neutrino light clients.

## Install

```bash
bun install
bun run check
```

## Quick usage

```ts
import {
  MAINNET_HEADER_CONSENSUS,
  validateHeaderChain,
  type HeaderRecord,
} from "bitcoin-headers";

const chain = validateHeaderChain(
  headers as HeaderRecord[],
  MAINNET_HEADER_CONSENSUS,
  Math.floor(Date.now() / 1000),
);
console.log(chain.tipHeight, chain.tipHashDisplay, chain.chainWork);
```

## React Native

Import the package root (or the `react-native` export condition). Do not pull in
Node built-ins; the RN build bundles `@noble/hashes`.

## Tests

- Synthetic easy-difficulty consensus fixtures (retarget, MTP, PoW, linkage)
- Verified mainnet checkpoint PoW / serialization checks
- Real mainnet header vectors from a Helix2 synced store (`testdata/`)
