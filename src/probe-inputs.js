'use strict';

const YAML = require('yaml');

const SHARE_LINK_PATTERN = /\b(?:vless|vmess|trojan|ss):\/\/[^\s"'<>]+/gi;
const DEFAULT_MAX_NODES = 4;
const MAX_NODES = 100;
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 20000;
const DEFAULT_SUBSCRIPTION_USER_AGENTS = [
  'sing-box/1.12.0',
  'v2rayN/7.0',
  'NekoBox/4.0',
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
  const plan = await collectProbePlan(env, fetchImpl);
  return plan.inputs;
}

/**
 * 功能说明：收集探测计划，保留订阅原文和节点来源用于后续私密发布。
 * 参数说明：env 为环境变量对象，fetchImpl 为可替换的 fetch 实现。
 * 返回值说明：返回 inputs 和 subscriptionDocuments。
 */
async function collectProbePlan(env = process.env, fetchImpl = globalThis.fetch) {
  const directLinks = [
    ...splitMultilineSecret(env.XRAY_SHARE_LINK),
    ...splitMultilineSecret(env.XRAY_SHARE_LINKS),
  ].map((shareLink) => ({ shareLink, source: { type: 'direct' } }));
  const subscriptionUrls = splitMultilineSecret(env.XRAY_SUBSCRIPTION_URLS);
  const subscriptionDocuments = await fetchSubscriptionDocuments(subscriptionUrls, env, fetchImpl);
  const subscriptionInputs = subscriptionDocuments.flatMap((document) =>
    extractDocumentInputs(document),
  );
  const maxNodes = getMaxNodes(env.PROBE_MAX_NODES);

  return {
    inputs: dedupeProbeInputs([...directLinks, ...subscriptionInputs]).slice(0, maxNodes),
    subscriptionDocuments,
  };
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
  const documents = await fetchSubscriptionDocuments(subscriptionUrls, env, fetchImpl);
  return documents.flatMap((document) => extractDocumentInputs(document));
}

/**
 * 功能说明：拉取订阅原文并保留来源索引。
 * 参数说明：subscriptionUrls 为订阅 URL 数组，env 为环境变量对象，fetchImpl 为 fetch 函数。
 * 返回值说明：返回订阅文档数组。
 */
async function fetchSubscriptionDocuments(subscriptionUrls, env, fetchImpl) {
  if (subscriptionUrls.length === 0) {
    return [];
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required to read subscription urls');
  }

  const documents = [];
  const userAgents = getSubscriptionUserAgents(env.SUBSCRIPTION_USER_AGENT);
  for (const [documentIndex, subscriptionUrl] of subscriptionUrls.entries()) {
    const content = await fetchSubscription(subscriptionUrl, userAgents, fetchImpl);
    const extractedInputs = extractProbeInputs(content);

    if (extractedInputs.length === 0) {
      console.error(`subscription format summary: ${describeSubscriptionContent(content)}`);
    }

    documents.push({ documentIndex, content });
  }

  return documents;
}

/**
 * 功能说明：提取单个订阅文档中的节点并记录来源位置。
 * 参数说明：document 为订阅文档。
 * 返回值说明：返回带 source 的节点输入数组。
 */
function extractDocumentInputs(document) {
  return extractProbeInputs(document.content).map((input, nodeIndex) => ({
    ...input,
    source: {
      type: 'subscription',
      documentIndex: document.documentIndex,
      nodeIndex,
    },
  }));
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

  const jsonInputs = extractSingBoxJsonInputs(content);

  if (jsonInputs.length > 0) {
    return jsonInputs;
  }

  const decodedContent = decodeBase64(content);
  const decodedYamlInputs = extractClashYamlInputs(decodedContent);

  if (decodedYamlInputs.length > 0) {
    return decodedYamlInputs;
  }

  return extractSingBoxJsonInputs(decodedContent);
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
  const proxies = getYamlProxyList(parsedConfig);

  return proxies.map(convertClashProxy).filter(Boolean);
}

/**
 * 功能说明：读取 Clash/Mihomo YAML 中的 proxies 列表。
 * 参数说明：parsedConfig 为 YAML 解析结果。
 * 返回值说明：返回代理数组。
 */
function getYamlProxyList(parsedConfig) {
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return [];
  }

  for (const key of ['proxies', 'Proxies', 'proxy', 'Proxy']) {
    if (Array.isArray(parsedConfig[key])) {
      return parsedConfig[key];
    }
  }

  return [];
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
 * 功能说明：从 sing-box JSON 配置中提取代理节点。
 * 参数说明：content 为 JSON 文本。
 * 返回值说明：返回可直接传给 probeNodeIpv4 的节点输入。
 */
function extractSingBoxJsonInputs(content) {
  const parsedConfig = parseJson(content);
  const outbounds = Array.isArray(parsedConfig?.outbounds)
    ? parsedConfig.outbounds
    : getArrayConfig(parsedConfig);

  return outbounds.map(convertSingBoxOutbound).filter(Boolean);
}

/**
 * 功能说明：解析 JSON，避免非 JSON 订阅导致流程中断。
 * 参数说明：content 为候选 JSON 文本。
 * 返回值说明：解析成功返回对象，失败返回 null。
 */
function parseJson(content) {
  try {
    return JSON.parse(String(content));
  } catch (error) {
    return null;
  }
}

/**
 * 功能说明：兼容直接返回 outbound 数组的订阅。
 * 参数说明：parsedConfig 为 JSON 解析结果。
 * 返回值说明：返回数组配置或空数组。
 */
function getArrayConfig(parsedConfig) {
  return Array.isArray(parsedConfig) ? parsedConfig : [];
}

/**
 * 功能说明：生成订阅内容的安全格式摘要，帮助排查解析失败。
 * 参数说明：content 为订阅响应正文。
 * 返回值说明：返回不包含正文和节点密钥的摘要字符串。
 */
function describeSubscriptionContent(content) {
  const text = String(content);
  const jsonConfig = parseJson(text);
  const yamlConfig = parseYaml(text);
  const decodedText = decodeBase64(text);
  const decodedJsonConfig = parseJson(decodedText);
  const decodedYamlConfig = parseYaml(decodedText);

  return JSON.stringify({
    length: text.length,
    hasShareLinks: matchShareLinks(text).length > 0,
    json: describeParsedConfig(jsonConfig),
    yaml: describeParsedConfig(yamlConfig),
    decodedLength: decodedText === text ? 0 : decodedText.length,
    decodedHasShareLinks: decodedText === text ? false : matchShareLinks(decodedText).length > 0,
    decodedJson: describeParsedConfig(decodedJsonConfig),
    decodedYaml: describeParsedConfig(decodedYamlConfig),
  });
}

/**
 * 功能说明：描述解析后配置的结构，不包含字段值。
 * 参数说明：config 为 JSON/YAML 解析结果。
 * 返回值说明：返回结构摘要。
 */
function describeParsedConfig(config) {
  if (!config || typeof config !== 'object') {
    return { type: typeof config };
  }

  if (Array.isArray(config)) {
    return { type: 'array', length: config.length };
  }

  return {
    type: 'object',
    keys: Object.keys(config).slice(0, 20),
    proxies: getYamlProxyList(config).length,
    outbounds: Array.isArray(config.outbounds) ? config.outbounds.length : 0,
  };
}

/**
 * 功能说明：把 sing-box outbound 转成 Xray outbound。
 * 参数说明：outbound 为 sing-box outbounds 列表中的单个节点。
 * 返回值说明：支持的节点返回探测输入，不支持返回 null。
 */
function convertSingBoxOutbound(outbound) {
  if (!outbound || typeof outbound !== 'object') {
    return null;
  }

  if (outbound.type === 'vless') {
    return convertSingBoxVless(outbound);
  }

  if (outbound.type === 'vmess') {
    return convertSingBoxVmess(outbound);
  }

  if (outbound.type === 'trojan') {
    return convertSingBoxTrojan(outbound);
  }

  if (outbound.type === 'shadowsocks') {
    return convertSingBoxShadowsocks(outbound);
  }

  return null;
}

/**
 * 功能说明：转换 sing-box VLESS 出站。
 * 参数说明：outbound 为 sing-box VLESS outbound。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertSingBoxVless(outbound) {
  return {
    nodeName: outbound.tag || 'vless-node',
    outbound: {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: outbound.server,
            port: Number(outbound.server_port),
            users: [
              {
                id: outbound.uuid,
                encryption: 'none',
                ...(outbound.flow ? { flow: outbound.flow } : {}),
              },
            ],
          },
        ],
      },
      streamSettings: buildSingBoxStreamSettings(outbound),
    },
  };
}

/**
 * 功能说明：转换 sing-box VMess 出站。
 * 参数说明：outbound 为 sing-box VMess outbound。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertSingBoxVmess(outbound) {
  return {
    nodeName: outbound.tag || 'vmess-node',
    outbound: {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: outbound.server,
            port: Number(outbound.server_port),
            users: [
              {
                id: outbound.uuid,
                alterId: Number(outbound.alter_id || 0),
                security: outbound.security || 'auto',
              },
            ],
          },
        ],
      },
      streamSettings: buildSingBoxStreamSettings(outbound),
    },
  };
}

/**
 * 功能说明：转换 sing-box Trojan 出站。
 * 参数说明：outbound 为 sing-box Trojan outbound。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertSingBoxTrojan(outbound) {
  return {
    nodeName: outbound.tag || 'trojan-node',
    outbound: {
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address: outbound.server,
            port: Number(outbound.server_port),
            password: outbound.password,
          },
        ],
      },
      streamSettings: buildSingBoxStreamSettings(outbound),
    },
  };
}

/**
 * 功能说明：转换 sing-box Shadowsocks 出站。
 * 参数说明：outbound 为 sing-box Shadowsocks outbound。
 * 返回值说明：返回 Xray outbound 探测输入。
 */
function convertSingBoxShadowsocks(outbound) {
  return {
    nodeName: outbound.tag || 'ss-node',
    outbound: {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: outbound.server,
            port: Number(outbound.server_port),
            method: outbound.method,
            password: outbound.password,
          },
        ],
      },
    },
  };
}

