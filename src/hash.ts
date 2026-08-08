import { sha256 } from "@noble/hashes/sha2.js";

/** SHA256d: `SHA256(SHA256(data))`, as used throughout Bitcoin consensus code. */
export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}
