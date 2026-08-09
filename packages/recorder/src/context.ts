import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  createCaptureBuffers,
  type CaptureBuffers,
  type RequestCaptureContext,
} from "./capture.js";

export type { CaptureBuffers, RequestCaptureContext };

export const requestContext = new AsyncLocalStorage<RequestCaptureContext>();

/**
 * Build request-scoped capture state. Interaction ids are allocated lazily on
 * first read so disabled / unused contexts skip UUID work.
 */
export function createCaptureContext(
  withCapture: boolean,
  allocateId: () => string = randomUUID,
): RequestCaptureContext {
  let interactionId: string | undefined;
  return {
    get interactionId(): string {
      interactionId ??= allocateId();
      return interactionId;
    },
    capture: withCapture ? createCaptureBuffers() : null,
  };
}
