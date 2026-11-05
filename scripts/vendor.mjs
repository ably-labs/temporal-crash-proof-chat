// Builds the unreleased Ably libraries the demo needs, and packs each into vendor/ under a fixed name, which
// package.json depends on. Run `npm install` afterwards.
//
// - The SDK: `main` (which has the Temporal plugin, ably-pubsub-js#2325) merged with the realtime channel pool
//   branch (ably-pubsub-js#2340). Gives @ably/pubsub-core, @ably/pubsub-device and @ably/pubsub-server.
// - AI Transport: `main`, which has `vercelAdaptor` and `vercelDecoder` (ably-ai-transport-js#366) but is not yet
//   released. Gives @ably/ai-transport.
//
// The sources are cloned into .vendor-src/, so no other checkout is touched. Each ref is pinned to the commit the demo
// was checked against, and each repo and ref can be overridden (a ref can be a branch name or a commit):
//
//   SDK_REPO  (default https://github.com/ably/ably-pubsub-js.git)
//   SDK_REF   (default 30af1ed, main with #2325 merged)
//   POOL_REF  (default afcb69e, the head of #2340's realtime-channel-pool branch)
//   AIT_REPO  (default https://github.com/ably/ably-ai-transport-js.git)
//   AIT_REF   (default 3714547, main with #366 merged)
//
// Usage: npm run vendor                (fetches, merges and builds)
//        npm run vendor -- --no-build  (packs the existing builds)

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(projectDir, '.vendor-src');
const vendorDir = join(projectDir, 'vendor');

const sdk = {
  repo: process.env.SDK_REPO ?? 'https://github.com/ably/ably-pubsub-js.git',
  ref: process.env.SDK_REF ?? '30af1ed4265092cff5c2b48f8b2ed532e9c396ed',
  poolRef: process.env.POOL_REF ?? 'afcb69ed5076963db955e291f82ada77bd6d07bc',
  dir: join(sourcesDir, 'sdk'),
};
const ait = {
  repo: process.env.AIT_REPO ?? 'https://github.com/ably/ably-ai-transport-js.git',
  ref: process.env.AIT_REF ?? '371454707517ddc57fe28f8f18a9f47d692d76eb',
  dir: join(sourcesDir, 'ait'),
};

function run(command, args, cwd, env = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

// The merge commit needs an author, which a fresh clone may not have.
const git = (args, cwd) => run('git', ['-c', 'user.name=vendor', '-c', 'user.email=vendor@localhost', ...args], cwd);

/** A branch name as the remote's branch, or a commit as it is. */
function resolve(ref, dir) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `origin/${ref}`], { cwd: dir, stdio: 'ignore' });
    return `origin/${ref}`;
  } catch {
    return ref;
  }
}

/** Clones the repo once, then fetches, and leaves the ref checked out as a detached HEAD. */
function checkout({ repo, ref, dir }) {
  if (!existsSync(dir)) {
    git(['clone', '--filter=blob:none', '--no-checkout', repo, dir], projectDir);
  }
  git(['fetch', '--prune', 'origin'], dir);
  git(['checkout', '--force', '--detach', resolve(ref, dir)], dir);
  git(['clean', '-fdx', '-e', 'node_modules'], dir);
}

/**
 * The SDK's build uses a fork of esbuild-plugin-umd-wrapper, installed from git, which only builds in its `prepare`
 * script. With install scripts ignored it arrives unbuilt, so build that one package here, from the commit the SDK's
 * lockfile pins, and copy its output into the SDK's node_modules.
 */
function buildUmdWrapper() {
  const lock = JSON.parse(readFileSync(join(sdk.dir, 'package-lock.json'), 'utf8'));
  const { resolved } = lock.packages['node_modules/esbuild-plugin-umd-wrapper'];
  const [, path, commit] = /github\.com[/:](.+?)(?:\.git)?#([0-9a-f]+)$/.exec(resolved);
  const dir = join(sourcesDir, 'esbuild-plugin-umd-wrapper');
  if (!existsSync(dir)) {
    git(['clone', `https://github.com/${path}.git`, dir], projectDir);
  }
  git(['fetch', 'origin'], dir);
  git(['checkout', '--force', '--detach', commit], dir);
  run('npm', [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-save'], dir);
  // build.js runs `tsc` once esbuild has finished.
  run('node', ['build.js'], dir, { PATH: `${join(dir, 'node_modules', '.bin')}:${process.env.PATH}` });
  cpSync(join(dir, 'dist'), join(sdk.dir, 'node_modules', 'esbuild-plugin-umd-wrapper', 'dist'), { recursive: true });
}

/** Packs a package directory into vendor/<name>.tgz. */
function pack(packageDir, name) {
  console.log(`$ npm pack ${packageDir}`);
  const output = execFileSync('npm', ['pack', packageDir, '--ignore-scripts', '--json', '--pack-destination', vendorDir], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(output);
  renameSync(join(vendorDir, filename), join(vendorDir, name));
}

if (!process.argv.includes('--no-build')) {
  mkdirSync(sourcesDir, { recursive: true });

  checkout(sdk);
  // The two SDK branches only conflict in packages/server/README.md, so keep `main`'s side of any conflict.
  git(['merge', '--no-edit', '-X', 'ours', resolve(sdk.poolRef, sdk.dir)], sdk.dir);
  // The lockfile pins every version, so a minimum release age set in ~/.npmrc has nothing to choose, and npm refuses
  // to prepare the lockfile's git dependencies with one set. This install reads a user config of its own instead,
  // which still ignores install scripts.
  const npmrc = join(sourcesDir, 'npmrc');
  writeFileSync(npmrc, 'ignore-scripts=true\n');
  run('npm', ['ci'], sdk.dir, { npm_config_userconfig: npmrc });
  buildUmdWrapper();
  run('npm', ['run', 'build:packages'], sdk.dir);

  checkout(ait);
  run('pnpm', ['install', '--frozen-lockfile'], ait.dir);
  run('pnpm', ['run', 'build'], ait.dir);
}

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir);
for (const pkg of ['core', 'device', 'server']) {
  pack(join(sdk.dir, 'packages', pkg), `ably-pubsub-${pkg}.tgz`);
}
pack(ait.dir, 'ably-ai-transport.tgz');

console.log(`Packed into ${vendorDir}. Now run: npm install`);
