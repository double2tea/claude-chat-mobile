// tests/unit/subagent-view-format.test.mjs —— 子代理列表行的文案拼装
//
// 只测纯函数：DOM 覆盖层与 socket 往返归 E2E。这里钉的是「字段各自可选时那行仍读得通」——
// meta 缺失、流水正在写、老会话没有 model 都会让某个字段为空，拼错分隔符在手机上就是一条断句。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSubagentRowMeta, subagentStateLabel } from '../../app/public/js/app/subagent-view.js';

// 单测里用恒等 t()：i18n 的中文原文就是 key，运行时要翻的只可能是词典，不参与这里的断言。
const t = s => s;

test('行副标题按 工具 · 消息数 · 模型 的顺序拼，缺项不留空分隔符', () => {
  assert.equal(
    formatSubagentRowMeta({ lastToolName: 'Read', messageCount: 7, model: 'haiku' }, t),
    'Read · 7 条消息 · haiku',
  );
  assert.equal(formatSubagentRowMeta({ lastToolName: 'Read' }, t), 'Read');
  assert.equal(formatSubagentRowMeta({ messageCount: 0 }, t), '0 条消息');
  assert.equal(formatSubagentRowMeta({ model: 'sonnet' }, t), 'sonnet');
  assert.equal(formatSubagentRowMeta({}, t), '');
  assert.equal(formatSubagentRowMeta(null, t), '');
});

test('消息数只认数字：字符串与缺失都不拼', () => {
  assert.equal(formatSubagentRowMeta({ messageCount: '9' }, t), '');
});

test('状态只在 finished 明确为 false 时算运行中', () => {
  assert.equal(subagentStateLabel(false, t), '运行中');
  assert.equal(subagentStateLabel(true, t), '已完成');
  // 老记录没有这个字段：按已完成，免得一条早已结束的子代理永远挂着「运行中」
  assert.equal(subagentStateLabel(null, t), '已完成');
  assert.equal(subagentStateLabel(undefined, t), '已完成');
});
