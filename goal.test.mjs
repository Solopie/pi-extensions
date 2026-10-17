// Run with Node >= 22: node --test goal.test.mjs (no live model calls).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';

let source = readFileSync(new URL('./goal.ts', import.meta.url), 'utf8');
source = source.replace(/import[\s\S]*?from "[^"]+";/g, '');
source = `const {createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, truncateTail, Box, matchesKey, Text, Type} = globalThis.goalTestSDK;\n` + stripTypeScriptTypes(source);

const calls = [];
let responses = [];
let reloadHook;
globalThis.goalTestSDK = {
  DefaultResourceLoader: class { async reload() { await reloadHook?.(); } },
  getAgentDir: () => '/tmp',
  ModelRuntime: {create: async () => ({getModel: () => ({})})},
  SessionManager: {inMemory: () => ({})},
  truncateTail: content => ({content, truncated: false}),
  matchesKey: (data, key) => key === 'escape' && data === '\x1b',
  Type: {Object: () => ({})}, Box: class {}, Text: class {},
  createAgentSession: async options => {
    calls.push(options);
    let listener;
    return {session: {
      subscribe: fn => {listener = fn; return () => {};},
      prompt: async prompt => {
        calls.at(-1).prompt = prompt;
        const queuedReply = responses.shift();
        const reply = typeof queuedReply === 'function' ? await queuedReply() : queuedReply;
        if (reply instanceof Error) throw reply;
        listener({type: 'message_end', message: {role: 'assistant', content: [{type:'text', text: JSON.stringify(reply)}]}});
      }, abort() { options.aborts = (options.aborts ?? 0) + 1; }, dispose() { options.disposed = true; },
    }};
  },
};
const {default: extension} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function harness() {
  const entries = [], messages = [], events = {}, statuses = [], inputs = [];
  const bus = new EventEmitter();
  let command, terminalInput;
  const pi = {
    events: bus,
    on: (name, fn) => events[name] = fn,
    registerCommand: (_, spec) => command = spec.handler,
    registerTool() {}, registerEntryRenderer() {},
    appendEntry: (customType, data) => entries.push({type:'custom', customType, data}),
    sendUserMessage: (...args) => inputs.push(args), sendMessage: msg => messages.push(msg),
  };
  const ctx = {
    hasUI: true, cwd:'/tmp', model:{provider:'test', id:'test'},
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: {getBranch: () => entries, buildContextEntries: () => [{type:'message', message:{role:'assistant', content:'Implemented part A'}}]},
    ui: {onTerminalInput: fn => { terminalInput = fn; return () => {terminalInput = undefined;}; }, setStatus: (_, text) => statuses.push(text), setWidget() {}, notify() {}, confirm: async () => true},
  };
  extension(pi);
  return {ctx, events, messages, statuses, inputs, eventsBus:bus,
    key: data => terminalInput?.(data),
    remoteState: () => { let result; bus.emit('pi-goal:remote:v1', {version:1,action:'status',context:ctx,respond: value => {result=value.state;}}); return result; },
    remote: request => new Promise(resolve => bus.emit('pi-goal:remote:v1', {version:1,context:ctx,...request,respond:resolve})),
    command: arg => command(arg, ctx), goal: () => entries.filter(e => e.customType === 'goal-state').at(-1)?.data};
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

test('recovered low-level provider error does not pause the goal', async () => {
  calls.length = 0;
  responses = [{met:false, evidence:'More work remains', next:'Continue'}];
  const h = harness();
  await h.command('Fix tests');
  await h.events.agent_end({messages:[{role:'assistant', stopReason:'error', errorMessage:'WebSocket closed 1012'}]}, h.ctx);
  await h.events.agent_end({messages:[{role:'assistant', stopReason:'stop'}]}, h.ctx);
  await h.events.agent_before_settle({outcome:'completed'}, h.ctx);
  await h.events.agent_settled({}, h.ctx);
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().turns, 1);
  assert.equal(calls.length, 1);
  await h.events.session_shutdown({}, h.ctx);
});

