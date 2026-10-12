const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const piRoot = path.resolve(path.dirname(execFileSync('readlink', ['-f', execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()], { encoding: 'utf8' }).trim()), '../lib/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(piRoot, 'node_modules/jiti'));
const jiti = createJiti(__filename, { alias: {
  '@earendil-works/pi-coding-agent': piRoot,
  '@earendil-works/pi-tui': path.join(piRoot, 'node_modules/@earendil-works/pi-tui'),
} });

const { default: btw, launchSideChat, describeMessage, quote } = jiti('./btw.ts');
const fs = require('node:fs/promises');

test('excludes private reasoning', () => {
 const text = describeMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'Visible' }] });
 assert.ok(!text.includes('SECRET')); assert.ok(text.includes('Visible'));
});
test('shell quoting preserves apostrophes and command-like text', () => {
 const value = "why's this? $(touch /tmp/not-executed)";
 assert.equal(execFileSync('sh', ['-c', 'printf %s ' + quote(value)], { encoding: 'utf8' }), value);
});
test('launches native regular-mode Pi with isolated snapshot and return trap', async () => {
 const calls = []; let dir;
 const run = async (command, args) => {
  assert.equal(command, 'tmux'); calls.push(args);
  if (args[0] === 'display-message') return { stdout: '@7\n' };
  if (args[0] === 'new-window') {
   const match = args.at(-1).match(/sh '(.*)\/run.sh'/); assert.ok(match);
   dir = match[1];
   const script = await fs.readFile(path.join(dir, 'run.sh'), 'utf8');
   execFileSync('sh', ['-n', path.join(dir, 'run.sh')]);
   assert.ok(script.includes("'--tui-mode' 'regular'"));
   assert.ok(script.includes("'--no-session'"));
   assert.ok(script.includes("'--no-tools'"));
   assert.ok(script.includes("'--no-mcp'"));
   assert.ok(script.includes("select-window -t"));
   assert.ok(script.includes('@7'));
   assert.ok(script.includes(quote("Why's this?")));
   assert.ok((await fs.readFile(path.join(dir, 'system.md'), 'utf8')).includes('Checking tests'));
   const child = jiti(path.join(dir, 'close.ts')).default;
   const events = {}, commands = {}, statuses = [];
   child({ on: (name, handler) => { events[name] = handler; }, registerCommand: (name, spec) => { commands[name] = spec; } });
   let shutdown = false;
   const ctx = { ui: { setStatus: (...args) => statuses.push(args) }, shutdown: () => { shutdown = true; } };
   events.session_start({}, ctx);
   assert.match(statuses[0][1], /BTW session.*\/close.*\/exit.*original chat/);
   await commands.close.handler('', ctx); assert.ok(shutdown);
   events.session_shutdown({}, ctx);
   assert.deepEqual(statuses.at(-1), ['btw', undefined]);
   assert.equal((await fs.stat(path.join(dir, 'system.md'))).mode & 0o777, 0o600);
   return { stdout: '@8\n' };
  }
  return { stdout: '' };
 };
 try {
  const id = await launchSideChat({ cwd: '/tmp', model: { provider: 'test', id: 'model' },
   snapshot: 'Checking tests', question: "Why's this?", pane: '%1' }, run);
  assert.equal(id, '@8');
  assert.deepEqual(calls.at(-1), ['select-window', '-t', '@8']);
  assert.ok(calls.some(args => args.join(' ').includes('remain-on-exit off')));
 } finally { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
});
test('failed launch removes temporary snapshot', async () => {
 let dir;
 const run = async (_command, args) => {
  if (args[0] === 'display-message') return { stdout: '@7\n' };
  dir = args.at(-1).match(/sh '(.*)\/run.sh'/)[1];
  throw new Error('launch failed');
 };
 await assert.rejects(launchSideChat({ cwd: '/tmp', model: { provider: 'test', id: 'model' }, snapshot: 'private', question: '' }, run), /launch failed/);
 await assert.rejects(fs.stat(dir), /ENOENT/);
});
test('parent status shows creation and open state, then clears when window closes', async () => {
 const oldTmux = process.env.TMUX;
 process.env.TMUX = 'test';
 let dir, alive = true, displayCount = 0;
 const events = {}, statuses = [];
 let handler;
 const run = async (_command, args) => {
  if (args[0] === 'display-message') {
   displayCount++;
   if (args.includes('@8')) {
    if (!alive) throw new Error('no such window');
    return { stdout: '@8\n' };
   }
   return { stdout: '@7\n' };
  }
  if (args[0] === 'new-window') {
   dir = args.at(-1).match(/sh '(.*)\/run.sh'/)[1];
   return { stdout: '@8\n' };
  }
  return { stdout: '' };
 };
 btw({ on: (name, fn) => { events[name] = fn; }, registerCommand: (_name, spec) => { handler = spec.handler; } }, run);
 const ctx = { mode: 'tui', cwd: '/tmp', model: { provider: 'test', id: 'model' },
  isIdle: () => false, sessionManager: { getBranch: () => [] },
  ui: { setStatus: (...args) => statuses.push(args), notify: message => { throw new Error(message); } } };
 try {
  await handler('', ctx);
  assert.deepEqual(statuses[0], ['btw', 'Creating BTW session…']);
  assert.match(statuses.at(-1)[1], /BTW session open.*\/btw/);
  alive = false;
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.ok(displayCount >= 2);
  assert.deepEqual(statuses.at(-1), ['btw', undefined]);
 } finally {
  events.session_shutdown({}, ctx);
  if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
 }
});
