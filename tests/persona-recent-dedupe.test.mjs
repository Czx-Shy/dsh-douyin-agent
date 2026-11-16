import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonaMemory } from '../persona-memory.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-persona-recent-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('测试清理路径越界。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const memoryDir = path.join(root, 'memory');
  const store = new PersonaMemory({ memoryDir, legacyRoleCardFile: path.join(root, 'legacy-card.md') });
  return { root, store };
}

const observation = (id, videoId, observedAt) => ({
  id: `video:${id.repeat(64)}`,
  videoId,
  url: `https://www.douyin.com/video/${videoId}`,
  title: `合成作品${videoId}`,
  visibility: 'account-visible-unverified',
  privacy: 'internal-reference',
  source: 'api',
  sources: ['api'],
  observedAt,
  kind: 'visual',
});

test('人格卡最近作品按作品去重，同一作品多次观察只出现一次', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.store.stateFile), { recursive: true });
  fs.writeFileSync(f.store.roleCardFile, '# 合成人格卡\n');
  fs.writeFileSync(f.store.stateFile, JSON.stringify({
    version: 1,
    generation: 4,
    initializedAt: 1,
    observations: [
      observation('a', '100001', 1),
      observation('b', '100001', 2),
      observation('c', '100002', 3),
      observation('d', '100002', 4),
      observation('e', '100003', 5),
    ],
    interests: [],
    userPreferences: [],
  }));
  const text = f.store.snapshot().personaText;
  const count = value => (text.match(new RegExp(`/video/${value}`, 'g')) || []).length;
  assert.equal(count('100001'), 1);
  assert.equal(count('100002'), 1);
  assert.equal(count('100003'), 1);
  // 保留最新的三条不同作品，且不改变原有顺序。
  assert.ok(text.indexOf('100003') > text.indexOf('100002'));
  assert.ok(text.indexOf('100002') > text.indexOf('100001'));
});
