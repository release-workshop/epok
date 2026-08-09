import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  createCaptureBuffers,
  type CaptureBuffers,
  type RequestCaptureContext,
} from "./capture.js";

export type { CaptureBuffers, RequestCaptureContext };

export const requestContext = new AsyncLocalStorage<RequestCaptureContext>();

export function createCaptureContext(
  withCapture: boolean,
): RequestCaptureContext {
  return {
    interactionId: randomUUID(),
    capture: withCapture ? createCaptureBuffers() : null,
  };
}
