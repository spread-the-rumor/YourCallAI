// Ship: commit local changes → bump version → tag → push. The pushed tag triggers
// .github/workflows/release.yml, which builds win/mac releases AND deploys the API to Vercel.
// Usage: npm run ship            (patch bump, message "ship")
//        npm run ship -- "msg" minor
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const message = args[0] || 'ship';
const bump = args[1] || 'patch'; // patch | minor | major

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// 1. Commit working changes (skip if nothing staged/changed).
run('git add -A');
if (out('git status --porcelain')) {
  execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: 'inherit' });
} else {
  console.log('No changes to commit — shipping current HEAD.');
}

// 2. Bump version — this commits package.json and creates the vX.Y.Z tag.
run(`npm version ${bump} -m "release v%s"`);

// 3. Push commits + the new tag → fires the release workflow.
run('git push --follow-tags');

console.log(`\n✓ Shipped. Watch: https://github.com/spread-the-rumor/YourCallAI/actions`);
