export type BlockHeader = {
  version: number;
  previousBlockHash: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
};

export function decodeBlockHeader(bytes: Uint8Array): BlockHeader {
  if (bytes.length !== 80) {
    throw new Error(`header must be 80 bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getInt32(0, true),
    previousBlockHash: bytes.slice(4, 36),
    merkleRoot: bytes.slice(36, 68),
    timestamp: view.getUint32(68, true),
    bits: view.getUint32(72, true),
    nonce: view.getUint32(76, true),
  };
}

export function encodeBlockHeader(header: BlockHeader): Uint8Array {
  if (header.previousBlockHash.length !== 32) {
    throw new Error("previous block hash must be 32 bytes");
  }
  if (header.merkleRoot.length !== 32) {
    throw new Error("merkle root must be 32 bytes");
  }
  const out = new Uint8Array(80);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setInt32(0, header.version, true);
  out.set(header.previousBlockHash, 4);
  out.set(header.merkleRoot, 36);
  view.setUint32(68, header.timestamp, true);
  view.setUint32(72, header.bits, true);
  view.setUint32(76, header.nonce, true);
  return out;
}
