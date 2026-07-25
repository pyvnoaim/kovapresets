#!/usr/bin/env node
// Release driver.
//
// This exists because electron-builder's GitHub publisher races with itself: it
// starts one publisher per artifact, and each one tries to CREATE the release.
// Whichever loses gets `422 already_exists` and aborts the publish task - so the
// release goes live containing only whatever had uploaded by then, with a
// latest.yml still pointing at the PREVIOUS version. That silently shipped a
// broken auto-update on both v1.0.4 and v1.0.5.
//
// Creating the release up front removes the race: the publishers find it and
// only ever upload into it.
//
// Usage:
//   npm version patch                 # makes the "1.0.6" commit + v1.0.6 tag
//   npm run release                    # push, create release, build, upload
//   npm run release -- --dry-run       # run every check, change nothing
//
// Release notes are read from release-notes/<version>.md when present, else
// GitHub generates them from the commits.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
// for commands whose failure is a legitimate answer ("does this exist?")
const tryRun = (cmd, args) => {
  try {
    return { ok: true, out: run(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  } catch (err) {
    return { ok: false, out: String(err.stdout || '').trim() }
  }
}
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`)
const info = (msg) => console.log(`  ${msg}`)
const die = (msg) => {
  console.error(`\n\x1b[31mrelease aborted:\x1b[0m ${msg}\n`)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const tag = `v${version}`
console.log(`\nReleasing ${version} (tag ${tag})${dryRun ? '  [DRY RUN]' : ''}`)

// ---- preflight ---------------------------------------------------------------
step('Checking the working tree')
const dirty = run('git', ['status', '--porcelain']).trim()
if (dirty) die(`working tree is dirty - commit or stash first:\n${dirty}`)
info('clean')

step('Checking the tag')
if (!tryRun('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok)
  die(`tag ${tag} does not exist. Run "npm version patch" (or minor/major) first - it makes the version commit and the tag together.`)
const tagSha = tryRun('git', ['rev-list', '-n1', tag]).out
const headSha = tryRun('git', ['rev-parse', 'HEAD']).out
if (tagSha !== headSha)
  die(`tag ${tag} points at ${tagSha.slice(0, 8)} but HEAD is ${headSha.slice(0, 8)} - check out the tagged commit, or re-tag.`)
info(`${tag} -> ${tagSha.slice(0, 8)} (= HEAD)`)

step('Checking gh auth')
if (!tryRun('gh', ['--version']).ok) die('the GitHub CLI ("gh") is required - https://cli.github.com')
const token = tryRun('gh', ['auth', 'token'])
if (!token.ok || !token.out) die('gh is not authenticated - run "gh auth login"')
info('authenticated, token available for electron-builder')

step('Checking tests')
if (dryRun) info('skipped in a dry run')
else {
  run('npm', ['run', 'core:test'], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
  info('core:test passed')
}

// ---- push --------------------------------------------------------------------
step('Pushing the commit and tag')
if (dryRun) info('would run: git push origin HEAD --follow-tags')
else {
  run('git', ['push', 'origin', 'HEAD', '--follow-tags'], { stdio: 'inherit' })
  info('pushed')
}

// ---- create the release BEFORE building (this is the whole point) ------------
step('Ensuring the GitHub release exists')
const existing = tryRun('gh', ['release', 'view', tag, '--json', 'tagName'])
if (existing.ok) {
  info(`${tag} already exists - electron-builder will upload into it`)
} else {
  const notesFile = path.join(root, 'release-notes', `${version}.md`)
  const hasNotes = fs.existsSync(notesFile)
  const args = ['release', 'create', tag, '--title', version]
  if (hasNotes) args.push('--notes-file', notesFile)
  else args.push('--generate-notes')
  info(hasNotes ? `notes from release-notes/${version}.md` : 'notes auto-generated from commits')
  if (dryRun) info(`would run: gh ${args.join(' ')}`)
  else {
    run('gh', args, { stdio: 'inherit' })
    info(`created ${tag}`)
  }
}

// ---- build + upload ----------------------------------------------------------
step('Building and uploading')
if (dryRun) {
  info('would run: electron-builder --publish always (with GH_TOKEN from gh)')
  console.log('\n\x1b[32mdry run complete - every check passed\x1b[0m\n')
  process.exit(0)
}
run('npx', ['electron-builder', '--publish', 'always'], {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token.out },
  shell: process.platform === 'win32', // npx is a .cmd shim on Windows
})

// ---- verify what actually landed --------------------------------------------
// The failure mode this script exists to prevent is a release that looks fine
// but is missing assets, so don't just trust the exit code.
step('Verifying the published assets')
const assets = JSON.parse(tryRun('gh', ['release', 'view', tag, '--json', 'assets']).out || '{"assets":[]}')
const names = assets.assets.map((a) => a.name)
for (const n of names) info(n)
const missing = ['latest.yml', '.exe', '.exe.blockmap'].filter(
  (want) => !names.some((n) => (want.startsWith('.') ? n.endsWith(want) : n === want))
)
if (missing.length)
  die(`release ${tag} is missing ${missing.join(', ')} - auto-update will be broken. Re-run "npm run release" to finish the upload.`)
console.log(`\n\x1b[32m${version} released\x1b[0m  https://github.com/pyvnoaim/kovapresets/releases/tag/${tag}\n`)
