#!/usr/bin/env node
// worker-output-filter.js — PostToolUse hook: filter verbose Bash output before it
// enters model context, writing raw bytes to $OUTPUT_DIR/captures/<sha8>.log.
//
// Enabled only when ADVISOR_OUTPUT_FILTER=1. Fail-open: any exception exits
// non-zero, leaving the original tool output completely untouched.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { filter } = require('../output-filter.js');

const LINE_BUDGET = 80;
const MIN_BYTES = 2048;

async function main() {
  if (process.env.ADVISOR_OUTPUT_FILTER !== '1') return;

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    // Malformed stdin: fail open by exiting non-zero.
    process.exit(1);
  }

  if (event.tool_name !== 'Bash') return; // only intercept Bash

  const toolOutput = event?.tool_response?.output;
  if (typeof toolOutput !== 'string') return; // no output field: pass through

  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir) return; // no capture dir: pass through without filtering

  const { summary, stats } = filter(toolOutput, { lineBudget: LINE_BUDGET, minBytes: MIN_BYTES });

  // Passthrough: output was below minBytes, nothing to write
  if (stats.rawBytes < MIN_BYTES) return;

  // Write raw bytes to captures dir (content-addressed by first 8 hex of sha256)
  const sha8 = crypto.createHash('sha256').update(toolOutput).digest('hex').slice(0, 8);
  const capturesDir = path.join(outputDir, 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });
  const capturePath = path.join(capturesDir, `${sha8}.log`);
  fs.writeFileSync(capturePath, toolOutput, 'utf8');

  const footer = `\n[output-filter: ${stats.rawLines} lines → ${stats.keptLines} kept, ${stats.droppedLines} dropped; raw at ${capturePath}]`;
  const filtered = summary + footer;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: filtered,
    },
  }));
}

main().catch(() => {
  // Any unhandled exception: exit non-zero so Claude Code leaves output untouched.
  process.exit(1);
});
