import type { Dependency } from "./interaction.js";

/**
 * Strict executable re-run match key: method + URL.
 * Matching must not rely on redacted secret header/query values.
 */
export interface ReplayMatchKey {
  method: string;
  url: string;
}

export interface ReplayMatchOptions {
  /** Disambiguate retries / identical method+URL rows by recorded seq. */
  seq?: number;
}

export function matchKeyFromDependency(dependency: Dependency): ReplayMatchKey {
  return {
    method: dependency.request.method,
    url: dependency.request.url,
  };
}

/**
 * Find a recorded dependency for an outbound attempt under strict matching.
 * When multiple rows share method+URL, pass `seq` to select the retry row.
 */
export function matchDependency(
  recorded: readonly Dependency[],
  attempt: ReplayMatchKey,
  options?: ReplayMatchOptions,
): Dependency | undefined {
  const candidates = recorded.filter(
    (dep) =>
      dep.request.method === attempt.method && dep.request.url === attempt.url,
  );

  if (options?.seq !== undefined) {
    return candidates.find((dep) => dep.seq === options.seq);
  }

  // Strict matching: identical method+URL retries require seq disambiguation.
  if (candidates.length !== 1) {
    return undefined;
  }

  return candidates[0];
}
