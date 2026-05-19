function rewriteTestCommand(cmd, fromPath, toPath) {
  if (!cmd || !fromPath) return cmd;
  return cmd.split(fromPath).join(toPath);
}

module.exports = { rewriteTestCommand };
