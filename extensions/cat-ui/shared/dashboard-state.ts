/**
 * Shared dashboard state types and utilities for the pi TUI dashboard.
 *
 * Originally from the pi monorepo dashboard extension. Re-exported here
 * so the cat-ui extension can use them as a module-local dependency.
 */

export interface ModelInfoState {
  contextPercent: number | null;
  contextWindow: number;
  tokensPerSecond: number | null;
  cost: number;
  provider: string;
  modelId: string;
  thinking: string;
  isSystemChain: boolean;
}

export interface GitInfoState {
  changedFiles: number;
  branch: string;
  pullRequest?: { number: number; url: string };
}

export interface RefreshPayload {
  force?: boolean;
}

export const GIT_INFO_CHANNEL = "dashboard:gitInfo";
export const MODEL_INFO_CHANNEL = "dashboard:modelInfo";
export const REFRESH_CHANNEL = "dashboard:refresh";

export function emptyGitInfoState(): GitInfoState {
  return { changedFiles: 0, branch: "" };
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    contextPercent: null,
    contextWindow: 0,
    tokensPerSecond: null,
    cost: 0,
    provider: "",
    modelId: "",
    thinking: "off",
    isSystemChain: false,
  };
}

export function isGitInfoState(value: unknown): value is GitInfoState {
  return (
    typeof value === "object" &&
    value !== null &&
    "changedFiles" in value &&
    "branch" in value
  );
}

export function isModelInfoState(value: unknown): value is ModelInfoState {
  return (
    typeof value === "object" &&
    value !== null &&
    "contextPercent" in value &&
    "contextWindow" in value &&
    "cost" in value
  );
}
