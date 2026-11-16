import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousComments, validateCommentText } from '../autonomous-comments.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

const videoState = (id = '12345') => ({ url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id, url: `https://www.douyin.com/video/${id}`, title: '合成公开视频观察', author: '合成作者', time: 3, duration: 60, paused: false, readyState: 4 } });
const receipt = videoId => ({ confirmed: true, deliveryUncertain: false, videoId, commentId: '90001', operationId: 'synthetic-comment' });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comments-')), stateDir = path.join(root, 'state'); let now = Date.parse('2026-10-15T04:00:00Z'); const clock = () => now;
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'no-role.md'), clock }); personaMemory.initialize();
  const videoLimits = new VideoLimits({ stateDir, now: clock }); videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 60 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  const calls = [], watchRunId = 'synthetic-watch';
  const lock = () => fs.writeFileSync(path.join(stateDir, 'watch-loop.lock'), JSON.stringify({ version: 1, pid: process.pid, runId: watchRunId, sessionId: videoLimits.state().session.id, source: 'api', status: 'running' })); lock();
  const { post: postOption, ...rest } = options;
  const post = postOption || (async (input, controls) => { calls.push({ input, controls }); controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId }); controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); const release = controls.authorize.beginDispatch(); release(); return receipt(input.expectedVideoId); });
  const service = new AutonomousComments({ personaMemory, videoLimits, post, stateDir, now: clock, ...rest });
  const evidence = (id = '12345', text = '这个配色挺有意思，画面很舒服。') => ({ evidenceId: personaMemory.recordObservation(videoState(id), { source: 'api' }).evidenceId, videoId: id, text });
  t.after(async () => { await service.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, clock, setNow: value => { now = value; }, service, personaMemory, videoLimits, evidence, calls, watchRunId, controls: { watchRunId }, lock };
}

