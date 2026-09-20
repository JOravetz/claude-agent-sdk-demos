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
};

export const SCENARIOS: Record<string, Scenario> = {
  [branding.id]: branding,
  [tpmRank.id]: tpmRank,
};

export const DEFAULT_SCENARIO = branding.id;

export function getScenario(id: string | undefined): Scenario {
  return SCENARIOS[id ?? DEFAULT_SCENARIO] ?? SCENARIOS[DEFAULT_SCENARIO];
}
