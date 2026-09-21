import { branding } from "./branding.js";
import { tpmRank } from "./tpm-rank.js";

export type PreviewStyle = "hybrid" | "plain";

export type Scenario = {
  id: string;
  label: string;
  /** Prompt text shown in the client's textarea when this scenario is picked. */
  defaultPrompt: string;
  systemPrompt: string;
  previewStyle: PreviewStyle;
  /**
   * Tools this scenario may use, beyond the SDK plumbing. Scenarios that show
   * real-world imagery need to go and find it; tpm-rank must not, since its
   * numbers may only come from its evidence tables.
   */
  tools: string[];
  /**
   * Instruction pushed when the user presses "Continue to Design".
   *
   * This belongs to the scenario, not the session. It used to be one hardcoded
   * string, so a branding conversation was handed a simulated market tape and
   * asked for "the per-flag rationale".
   *
   * `seed` is derived from the session id, so a scenario that needs sample data
   * can generate a reproducible set.
   */
  designPrompt: (seed: number) => string;
};

export const SCENARIOS: Record<string, Scenario> = {
  [branding.id]: branding,
  [tpmRank.id]: tpmRank,
};

export const DEFAULT_SCENARIO = branding.id;

export function getScenario(id: string | undefined): Scenario {
  return SCENARIOS[id ?? DEFAULT_SCENARIO] ?? SCENARIOS[DEFAULT_SCENARIO];
}
