export type Pick = {
  id: string;
  header: string;
  question: string;
  label: string;
  description: string;
  /** id of the pick that replaced this one, when amended. */
  supersededBy?: string;
};

export type PickStoreData = { nextId: number; picks: Pick[] };

export type PickInput = {
  header: string;
  question: string;
  label: string;
  description: string;
};

/**
 * Ordered record of what the user chose, with amendments kept as history
 * rather than overwritten. Ids are sequential so a serialized store is stable:
 * two stores built from the same choices produce byte-identical JSON, which is
 * what lets writeIfChanged skip redundant snapshots.
 */
export class PickStore {
  private picks: Pick[] = [];
  private nextId = 1;

  record(input: PickInput): Pick {
    const pick: Pick = { id: `p${this.nextId++}`, ...input };
    this.picks.push(pick);
    return pick;
  }

  amend(pickId: string, label: string, description: string): Pick {
    const original = this.picks.find((p) => p.id === pickId);
    if (!original) throw new Error(`unknown pick: ${pickId}`);

    const replacement: Pick = {
      id: `p${this.nextId++}`,
      header: original.header,
      question: original.question,
      label,
      description,
    };
    original.supersededBy = replacement.id;
    // Insert in the superseded pick's slot so display order is unchanged.
    this.picks.splice(this.picks.indexOf(original) + 1, 0, replacement);
    return replacement;
  }

  /** Picks that have not been replaced, in display order. */
  current(): Pick[] {
    return this.picks.filter((p) => !p.supersededBy);
  }

  /** Picks that have been replaced, oldest first. */
  history(): Pick[] {
    return this.picks.filter((p) => p.supersededBy);
  }

  toObject(): PickStoreData {
    return { nextId: this.nextId, picks: this.picks };
  }

  static fromObject(data: PickStoreData): PickStore {
    const store = new PickStore();
    store.picks = data.picks;
    store.nextId = data.nextId;
    return store;
  }

  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  static fromJSON(json: string): PickStore {
    return PickStore.fromObject(JSON.parse(json) as PickStoreData);
  }
}
