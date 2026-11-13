import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OutboundCoordinator } from './outbound-send.mjs';

const DEFAULTS = Object.freeze({ enabled: false, dailyLimit: 5, minIntervalSeconds: 30, autoFollow: true, dmPrompt: '' });
const PROMPT_MAX = 1000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const SEC_UID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
// 只接受抖音自己的域名，导航前就挡掉第三方地址。
const DOUYIN_USER_HOSTS = new Set(['www.douyin.com', 'douyin.com']);
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail(`主动私信设置文件损坏：${error.message}`, 500); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

// 解析作者主页地址：必须是抖音域名下的 /user/<secUid>。
// 浏览器给的 page.url() 是完整地址，身份核对时必须取出 pathname 再比较。
const userPathOf = value => {
  try { return new URL(String(value)).pathname.replace(/\/+$/, ''); } catch { return ''; }
};

function parseUserUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw fail('作者主页地址不是有效网址，未发送。', 400); }
  if (parsed.protocol !== 'https:' || !DOUYIN_USER_HOSTS.has(parsed.hostname.toLowerCase())) throw fail('只允许打开抖音域名下的作者主页，未发送。', 400);
  const match = /^\/user\/([A-Za-z0-9_-]{4,128})\/?$/.exec(parsed.pathname);
  if (!match) throw fail('作者主页地址必须是 /user/<secUid> 形式，未发送。', 400);
  return match[1];
}

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('主动私信设置必须是对象。');
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled;
  const dailyLimit = Number.isSafeInteger(value.dailyLimit) && value.dailyLimit >= 1 && value.dailyLimit <= 50 ? value.dailyLimit : DEFAULTS.dailyLimit;
  const minIntervalSeconds = Number.isSafeInteger(value.minIntervalSeconds) && value.minIntervalSeconds >= 10 && value.minIntervalSeconds <= 300 ? value.minIntervalSeconds : DEFAULTS.minIntervalSeconds;
  const autoFollow = typeof value.autoFollow === 'boolean' ? value.autoFollow : DEFAULTS.autoFollow;
  if (value.dmPrompt !== undefined && typeof value.dmPrompt !== 'string') throw fail('私信提示词必须是文字。');
  const dmPrompt = typeof value.dmPrompt === 'string' ? value.dmPrompt : DEFAULTS.dmPrompt;
  if (dmPrompt.length > PROMPT_MAX) throw fail(`私信提示词最多 ${PROMPT_MAX} 字。`);
  return { version: 1, enabled, dailyLimit, minIntervalSeconds, autoFollow, dmPrompt: dmPrompt.trim() };
}

// 主动私信服务：从用户主页发起私信，含风控与发送结果核对。
export class OutboundMessageService {
  constructor({ controller, stateDir, source = 'api' }) {
    if (!controller?.navigate || !controller?.state) throw new TypeError('主动私信服务需要浏览器控制器。');
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('状态目录须为绝对路径。');
    Object.assign(this, { controller, stateDir, source });
    this.policyFile = path.join(stateDir, 'outbound-message-policy.json');
    this.dailyFile = path.join(stateDir, 'outbound-daily.json');
    this.receiptFile = path.join(stateDir, 'outbound-receipts.jsonl');
    // 与好友回复/分享共用同一把跨进程锁，只在额度预留和结算的短临界区持有。
    this.coordinator = new OutboundCoordinator({ stateDir, source: ['api', 'dsh'].includes(source) ? source : 'api' });
    fs.mkdirSync(stateDir, { recursive: true });
  }

  policy() {
    const stored = read(this.policyFile, null);
    return stored ? validatePolicy(stored) : { ...DEFAULTS, version: 1 };
  }

