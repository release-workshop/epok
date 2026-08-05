#!/usr/bin/env node
import { runCli } from "./run.js";

const code = await runCli(process.argv);
process.exitCode = code;
