import type { CasAlgorithm, CasRef } from "./interaction.js";

/** Threshold above which body bytes must stay in external CAS (Interaction spec §6.3). */
export const EMBEDDED_OBJECT_MAX_BYTES = 16 * 1024;

export interface CasKey {
  alg: CasAlgorithm;
  hash: string;
}

export function casKeyFromRef(ref: CasRef): CasKey {
  return { alg: ref.alg, hash: ref.hash };
}

/** Whether sanitized body bytes may be embedded in `manifest.objects`. */
export function mayEmbedObject(size: number): boolean {
  return size < EMBEDDED_OBJECT_MAX_BYTES;
}
