import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutboundMessageService } from '../outbound-message.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-outbound-message-'));
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('测试清理路径越界。');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const controller = { page: null, navigate: async () => {}, state: async () => ({}) };
  const service = new OutboundMessageService({ controller, stateDir: directory, source: 'dsh' });
  return { directory, service, controller };
}

const receiptsFile = directory => path.join(directory, 'outbound-receipts.jsonl');
const writeDaily = (directory, value) => fs.writeFileSync(path.join(directory, 'outbound-daily.json'), JSON.stringify(value));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

test('主动私信服务要求浏览器控制器与绝对状态目录', () => {
  assert.throws(() => new OutboundMessageService({ stateDir: 'relative' }), /浏览器控制器/);
  const controller = { page: null, navigate: async () => {}, state: async () => ({}) };
  assert.throws(() => new OutboundMessageService({ controller, stateDir: 'relative' }), /绝对路径/);
});

test('主动私信默认关闭，关闭时不能发送也不能预留', async t => {
  const { service } = fixture(t);
  const state = service.state();
  assert.equal(state.protocol, 'outbound-message-v1');
  assert.equal(state.enabled, false);
  assert.equal(state.autoFollow, true);
  assert.equal(state.remaining, 0);
  assert.equal(state.ledgerOk, true);
  assert.throws(() => service.checkQuota(), /未开启/);
  await assert.rejects(service.sendToUser({ secUid: 'Abcd1234efgh', message: '合成' }), /未开启/);
});

test('主动私信设置只能由本人修改，并校验上限、间隔与提示词', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.configure({ enabled: true }), /本人/);
  const saved = await service.configure({ enabled: true, dailyLimit: 3, minIntervalSeconds: 20, autoFollow: false, dmPrompt: '  合成提示词  ' }, { explicit: true });
  assert.equal(saved.enabled, true);
  assert.equal(saved.dailyLimit, 3);
  assert.equal(saved.minIntervalSeconds, 20);
  assert.equal(saved.autoFollow, false);
  assert.equal(saved.dmPrompt, '合成提示词');
  assert.equal(saved.remaining, 3);
  for (const input of [{ enabled: 'yes' }, { autoFollow: 'yes' }, { dailyLimit: 0 }, { dailyLimit: 51 }, { minIntervalSeconds: 9 }, { minIntervalSeconds: 301 }, { dmPrompt: 123 }, { dmPrompt: '字'.repeat(1001) }]) {
    await assert.rejects(service.configure(input, { explicit: true }));
  }
  assert.equal(service.state().dailyLimit, 3);
});

test('最小发送间隔按上次实际发送时间计算', async t => {
  const { service } = fixture(t);
  await service.configure({ enabled: true, dailyLimit: 5, minIntervalSeconds: 30 }, { explicit: true });
  const first = await service._reserve('Abcd1234efgh');
  await service._settle(first, { sent: true });
  assert.equal(service.state().todayCount, 1);
  assert.throws(() => service.checkQuota(), /不足 30 秒/);
  await assert.rejects(service._reserve('Abcd1234efgh'), /不足 30 秒/);
});

