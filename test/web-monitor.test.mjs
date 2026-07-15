import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNewWebMonitorItems,
  formatWebMonitorNotification,
  normalizeWebMonitorSettings,
  validateMonitorUrl
} from '../web-monitor.js';

test('网页监控默认每天检查并使用 PT 页面选择器', () => {
  const settings = normalizeWebMonitorSettings({
    monitorUrl: ' https://www.ptyqm.com/category/kfyqzc/ '
  });
  assert.equal(settings.monitorUrl, 'https://www.ptyqm.com/category/kfyqzc/');
  assert.equal(settings.monitorIntervalHours, 24);
  assert.equal(settings.monitorItemSelector, 'h2.entry-title a');
  assert.equal(settings.monitorDateSelector, 'article time[datetime]');
  assert.equal(settings.monitorSummarySelector, 'article .entry-content');
});

test('仅允许公网 HTTP/HTTPS 监控地址', () => {
  assert.equal(validateMonitorUrl('https://www.ptyqm.com/category/kfyqzc/').hostname, 'www.ptyqm.com');
  for (const url of ['file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/']) {
    assert.throws(() => validateMonitorUrl(url));
  }
});

test('按文章永久链接识别新内容', () => {
  const subscription = { monitorSeenUrls: ['https://example.com/old'] };
  const items = [
    { title: '新内容', url: 'https://example.com/new' },
    { title: '旧内容', url: 'https://example.com/old' }
  ];
  assert.deepEqual(findNewWebMonitorItems(subscription, items), [items[0]]);
});

test('通知正文包含文章和监控页链接', () => {
  const content = formatWebMonitorNotification(
    { monitorUrl: 'https://example.com/list' },
    [{ title: '开放注册', url: 'https://example.com/post', publishedAt: '2026-07-15', summary: '摘要' }]
  );
  assert.match(content, /开放注册/);
  assert.match(content, /https:\/\/example\.com\/post/);
  assert.match(content, /https:\/\/example\.com\/list/);
});
