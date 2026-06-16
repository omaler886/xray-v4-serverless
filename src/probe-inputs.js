'use strict';

const YAML = require('yaml');

const SHARE_LINK_PATTERN = /\b(?:vless|vmess|trojan|ss):\/\/[^\s"'<>]+/gi;
const DEFAULT_MAX_NODES = 4;
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 20000;
const DEFAULT_SUBSCRIPTION_USER_AGENTS = [
  'ClashforWindows/0.20.39',
  'clash.meta',
  'ClashX Pro/1.118.0.1',
  'Shadowrocket/1997 CFNetwork/1496.0.7 Darwin/23.5.0',
  'xray-v4-prober/1.0',
];

/**
 * 功能说明：从环境变量收集要探测的节点链接。
 * 参数说明：env 为环境变量对象，fetchImpl 为可替换的 fetch 实现。
 * 返回值说明：返回去重并限量后的分享链接数组。
 */
async function collectShareLinks(env = process.env, fetchImpl = globalThis.fetch) {
  const probeInputs = await collectProbeInputs(env, fetchImpl);
  return probeInputs.filter((input) => input.shareLink).map((input) => input.shareLink);
}

/**
 * 功能说明：从环境变量收集要探测的节点输入。
 * 参数说明：env 为环境变量对象，fetchImpl 为可替换的 fetch 实现。
 * 返回值说明：返回去重并限量后的节点输入数组。
 */
async function collectProbeInputs(env = process.env, fetchImpl = globalThis.fetch) {
  const directLinks = [
    ...splitMultilineSecret(env.XRAY_SHARE_LINK),
    ...splitMultilineSecret(env.XRAY_SHARE_LINKS),
  ].map((shareLink) => ({ shareLink }));
  const subscriptionUrls = splitMultilineSecret(env.XRAY_SUBSCRIPTION_URLS);
  const subscriptionInputs = await fetchSubscriptionInputs(subscriptionUrls, env, fetchImpl);
  const maxNodes = getMaxNodes(env.PROBE_MAX_NODES);

  return dedupeProbeInputs([...directLinks, ...subscriptionInputs]).slice(0, maxNodes);
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
 * 功能说明：拉取订阅并提取可探测节点。
 * 参数说明：subscriptionUrls 为订阅 URL 数组，env 为环境变量对象，fetchImpl 为 fetch 函数。
 * 返回值说明：返回订阅内提取出的节点输入数组。
 */
async function fetchSubscriptionInputs(subscriptionUrls, env, fetchImpl) {
  if (subscriptionUrls.length === 0) {
    return [];
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required to read subscription urls');
  }

  const inputs = [];
  const userAgents = getSubscriptionUserAgents(env.SUBSCRIPTION_USER_AGENT);
  for (const subscriptionUrl of subscriptionUrls) {
    const content = await fetchSubscription(subscriptionUrl, userAgents, fetchImpl);
    inputs.push(...extractProbeInputs(content));
  }

  return inputs;
}

/**
 * 功能说明：下载单个订阅内容。
 * 参数说明：subscriptionUrl 为订阅地址，userAgents 为候选客户端 UA，fetchImpl 为 fetch 函数。
 * 返回值说明：返回订阅文本。
 */
async function fetchSubscription(subscriptionUrl, userAgents, fetchImpl) {
  let lastStatus = null;

  for (const userAgent of userAgents) {
    const response = await fetchSubscriptionWithUserAgent(subscriptionUrl, userAgent, fetchImpl);

    if (response.ok) {
      return await response.text();
    }

    lastStatus = response.status;

    // 403/429 常由 UA 或频率触发，换常见客户端 UA 再试。
    if (response.status !== 403 && response.status !== 429) {
      break;
    }
  }

  throw new Error(`subscription returned status ${lastStatus}`);
}

/**
 * 功能说明：使用指定 User-Agent 拉取订阅。
 * 参数说明：subscriptionUrl 为订阅地址，userAgent 为客户端标识，fetchImpl 为 fetch 函数。
 * 返回值说明：返回 fetch Response 对象。
 */
async function fetchSubscriptionWithUserAgent(subscriptionUrl, userAgent, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_SUBSCRIPTION_TIMEOUT_MS);

  try {
    return await fetchImpl(subscriptionUrl, {
      headers: {
        accept: '*/*',
        'user-agent': userAgent,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 功能说明：整理订阅拉取使用的 User-Agent 列表。
 * 参数说明：customUserAgent 为用户指定的客户端 UA。
 * 返回值说明：返回去重后的 UA 数组。
 */
function getSubscriptionUserAgents(customUserAgent) {
  return dedupeLinks([
    ...splitMultilineSecret(customUserAgent),
    ...DEFAULT_SUBSCRIPTION_USER_AGENTS,
  ]);
}

/**
 * 功能说明：从订阅文本中提取可探测节点，兼容分享链接和 Clash YAML。
 * 参数说明：content 为订阅响应正文。
 * 返回值说明：返回节点输入数组。
 */
function extractProbeInputs(content) {
  const shareLinks = extractShareLinks(content);

  if (shareLinks.length > 0) {
    return shareLinks.map((shareLink) => ({ shareLink }));
  }

  const yamlInputs = extractClashYamlInputs(content);

  if (yamlInputs.length > 0) {
    return yamlInputs;
  }

  const decodedContent = decodeBase64(content);
  return extractClashYamlInputs(decodedContent);
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
 * 功能说明：从 Clash/Mihomo YAML 订阅中提取代理节点。
 * 参数说明：content 为 YAML 文本。
 * 返回值说明：返回可直接传给 probeNodeIpv4 的节点输入。
 */
function extractClashYamlInputs(content) {
  const parsedConfig = parseYaml(content);
  const proxies = Array.isArray(parsedConfig?.proxies) ? parsedConfig.proxies : [];

  return proxies.map(convertClashProxy).filter(Boolean);
}

/**
 * 功能说明：安全解析 YAML，避免非 YAML 订阅导致流程中断。
 * 参数说明：content 为候选 YAML 文本。
 * 返回值说明：解析成功返回对象，失败返回 null。
 */
function parseYaml(content) {
  try {
    return YAML.parse(String(content));
  } catch (error) {
    return null;
  }
}

/**
 * 功能说明：把 Clash/Mihomo proxy 转成 Xray outbound。
 * 参数说明：proxy 为 YAML proxies 列表中的单个节点。
 * 返回值说明：支持的节点返回探测输入，不支持返回 null。
 */
function convertClashProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') {
    return null;
  }

  if (proxy.type === 'vless') {
    return convertVlessProxy(proxy);
  }

  if (proxy.type === 'vmess') {
    return convertVmessProxy(proxy);
  }

  if (proxy.type === 'trojan') {
    return convertTrojanProxy(proxy);
  }

  if (proxy.type === 'ss') {
    return convertShadowsocksProxy(proxy);
  }

  return null;
}

/**
 * 功能说明：转换 Clash VLESS 节点。
 * 参数说明：proxy 为 Clash/Mihomo VLESS proxy。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertVlessProxy(proxy) {
  return {
    nodeName: proxy.name || 'vless-node',
    outbound: {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: proxy.server,
            port: Number(proxy.port),
            users: [
              {
                id: proxy.uuid,
                encryption: proxy.encryption || 'none',
                ...(proxy.flow ? { flow: proxy.flow } : {}),
              },
            ],
          },
        ],
      },
      streamSettings: buildClashStreamSettings(proxy),
    },
  };
}

/**
 * 功能说明：转换 Clash VMess 节点。
 * 参数说明：proxy 为 Clash/Mihomo VMess proxy。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertVmessProxy(proxy) {
  return {
    nodeName: proxy.name || 'vmess-node',
    outbound: {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: proxy.server,
            port: Number(proxy.port),
            users: [
              {
                id: proxy.uuid,
                alterId: Number(proxy.alterId || proxy.alterid || 0),
                security: proxy.cipher || 'auto',
              },
            ],
          },
        ],
      },
      streamSettings: buildClashStreamSettings(proxy),
    },
  };
}

/**
 * 功能说明：转换 Clash Trojan 节点。
 * 参数说明：proxy 为 Clash/Mihomo Trojan proxy。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertTrojanProxy(proxy) {
  return {
    nodeName: proxy.name || 'trojan-node',
    outbound: {
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address: proxy.server,
            port: Number(proxy.port),
            password: proxy.password,
          },
        ],
      },
      streamSettings: buildClashStreamSettings(proxy),
    },
  };
}

/**
 * 功能说明：转换 Clash Shadowsocks 节点。
 * 参数说明：proxy 为 Clash/Mihomo Shadowsocks proxy。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertShadowsocksProxy(proxy) {
  return {
    nodeName: proxy.name || 'ss-node',
    outbound: {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: proxy.server,
            port: Number(proxy.port),
            method: proxy.cipher,
            password: proxy.password,
          },
        ],
      },
    },
  };
}

/**
 * 功能说明：转换 Clash 节点的传输层配置。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 Xray streamSettings。
 */
function buildClashStreamSettings(proxy) {
  const network = proxy.network || 'tcp';
  const streamSettings = {
    network,
    security: getClashSecurity(proxy),
  };

  if (streamSettings.security === 'tls') {
    streamSettings.tlsSettings = buildClashTlsSettings(proxy);
  }

  if (streamSettings.security === 'reality') {
    streamSettings.realitySettings = buildClashRealitySettings(proxy);
  }

  if (network === 'ws') {
    streamSettings.wsSettings = buildClashWsSettings(proxy);
  }

  if (network === 'grpc') {
    streamSettings.grpcSettings = buildClashGrpcSettings(proxy);
  }

  return streamSettings;
}

/**
 * 功能说明：判断 Clash 节点使用的安全层。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 Xray security 值。
 */
function getClashSecurity(proxy) {
  if (proxy['reality-opts']) {
    return 'reality';
  }

  return proxy.tls ? 'tls' : 'none';
}

/**
 * 功能说明：转换 TLS 参数。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 tlsSettings。
 */
function buildClashTlsSettings(proxy) {
  return {
    serverName: proxy.servername || proxy.sni || proxy.server,
    ...(proxy['client-fingerprint'] ? { fingerprint: proxy['client-fingerprint'] } : {}),
    ...(proxy.skipCertVerify ? { allowInsecure: true } : {}),
  };
}

/**
 * 功能说明：转换 Reality 参数。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 realitySettings。
 */
function buildClashRealitySettings(proxy) {
  const realityOptions = proxy['reality-opts'] || {};

  return {
    serverName: proxy.servername || proxy.sni || '',
    fingerprint: proxy['client-fingerprint'] || 'chrome',
    publicKey: realityOptions['public-key'] || realityOptions.publicKey || '',
    shortId: realityOptions['short-id'] || realityOptions.shortId || '',
  };
}

/**
 * 功能说明：转换 WebSocket 参数。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 wsSettings。
 */
function buildClashWsSettings(proxy) {
  const wsOptions = proxy['ws-opts'] || {};
  const headers = wsOptions.headers || {};
  const host = headers.Host || headers.host;
  const wsSettings = {
    path: wsOptions.path || '/',
  };

  if (host) {
    wsSettings.headers = { Host: host };
  }

  return wsSettings;
}

/**
 * 功能说明：转换 gRPC 参数。
 * 参数说明：proxy 为 Clash/Mihomo proxy。
 * 返回值说明：返回 grpcSettings。
 */
function buildClashGrpcSettings(proxy) {
  const grpcOptions = proxy['grpc-opts'] || {};

  return {
    serviceName: grpcOptions['grpc-service-name'] || grpcOptions.serviceName || '',
  };
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
 * 功能说明：按节点输入内容去重。
 * 参数说明：inputs 为候选节点输入数组。
 * 返回值说明：返回去重后的节点输入数组。
 */
function dedupeProbeInputs(inputs) {
  const seenKeys = new Set();
  const dedupedInputs = [];

  for (const input of inputs) {
    const key = input.shareLink || JSON.stringify(input.outbound);

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    dedupedInputs.push(input);
  }

  return dedupedInputs;
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
  collectProbeInputs,
  collectShareLinks,
  extractProbeInputs,
  extractShareLinks,
  splitMultilineSecret,
};
