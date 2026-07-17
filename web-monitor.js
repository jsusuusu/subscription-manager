const DEFAULT_ITEM_SELECTOR = 'h2.entry-title a';
const DEFAULT_DATE_SELECTOR = 'article time[datetime]';
const DEFAULT_SUMMARY_SELECTOR = 'article .entry-content';
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_MAX_ITEMS = 20;
const MAX_SEEN_URLS = 200;
const MAX_TEXT_LENGTH = 600;
const MAX_REDIRECTS = 5;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeSelector(value, fallback) {
  const selector = typeof value === 'string' ? value.trim() : '';
  return selector || fallback;
}

export function normalizeWebMonitorSettings(source = {}) {
  return {
    monitorUrl: typeof source.monitorUrl === 'string' ? source.monitorUrl.trim() : '',
    monitorItemSelector: normalizeSelector(source.monitorItemSelector, DEFAULT_ITEM_SELECTOR),
    monitorDateSelector: normalizeSelector(source.monitorDateSelector, DEFAULT_DATE_SELECTOR),
    monitorSummarySelector: normalizeSelector(source.monitorSummarySelector, DEFAULT_SUMMARY_SELECTOR),
    monitorIntervalHours: clampNumber(source.monitorIntervalHours, DEFAULT_INTERVAL_HOURS, 1, 168),
    monitorMaxItems: clampNumber(source.monitorMaxItems, DEFAULT_MAX_ITEMS, 1, 50)
  };
}

export function isScheduledWebMonitorDue(subscription = {}, scheduledAt = new Date()) {
  const scheduledTimestamp = scheduledAt instanceof Date
    ? scheduledAt.getTime()
    : new Date(scheduledAt).getTime();
  const lastScheduledTimestamp = subscription.monitorLastScheduledAt
    ? new Date(subscription.monitorLastScheduledAt).getTime()
    : NaN;

  if (!Number.isFinite(scheduledTimestamp)) return false;
  if (!Number.isFinite(lastScheduledTimestamp)) return true;

  const { monitorIntervalHours } = normalizeWebMonitorSettings(subscription);
  return scheduledTimestamp - lastScheduledTimestamp >= monitorIntervalHours * 60 * 60 * 1000;
}

export function validateMonitorUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('监控网址格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('监控网址只支持 HTTP 或 HTTPS');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpv6 = host.includes(':');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    (isIpv6 && (
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('::ffff:127.') ||
      host.startsWith('::ffff:10.') ||
      host.startsWith('::ffff:192.168.')
    ))
  ) {
    throw new Error('不允许监控本机或内网地址');
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some(part => part < 0 || part > 255)) {
      throw new Error('监控网址 IP 地址无效');
    }
    const [a, b] = parts;
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      throw new Error('不允许监控本机或内网地址');
    }
  }
  return url;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
}

class ElementCollector {
  constructor(limit, attribute = null) {
    this.limit = limit;
    this.attribute = attribute;
    this.items = [];
    this.current = null;
  }

  element(element) {
    if (this.items.length >= this.limit) {
      this.current = null;
      return;
    }
    const item = {
      text: '',
      attribute: this.attribute ? (element.getAttribute(this.attribute) || '') : ''
    };
    this.items.push(item);
    this.current = item;
    element.onEndTag(() => {
      if (this.current === item) this.current = null;
    });
  }

  text(text) {
    if (!this.current || this.current.text.length >= MAX_TEXT_LENGTH) return;
    this.current.text += text.text;
  }
}

export async function extractWebMonitorItems(response, settings, pageUrl) {
  const itemCollector = new ElementCollector(settings.monitorMaxItems, 'href');
  const dateCollector = new ElementCollector(settings.monitorMaxItems, 'datetime');
  const summaryCollector = new ElementCollector(settings.monitorMaxItems);

  let rewriter = new HTMLRewriter().on(settings.monitorItemSelector, itemCollector);
  if (settings.monitorDateSelector) rewriter = rewriter.on(settings.monitorDateSelector, dateCollector);
  if (settings.monitorSummarySelector) rewriter = rewriter.on(settings.monitorSummarySelector, summaryCollector);
  await rewriter.transform(response).text();

  const seen = new Set();
  const items = [];
  for (let index = 0; index < itemCollector.items.length; index += 1) {
    const source = itemCollector.items[index];
    const title = compactText(source.text);
    let itemUrl = '';
    try {
      itemUrl = new URL(source.attribute || '', pageUrl).href;
    } catch {
      itemUrl = '';
    }
    if (!itemUrl || seen.has(itemUrl)) continue;
    seen.add(itemUrl);
    const dateSource = dateCollector.items[index];
    const summarySource = summaryCollector.items[index];
    items.push({
      title: title || itemUrl,
      url: itemUrl,
      publishedAt: compactText(dateSource?.attribute || dateSource?.text || ''),
      summary: compactText(summarySource?.text || '')
    });
  }
  return items;
}

async function fetchWithSafeRedirects(initialUrl, fetchImpl) {
  let currentUrl = validateMonitorUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl.href, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'SubscriptionManager-WebMonitor/1.0'
      },
      redirect: 'manual'
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, pageUrl: currentUrl };
    }
    const location = response.headers.get('Location');
    if (!location) throw new Error('网页重定向缺少目标地址');
    if (redirectCount === MAX_REDIRECTS) throw new Error('网页重定向次数过多');
    currentUrl = validateMonitorUrl(new URL(location, currentUrl).href);
  }
  throw new Error('网页重定向次数过多');
}