test('同一作者存在未决收据时禁止重发，已确认或未发出不阻塞', async t => {
  const { directory, service } = fixture(t);
  const base = { at: new Date().toISOString(), targetSecUid: 'Abcd1234efgh' };
  fs.writeFileSync(receiptsFile(directory), [
    { id: 'confirmed-1', status: 'confirmed', ...base },
    { id: 'not-sent-1', status: 'not-sent', ...base },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  assert.doesNotThrow(() => service._assertNoPendingTarget('Abcd1234efgh'));
  fs.appendFileSync(receiptsFile(directory), JSON.stringify({ id: 'uncertain-1', status: 'uncertain', ...base }) + '\n');
  assert.throws(() => service._assertNoPendingTarget('Abcd1234efgh'), /结果未确认/);
  // 其他作者不受影响。
  assert.doesNotThrow(() => service._assertNoPendingTarget('Other12345678'));
});

test('只有点击过发送才扣今日条数，未点击的失败会释放预留', async t => {
  const { directory, service } = fixture(t);
  await service.configure({ enabled: true, dailyLimit: 5, minIntervalSeconds: 10 }, { explicit: true });
  const ok = await service._withReservation(mark => { mark(); return { ok: true }; }, 'Abcd1234efgh');
  assert.deepEqual(ok, { ok: true });
  assert.equal(service.state().todayCount, 1);
  assert.equal(service.state().reserved, 0);
  assert.ok(service.state().lastSentAt);
  // 把上次发送时间提前，避免最短间隔挡住本次失败用例。
  const daily = JSON.parse(fs.readFileSync(path.join(directory, 'outbound-daily.json'), 'utf8'));
  daily.lastSentAt = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(path.join(directory, 'outbound-daily.json'), JSON.stringify(daily));
  await assert.rejects(service._withReservation(async () => { throw new Error('合成发送失败'); }, 'Other12345678'), /合成发送失败/);
  assert.equal(service.state().todayCount, 1);
  assert.equal(service.state().reserved, 0);
});

// 发送链路的最小页面替身：只覆盖 _sendToUser 在点击前后会用到的接口。
async function sendFixture(t, { draftAfterFailure = '' } = {}) {
  const { directory, service, controller } = fixture(t);
  await service.configure({ enabled: true, dailyLimit: 5, minIntervalSeconds: 10 }, { explicit: true });
  let draft = '', clicked = 0;
  const editor = {
    isVisible: async () => true,
    count: async () => 1,
    click: async () => {},
    evaluate: async fn => fn({ innerText: draft, textContent: draft }),
  };
  const page = {
    isClosed: () => false,
    url: () => 'https://www.douyin.com/user/Abcd1234efgh',
    waitForTimeout: async () => {},
    keyboard: { insertText: async value => { draft = value; } },
    getByText: () => ({ filter: () => ({ first: () => ({ count: async () => 0 }) }) }),
    evaluate: async () => false,
    locator: selector => {
      if (selector.includes('ChatHeadertitle')) return { first: () => ({ innerText: async () => '合成昵称' }) };
      if (selector.includes('data-slate-editor')) return { first: () => editor };
      if (selector.includes('e2e-send-msg-btn')) return { first: () => ({ count: async () => 1, click: async () => { clicked++; draft = draftAfterFailure; throw new Error('合成点击失败'); } }) };
      if (selector === '[data-e2e="im-dialog"]') return { first: () => ({ isVisible: async () => false }) };
      return { filter: () => ({ first: () => ({ count: async () => 0, click: async () => {} }) }), first: () => ({ count: async () => 0, click: async () => {} }) };
    },
  };
  controller.page = page;
  controller.state = async () => ({ pageKind: 'user-profile', loginRequired: false, verificationRequired: false, privateChatVisible: true, userProfile: { secUid: 'Abcd1234efgh', nickname: '合成昵称' } });
  return { directory, service, clicked: () => clicked };
}

test('私信点击抛错且草稿仍在时不扣额度，留下未发送收据并允许重试', async t => {
  const { directory, service, clicked } = await sendFixture(t, { draftAfterFailure: '合成私信正文' });
  await assert.rejects(service.sendToUser({ secUid: 'Abcd1234efgh', message: '合成私信正文' }), /合成点击失败/);
  assert.equal(clicked(), 1);
  const state = service.state();
  assert.equal(state.todayCount, 0);
  assert.equal(state.reserved, 0);
  assert.equal(state.remaining, 5);
  assert.doesNotThrow(() => service._assertNoPendingTarget('Abcd1234efgh'));
  const lines = fs.readFileSync(path.join(directory, 'outbound-receipts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.at(-1).status, 'not-sent');
});

test('私信点击抛错但草稿已清空时保持结果不明，禁止自动重试', async t => {
  const { service } = await sendFixture(t, { draftAfterFailure: '' });
  await assert.rejects(service.sendToUser({ secUid: 'Abcd1234efgh', message: '合成私信正文' }), /合成点击失败/);
  const state = service.state();
  assert.equal(state.todayCount, 0);
  assert.equal(state.reserved, 0);
  assert.throws(() => service._assertNoPendingTarget('Abcd1234efgh'), /未确认/);
});

test('汇总：跨日重置、账本异常时降级并拒绝', async t => {
  const { directory, service } = fixture(t);
  await service.configure({ enabled: true, dailyLimit: 5 }, { explicit: true });
  writeDaily(directory, { date: '2000-01-01', count: 9, lastSentAt: null, reservations: [] });
  assert.equal(service.state().todayCount, 0);
  assert.equal(service.state().remaining, 5);
  const broken = JSON.stringify({ date: today(), count: 99, lastSentAt: 'not-a-date', reservations: [] });
  fs.writeFileSync(path.join(directory, 'outbound-daily.json'), broken);
  assert.equal(service.state().ledgerOk, false);
  assert.throws(() => service.checkQuota(), /异常/);
  await assert.rejects(service._reserve('Abcd1234efgh'), /异常/);
  assert.equal(fs.readFileSync(path.join(directory, 'outbound-daily.json'), 'utf8'), broken);
});

test('私信目标只接受抖音域名的用户主页，secUid 与链接必须一致', async t => {
  const { service } = fixture(t);
  await service.configure({ enabled: true }, { explicit: true });
  await assert.rejects(service.sendToUser({ url: 'https://evil.example.com/user/Abcd1234efgh', message: '合成' }), /只允许打开抖音域名/);
  await assert.rejects(service.sendToUser({ url: 'https://www.douyin.com/video/111', message: '合成' }), /\/user\//);
  await assert.rejects(service.sendToUser({ secUid: 'Abcd1234efgh', url: 'https://www.douyin.com/user/Other12345678', message: '合成' }), /不一致/);
  await assert.rejects(service.sendToUser({ message: '合成' }), /需要明确的作者主页/);
});

test('发送结束后收起私信弹窗，Esc 关不掉时回到作者主页', async t => {
  const { service, controller } = fixture(t);
  const dialog = { visible: true };
  let presses = 0;
  const page = {
    isClosed: () => false,
    keyboard: { press: async () => { presses++; if (presses >= 2) dialog.visible = false; } },
    locator: () => ({ first: () => ({ isVisible: async () => dialog.visible }) }),
    waitForTimeout: async () => {},
  };
  controller.page = page;
  assert.equal(await service._closeDmDialog('Abcd1234efgh'), true);
  assert.ok(presses >= 2);
  // Esc 一直无效时，用作者主页替换掉弹窗页面。
  const stubborn = { visible: true };
  const navigated = [];
  controller.page = {
    isClosed: () => false,
    keyboard: { press: async () => {} },
    locator: () => ({ first: () => ({ isVisible: async () => stubborn.visible }) }),
    waitForTimeout: async () => {},
  };
  controller.navigate = async url => { navigated.push(url); stubborn.visible = false; };
  assert.equal(await service._closeDmDialog('Abcd1234efgh'), true);
  assert.deepEqual(navigated, ['https://www.douyin.com/user/Abcd1234efgh']);
  controller.page = null;
  assert.equal(await service._closeDmDialog('Abcd1234efgh'), false);
});
