// Copies app/ to dist/ and stamps the git sha into the page (R6). Refuses a dirty tree,
// so the sha the page names is the code it runs.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const dirty = execSync('git status --porcelain -- app').toString().trim();
if (dirty && !process.argv.includes('--allow-dirty')) {
  console.error(`app/ has uncommitted changes; commit first so the build sha is honest:\n${dirty}`);
  process.exit(1);
}
// The build is the last commit that changed app/, so tooling commits do not rename it.
const sha = execSync('git log -1 --format=%H -- app').toString().trim();
rmSync('dist', { recursive: true, force: true });
cpSync('app', 'dist', { recursive: true });
const html = readFileSync('dist/index.html', 'utf8').replaceAll('__BUILD_SHA__', sha);
writeFileSync('dist/index.html', html);
// Recordings (git-ignored) ride along under /video/ so the board's host also serves them.
if (existsSync('recordings')) {
  mkdirSync('dist/video', { recursive: true });
  for (const f of readdirSync('recordings').filter((n) => n.endsWith('.mp4'))) cpSync(`recordings/${f}`, `dist/video/${f}`);
}
console.log(sha);
