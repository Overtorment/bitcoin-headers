/** Durable header record (hex-encoded) used by validators and light-client stores. */
export type HeaderRecord = {
  height: number;
  hashDisplay: string;
  hashInternalHex: string;
  headerHex: string;
};
