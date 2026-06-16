'use strict';

const SHARE_LINK_PATTERN = /\b(?:vless|vmess|trojan|ss):\/\/[^\s"'<>]+/gi;
const DEFAULT_MAX_NODES = 4;
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 20000;

/**
 * 功能说明：从环境变量收集要探测的节点链接。
 * 参数说明：env 为环境变量对象，fetchImpl 为可替换的 fetch 实现。
 * 返回值说明：返回去重并限量后的分享链接数组。
 */
async function collectShareLinks(env = process.env, fetchImpl = globalThis.fetch) {
  const directLinks = [
    ...splitMultilineSecret(env.XRAY_SHARE_LINK),
    ...splitMultilineSecret(env.XRAY_SHARE_LINKS),
  ];
  const subscriptionUrls = splitMultilineSecret(env.XRAY_SUBSCRIPTION_URLS);
  const subscriptionLinks = await fetchSubscriptionLinks(subscriptionUrls, fetchImpl);
  const maxNodes = getMaxNodes(env.PROBE_MAX_NODES);

  return dedupeLinks([...directLinks, ...subscriptionLinks]).slice(0, maxNodes);
}

/**
 * 功能说明：按行拆分多行 secret，保留链接中的 fragment。
 * 参数说明：value 为 GitHub secret 字符串。
 * 返回值说明：返回非空行数组。
 */
function splitMultilineSecret(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 功能说明：拉取订阅并提取分享链接。
 * 参数说明：subscriptionUrls 为订阅 URL 数组，fetchImpl 为 fetch 函数。
 * 返回值说明：返回订阅内提取出的分享链接数组。
 */
async function fetchSubscriptionLinks(subscriptionUrls, fetchImpl) {
  if (subscriptionUrls.length === 0) {
    return [];
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required to read subscription urls');
  }

  const links = [];
  for (const subscriptionUrl of subscriptionUrls) {
    const content = await fetchSubscription(subscriptionUrl, fetchImpl);
    links.push(...extractShareLinks(content));
  }

  return links;
}

/**
 * 功能说明：下载单个订阅内容。
 * 参数说明：subscriptionUrl 为订阅地址，fetchImpl 为 fetch 函数。
 * 返回值说明：返回订阅文本。
 */
async function fetchSubscription(subscriptionUrl, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_SUBSCRIPTION_TIMEOUT_MS);

  try {
    const response = await fetchImpl(subscriptionUrl, {
      headers: { 'user-agent': 'xray-v4-prober/1.0' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`subscription returned status ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 功能说明：从订阅文本中提取分享链接，兼容 base64 和明文订阅。
 * 参数说明：content 为订阅响应正文。
 * 返回值说明：返回分享链接数组。
 */
function extractShareLinks(content) {
  const plainLinks = matchShareLinks(content);

  if (plainLinks.length > 0) {
    return plainLinks;
  }

  return matchShareLinks(decodeBase64(content));
}

/**
 * 功能说明：用正则提取常见代理分享链接。
 * 参数说明：content 为订阅文本。
 * 返回值说明：返回链接数组。
 */
function matchShareLinks(content) {
  return Array.from(String(content).matchAll(SHARE_LINK_PATTERN), (match) => match[0]);
}

/**
 * 功能说明：解析单次最多探测节点数，避免 Actions 额度被误刷。
 * 参数说明：value 为 PROBE_MAX_NODES 环境变量。
 * 返回值说明：返回 1 到 20 之间的整数。
 */
function getMaxNodes(value) {
  const maxNodes = Number(value || DEFAULT_MAX_NODES);

  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 20) {
    throw new Error('PROBE_MAX_NODES must be an integer between 1 and 20');
  }

  return maxNodes;
}

/**
 * 功能说明：按完整链接去重，避免同一个节点重复消耗时间。
 * 参数说明：links 为候选分享链接数组。
 * 返回值说明：返回去重后的链接数组。
 */
function dedupeLinks(links) {
  return Array.from(new Set(links));
}

/**
 * 功能说明：兼容标准 base64 和 URL-safe base64。
 * 参数说明：value 为 base64 文本。
 * 返回值说明：返回 utf8 明文。
 */
function decodeBase64(value) {
  const compactValue = String(value).replace(/\s+/g, '');
  const normalizedValue = compactValue.replace(/-/g, '+').replace(/_/g, '/');
  const paddedValue = normalizedValue.padEnd(
    normalizedValue.length + ((4 - (normalizedValue.length % 4)) % 4),
    '=',
  );

  return Buffer.from(paddedValue, 'base64').toString('utf8');
}

module.exports = {
  collectShareLinks,
  extractShareLinks,
  splitMultilineSecret,
};
