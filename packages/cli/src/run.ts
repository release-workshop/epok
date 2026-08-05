/**
 * CLI entry for `epok replay run` / `epok replay validate`.
 * Command implementations land in the CLI golden-path slice.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const [, , ...args] = argv;
  if (args[0] === "replay" && (args[1] === "run" || args[1] === "validate")) {
    throw new Error(`@epok/cli: epok replay ${args[1]} is not implemented yet`);
  }

  console.error("Usage: epok replay <run|validate> <interaction-ref>");
  return 1;
}