test('final provider error still pauses the goal without auditing', async () => {
  calls.length = 0;
  const h = harness();
  await h.command('Fix tests');
  await h.events.agent_end({messages:[{role:'assistant', stopReason:'error', errorMessage:'offline'}]}, h.ctx);
  await h.events.agent_before_settle({outcome:'error'}, h.ctx);
  await h.events.agent_settled({}, h.ctx);
  assert.equal(h.goal().status, 'paused');
  assert.equal(calls.length, 0);
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

test('Esc during tool execution pauses without auditing and resume still works', async () => {
  calls.length = 0;
  responses = [{met:true, evidence:'Tests pass', next:''}];
  const h = harness();
  try {
    await h.command('Fix tests');
    // The model already requested a tool; Esc does not produce an aborted
    // assistant message. Pi reports the cancellation when the run settles.
    await h.events.agent_end({messages:[{role:'assistant', stopReason:'toolUse'}]}, h.ctx);
    await h.events.agent_settled({aborted:true}, h.ctx);
    assert.equal(h.goal().status, 'paused');
    assert.equal(h.goal().turns, 0);
    assert.match(h.statuses.at(-1), /paused/);
    assert.equal(calls.length, 0);
    assert.equal(h.messages.length, 0);

    await h.command('resume');
    await h.events.agent_end({messages:[{role:'assistant', stopReason:'stop'}]}, h.ctx);
    await h.events.agent_settled({aborted:false}, h.ctx);
    assert.equal(h.goal().status, 'achieved');
    assert.equal(calls.length, 1);
  } finally {
    await h.events.session_shutdown({}, h.ctx);
  }
});

test('older runtimes still pause on an aborted assistant message', async () => {
  calls.length = 0;
  const h = harness();
  try {
    await h.command('Fix tests');
    await h.events.agent_end({messages:[{role:'assistant', stopReason:'aborted'}]}, h.ctx);
    await h.events.agent_settled({}, h.ctx);
    assert.equal(h.goal().status, 'paused');
    assert.equal(calls.length, 0);
  } finally {
    await h.events.session_shutdown({}, h.ctx);
  }
});

test('Esc discards a queued goal instead of starting it', async () => {
  calls.length = 0;
  const h = harness();
  try {
    h.ctx.isIdle = () => false;
    await h.command('Fix tests');
    assert.equal(h.goal(), undefined);
    h.ctx.isIdle = () => true;
    await h.events.agent_settled({aborted:true}, h.ctx);
    await h.events.agent_settled({aborted:false}, h.ctx);
    assert.equal(h.goal(), undefined);
    assert.equal(calls.length, 0);
    assert.equal(h.messages.length, 0);
  } finally {
    await h.events.session_shutdown({}, h.ctx);
  }
});

test('a successful final outcome overrides an intermediate aborted attempt', async () => {
  for (const settled of [{}, {aborted:false}]) {
    calls.length = 0;
    responses = [{met:true, evidence:'Tests pass', next:''}];
    const h = harness();
    try {
      await h.command('Fix tests');
      await h.events.agent_end({messages:[{role:'assistant', stopReason:'aborted'}]}, h.ctx);
      if (settled.aborted === undefined) {
        await h.events.agent_before_settle({outcome:'completed'}, h.ctx);
      }
      await h.events.agent_settled(settled, h.ctx);
      assert.equal(h.goal().status, 'achieved');
      assert.equal(calls.length, 1);
    } finally {
      await h.events.session_shutdown({}, h.ctx);
    }
  }
});


test('remote bridge reuses goal lifecycle; paused edits do not resume work and stale actions are rejected', async () => {
  const h = harness();
  let state = h.remoteState(); assert.equal(state.status, 'none');
  let reply = await h.remote({action:'start',objective:'Fix the tests',revision:state.revision});
  assert.equal(reply.ok,true); assert.equal(h.goal().objective,'Fix the tests'); assert.equal(h.inputs.length,1);
  const stale = reply.state.revision;
  await h.command('pause');
  reply = await h.remote({action:'clear',revision:stale}); assert.equal(reply.ok,false); assert.match(reply.error,/changed on the host/);
  state = h.remoteState();
  reply = await h.remote({action:'edit',objective:'Fix tests and docs',revision:state.revision});
  assert.equal(reply.ok,true); assert.equal(h.goal().status,'paused'); assert.equal(h.goal().objective,'Fix tests and docs'); assert.equal(h.inputs.length,1);
  reply = await h.remote({action:'resume',revision:reply.state.revision}); assert.equal(reply.ok,true); assert.equal(h.inputs.length,2);
  const startedAt = h.goal().startedAt;
  h.ctx.ui.confirm = () => {throw Error('Remote must never prompt the terminal');};
  reply = await h.remote({action:'edit',objective:'The final goal',revision:reply.state.revision});
  assert.equal(reply.ok,true); assert.ok(h.goal().startedAt>startedAt); assert.equal(h.inputs.length,3);
  reply = await h.remote({action:'pause',revision:reply.state.revision}); assert.equal(reply.ok,true);
  reply = await h.remote({action:'clear',revision:reply.state.revision}); assert.equal(reply.ok,true); assert.equal(h.goal().status,'cleared');
  await h.events.session_shutdown({},h.ctx);
});

test('remote starts and edits literal objectives, not slash-command argument strings', async () => {
  for (const objective of ['clear','pause','--cheerleader delete nothing']) {
    const h = harness();
    const reply = await h.remote({action:'start',objective,revision:h.remoteState().revision});
    assert.equal(reply.ok,true); assert.equal(h.goal().objective,objective); assert.equal(h.goal().cheerleader,false);
    await h.events.session_shutdown({},h.ctx);
  }
});

test('remote queued goals can be edited and cleared without starting or stopping the running agent', async () => {
  const h=harness();h.ctx.isIdle=()=>false;
  let reply=await h.remote({action:'start',objective:'Do this later',revision:h.remoteState().revision});
  assert.equal(reply.ok,true);assert.equal(reply.state.status,'queued');assert.equal(h.inputs.length,0);
  reply=await h.remote({action:'edit',objective:'Do that later',revision:reply.state.revision});
  assert.equal(reply.ok,true);assert.equal(reply.state.objective,'Do that later');
  reply=await h.remote({action:'clear',revision:reply.state.revision});assert.equal(reply.ok,true);assert.equal(h.inputs.length,0);
  h.ctx.isIdle=()=>true;await h.events.agent_settled({},h.ctx);assert.equal(h.inputs.length,0);
  await h.events.session_shutdown({},h.ctx);
});


test('editing an active goal invalidates the old in-flight audit verdict without stopping the parent', async () => {
  let entered, release;
  const started = new Promise(resolve => {entered=resolve;});
  const gate = new Promise(resolve => {release=resolve;});
  responses=[async()=>{entered();await gate;return {met:true,evidence:'Old objective passed',next:''};}];
  const h=harness();let parentAborts=0;h.ctx.abort=()=>parentAborts++;
  await h.command('Old objective');
  const audit=h.events.agent_settled({},h.ctx);await started;
  const reply=await h.remote({action:'edit',objective:'New objective',revision:h.remoteState().revision});
  assert.equal(reply.ok,true);release();await audit;
  assert.equal(h.goal().objective,'New objective');assert.equal(h.goal().status,'active');assert.equal(h.goal().turns,0);
  assert.equal(h.goal().lastEvidence,undefined);assert.equal(parentAborts,0);
  await h.events.session_shutdown({},h.ctx);
});


test('explicit Remote-owned follow-ups outrank autonomous goal audits, without changing normal goals', async () => {
  calls.length=0;responses=[{met:true,evidence:'All tests pass',next:''}];
  const h=harness();await h.command('Finish the task');
  const pending=request=>request.respond({version:1,pending:true});h.eventsBus.on('pi-remote:queue-pending:v1',pending);
  await h.events.agent_settled({},h.ctx);assert.equal(calls.length,0);assert.equal(h.goal().status,'active');
  h.eventsBus.off('pi-remote:queue-pending:v1',pending);await h.events.agent_settled({},h.ctx);
  assert.equal(calls.length,1);assert.equal(h.goal().status,'achieved');await h.events.session_shutdown({},h.ctx);
});


test('Remote follow-ups arriving during an audit suppress coaching and autonomous continuation', async () => {
  let waiting=false;calls.length=0;responses=[async()=>{waiting=true;return{met:false,evidence:'More user work arrived',next:'Continue'};}];
  const h=harness();h.eventsBus.on('pi-remote:queue-pending:v1',request=>request.respond({version:1,pending:waiting}));
  await h.command('--cheerleader Finish the task');await h.events.agent_settled({},h.ctx);
  assert.equal(calls.length,1);assert.equal(h.messages.length,0);assert.equal(h.goal().status,'active');assert.equal(h.goal().turns,1);
  waiting=false;responses=[{met:true,evidence:'Done',next:''}];await h.events.agent_settled({},h.ctx);assert.equal(h.goal().status,'achieved');
  await h.events.session_shutdown({},h.ctx);
});


test('Escape cancels audits and coaching, suppresses verdicts/retries, and permits resume', async () => {
  for (const coaching of [false, true]) {
    calls.length = 0;
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const blocked = async () => { entered(); await gate; return {notAVerdict: true}; };
    responses = coaching ? [{met:false, evidence:'Missing test', next:'Add test'}, blocked] : [blocked];
    const h = harness();
    try {
      await h.command(coaching ? '--cheerleader Fix tests' : 'Fix tests');
      const audit = h.events.agent_settled({}, h.ctx);
      await started;
      assert.equal(h.key('x'), undefined);
      assert.match(h.statuses.at(-1), /Esc to cancel/);
      assert.deepEqual(h.key('\x1b'), {consume:true});
      assert.equal(h.goal().status, 'paused');
      assert.equal(calls.at(-1).aborts, 1);
      release();
      await audit;
      assert.equal(calls.at(-1).disposed, true);
      assert.equal(h.goal().turns, 0);
      assert.equal(h.messages.length, 0);
      assert.equal(h.key('\x1b'), undefined);
      responses = [{met:true, evidence:'Tests pass', next:''}];
      await h.command('resume');
      await h.events.agent_settled({}, h.ctx);
      assert.equal(h.goal().status, 'achieved');
    } finally { release(); await h.events.session_shutdown({}, h.ctx); }
  }
});

test('pause and clear during auditor setup prevent it from starting a model request', async () => {
  for (const action of ['pause', 'clear']) {
    calls.length = 0;
    let entered, release;
    const started = new Promise(resolve => {entered=resolve;});
    const gate = new Promise(resolve => {release=resolve;});
    reloadHook = async () => {entered(); await gate;};
    const h = harness();
    try {
      await h.command('Fix tests');
      const audit = h.events.agent_settled({}, h.ctx);
      await started;
      await h.command(action);
      release();
      await audit;
      assert.equal(calls.length, 0);
      assert.equal(h.goal().status, action === 'pause' ? 'paused' : 'cleared');
      assert.equal(h.messages.length, 0);
    } finally { reloadHook = undefined; release(); await h.events.session_shutdown({}, h.ctx); }
  }
});
