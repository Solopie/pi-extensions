// Run with Node >= 22: node --test goal.test.mjs (no live model calls).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let source = readFileSync(new URL('./goal.ts', import.meta.url), 'utf8');
source = source.replace(/import[\s\S]*?from "[^"]+";/g, '');
source = `const {createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, truncateTail, Box, Text, Type} = globalThis.goalTestSDK;\n` + stripTypeScriptTypes(source);

const calls = [];
let responses = [];
globalThis.goalTestSDK = {
  DefaultResourceLoader: class { async reload() {} },
  getAgentDir: () => '/tmp',
  ModelRuntime: {create: async () => ({getModel: () => ({})})},
  SessionManager: {inMemory: () => ({})},
  truncateTail: content => ({content, truncated: false}),
  Type: {Object: () => ({})}, Box: class {}, Text: class {},
  createAgentSession: async options => {
    calls.push(options);
    let listener;
    return {session: {
      subscribe: fn => {listener = fn; return () => {};},
      prompt: async prompt => {
        calls.at(-1).prompt = prompt;
        const reply = responses.shift();
        if (reply instanceof Error) throw reply;
        listener({type: 'message_end', message: {role: 'assistant', content: [{type:'text', text: JSON.stringify(reply)}]}});
      }, abort() {}, dispose() {},
    }};
  },
};
const {default: extension} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function harness() {
  const entries = [], messages = [], events = {}, statuses = [];
  let command;
  const pi = {
    on: (name, fn) => events[name] = fn,
    registerCommand: (_, spec) => command = spec.handler,
    registerTool() {}, registerEntryRenderer() {},
    appendEntry: (customType, data) => entries.push({type:'custom', customType, data}),
    sendUserMessage() {}, sendMessage: msg => messages.push(msg),
  };
  const ctx = {
    cwd:'/tmp', model:{provider:'test', id:'test'},
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: {getBranch: () => entries, buildContextEntries: () => [{type:'message', message:{role:'assistant', content:'Implemented part A'}}]},
    ui: {setStatus: (_, text) => statuses.push(text), setWidget() {}, notify() {}, confirm: async () => true},
  };
  extension(pi);
  return {ctx, events, messages, statuses, command: arg => command(arg, ctx), goal: () => entries.filter(e => e.customType === 'goal-state').at(-1)?.data};
}

test('cheerleader continues with context-specific coaching; normal mode stays audited', async () => {
  for (const enabled of [true, false]) {
    calls.length = 0;
    responses = [{met:false, evidence:'Test B fails', next:'Fix B'}, {met:false, next:'Could you check the missing B edge case?'}];
    const h = harness();
    await h.command(enabled ? '--cheerleader Fix A and B' : 'Fix A and B');
    await h.events.agent_settled({}, h.ctx);
    assert.equal(h.goal().status, 'active');
    assert.equal(h.goal().turns, 1);
    assert.equal(calls.length, enabled ? 2 : 1);
    if (enabled) {
      assert.deepEqual(calls[1].tools, []);
      assert.match(calls[1].prompt, /Implemented part A/);
      assert.match(calls[1].prompt, /Test B fails/);
      assert.match(h.messages[0].content, /missing B edge case/);
    } else assert.match(h.messages[0].content, /NOT yet met/);
    await h.events.session_shutdown({}, h.ctx);
  }
});

test('verified completion does not invoke coach; mode toggle persists through resume', async () => {
  calls.length = 0;
  responses = [{met:true, evidence:'Tests pass', next:''}];
  const h = harness();
  await h.command('Fix tests');
  await h.command('cheerleader on');
  await h.command('pause');
  await h.command('resume');
  assert.equal(h.goal().cheerleader, true);
  await h.events.agent_settled({}, h.ctx);
  assert.equal(h.goal().status, 'achieved');
  assert.equal(calls.length, 1);
  assert.equal(h.messages.length, 0);
  await h.events.session_shutdown({}, h.ctx);
});

test('coach failure falls back to encouragement without stopping the goal', async () => {
  responses = [{met:false, evidence:'Missing test', next:'Add test'}, new Error('offline')];
  const h = harness();
  await h.command('--cheerleader Fix tests');
  await h.events.agent_settled({}, h.ctx);
  assert.equal(h.goal().status, 'active');
  assert.match(h.messages[0].content, /one concrete next step/);
  await h.events.session_shutdown({}, h.ctx);
});


test('statusline shows mode and immediately updates toggles, including paused goals', async () => {
  const h = harness();
  await h.command('Fix tests');
  assert.match(h.statuses.at(-1), /cheerleader off/);
  await h.command('cheerleader on');
  assert.match(h.statuses.at(-1), /cheerleader on/);
  await h.command('pause');
  assert.match(h.statuses.at(-1), /paused.*cheerleader on/);
  await h.command('cheerleader off');
  assert.match(h.statuses.at(-1), /paused.*cheerleader off/);
  await h.command('resume');
  assert.match(h.statuses.at(-1), /active.*cheerleader off/);
  await h.events.session_shutdown({}, h.ctx);
});