/**
 * 功能说明：转换 sing-box 出站的传输层配置。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 Xray streamSettings。
 */
function buildSingBoxStreamSettings(outbound) {
  const network = outbound.transport?.type || 'tcp';
  const streamSettings = {
    network: mapSingBoxNetwork(network),
    security: getSingBoxSecurity(outbound),
  };

  if (streamSettings.security === 'tls') {
    streamSettings.tlsSettings = buildSingBoxTlsSettings(outbound);
  }

  if (streamSettings.security === 'reality') {
    streamSettings.realitySettings = buildSingBoxRealitySettings(outbound);
  }

  if (streamSettings.network === 'ws') {
    streamSettings.wsSettings = buildSingBoxWsSettings(outbound);
  }

  if (streamSettings.network === 'grpc') {
    streamSettings.grpcSettings = buildSingBoxGrpcSettings(outbound);
  }

  return streamSettings;
}

/**
 * 功能说明：映射 sing-box transport 类型到 Xray network。
 * 参数说明：network 为 sing-box transport.type。
 * 返回值说明：返回 Xray network。
 */
function mapSingBoxNetwork(network) {
  if (network === 'httpupgrade') {
    return 'httpupgrade';
  }

  return network;
}

/**
 * 功能说明：判断 sing-box 出站安全层。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 Xray security 值。
 */
