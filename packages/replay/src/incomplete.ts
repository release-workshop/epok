import type { InteractionManifest } from "@epok/core";
import type { ReplayMismatch } from "./types.js";

export const INBOUND_RESPONSE_MISSING_CODE = "inbound_response_missing";

export const INBOUND_RESPONSE_MISSING_MESSAGE =
  "recorded inbound response was not observed; cannot replay";

export function inboundResponseMissingMismatch(): ReplayMismatch {
  return {
    code: INBOUND_RESPONSE_MISSING_CODE,
    message: INBOUND_RESPONSE_MISSING_MESSAGE,
  };
}

export function hasObservedInboundResponse(
  manifest: InteractionManifest,
): boolean {
  return manifest.response !== null;
}
