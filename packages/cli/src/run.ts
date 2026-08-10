import { pathToFileURL } from "node:url";
import path from "node:path";
import { createFsStorageProvider } from "@epok/storage-fs";
import {
  mockReplay,
  runReplay,
  validateReplay,
  type ReplayHandler,
  type ReplayMismatchMode,
  type ReplayResult,
  type ReplayTimingMode,
} from "@epok/replay";

const USAGE = `Usage:
  epok replay validate [options] <interaction-id>
  epok replay run [options] <interaction-id>
  epok replay mock [options] <interaction-id>

Commands:
  validate   Integrity + compatibility checks (no execution)
  run        Executable re-run: re-drive handler, inject deps, compare response
  mock       Snapshot/mock: load fixtures without executable re-drive
             (library installFetch stubs deps; CLI confirms fixtures load)

Options:
  --dir <path>        Filesystem Storage Provider root (default: .epok)
  --handler <path>    Handler module for replay run (required for run)
  --report <format>   text | json (default: text)
  --mode <mode>       strict (default) | diagnostic-lenient
  --timing <mode>     instant (default) | realtime
  -h, --help          Show this help
`;

type ReportFormat = "text" | "json";

interface ParsedArgs {
  command: "run" | "validate" | "mock" | "help" | undefined;
  interactionId: string | undefined;
  dir: string;
  handler: string | undefined;
  report: ReportFormat;
  mode: ReplayMismatchMode;
  timing: ReplayTimingMode;
  error: string | undefined;
}

type OptionName = "--dir" | "--handler" | "--report" | "--mode" | "--timing";

function isOptionName(arg: string): arg is OptionName {
  return (
    arg === "--dir" ||
    arg === "--handler" ||
    arg === "--report" ||
    arg === "--mode" ||
    arg === "--timing"
  );
}

function applyOption(
  name: OptionName,
  value: string,
  state: ParsedArgs,
): string | undefined {
  switch (name) {
    case "--dir":
      state.dir = value;
      return undefined;
    case "--handler":
      state.handler = value;
      return undefined;
    case "--report":
      if (value !== "text" && value !== "json") {
        return `--report must be text or json`;
      }
      state.report = value;
      return undefined;
    case "--mode":
      if (value !== "strict" && value !== "diagnostic-lenient") {
        return `--mode must be strict or diagnostic-lenient`;
      }
      state.mode = value;
      return undefined;
    case "--timing":
      if (value !== "instant" && value !== "realtime") {
        return `--timing must be instant or realtime`;
      }
      state.timing = value;
      return undefined;
  }
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const state: ParsedArgs = {
    command: undefined,
    interactionId: undefined,
    dir: ".epok",
    handler: undefined,
    report: "text",
    mode: "strict",
    timing: "instant",
    error: undefined,
  };

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    state.command = "help";
    return state;
  }

  if (args[0] !== "replay") {
    state.error = `unknown command: ${args[0]}`;
    return state;
  }

  const sub = args[1];
  if (sub === "run" || sub === "validate" || sub === "mock") {
    state.command = sub;
  } else if (sub === "-h" || sub === "--help" || sub === undefined) {
    state.command = "help";
    return state;
  } else {
    state.error = `unknown replay command: ${sub}`;
    return state;
  }

  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) break;

    if (arg === "-h" || arg === "--help") {
      state.command = "help";
      return state;
    }

    if (isOptionName(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        state.error = `${arg} requires a value`;
        return state;
      }
      i += 1;
      const optionError = applyOption(arg, value, state);
      if (optionError !== undefined) {
        state.error = optionError;
        return state;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      state.error = `unknown option: ${arg}`;
      return state;
    }

    if (state.interactionId !== undefined) {
      state.error = `unexpected argument: ${arg}`;
      return state;
    }
    state.interactionId = arg;
  }

  return state;
}

function printReport(
  result: ReplayResult & { dependencyCount?: number },
  format: ReportFormat,
): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const stream = result.ok ? console.log : console.error;
  const label = result.ok ? "PASS" : "FAIL";
  stream(`${label}  ${result.interactionId}`);
  stream(`      ${result.message}`);
  if (result.playback !== undefined) {
    stream(`      playback=${result.playback}`);
  }
  if (result.dependencyCount !== undefined) {
    stream(`      dependencies=${result.dependencyCount}`);
  }
  if (result.mismatches && result.mismatches.length > 0) {
    for (const mismatch of result.mismatches) {
      const parts = [`${mismatch.code}: ${mismatch.message}`];
      if (mismatch.method !== undefined) {
        parts.push(`method=${mismatch.method}`);
      }
      if (mismatch.url !== undefined) parts.push(`url=${mismatch.url}`);
      if (mismatch.dependencySeq !== undefined) {
        parts.push(`seq=${mismatch.dependencySeq}`);
      }
      stream(`      - ${parts.join("  ")}`);
    }
  }
  if (result.timingNotes && result.timingNotes.length > 0) {
    for (const note of result.timingNotes) {
      stream(`      timing: ${note}`);
    }
  }
}

async function loadHandler(handlerPath: string): Promise<ReplayHandler> {
  const resolved = path.resolve(handlerPath);
  const mod = (await import(pathToFileURL(resolved).href)) as Record<
    string,
    unknown
  >;
  const candidate =
    mod["default"] ?? mod["handler"] ?? mod["handleRequest"] ?? mod["run"];
  if (typeof candidate !== "function") {
    throw new Error(
      `handler module must export a function as default, handler, handleRequest, or run: ${resolved}`,
    );
  }
  return candidate as ReplayHandler;
}

/**
 * CLI entry for `epok replay run` / `validate` / `mock`.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const [, , ...args] = argv;
  const parsed = parseArgs(args);

  if (parsed.command === "help") {
    console.log(USAGE);
    return 0;
  }

  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }

  if (parsed.command === undefined || parsed.interactionId === undefined) {
    console.error("missing interaction id");
    console.error(USAGE);
    return 2;
  }

  if (parsed.command === "run" && parsed.handler === undefined) {
    console.error("epok replay run requires --handler <path>");
    console.error(USAGE);
    return 2;
  }

  const storage = createFsStorageProvider({
    rootDir: path.resolve(parsed.dir),
  });

  try {
    if (parsed.command === "validate") {
      const result = await validateReplay({
        storage,
        interactionId: parsed.interactionId,
      });
      printReport(result, parsed.report);
      return result.ok ? 0 : 1;
    }

    if (parsed.command === "mock") {
      const ready = await mockReplay({
        storage,
        interactionId: parsed.interactionId,
        mode: parsed.mode,
        timing: parsed.timing,
      });
      if (!ready.ok) {
        printReport(ready, parsed.report);
        return 1;
      }
      const report: ReplayResult & { dependencyCount: number } = {
        ok: true,
        interactionId: ready.interactionId,
        message: ready.message,
        timing: ready.timing,
        mode: ready.mode,
        playback: ready.playback,
        dependencyCount: ready.dependencyCount,
      };
      printReport(report, parsed.report);
      return 0;
    }

    if (parsed.handler === undefined) {
      console.error("epok replay run requires --handler <path>");
      console.error(USAGE);
      return 2;
    }

    const handler = await loadHandler(parsed.handler);
    const result = await runReplay({
      storage,
      interactionId: parsed.interactionId,
      handler,
      mode: parsed.mode,
      timing: parsed.timing,
    });
    printReport(result, parsed.report);
    return result.ok ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ReplayResult = {
      ok: false,
      interactionId: parsed.interactionId,
      message,
    };
    printReport(result, parsed.report);
    return 1;
  }
}
