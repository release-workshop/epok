/**
 * WinterCG / Fetch-shaped observation surface.
 * Node `http` adaption belongs in `@epok/recorder`, not here.
 */

/** Subset of the Fetch API used by portable recorder observation. */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DependencyObservationError {
  type: string;
  message: string;
}

/**
 * Runtime-agnostic hooks for observing inbound request, outbound fetch
 * dependencies, and the host response. Adapters may wrap Node streams into
 * Fetch `Request`/`Response` before invoking these hooks.
 */
export interface RecorderObservationHooks {
  onInbound?(request: Request): void;
  onDependency?(
    request: Request,
    response: Response | null,
    error?: DependencyObservationError,
  ): void;
  onResponse?(response: Response): void;
}
