import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileViewService } from '../profile-view.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-profile-view-'));
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('测试清理路径越界。');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, service: new ProfileViewService({ stateDir: directory, source: 'dsh' }) };
}

test('查看主页默认关闭，关闭时不提供余量也不能预留', async t => {
  const { service } = fixture(t);
  const state = service.state();
  assert.equal(state.protocol, 'profile-view-v1');
  assert.equal(state.enabled, false);
  assert.equal(state.remaining, 0);
  assert.equal(state.ledgerOk, true);
  assert.equal(service.context().enabled, false);
  assert.throws(() => service.checkQuota(), /未开启/);
  await assert.rejects(service.reserve(), /未开启/);
});

test('查看主页设置只能由本人修改，并校验次数与提示词', async t => {
  const { service } = fixture(t);
  assert.throws(() => service.configure({ enabled: true }), /本人/);
  const saved = service.configure({ enabled: true, dailyLimit: 2, prompt: '  刷到电竞作品可以进主页  ' }, { explicit: true });
  assert.equal(saved.enabled, true);
  assert.equal(saved.dailyLimit, 2);
  assert.equal(saved.prompt, '刷到电竞作品可以进主页');
  assert.equal(saved.remaining, 2);
  assert.throws(() => service.configure({ dailyLimit: 0 }, { explicit: true }), /最多|至少|次数/);
  assert.throws(() => service.configure({ dailyLimit: 51 }, { explicit: true }), /最多|至少|次数/);
  assert.throws(() => service.configure({ prompt: '主'.repeat(1001) }, { explicit: true }), /最多 1000/);
  assert.throws(() => service.configure({ enabled: 'yes' }, { explicit: true }), /布尔值/);
  // 非法输入回落后仍保持原值，不会被静默改写。
  assert.equal(service.state().enabled, true);
  assert.equal(service.state().dailyLimit, 2);
});

test('预留占余量，只有读到主页才计入次数，失败预留会释放', async t => {
  const { service } = fixture(t);
  service.configure({ enabled: true, dailyLimit: 2 }, { explicit: true });
  const first = await service.reserve();
  assert.equal(service.state().remaining, 1);
  assert.equal(service.state().reserved, 1);
  await service.settle(first, { visited: true });
  assert.equal(service.state().todayCount, 1);
  assert.equal(service.state().remaining, 1);
  const second = await service.reserve();
  await service.settle(second, { visited: false });
  assert.equal(service.state().todayCount, 1);
  assert.equal(service.state().remaining, 1);
  const third = await service.reserve();
  assert.equal(service.state().remaining, 0);
  await assert.rejects(service.reserve(), /上限/);
  await service.settle(third, { visited: true });
  assert.equal(service.state().todayCount, 2);
  assert.equal(service.state().remaining, 0);
  assert.equal(service.context().enabled, false);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

test('计数文件异常时降级显示并拒绝预留与结算，不覆盖原文件', async t => {
  const { directory, service } = fixture(t);
  service.configure({ enabled: true, dailyLimit: 5 }, { explicit: true });
  const dailyFile = path.join(directory, 'profile-view-daily.json');
  const broken = JSON.stringify({ date: today(), count: 999, reservations: [] });
  fs.writeFileSync(dailyFile, broken);
  const state = service.state();
  assert.equal(state.ledgerOk, false);
  assert.equal(state.remaining, 0);
  assert.throws(() => service.checkQuota(), /异常/);
  await assert.rejects(service.reserve(), /异常/);
  await assert.rejects(service.settle('synthetic-id', { visited: true }), /异常/);
  assert.equal(fs.readFileSync(dailyFile, 'utf8'), broken);
});

test('跨日账本自动从零开始，旧日期不计入今天', async t => {
  const { directory, service } = fixture(t);
  service.configure({ enabled: true, dailyLimit: 5 }, { explicit: true });
  fs.writeFileSync(path.join(directory, 'profile-view-daily.json'), JSON.stringify({ date: '2000-01-01', count: 4, reservations: [] }));
  assert.equal(service.state().todayCount, 0);
  assert.equal(service.state().remaining, 5);
  const id = await service.reserve();
  await service.settle(id, { visited: true });
  assert.equal(service.state().todayCount, 1);
});

test('损坏的设置文件不会被空设置覆盖', async t => {
  const { directory, service } = fixture(t);
  fs.writeFileSync(path.join(directory, 'profile-view-policy.json'), '{not json');
  assert.throws(() => service.state(), /损坏/);
  assert.equal(fs.readFileSync(path.join(directory, 'profile-view-policy.json'), 'utf8'), '{not json');
});
