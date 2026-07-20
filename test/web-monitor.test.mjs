import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWebMonitorSubscription,
  findNewWebMonitorItems,
  findWebMonitorChanges,
  formatWebMonitorNotification,
  getWebMonitorItemFingerprint,
  isScheduledWebMonitorDue,
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

test('同一文章链接的标题或发布时间变化会识别为内容更新', () => {
  const url = 'https://example.com/reused-post';
  const previous = { title: '旧一轮开放注册', url, publishedAt: '2026-03-10', summary: '旧内容' };
  const current = { title: '新一轮开放注册', url, publishedAt: '2026-07-15', summary: '新内容' };
  const subscription = {
    monitorSeenUrls: [url],
    monitorItemFingerprints: { [url]: getWebMonitorItemFingerprint(previous) }
  };

  assert.deepEqual(findWebMonitorChanges(subscription, [current]), [
    { ...current, changeType: 'updated' }
  ]);
});

test('旧订阅首次升级时静默建立指纹，但仍识别真正的新链接', () => {
  const oldItem = { title: '已记录文章', url: 'https://example.com/old', publishedAt: '2026-03-10' };
  const newItem = { title: '新文章', url: 'https://example.com/new', publishedAt: '2026-07-20' };
  const subscription = { monitorSeenUrls: [oldItem.url] };

  assert.deepEqual(findWebMonitorChanges(subscription, [oldItem]), []);
  assert.deepEqual(findWebMonitorChanges(subscription, [oldItem, newItem]), [
    { ...newItem, changeType: 'new' }
  ]);
});

test('存在发布时间时内容指纹忽略易变的浏览量摘要', () => {
  const base = { title: '开放注册', url: 'https://example.com/post', publishedAt: '2026-07-20' };
  assert.equal(
    getWebMonitorItemFingerprint({ ...base, summary: '浏览量 100' }),
    getWebMonitorItemFingerprint({ ...base, summary: '浏览量 101' })
  );
});

test('没有发布时间时内容指纹使用摘要识别更新', () => {
  const base = { title: '开放注册', url: 'https://example.com/post' };
  assert.notEqual(
    getWebMonitorItemFingerprint({ ...base, summary: '第一轮注册' }),
    getWebMonitorItemFingerprint({ ...base, summary: '第二轮注册' })
  );
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

test('旧链接内容变化在通知中标记为内容更新', () => {
  const content = formatWebMonitorNotification(
    { monitorUrl: 'https://example.com/list' },
    [{ title: '星云 PT 开放注册', url: 'https://example.com/post', publishedAt: '2026-07-15', changeType: 'updated' }]
  );
  assert.match(content, /内容更新：星云 PT 开放注册/);
});

test('manual checks do not delay scheduled web monitor checks', () => {
  const subscription = {
    monitorIntervalHours: 24,
    monitorLastCheckedAt: '2026-07-15T08:13:00.000Z',
    monitorLastScheduledAt: null
  };

  assert.equal(isScheduledWebMonitorDue(subscription, '2026-07-16T08:00:00.000Z'), true);
});

test('scheduled checks use the previous scheduled run for their interval', () => {
  const subscription = {
    monitorIntervalHours: 24,
    monitorLastScheduledAt: '2026-07-15T08:00:00.000Z'
  };

  assert.equal(isScheduledWebMonitorDue(subscription, '2026-07-16T07:59:59.999Z'), false);
  assert.equal(isScheduledWebMonitorDue(subscription, '2026-07-16T08:00:00.000Z'), true);
});

test('scheduled runs persist their own timestamp', async () => {
  let savedSubscription;
  const now = new Date('2026-07-16T08:00:00.000Z');
  const result = await checkWebMonitorSubscription(
    { monitorUrl: 'https://example.com/list' },
    {
      save: async subscription => { savedSubscription = subscription; },
      notify: async () => ({ successCount: 1 })
    },
    {
      now,
      isScheduled: true,
      fetchImpl: async () => { throw new Error('offline'); }
    }
  );

  assert.equal(result.status, 'error');
  assert.equal(savedSubscription.monitorLastScheduledAt, now.toISOString());
});
