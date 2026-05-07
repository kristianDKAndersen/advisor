import { spawnSync } from 'child_process';

const PATTERN = /\$\(([^)]+)\)/g;

export function expandSkillContent(content) {
  return content.replace(PATTERN, (_, cmd) => {
    const r = spawnSync('bash', ['-c', cmd], { timeout: 10000, encoding: 'utf8' });
    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' || r.status === null) {
      return '[expansion timed out]';
    }
    const out = r.stdout.replace(/\n$/, '');
    return out.slice(0, 4000);
  });
}
