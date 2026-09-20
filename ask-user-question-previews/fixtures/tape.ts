/**
 * A deterministic, SIMULATED tpm-rank tape.
 *
 * The demo never runs `bb-tpm-rank` and never reads the market, so with the
 * session closed there are no rows for the phase-2 dashboard to render. This
 * generator supplies them.
 *
 * Symbols are deliberately synthetic (SIM*). Real tickers carrying invented
 * trade rates and prices would be indistinguishable from a recorded session in
 * a screenshot, and someone would eventually read them as real. Every consumer
 * must label the output SIMULATED.
 */

export type TapeRow = {
  rank: number;
  sym: string;
  tpm: number;
  dTpm: number;
  price: number;
  oneMin: number;
  ign: string;
  tier: string;
  volMin: number;
  lit: boolean;
};

/** mulberry32: small, fast, and seedable, so a seed always gives one tape. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = [
  "SIMA", "SIMB", "SIMC", "SIMD", "SIME", "SIMF",
  "SIMG", "SIMH", "SIMJ", "SIMK", "SIML", "SIMN",
];

type SymbolState = {
  sym: string;
  tpm: number;
  prevTpm: number;
  price: number;
  openPrice: number;
  clip: number;
  litFor: number;
};

/** Seconds of tape each tick() covers; matches bb-tpm-rank's default --rate. */
const BUCKET_SECONDS = 5;
/** How long a lit row keeps its IGN stamp before re-arming. */
const IGN_HOLD_SECONDS = 60;

export class SimulatedTape {
  private rand: () => number;
  private states: SymbolState[];

  constructor(
    seed = 1,
    private readonly tiers: number[] = [2000, 4000, 8000],
  ) {
    this.rand = mulberry32(seed);
    this.states = SYMBOLS.map((sym) => {
      const price = 1.5 + this.rand() * 12;
      return {
        sym,
        tpm: 40 + Math.floor(this.rand() * 900),
        prevTpm: 0,
        price,
        openPrice: price,
        clip: 80 + Math.floor(this.rand() * 400),
        litFor: 0,
      };
    });
  }

  private tierFor(tpm: number): string {
    let tier = "";
    this.tiers.forEach((cut, i) => {
      if (tpm >= cut) tier = `T${i + 1}`;
    });
    return tier;
  }

  /** Advance one bucket and return the ranked table. */
  tick(): TapeRow[] {
    for (const s of this.states) {
      s.prevTpm = s.tpm;

      const igniting = s.litFor === 0 && this.rand() < 0.08;
      if (igniting) {
        s.tpm = Math.floor(s.tpm * (4 + this.rand() * 8));
        s.litFor = BUCKET_SECONDS;
        s.price *= 1 + this.rand() * 0.04;
      } else if (s.litFor > 0) {
        s.litFor += BUCKET_SECONDS;
        s.tpm = Math.floor(s.tpm * (0.82 + this.rand() * 0.3));
        s.price *= 1 + (this.rand() - 0.4) * 0.012;
        if (s.litFor >= IGN_HOLD_SECONDS) s.litFor = 0;
      } else {
        s.tpm = Math.max(5, Math.floor(s.tpm * (0.9 + this.rand() * 0.22)));
        s.price *= 1 + (this.rand() - 0.5) * 0.006;
      }
    }

    return [...this.states]
      .sort((a, b) => b.tpm - a.tpm)
      .map((s, i) => ({
        rank: i + 1,
        sym: s.sym,
        tpm: s.tpm,
        dTpm: s.tpm - s.prevTpm,
        price: Number(s.price.toFixed(4)),
        oneMin: Number((((s.price - s.openPrice) / s.openPrice) * 100).toFixed(2)),
        ign: s.litFor > 0 ? `${s.litFor}s` : "",
        tier: s.litFor > 0 ? this.tierFor(s.tpm) : "",
        volMin: s.tpm * s.clip,
        lit: s.litFor > 0,
      }));
  }
}

/** State after `ticks` buckets. Same seed and count always give the same rows. */
export function tapeSample(ticks = 12, seed = 1): TapeRow[] {
  const tape = new SimulatedTape(seed);
  let rows: TapeRow[] = [];
  for (let i = 0; i < ticks; i++) rows = tape.tick();
  return rows;
}

/** Monospace rendering, right-justified numerics, for embedding in a prompt. */
export function formatTape(rows: TapeRow[]): string {
  const pad = (v: string | number, w: number) => String(v).padStart(w);
  const header =
    `${pad("RANK", 4)}  ${"SYM".padEnd(6)}${pad("TPM", 8)}${pad("dTPM", 8)}` +
    `${pad("PRICE", 10)}${pad("1m%", 8)}${pad("IGN", 6)}${pad("TIER", 6)}${pad("VOL/MIN", 11)}`;
  const body = rows
    .map(
      (r) =>
        `${pad(r.rank, 4)}  ${r.sym.padEnd(6)}${pad(r.tpm, 8)}` +
        `${pad(r.dTpm > 0 ? `+${r.dTpm}` : r.dTpm, 8)}${pad(r.price.toFixed(4), 10)}` +
        `${pad(`${r.oneMin > 0 ? "+" : ""}${r.oneMin.toFixed(2)}%`, 8)}` +
        `${pad(r.ign, 6)}${pad(r.tier, 6)}${pad(r.volMin.toLocaleString("en-US"), 11)}`,
    )
    .join("\n");
  return `${header}\n${"-".repeat(header.length)}\n${body}`;
}
