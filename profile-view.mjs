import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OutboundCoordinator } from './outbound-send.mjs';

const DEFAULTS = Object.freeze({ enabled: false, prompt: '', dailyLimit: 10 });
const PROMPT_MAX = 1000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail(`查看主页设置文件损坏：${error.message}`, 500); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('查看主页设置必须是对象。');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw fail('查看主页开关必须是布尔值。');
  if (value.dailyLimit !== undefined && !(Number.isSafeInteger(value.dailyLimit) && value.dailyLimit >= 1 && value.dailyLimit <= 50)) throw fail('每日查看主页次数须为 1 至 50 的整数。');
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled;
  const dailyLimit = Number.isSafeInteger(value.dailyLimit) && value.dailyLimit >= 1 && value.dailyLimit <= 50 ? value.dailyLimit : DEFAULTS.dailyLimit;
  if (value.prompt !== undefined && typeof value.prompt !== 'string') throw fail('查看主页提示词必须是文字。');
  const prompt = typeof value.prompt === 'string' ? value.prompt : DEFAULTS.prompt;
  if (prompt.length > PROMPT_MAX) throw fail(`查看主页提示词最多 ${PROMPT_MAX} 字。`);
  return { version: 1, enabled, dailyLimit, prompt: prompt.trim() };
}

// 查看主页策略：提示词只用于模型自主判断；每日次数独立于视频用量计数。
export class ProfileViewService {
  constructor({ stateDir, source = 'api' }) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('状态目录须为绝对路径。');
    this.stateDir = stateDir;
    this.policyFile = path.join(stateDir, 'profile-view-policy.json');
    this.dailyFile = path.join(stateDir, 'profile-view-daily.json');
    // 查看主页使用独立的跨进程锁，不与私信/分享共用同一把。
    this.coordinator = new OutboundCoordinator({ stateDir, source: ['api', 'dsh'].includes(source) ? source : 'api', guardFile: 'profile-view.guard' });
    fs.mkdirSync(stateDir, { recursive: true });
  }

  policy() {
    const stored = read(this.policyFile, null);
    return stored ? validatePolicy(stored) : { ...DEFAULTS, version: 1 };
  }

  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('查看主页设置只能由本人修改。', 403);
    write(this.policyFile, validatePolicy({ ...this.policy(), ...input }));
    return this.state();
  }

  // 每日账本严格校验：日期、当天计数和预留条目结构都必须合法；异常时标记 invalid。
  _daily() {
    const today = dayKey();
    const blank = { date: today, count: 0, reservations: [], valid: true };
    const value = read(this.dailyFile, null);
    if (!value) return blank;
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { ...blank, valid: false };
    if (value.date !== today) return blank;
    const countOk = Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 50;
    const reservationsOk = value.reservations === undefined || (Array.isArray(value.reservations) && value.reservations.every(item => item && typeof item.id === 'string' && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))));
    if (!countOk || !reservationsOk) return { ...blank, valid: false };
    const now = Date.now();
    const reservations = (value.reservations || []).filter(item => now - Date.parse(item.at) < RESERVATION_TTL_MS);
    return { date: today, count: value.count, reservations, valid: true };
  }

  state() {
    const policy = this.policy();
    const daily = this._daily();
    const used = daily.count + daily.reservations.length;
    return {
      protocol: 'profile-view-v1',
      enabled: policy.enabled,
      prompt: policy.prompt,
      dailyLimit: policy.dailyLimit,
      todayCount: daily.count,
      reserved: daily.reservations.length,
      remaining: policy.enabled && daily.valid ? Math.max(0, policy.dailyLimit - used) : 0,
      ledgerOk: daily.valid,
    };
  }

  // 供决策提示使用的最小上下文：只在开启、账本正常且有余量时允许模型选择进入主页。
  context() {
    const state = this.state();
    return { enabled: state.enabled && state.ledgerOk && state.remaining > 0, prompt: state.prompt, remaining: state.remaining };
  }

  checkQuota() {
    const state = this.state();
    if (!state.ledgerOk) throw fail('查看主页计数文件异常，请检查或删除 profile-view-daily.json 后重试。', 500);
    if (!state.enabled) throw fail('查看主页总开关未开启，请在设置页启用后再试。', 403);
    if (state.remaining < 1) throw fail(`今日查看主页已达上限 ${state.dailyLimit} 次，请明日再试或在设置页调整上限。`, 429);
    return { remaining: state.remaining };
  }

  // 锁内复核额度并预留一个名额，随后立即释放锁；读取主页成功后再结算。
  async reserve(signal) {
    const release = await this.coordinator.acquire(signal);
    try {
      this.checkQuota();
      const daily = this._daily();
      const id = randomUUID();
      write(this.dailyFile, { date: daily.date, count: daily.count, reservations: [...daily.reservations, { id, at: new Date().toISOString() }] });
      return id;
    } finally { release(); }
  }

  // 读取成功才计入次数；失败只释放预留，不占用当日额度。
  async settle(id, { visited } = {}) {
    const release = await this.coordinator.acquire();
    try {
      const daily = this._daily();
      // 账本异常时不覆盖原文件，避免把损坏数据静默重写成 0/1。
      if (!daily.valid) throw fail('查看主页计数文件异常，未更新额度。', 500);
      write(this.dailyFile, { date: daily.date, count: visited ? daily.count + 1 : daily.count, reservations: daily.reservations.filter(item => item.id !== id) });
    } finally { release(); }
  }
}

export default ProfileViewService;
