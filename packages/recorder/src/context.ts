import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestCaptureContext {
  interactionId: string;
}

export const requestContext = new AsyncLocalStorage<RequestCaptureContext>();

export function createCaptureContext(): RequestCaptureContext {
  return { interactionId: randomUUID() };
}
