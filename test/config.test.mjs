import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, normalizeConfig, renderPrompt } from '../src/config.js';

test('空配置全用默认值', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.sessionTitle, 'B站私信');
  assert.equal(c.dryRun, false);
  assert.equal(c.ownerMid, 0);
  assert.equal(c.dedupeWindowMs, DEFAULTS.dedupeWindowMs);
  assert.deepEqual(Object.keys(c).sort(), Object.keys(DEFAULTS).sort());
});

test('数值字符串会被收敛成整数，负数抬到下限', () => {
  const c = normalizeConfig({ dedupeWindowMs: '5000', maxQueue: -3, maxTextLength: '1' });
  assert.equal(c.dedupeWindowMs, 5000);
  assert.equal(c.maxQueue, 1, 'maxQueue 最小是 1');
  assert.equal(c.maxTextLength, 100, 'maxTextLength 最小是 100');
  assert.equal(normalizeConfig({ ownerMid: '100000001' }).ownerMid, 100000001);
});

test('布尔支持字符串写法', () => {
  assert.equal(normalizeConfig({ dryRun: 'false' }).dryRun, false);
  assert.equal(normalizeConfig({ dryRun: 'true' }).dryRun, true);
  assert.equal(normalizeConfig({ dryRun: 1 }).dryRun, true);
  assert.equal(normalizeConfig({ dryRun: 0 }).dryRun, false);
});

test('cwd 末尾分隔符去掉，空 marker 回落到默认值', () => {
  assert.equal(normalizeConfig({ cwd: 'C:\\work\\bili\\' }).cwd, 'C:\\work\\bili');
  assert.equal(normalizeConfig({ marker: '' }).marker, DEFAULTS.marker);
});

test('renderPrompt 换占位符', () => {
  const c = normalizeConfig({ ownerMid: 100000001, promptTemplate: '{marker} {text} [{ownerHint}][{kind}]' });
  const text = renderPrompt(c, { text: '你好', kind: 'inbox' });
  assert.equal(text, '【B站收件箱有新消息】 你好 [（UID 100000001）][inbox]');
  assert.ok(!text.includes('{text}'));
  assert.ok(!text.includes('{marker}'));
});

test('ownerMid 为 0 时不提 UID，也不留空括号', () => {
  const c = normalizeConfig({ promptTemplate: '主人{ownerHint}发来：{text}' });
  const text = renderPrompt(c, { text: '在吗' });
  assert.equal(text, '主人发来：在吗');
  assert.ok(!text.includes('UID'));
});

test('默认模板短到只用一行指令 —— 会话历史别被指令撑大', () => {
  const text = renderPrompt(normalizeConfig({}), { text: '在吗' });
  assert.equal(text, '【B站收件箱有新消息】 在吗');
  assert.ok(!text.includes('bili_dm'), '默认唤醒词不该再叠一层怎么办');
});

test('自定义模板原样生效', () => {
  const c = normalizeConfig({ promptTemplate: '{marker}|{kind}|{text}' });
  assert.equal(renderPrompt(c, { text: 'x', kind: 'recommend' }), '【B站收件箱有新消息】|recommend|x');
});