function getSingBoxSecurity(outbound) {
  if (outbound.tls?.reality?.enabled) {
    return 'reality';
  }

  return outbound.tls?.enabled ? 'tls' : 'none';
}

/**
 * 功能说明：转换 sing-box TLS 参数。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 tlsSettings。
 */
function buildSingBoxTlsSettings(outbound) {
  return {
    serverName: outbound.tls?.server_name || outbound.server,
    ...(outbound.tls?.utls?.fingerprint
      ? { fingerprint: outbound.tls.utls.fingerprint }
      : {}),
    ...(outbound.tls?.insecure ? { allowInsecure: true } : {}),
  };
}

/**
 * 功能说明：转换 sing-box Reality 参数。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 realitySettings。
 */
function buildSingBoxRealitySettings(outbound) {
  return {
    serverName: outbound.tls?.server_name || '',
    fingerprint: outbound.tls?.utls?.fingerprint || 'chrome',
    publicKey: outbound.tls?.reality?.public_key || '',
    shortId: outbound.tls?.reality?.short_id || '',
  };
}

/**
 * 功能说明：转换 sing-box WebSocket 参数。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 wsSettings。
 */
function buildSingBoxWsSettings(outbound) {
  const transport = outbound.transport || {};
  const host = transport.headers?.Host || transport.headers?.host;
  const wsSettings = {
    path: transport.path || '/',
  };

  if (host) {
    wsSettings.headers = { Host: host };
  }

  return wsSettings;
}

/**
 * 功能说明：转换 sing-box gRPC 参数。
 * 参数说明：outbound 为 sing-box outbound。
 * 返回值说明：返回 grpcSettings。
 */
function buildSingBoxGrpcSettings(outbound) {
  return {
    serviceName: outbound.transport?.service_name || '',
  };
}

/**
 * 功能说明：解析单次最多探测节点数，避免 Actions 额度被误刷。
 * 参数说明：value 为 PROBE_MAX_NODES 环境变量。
 * 返回值说明：返回 1 到 100 之间的整数。
 */
function getMaxNodes(value) {
  const maxNodes = Number(value || DEFAULT_MAX_NODES);

  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_NODES) {
    throw new Error(`PROBE_MAX_NODES must be an integer between 1 and ${MAX_NODES}`);
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
  collectProbePlan,
  collectProbeInputs,
  collectShareLinks,
  describeSubscriptionContent,
  extractProbeInputs,
  extractShareLinks,
  splitMultilineSecret,
};
