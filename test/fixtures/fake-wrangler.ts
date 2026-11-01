#!/usr/bin/env bun
// Stands in for wrangler: logs each call with its stdin, and fails when told to.

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");

if (process.env.FAKE_WRANGLER_LOG) {
  appendFileSync(
    process.env.FAKE_WRANGLER_LOG,
    `${JSON.stringify({ args, stdin, cwd: process.cwd() })}\n`,
  );
}

if (process.env.FAKE_WRANGLER_FAIL === args[0]) {
  process.stderr.write("Authentication error [code: 10000]\n");
  process.exit(1);
}

process.stdout.write("Success!\n");