test('评论默认关闭且模型不能改许可；次数只接受有限整数', async t => {
  const f = fixture(t); assert.equal(f.service.state().enabled, false); assert.deepEqual(f.service.state().policy, { enabled: false, dailyLimit: 3, perSessionLimit: 1 });
  assert.equal(f.service.context().enabled, false); assert.equal(f.service.context().maxTextLength, 200);
  assert.throws(() => f.service.configure({ enabled: true }), /用户/);
  for (const body of [{ enabled: 1 }, { enabled: true, dailyLimit: 0 }, { enabled: true, dailyLimit: 21 }, { enabled: true, perSessionLimit: 0 }, { enabled: true, perSessionLimit: 4 }, { enabled: true, url: 'https://example.com' }]) assert.throws(() => f.service.configure(body, { explicit: true }));
  await assert.rejects(f.service.comment(f.evidence(), f.controls), /尚未启用/); assert.equal(f.calls.length, 0);
  f.service.configure({ enabled: true }, { explicit: true }); assert.deepEqual(f.service.context(), { enabled: true, remainingDaily: 3, remainingSession: 1, paused: false, maxTextLength: 200 });
});
test('公开评论只接受短纯文字，拒绝@、URL、号码、Key、私聊信息和现实承诺', () => {
  assert.equal(validateCommentText('  光影看着很舒服。  '), '光影看着很舒服。'); assert.equal(validateCommentText('鱼'.repeat(200)).length, 200);
  for (const text of ['', '鱼'.repeat(201), '第一行\n第二行', '隐\u200b藏', '@朋友', '＠朋友', 'https://example.com/a', '看example.com', '电话13800138000', 'sk-abcdefghijklmnopqrstuvwxyz', 'API Key是abc', 'QQ12345', '微信聊', '好友也喜欢', '我保证帮你', '我会联系你', '我亲自去过这里']) assert.throws(() => validateCommentText(text), undefined, text);
});
test('没有同源当前自主观看与有限轮次，或已请求停止时不能评论', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence();
  await assert.rejects(f.service.comment(input), /自主观看/); await assert.rejects(f.service.comment(input, { watchRunId: 'wrong' }), /自主观看/);
  const file = path.join(f.stateDir, 'watch-loop.lock'), saved = fs.readFileSync(file, 'utf8'); fs.unlinkSync(file); await assert.rejects(f.service.comment(input, f.controls), /自主观看/); fs.writeFileSync(file, saved);
  fs.writeFileSync(path.join(f.stateDir, 'watch-stop.request.json'), JSON.stringify({ runId: f.watchRunId })); await assert.rejects(f.service.comment(input, f.controls), /停止/); assert.equal(f.calls.length, 0);
});
test('未观察作品、不同来源和联系人内容不进入评论发布器', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence();
  await assert.rejects(f.service.comment({ ...input, evidenceId: `video:${'f'.repeat(64)}` }, f.controls), /观察/);
  await assert.rejects(f.service.comment({ ...input, videoId: '67890' }, f.controls), /观察/);
  await assert.rejects(f.service.comment({ ...input, url: 'https://www.douyin.com/video/12345' }, f.controls), /只接受/);
  fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ id: 'conv:private', name: '合成朋友甲' }] }));
  await assert.rejects(f.service.comment(f.evidence('12345', '合成朋友甲可能喜欢这个'), f.controls), /联系人信息/); assert.equal(f.calls.length, 0);
  const snapshot = f.personaMemory.snapshot.bind(f.personaMemory); f.personaMemory.snapshot = () => ({ recentObservations: snapshot().recentObservations.map(row => ({ ...row, sources: ['dsh'] })) }); await assert.rejects(f.service.comment(input, f.controls), /观察/);
});
test('确认回执精确绑定作品和commentId，预留扣每日与单轮次数', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence(), result = await f.service.comment(input, f.controls);
  assert.equal(result.confirmed, true); assert.equal(result.commentId, '90001'); assert.deepEqual(Object.keys(f.calls[0].input).sort(), ['expectedVideoId', 'text']); assert.equal(f.calls[0].controls.autonomousRunId, f.watchRunId);
  assert.equal(f.service.state().daily.attempts, 1); assert.equal(f.service.state().session.remaining, 0); assert.equal(f.service.context().enabled, false); assert.equal(f.service.ledger().operations[0].status, 'confirmed');
  await assert.rejects(f.service.comment(f.evidence('67890'), f.controls), /次数/); assert.equal(fs.existsSync(f.service.files.send), false);
});
test('回复评论必须带稳定目标，并原样传给发布器', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true });
  const input = f.evidence();
  for (const replyToIndex of [0, 21, 1.5, '2']) await assert.rejects(f.service.comment({ ...input, replyToIndex, replyToCommentId: '90002', replyToText: '目标评论' }, f.controls), /只接受/);
  await assert.rejects(f.service.comment({ ...input, replyToIndex: 2 }, f.controls), /完整回复目标/);
  assert.equal(f.calls.length, 0);
  const result = await f.service.comment({ ...input, replyToIndex: 2, replyToCommentId: '90002', replyToText: '目标评论' }, f.controls);
  assert.equal(result.confirmed, true); assert.equal(f.calls[0].input.replyToIndex, 2); assert.equal(f.calls[0].input.replyToCommentId, '90002');
  assert.equal(f.service.ledger().operations[0].replyToCommentId, '90002');
});
test('停启同一轮不重置次数，新轮只重置单轮额度，跨日也不重复旧作品', async t => {
  const f = fixture(t); f.service.configure({ enabled: true, dailyLimit: 3, perSessionLimit: 1 }, { explicit: true }); const first = f.evidence(); await f.service.comment(first, f.controls);
  f.lock(); await assert.rejects(f.service.comment(f.evidence('67890'), f.controls), /次数/);
  f.videoLimits.endSession({explicit:true}); f.videoLimits.markSession('api', { explicit: true }); f.lock(); assert.equal(f.service.state().session.remaining, 1); await assert.rejects(f.service.comment(first, f.controls), /重复/);
  await f.service.comment(f.evidence('67890'), f.controls); assert.equal(f.service.state().daily.attempts, 2);
  f.setNow(Date.parse('2026-10-15T16:01:00Z')); f.videoLimits.endSession({explicit:true}); f.videoLimits.markSession('api', { explicit: true }); f.lock(); assert.equal(f.service.state().daily.remaining, 3); await assert.rejects(f.service.comment(first, f.controls), /重复/); assert.equal(f.calls.length, 2);
});
test('输入不可用和发布前失败释放额度，并允许同作品重新尝试', async t => {
  const f = fixture(t, { post: async () => ({ confirmed: false, deliveryUncertain: false, needsUserAction: true, reason: '合成未打开评论面板' }) }); f.service.configure({ enabled: true, perSessionLimit: 3 }, { explicit: true }); const input = f.evidence(), result = await f.service.comment(input, f.controls);
  assert.equal(result.needsUserAction, true); assert.equal(result.deliveryUncertain, false); assert.equal(f.service.ledger().operations[0].status, 'not-sent'); assert.equal(f.service.state().daily.attempts, 0);
  f.service.configure({ enabled: false }, { explicit: true }); f.service.configure({ enabled: true }, { explicit: true });
  const retry = await f.service.comment(input, f.controls); assert.equal(retry.confirmed, false); assert.equal(f.service.ledger().operations.length, 2);
});
test('确认缺commentId、错作品或没有可信发布授权时均不能当成功', async t => {
  for (const result of [{ ...receipt('12345'), commentId: '' }, receipt('67890'), receipt('12345')]) {
    const f = fixture(t, { post: async (input, controls) => { if (!result.commentId || result.videoId !== '12345') controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return result; } }); f.service.configure({ enabled: true }, { explicit: true }); const output = await f.service.comment(f.evidence(), f.controls); assert.equal(output.confirmed, false); assert.equal(output.deliveryUncertain, true); assert.equal(f.service.state().paused, false); assert.equal(f.service.state().pendingRecheck, 1);
  }
});
test('未确认跨重启暂停，人工核对只解除暂停，不退次数或重发旧作品', async t => {
  const f = fixture(t, { post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true }; } }); f.service.configure({ enabled: true, perSessionLimit: 3 }, { explicit: true }); const input = f.evidence(), result = await f.service.comment(input, f.controls);
  const restarted = new AutonomousComments({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock }); assert.equal(restarted.state().paused, false); assert.equal(restarted.state().pendingRecheck, 1);
  restarted.configure({ enabled: false }, { explicit: true }); assert.throws(() => restarted.configure({ enabled: true }, { explicit: true }), /核对/); await assert.rejects(restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }), /用户/);
  await restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }, { explicit: true }); restarted.configure({ enabled: true }, { explicit: true }); assert.equal(restarted.state().daily.attempts, 0); await restarted.close();
});
test('未确认进入延迟复核，复核期间不暂停且只阻止同作品', async t => {
  const verified = [];
  const f = fixture(t, {
    post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true, baselineKnownIds: ['89999'] }; },
    getCommenter: async () => ({ verifyPublished: async input => { verified.push(input); return { found: true, commentId: '90003' }; } }),
  });
  f.service.configure({ enabled: true, dailyLimit: 3, perSessionLimit: 3 }, { explicit: true });
  const input = f.evidence(), result = await f.service.comment(input, f.controls);
  assert.equal(result.deliveryUncertain, true); assert.equal(result.pendingRecheck, true);
  assert.equal(f.service.state().paused, false); assert.equal(f.service.state().pendingRecheck, 1);
  assert.equal(Date.parse(f.service.ledger().operations[0].recheckDueAt) - Date.parse(f.service.ledger().operations[0].completedAt), 45000);
  assert.deepEqual(f.service.state().pendingRecheckVideos, ['12345']); assert.equal(f.service.context().enabled, true);
  await assert.rejects(f.service.comment(input, f.controls), /重复/);
  f.setNow(Date.parse(f.service.state().nextRecheckAt) + 1);
  assert.deepEqual(await f.service.recheckDue(), { checked: 1, confirmed: 1, pending: 0, exhausted: 0 });
  assert.equal(verified[0].expectedVideoId, '12345'); assert.deepEqual(verified[0].knownIds, ['89999']);
  assert.equal(f.service.ledger().operations[0].status, 'confirmed'); assert.equal(f.service.state().pendingRecheck, 0); assert.equal(f.service.state().paused, false);
});
test('复核连续未命中三次后转为最终未确认并暂停', async t => {
  const f = fixture(t, {
    post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true }; },
    getCommenter: async () => ({ verifyPublished: async () => ({ found: false }) }),
  });
  f.service.configure({ enabled: true }, { explicit: true }); await f.service.comment(f.evidence(), f.controls);
  for (let attempt = 0; attempt < 3; attempt++) { f.setNow(Date.parse(f.service.state().nextRecheckAt || f.service.state().needsReview[0].recheckDueAt) + 1); await f.service.recheckDue(); }
  assert.equal(f.service.state().pendingRecheck, 0); assert.equal(f.service.state().paused, true);
  assert.equal(f.service.state().needsReview[0].pendingRecheck, false); assert.equal(f.service.state().needsReview[0].recheckAttempts, 3);
});
test('复核遇到页面不在目标作品时只顺延不消耗次数', async t => {
  const f = fixture(t, {
    post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true }; },
    getCommenter: async () => ({ verifyPublished: async () => ({ found: false, unavailable: true, reason: '页面不在目标作品' }) }),
  });
  f.service.configure({ enabled: true }, { explicit: true }); await f.service.comment(f.evidence(), f.controls);
  f.setNow(Date.parse(f.service.state().nextRecheckAt) + 1);
  assert.deepEqual(await f.service.recheckDue(), { checked: 1, confirmed: 0, pending: 1, exhausted: 0 });
  assert.equal(f.service.state().needsReview[0].recheckAttempts, 0); assert.equal(f.service.state().paused, false);
});
test('核对未发送会同步评论收据并释放额度', async t => {
  const calls = [];
  const f = fixture(t, {
    post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true, operationId: 'browser-op-1' }; },
    getCommenter: async () => ({ markResolved: input => { calls.push(input); } }),
  });
  f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.comment(f.evidence(), f.controls);
  await f.service.resolve({ operationId: result.operationId, outcome: 'not-sent' }, { explicit: true });
  assert.deepEqual(calls, [{ videoId: '12345', operationId: 'browser-op-1', outcome: 'not-sent' }]);
  assert.equal(f.service.state().daily.attempts, 0); assert.equal(f.service.state().paused, false);
});
test('收据同步失败时拒绝核对且不释放额度', async t => {
  const f = fixture(t, {
    post: async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true, operationId: 'browser-op-2' }; },
    getCommenter: async () => ({ markResolved: () => { throw new Error('评论收据已确认发布，不能改为未发送。'); } }),
  });
  f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.comment(f.evidence(), f.controls);
  await assert.rejects(f.service.resolve({ operationId: result.operationId, outcome: 'not-sent' }, { explicit: true }), /不能改为未发送/);
  assert.equal(f.service.state().daily.attempts, 1); assert.equal(f.service.state().pendingRecheck, 1);
});
test('另一入口关闭、结束轮次、丢失观察或更换run都在最终发布前撤回', async t => {
  for (const mutation of ['disabled', 'session', 'evidence', 'run']) {
    let f; f = fixture(t, { post: async (input, controls) => {
      controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId });
      if (mutation === 'disabled') new AutonomousComments({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock }).configure({ enabled: false }, { explicit: true });
      if (mutation === 'session') f.videoLimits.endSession({ explicit: true });
      if (mutation === 'evidence') f.personaMemory.snapshot = () => ({ recentObservations: [] });
      if (mutation === 'run') fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify({ pid: process.pid, source: 'api', runId: 'different', sessionId: f.videoLimits.state().session.id, status: 'running' }));
      controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); assert.fail('撤回后不得发布');
    } }); f.service.configure({ enabled: true }, { explicit: true }); await assert.rejects(f.service.comment(f.evidence(), f.controls)); assert.equal(f.service.ledger().operations[0].status, 'not-sent'); assert.equal(f.service.state().daily.attempts, 0);
  }
});
test('最终短输入与许可关闭互斥，释放后关闭才生效', async t => {
  let f; f = fixture(t, { post: async (input, controls) => {
    controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId }); const release = controls.authorize.beginDispatch(); const other = new AutonomousComments({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
    try { assert.throws(() => other.configure({ enabled: false }, { explicit: true }), /仍在处理/); assert.equal(f.service.policy().enabled, true); } finally { release(); }
    assert.equal(other.configure({ enabled: false }, { explicit: true }).enabled, false); return { confirmed: false, deliveryUncertain: true };
  } }); f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.comment(f.evidence(), f.controls); assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().enabled, false); assert.equal(fs.existsSync(f.service.files.control), false);
});
test('损坏记录和不明发送残锁不被自动清除或覆盖', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence();
  fs.writeFileSync(f.service.files.send, JSON.stringify({ pid: 2147483647, token: 'dead-owner' })); assert.equal(f.service.state().recoveryRequired, true); await assert.rejects(f.service.comment(input, f.controls), /发送锁/); assert.equal(fs.existsSync(f.service.files.send), true); fs.unlinkSync(f.service.files.send);
  fs.writeFileSync(f.service.files.ledger, '{bad'); await assert.rejects(f.service.comment(input, f.controls), /记录/); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), '{bad');
});
test('关闭只取消自己的发布，保持预留次数且不盲重发', async t => {
  const started = Promise.withResolvers(); const f = fixture(t, { post: async (input, controls) => { controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId }); started.resolve(); await new Promise((resolve, reject) => controls.signal.addEventListener('abort', () => reject(controls.signal.reason), { once: true })); } }); f.service.configure({ enabled: true }, { explicit: true });
  const other = new AutonomousComments({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock }); const pending = f.service.comment(f.evidence(), f.controls).catch(error => error); await started.promise; await other.close(); assert.equal(f.service.state().busy, true); await f.service.close(); assert.ok(await pending instanceof Error); assert.equal(f.service.state().daily.attempts, 0); assert.equal(f.service.ledger().operations[0].status, 'not-sent');
});
