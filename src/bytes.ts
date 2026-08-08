export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex.length}`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesFromHex(
  value: string,
  byteLength: number,
  label: string,
): Uint8Array {
  if (value.length !== byteLength * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${label} must be ${byteLength} bytes of lowercase hex`);
  }
  return hexToBytes(value);
}