  async configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('主动私信设置只能由本人修改。', 403);
    const policy = validatePolicy({ ...this.policy(), ...input });
    write(this.policyFile, policy);
    return this.state();
  }

  // 每日账本：count 是已点击发送的条数，reservations 是短锁内预留的发送中条目。
  // 日期、count、lastSentAt 和 reservations 结构都必须合法；异常时标记 invalid，显示降级但执行拒绝。
  _daily() {
    const today = dayKey();
    const blank = { date: today, count: 0, lastSentAt: null, reservations: [], valid: true };
    const value = read(this.dailyFile, null);
    if (!value) return blank;
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { ...blank, valid: false };
    if (value.date !== today) return blank;
    const countOk = Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 50;
    const lastOk = value.lastSentAt === null || value.lastSentAt === undefined || (typeof value.lastSentAt === 'string' && Number.isFinite(Date.parse(value.lastSentAt)));
    const reservationsOk = value.reservations === undefined || (Array.isArray(value.reservations) && value.reservations.every(item => item && typeof item.id === 'string' && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))));
    if (!countOk || !lastOk || !reservationsOk) return { ...blank, valid: false };
    const now = Date.now();
    const reservations = (value.reservations || []).filter(item => now - Date.parse(item.at) < RESERVATION_TTL_MS);
    return { date: today, count: value.count, lastSentAt: value.lastSentAt ?? null, reservations, valid: true };
  }

  state() {
    const policy = this.policy();
    const daily = this._daily();
    const remaining = policy.enabled && daily.valid ? Math.max(0, policy.dailyLimit - daily.count - daily.reservations.length) : 0;
    return {
      protocol: 'outbound-message-v1',
      enabled: policy.enabled,
      dailyLimit: policy.dailyLimit,
      minIntervalSeconds: policy.minIntervalSeconds,
      autoFollow: policy.autoFollow,
      dmPrompt: policy.dmPrompt,
      todayCount: daily.count,
      reserved: daily.reservations.length,
      remaining,
      lastSentAt: daily.lastSentAt,
      ledgerOk: daily.valid,
    };
  }

  // 检查今日配额与最小间隔，未通过时返回明确原因。
  checkQuota() {
    const policy = this.policy();
    const daily = this._daily();
    if (!daily.valid) throw fail('主动私信计数文件异常，请检查或删除 outbound-daily.json 后重试。', 500);
    if (!policy.enabled) throw fail('主动私信总开关未开启，请在设置页启用后再试。', 403);
    if (daily.count + daily.reservations.length >= policy.dailyLimit) throw fail(`今日主动私信已达上限 ${policy.dailyLimit} 条，请明日再试或在设置页调整上限。`, 429);
    if (daily.lastSentAt) {
      const elapsed = (Date.now() - new Date(daily.lastSentAt).getTime()) / 1000;
      if (elapsed < policy.minIntervalSeconds) throw fail(`距离上次主动私信不足 ${policy.minIntervalSeconds} 秒，请稍后再试。`, 429);
    }
    return { allowed: true };
  }

  // 短锁预留：锁内复核额度与目标未决收据，并写入预留，随后立即释放。
  async _reserve(targetSecUid, signal) {
    const release = await this.coordinator.acquire(signal);
    try {
      this.checkQuota();
      this._assertNoPendingTarget(targetSecUid);
      const daily = this._daily();
      const id = randomUUID();
      write(this.dailyFile, { ...daily, reservations: [...daily.reservations, { id, at: new Date().toISOString() }] });
      return id;
    } finally { release(); }
  }

  // 结算：点击过就计入今日条数；未点击则只释放预留。
  async _settle(id, { sent }) {
    const release = await this.coordinator.acquire();
    try {
      const daily = this._daily();
      // 账本异常时不覆盖原文件，避免把损坏数据静默重写成 0/1。
      if (!daily.valid) throw fail('主动私信计数文件异常，未更新额度。', 500);
      write(this.dailyFile, {
        date: daily.date,
        count: sent ? daily.count + 1 : daily.count,
        lastSentAt: sent ? new Date().toISOString() : daily.lastSentAt,
        reservations: daily.reservations.filter(item => item.id !== id),
      });
    } finally { release(); }
  }

  _appendReceipt(receipt) {
    fs.appendFileSync(this.receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  }

  // 短锁只覆盖“预留—发送—结算”的生命周期管理，页面操作仍在锁外执行。
  async _withReservation(callback, targetSecUid, signal) {
    const reservationId = await this._reserve(targetSecUid, signal);
    let clicked = false;
    let result, failure;
    try { result = await callback(() => { clicked = true; }); }
    catch (error) { failure = error; }
    let settleError = null;
    try { await this._settle(reservationId, { sent: clicked }); }
    catch (error) {
      settleError = error;
      // 结算失败必须留下可核对的痕迹：预留仍在账本里，收据标记为待恢复。
      this._appendSettlePending({ reservationId, targetSecUid, sent: clicked, reason: error.message });
    }
    if (failure) {
      if (settleError) failure.settleError = settleError.message;
      throw failure;
    }
    if (settleError) throw fail(`私信已点击发送，但额度结算失败：${settleError.message}。已记录待恢复，请核对抖音会话后再试。`, 500);
    return result;
  }

  // 结算失败时的持久记录；收据也写不进去时仍然由调用方抛出结算异常，不静默。
  _appendSettlePending({ reservationId, targetSecUid, sent, reason }) {
    try {
      this._appendReceipt({ id: `settle-${reservationId}`, at: new Date().toISOString(), targetSecUid, status: 'settle-pending', sent, reason });
    } catch { /* 保留结算异常，交由 _withReservation 向上抛出 */ }
  }

  // 收据按行追加；只取最近 24 小时内、带目标身份且可解析的记录。
  _receipts(since) {
    let text;
    try { text = fs.readFileSync(this.receiptFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw fail(`主动私信收据读取失败：${error.message}`, 500); }
    const items = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.targetSecUid !== 'string') continue;
        const at = Date.parse(item.at);
        if (!Number.isFinite(at) || at < since) continue;
        items.push(item);
      } catch { /* 单行损坏不影响其他收据 */ }
    }
    return items;
  }

  // 同一作者 24 小时内有“结果不明”或“点击后无结果”时，禁止自动重发。
  _assertNoPendingTarget(targetSecUid, now = Date.now()) {
    const items = this._receipts(now - 24 * 60 * 60 * 1000).filter(item => item.targetSecUid === targetSecUid);
    const finished = new Set(items.filter(item => ['confirmed', 'uncertain', 'requires-follow', 'not-sent'].includes(item.status)).map(item => item.id));
    const pending = items.find(item => item.status === 'uncertain' || item.status === 'settle-pending' || (item.status === 'clicking' && !finished.has(item.id)));
    if (pending) throw fail('这位作者上次私信的结果未确认，为避免重复发送已暂停；请在抖音核对会话后再试。', 409);
  }

  // 主流程：核对目标身份 → 导航到主页 → 点发消息 → 自动关注（如需）→ 填写发送 → 回读验证
  async sendToUser({ secUid, url, message }, { signal } = {}) {
    // 目标 secUid 只从明确入参或主页地址解析；两者冲突时拒绝发送。
    const readSecUid = value => typeof value === 'string' && SEC_UID_PATTERN.test(value) ? value : null;
    // 导航前先核对域名和路径，第三方地址不会进入浏览器。
    const urlTarget = url === undefined || url === null || String(url).trim() === '' ? null : parseUserUrl(url);
    const explicitSecUid = readSecUid(secUid);
    const targetSecUid = explicitSecUid || urlTarget;
    if (!targetSecUid) throw fail('需要明确的作者主页地址或 secUid，未发送。', 400);
    if (explicitSecUid && urlTarget && explicitSecUid !== urlTarget) throw fail('secUid 与主页地址不一致，未发送。', 400);
    // 统一用规范地址导航，忽略传入地址里的查询串和大小写变体。
    const userUrl = `https://www.douyin.com/user/${targetSecUid}`;
    return this._withReservation(markClicked => this._sendToUser({ targetSecUid, userUrl, message }, { signal, markClicked }), targetSecUid, signal);
  }

  async _sendToUser({ targetSecUid, userUrl, message }, { signal, markClicked } = {}) {
    // 额度已在 _reserve 的锁内复核；此处不能再查一次，否则会把自己刚预留的名额算进去。
    const receiptId = randomUUID();
    const startedAt = new Date().toISOString();
    signal?.throwIfAborted();

    // 通过 controller 获取页面并导航
    await this.controller.navigate(userUrl, signal);
    signal?.throwIfAborted();
    const page = this.controller.page;
    if (!page) throw fail('浏览器页面未就绪。', 503);

    // 等待主页加载
    await page.waitForTimeout(1500);
    signal?.throwIfAborted();

    // 检查登录/验证状态
    const state = await this.controller.state({ record: false });
    if (state.loginRequired) throw fail('抖音账号需要登录，请先在专用浏览器完成登录。', 401);
    if (state.verificationRequired) throw fail('抖音需要安全验证，请先在专用浏览器完成验证。', 403);
    if (state.pageKind !== 'user-profile') throw fail('未能打开用户主页，页面状态不符。', 400);
    // 发送前最后一次身份核对：主页归属和地址都必须指向目标作者。
    if (!state.userProfile || state.userProfile.secUid !== targetSecUid) throw fail('打开的页面不是目标作者主页，未发送。', 409);
    const currentPath = userPathOf(page.url());
    if (currentPath !== `/user/${targetSecUid}`) throw fail('页面地址与目标作者不符，未发送。', 409);

    const nickname = state.userProfile.nickname || targetSecUid;

    // 打开私信：优先"发消息"，其次"私信"；页面未就绪时点击可能丢失，最多重试三次。
    const entry = page.locator('button:has-text("发消息"),[data-e2e="message-btn"],[class*="messageBtn"],button:has-text("私信"),a:has-text("私信"),[data-e2e="chat-btn"]').filter({ visible: true }).first();
    const editor = page.locator('[data-e2e="im-dialog"] [contenteditable="true"][data-slate-editor]').first();
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      if (!(await editor.isVisible().catch(() => false))) {
        if (await entry.count() === 0) throw fail('未找到"发消息"入口，对方可能关闭了私信或页面结构已变化。', 404);
        await entry.click().catch(() => {});
      }
      await page.waitForTimeout(1500);
      opened = await editor.isVisible().catch(() => false);
    }
    signal?.throwIfAborted();
    if (!opened) throw fail('私信对话框未打开，可能对方不接收陌生人消息。', 403);

    // 检测是否需要先关注
    const followPrompt = page.locator('text=关注后即可发送消息,text=关注后才能发消息,text=请先关注对方').filter({ visible: true }).first();
    if (await followPrompt.count() > 0) {
      const policy = this.policy();
      if (!policy.autoFollow) {
        this._appendReceipt({ id: receiptId, at: startedAt, secUid: targetSecUid, targetSecUid, url: userUrl, nickname, messagePreview: message.slice(0, 50), status: 'requires-follow', autoFollow: false });
        throw fail('对方设置了关注后才能发消息，且自动关注未开启。', 403);
      }
      // 点击关注按钮
      const followBtn = page.locator('button:has-text("关注"),[data-e2e="follow-btn"]').filter({ visible: true }).first();
      if (await followBtn.count() === 0) throw fail('需要关注但未找到关注按钮。', 404);
      await followBtn.click();
      await page.waitForTimeout(1000);
      signal?.throwIfAborted();
      // 再次尝试点击发消息
      const retryButton = page.locator('button:has-text("发消息"),[data-e2e="message-btn"],button:has-text("私信")').filter({ visible: true }).first();
      if (await retryButton.count() > 0) await retryButton.click();
      await page.waitForTimeout(1200);
    }

    // 核对当前会话对象，避免私信面板默认停在其他会话
    const activeTitle = (await page.locator('[data-e2e="im-dialog"] [class*="ChatHeadertitle"]').first().innerText().catch(() => '')).trim();
    if (activeTitle && nickname && activeTitle !== nickname) throw fail(`私信会话对象是「${activeTitle}」，与目标「${nickname}」不符，未发送。`, 409);
    signal?.throwIfAborted();

    // 检查已有草稿，避免覆盖
    const readEditor = async () => (await editor.evaluate(el => (el.innerText || el.textContent || '').replace(/\u200b/g, ''))).trim();
    const existingDraft = await readEditor();
    if (existingDraft) throw fail('当前会话已有草稿，未覆盖发送。', 409);

    // 填写消息：Slate 编辑器需要真实输入事件，fill 无效
    await editor.click();
    await page.keyboard.insertText(message);
    signal?.throwIfAborted();
    await page.waitForTimeout(500);

    // 回读草稿确认
    const draftText = await readEditor();
    if (draftText !== message.trim()) throw fail('填写后草稿回读不一致，未发送。', 500);

    // 发送按钮是带 e2e-send-msg-btn 类的 svg
    const sendButton = page.locator('[data-e2e="im-dialog"] .e2e-send-msg-btn').first();
    if (await sendButton.count() !== 1) throw fail('未找到唯一的发送按钮，未发送。', 500);

    // 点击前再次核对页面归属与草稿，避免异步等待期间页面被替换或切换会话。
    // 私信弹窗打开后 pageKind 会变成 unknown，所以以地址路径和弹窗状态为准。
    const finalState = await this.controller.state({ record: false });
    const finalPath = userPathOf(page.url());
    if (finalState.loginRequired || finalState.verificationRequired) throw fail('点击前出现登录或安全验证要求，未发送。', 403);
    if (finalPath !== `/user/${targetSecUid}`) throw fail('点击前页面已离开目标作者主页，未发送。', 409);
    const finalIdentity = finalState.userProfile?.secUid;
    if (finalIdentity && finalIdentity !== targetSecUid) throw fail('点击前页面已切换到其他作者，未发送。', 409);
    if (!finalState.privateChatVisible) throw fail('点击前私信对话已关闭，未发送。', 409);
    if (await readEditor() !== message.trim()) throw fail('点击前草稿内容已变化，未发送。', 409);

    // 点击前先落盘“正在发送”，进程在点击后中断也能在下次识别为结果不明。
    this._appendReceipt({ id: receiptId, at: startedAt, secUid: targetSecUid, targetSecUid, url: userUrl, nickname, messagePreview: message.slice(0, 80), status: 'clicking' });
    markClicked?.();
    await sendButton.click();
    signal?.throwIfAborted();
    await page.waitForTimeout(2500);

    // 回读验证：输入框应清空，且会话中出现刚发送的文本
    const clearedDraft = await readEditor();
    const appeared = await page.evaluate((text) => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]');
      return !!dialog && (dialog.innerText || '').includes(text);
    }, message.trim());
    const confirmed = !clearedDraft && appeared;
    this._appendReceipt({
      id: receiptId, at: startedAt, secUid: targetSecUid, targetSecUid, url: userUrl, nickname,
      messagePreview: message.slice(0, 80), status: confirmed ? 'confirmed' : 'uncertain',
      deliveryUncertain: !confirmed, draftCleared: !clearedDraft, messageAppeared: appeared,
    });

    return {
      ok: confirmed,
      receiptId,
      status: confirmed ? 'confirmed' : 'uncertain',
      nickname,
      message: confirmed ? `已向 ${nickname} 发送私信。` : '点击发送后未能通过消息列表回读确认，发送结果不明，未重发。',
    };
  }
}

export default OutboundMessageService;