export async function fetchWebMonitorItems(subscription, fetchImpl = fetch) {
  const settings = normalizeWebMonitorSettings(subscription);
  const { response, pageUrl } = await fetchWithSafeRedirects(settings.monitorUrl, fetchImpl);
  if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）`);
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error('监控地址返回的不是 HTML 页面');
  }
  const items = await extractWebMonitorItems(response, settings, pageUrl);
  if (items.length === 0) {
    throw new Error(`选择器未找到任何内容：${settings.monitorItemSelector}`);
  }
  return items;
}

function mergeSeenUrls(current, previous) {
  const merged = [];
  const seen = new Set();
  for (const url of [...current, ...previous]) {
    if (typeof url !== 'string' || !url || seen.has(url)) continue;
    seen.add(url);
    merged.push(url);
    if (merged.length >= MAX_SEEN_URLS) break;
  }
  return merged;
}

export function findNewWebMonitorItems(subscription, items) {
  const seen = new Set(Array.isArray(subscription.monitorSeenUrls) ? subscription.monitorSeenUrls : []);
  return items.filter(item => !seen.has(item.url));
}

export function formatWebMonitorNotification(subscription, items) {
  const blocks = items.slice(0, 10).map(item => {
    const parts = [`新内容：${item.title || '发现新内容'}`];
    if (item.publishedAt) parts.push(`发布时间：${item.publishedAt}`);
    if (item.summary) parts.push(item.summary);
    parts.push(item.url);
    return parts.join('\n');
  });
  if (items.length > 10) blocks.push(`另有 ${items.length - 10} 条新内容，请打开监控页查看。`);
  blocks.push(`监控页面：${subscription.monitorUrl}`);
  return blocks.join('\n\n');
}

export async function checkWebMonitorSubscription(subscription, callbacks, options = {}) {
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const fetchImpl = options.fetchImpl || fetch;
  const scheduledState = options.isScheduled ? { monitorLastScheduledAt: nowIso } : {};

  try {
    const items = await fetchWebMonitorItems(subscription, fetchImpl);
    const currentUrls = items.map(item => item.url);
    const previousSeen = Array.isArray(subscription.monitorSeenUrls) ? subscription.monitorSeenUrls : [];

    if (!subscription.monitorInitializedAt) {
      const next = {
        ...subscription,
        ...scheduledState,
        monitorSeenUrls: mergeSeenUrls(currentUrls, previousSeen),
        monitorInitializedAt: nowIso,
        monitorLastCheckedAt: nowIso,
        monitorLastAttemptAt: nowIso,
        monitorStatus: 'ready',
        monitorLastError: '',
        monitorLatestTitle: items[0]?.title || '',
        monitorLatestUrl: items[0]?.url || '',
        updatedAt: nowIso
      };
      await callbacks.save(next);
      return { status: 'initialized', itemCount: items.length, newItems: [], sentCount: 0, subscription: next };
    }

    const newItems = findNewWebMonitorItems(subscription, items);
    let notificationResult = null;
    let shouldCommitNewUrls = newItems.length === 0;
    if (newItems.length > 0) {
      notificationResult = await callbacks.notify(
        `网页更新：${subscription.name}`,
        formatWebMonitorNotification(subscription, newItems),
        subscription
      );
      shouldCommitNewUrls = Number(notificationResult?.successCount || 0) > 0;
    }

    const next = {
      ...subscription,
      ...scheduledState,
      monitorSeenUrls: shouldCommitNewUrls ? mergeSeenUrls(currentUrls, previousSeen) : previousSeen,
      monitorLastCheckedAt: shouldCommitNewUrls ? nowIso : (subscription.monitorLastCheckedAt || null),
      monitorLastAttemptAt: nowIso,
      monitorStatus: newItems.length > 0 && !shouldCommitNewUrls ? 'notify-error' : 'ready',
      monitorLastError: newItems.length > 0 && !shouldCommitNewUrls ? '发现新内容，但所有通知渠道均发送失败' : '',
      monitorLatestTitle: items[0]?.title || '',
      monitorLatestUrl: items[0]?.url || '',
      monitorLastNewItemAt: newItems.length > 0 && shouldCommitNewUrls ? nowIso : (subscription.monitorLastNewItemAt || null),
      updatedAt: nowIso
    };
    await callbacks.save(next);
    return {
      status: newItems.length === 0 ? 'unchanged' : (shouldCommitNewUrls ? 'notified' : 'notify-error'),
      itemCount: items.length,
      newItems,
      sentCount: Number(notificationResult?.successCount || 0),
      subscription: next
    };
  } catch (error) {
    const message = error?.message || String(error);
    const next = {
      ...subscription,
      ...scheduledState,
      monitorLastAttemptAt: nowIso,
      monitorStatus: 'error',
      monitorLastError: message,
      updatedAt: nowIso
    };
    await callbacks.save(next);
    return { status: 'error', itemCount: 0, newItems: [], sentCount: 0, error: message, subscription: next };
  }
}
