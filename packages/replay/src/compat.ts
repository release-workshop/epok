import { SPEC_VERSION } from "@epok/core";

export function unsupportedSpecVersionMessage(
  specVersion: string,
): string | undefined {
  const [supportedMajor] = SPEC_VERSION.split(".");
  const [actualMajor] = specVersion.split(".");
  if (actualMajor !== supportedMajor) {
    return `unsupported specVersion ${specVersion} (supported major ${supportedMajor})`;
  }
  return undefined;
}
