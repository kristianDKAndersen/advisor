#!/usr/bin/env node
// worker-trace.js — PostToolUse hook: append trace line to $OUTPUT_DIR/trace.jsonl.
// Reads PostToolUse stdin: { tool_name, tool_input, tool_response }
// Env vars consumed: OUTPUT_DIR, ADVISOR_WORKER_HOOKS

const fs = require('fs');

async function main() {
  if (process.env.ADVISOR_WORKER_HOOKS === '0') return;
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir) return;

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { return; }

  const toolName = event.tool_name || 'unknown';
  const input = event.tool_input || {};
  const response = event.tool_response || {};

  // args_summary: first 120 chars of the most informative input field
  let argsSummary = '';
  if (typeof input.command === 'string') argsSummary = input.command;
  else if (typeof input.file_path === 'string') argsSummary = input.file_path;
  else if (typeof input.prompt === 'string') argsSummary = input.prompt;
  else argsSummary = JSON.stringify(input);
  argsSummary = argsSummary.slice(0, 120);

  // result_summary: first 80 chars of output
  let resultSummary = '';
  if (typeof response.output === 'string') resultSummary = response.output.slice(0, 80).replace(/\n/g, ' ');
  else if (response.error) resultSummary = 'error: ' + String(response.error).slice(0, 72);
  else resultSummary = JSON.stringify(response).slice(0, 80);

  const line = JSON.stringify({
    tool: toolName,
    args_summary: argsSummary,
    result_summary: resultSummary,
    ts: Math.floor(Date.now() / 1000)
  });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.appendFileSync(`${outputDir}/trace.jsonl`, line + '\n');
}

main().catch(() => {});
