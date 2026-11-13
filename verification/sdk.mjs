import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

const marker = ['@deepseek-ai', 'cordis', 'package.json'];

// 依次尝试环境变量和本机常见安装位置；找不到时返回 null，由调用方明确跳过而不是假装通过。
export function resolveDshNodeModules() {
  const home = homedir();
  const candidates = [
    process.env.DSH_NODE_MODULES,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DSH Desktop', 'resources', 'app', 'node_modules'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
    path.join(home, '.dsh', 'node_modules'),
    'F:/codex/DSH Desktop 2/resources/app/node_modules',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.statSync(path.join(candidate, ...marker)).isFile()) return path.resolve(candidate); } catch { /* 继续尝试下一个候选路径 */ }
  }
  return null;
}

export const dshNodeModules = resolveDshNodeModules();
export const dshSkipReason = dshNodeModules ? false : '未找到 DSH 原生运行库：请设置 DSH_NODE_MODULES 指向 DSH 的 node_modules 后重跑。';

// 原生验证统一入口：缺少 SDK 时整组标记为跳过，并保留跳过原因。
export const nativeTest = (name, options, fn) => {
  if (typeof options === 'function') { fn = options; options = {}; }
  return test(name, { ...options, skip: options?.skip || dshSkipReason }, fn);
};
