/**
 * Measured results transcribed verbatim from `bb-tpm-rank --help`.
 *
 * These are the ONLY numbers a preview may show. A model asked to produce
 * plausible market statistics will produce them fluently and wrongly, and a
 * preview is the surface where a fabricated number reads as authoritative.
 */
export type EvidenceRow = {
  /** null = no floor applied. */
  value: number | null;
  fires: number;
  symbols?: number;
  reach1: number;
  reach2: number;
  medianHigh?: string;
};

export type EvidenceTable = {
  flag: string;
  scored: string;
  heldAt?: string;
  rows: EvidenceRow[];
};

export const EVIDENCE: Record<string, EvidenceTable> = {
  "--ign-min-tpm": {
    flag: "--ign-min-tpm",
    scored: "2026-09-10, 11,596 fires, scored on the next five minutes",
    rows: [
      { value: null, fires: 11596, reach1: 29, reach2: 16, medianHigh: "+0.33%" },
      { value: 1000, fires: 1148, reach1: 44, reach2: 30, medianHigh: "+0.74%" },
      { value: 3000, fires: 394, reach1: 58, reach2: 42, medianHigh: "+1.44%" },
    ],
  },
  "--ign-min-vol-min": {
    flag: "--ign-min-vol-min",
    scored: "2026-09-10, 11,596 fires",
    heldAt: "tpm >= 1,000",
    rows: [
      { value: null, fires: 1148, symbols: 229, reach1: 44, reach2: 30 },
      { value: 300000, fires: 475, symbols: 61, reach1: 55, reach2: 38 },
      { value: 500000, fires: 280, symbols: 30, reach1: 57, reach2: 39 },
      { value: 1000000, fires: 122, symbols: 11, reach1: 68, reach2: 55 },
    ],
  },
};

/** Tier bands are shaped differently: forward return by band, not by floor. */
export const TIER_EVIDENCE = {
  flag: "--ign-tiers",
  scored: "2026-09-18, 912 fires across 80 symbols, forward 30 minutes",
  bands: [
    { band: "<2,000", fires: 558, median: "+3.75%", over5: 41.9, over20: 14.3 },
    { band: "2,000-4,000", fires: 256, median: "+5.01%", over5: 50.4, over20: 18.4 },
    { band: "4,000-8,000", fires: 86, median: "+9.79%", over5: 72.1, over20: 20.9 },
    { band: ">8,000", fires: 12, median: "+29.23%", over5: 83.3, over20: 50.0 },
  ],
} as const;

export function hasEvidence(flag: string): boolean {
  return flag in EVIDENCE || flag === TIER_EVIDENCE.flag;
}
