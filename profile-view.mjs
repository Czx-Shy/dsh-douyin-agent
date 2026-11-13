import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULTS = Object.freeze({ enabled: false, prompt: '', dailyLimit: 10 });
const PROMPT_MAX = 1000;
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail(`查看主页设置文件损坏：${error.message}`, 500); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('查看主页设置必须是对象。');
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled;
  const dailyLimit = Number.isSafeInteger(value.dailyLimit) && value.dailyLimit >= 1 && value.dailyLimit <= 50 ? value.dailyLimit : DEFAULTS.dailyLimit;
  if (value.prompt !== undefined && typeof value.prompt !== 'string') throw fail('查看主页提示词必须是文字。');
  const prompt = typeof value.prompt === 'string' ? value.prompt : DEFAULTS.prompt;
  if (prompt.length > PROMPT_MAX) throw fail(`查看主页提示词最多 ${PROMPT_MAX} 字。`);
  return { version: 1, enabled, dailyLimit, prompt: prompt.trim() };
}

// 查看主页策略：提示词只用于模型自主判断；每日次数独立于视频用量计数。
export class ProfileViewService {
  constructor({ stateDir }) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('状态目录须为绝对路径。');
    this.stateDir = stateDir;
    this.policyFile = path.join(stateDir, 'profile-view-policy.json');
    this.dailyFile = path.join(stateDir, 'profile-view-daily.json');
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

  // 每日账本严格校验：日期格式、当天计数必须是 0 到上限之间的整数；异常时标记 invalid。
  _daily() {
    const today = dayKey();
    const value = read(this.dailyFile, null);
    if (!value) return { date: today, count: 0, valid: true };
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { date: today, count: 0, valid: false };
    if (value.date !== today) return { date: today, count: 0, valid: true };
    const valid = Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 50;
    return { date: today, count: valid ? value.count : 0, valid };
  }

  state() {
    const policy = this.policy();
    const daily = this._daily();
    return {
      protocol: 'profile-view-v1',
      enabled: policy.enabled,
      prompt: policy.prompt,
      dailyLimit: policy.dailyLimit,
      todayCount: daily.count,
      remaining: policy.enabled && daily.valid ? Math.max(0, policy.dailyLimit - daily.count) : 0,
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

  record() {
    const daily = this._daily();
    if (!daily.valid) throw fail('查看主页计数文件异常，未记录本次查看。', 500);
    write(this.dailyFile, { date: daily.date, count: daily.count + 1 });
  }
}

export default ProfileViewService;
