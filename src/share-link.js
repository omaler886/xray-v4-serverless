'use strict';

/**
 * 功能说明：把常见代理分享链接转换为 Xray outbound。
 * 参数说明：shareLink 为 vless/vmess/trojan/ss 分享链接。
 * 返回值说明：返回包含 outbound 和 nodeName 的解析结果。
 */
function parseShareLink(shareLink) {
  if (typeof shareLink !== 'string' || !shareLink.includes('://')) {
    throw new Error('share link must be a valid proxy url');
  }

  if (shareLink.startsWith('vless://')) {
    return parseVlessLink(shareLink);
  }

  if (shareLink.startsWith('vmess://')) {
    return parseVmessLink(shareLink);
  }

  if (shareLink.startsWith('trojan://')) {
    return parseTrojanLink(shareLink);
  }

  if (shareLink.startsWith('ss://')) {
    return parseShadowsocksLink(shareLink);
  }

  throw new Error('only vless://, vmess://, trojan://, and ss:// links are supported');
}

/**
 * 功能说明：解析 VLESS 分享链接。
 * 参数说明：shareLink 为 vless:// 链接。
 * 返回值说明：返回 Xray outbound 和节点名。
 */
function parseVlessLink(shareLink) {
  const url = new URL(shareLink);
  const query = url.searchParams;
  const network = query.get('type') || 'tcp';
  const security = getSecurity(query.get('security'));
  const user = {
    id: decodeURIComponent(url.username),
    encryption: query.get('encryption') || 'none',
  };

  if (query.get('flow')) {
    user.flow = query.get('flow');
  }

  return {
    nodeName: getNodeName(url, 'vless-node'),
    outbound: {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: url.hostname,
            port: getPort(url),
            users: [user],
          },
        ],
      },
      streamSettings: buildStreamSettings(network, security, query),
    },
  };
}

/**
 * 功能说明：解析 VMess 分享链接。
 * 参数说明：shareLink 为 vmess:// 链接。
 * 返回值说明：返回 Xray outbound 和节点名。
 */
function parseVmessLink(shareLink) {
  const rawPayload = shareLink.slice('vmess://'.length).split('#')[0];
  const config = JSON.parse(decodeBase64(rawPayload));
  const query = new URLSearchParams({
    type: config.type || config.net || 'tcp',
    security: config.tls || '',
    sni: config.sni || config.host || '',
    host: config.host || '',
    path: config.path || '',
    serviceName: config.path || '',
    fp: config.fp || '',
    alpn: config.alpn || '',
  });

  return {
    nodeName: config.ps || 'vmess-node',
    outbound: {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: config.add,
            port: Number(config.port),
            users: [
              {
                id: config.id,
                alterId: Number(config.aid || 0),
                security: config.scy || 'auto',
              },
            ],
          },
        ],
      },
      streamSettings: buildStreamSettings(config.net || 'tcp', getSecurity(config.tls), query),
    },
  };
}

/**
 * 功能说明：解析 Trojan 分享链接。
 * 参数说明：shareLink 为 trojan:// 链接。
 * 返回值说明：返回 Xray outbound 和节点名。
 */
function parseTrojanLink(shareLink) {
  const url = new URL(shareLink);
  const query = url.searchParams;
  const security = getSecurity(query.get('security') || 'tls');

  return {
    nodeName: getNodeName(url, 'trojan-node'),
    outbound: {
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address: url.hostname,
            port: getPort(url),
            password: decodeURIComponent(url.username),
          },
        ],
      },
      streamSettings: buildStreamSettings(query.get('type') || 'tcp', security, query),
    },
  };
}

/**
 * 功能说明：解析 Shadowsocks 分享链接。
 * 参数说明：shareLink 为 ss:// 链接。
 * 返回值说明：返回 Xray outbound 和节点名。
 */
function parseShadowsocksLink(shareLink) {
  const parsedLink = parseShadowsocksParts(shareLink);
  const userInfo = decodeBase64IfNeeded(decodeURIComponent(parsedLink.userInfo));
  const separatorIndex = userInfo.indexOf(':');

  if (separatorIndex === -1) {
    throw new Error('invalid ss user info');
  }

  if (parsedLink.url.searchParams.get('plugin')) {
    throw new Error('ss plugin links are not supported by this minimal parser');
  }

  return {
    nodeName: getNodeName(parsedLink.url, 'ss-node'),
    outbound: {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: parsedLink.url.hostname,
            port: getPort(parsedLink.url),
            method: userInfo.slice(0, separatorIndex),
            password: userInfo.slice(separatorIndex + 1),
          },
        ],
      },
    },
  };
}

/**
 * 功能说明：为 Xray 生成 streamSettings。
 * 参数说明：network 为传输层类型，security 为安全层类型，query 为链接参数。
 * 返回值说明：返回 Xray streamSettings 对象。
 */
function buildStreamSettings(network, security, query) {
  const streamSettings = {
    network,
    security,
  };

  if (security === 'tls') {
    streamSettings.tlsSettings = buildTlsSettings(query);
  }

  if (security === 'reality') {
    streamSettings.realitySettings = buildRealitySettings(query);
  }

  if (network === 'ws') {
    streamSettings.wsSettings = buildWsSettings(query);
  }

  if (network === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: query.get('serviceName') || query.get('path') || '',
    };
  }

  if (network === 'httpupgrade') {
    streamSettings.httpupgradeSettings = buildHttpUpgradeSettings(query);
  }

  if (network === 'xhttp') {
    streamSettings.xhttpSettings = {
      host: query.get('host') || '',
      path: query.get('path') || '/',
    };
  }

  return streamSettings;
}

/**
 * 功能说明：生成 TLS 配置，确保 SNI 等参数保留下来。
 * 参数说明：query 为链接查询参数。
 * 返回值说明：返回 Xray tlsSettings 对象。
 */
function buildTlsSettings(query) {
  const tlsSettings = {
    serverName: query.get('sni') || query.get('peer') || query.get('host') || '',
  };

  if (query.get('alpn')) {
    tlsSettings.alpn = query.get('alpn').split(',');
  }

  if (query.get('fp')) {
    tlsSettings.fingerprint = query.get('fp');
  }

  if (query.get('allowInsecure') === '1') {
    tlsSettings.allowInsecure = true;
  }

  return tlsSettings;
}

/**
 * 功能说明：生成 Reality 配置，保留公钥和 shortId。
 * 参数说明：query 为链接查询参数。
 * 返回值说明：返回 Xray realitySettings 对象。
 */
function buildRealitySettings(query) {
  return {
    serverName: query.get('sni') || '',
    fingerprint: query.get('fp') || 'chrome',
    publicKey: query.get('pbk') || '',
    shortId: query.get('sid') || '',
    spiderX: query.get('spx') || '',
  };
}

/**
 * 功能说明：生成 WebSocket 传输配置。
 * 参数说明：query 为链接查询参数。
 * 返回值说明：返回 Xray wsSettings 对象。
 */
function buildWsSettings(query) {
  const host = query.get('host') || '';
  const wsSettings = {
    path: query.get('path') || '/',
  };

  if (host) {
    wsSettings.headers = { Host: host };
  }

  return wsSettings;
}

/**
 * 功能说明：生成 HTTPUpgrade 传输配置。
 * 参数说明：query 为链接查询参数。
 * 返回值说明：返回 Xray httpupgradeSettings 对象。
 */
function buildHttpUpgradeSettings(query) {
  const host = query.get('host') || '';
  const settings = {
    path: query.get('path') || '/',
  };

  if (host) {
    settings.host = host;
  }

  return settings;
}

/**
 * 功能说明：读取链接端口并做基础校验。
 * 参数说明：url 为 URL 对象。
 * 返回值说明：返回整数端口。
 */
function getPort(url) {
  const port = Number(url.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('node port must be between 1 and 65535');
  }

  return port;
}

/**
 * 功能说明：读取链接片段作为节点名。
 * 参数说明：url 为 URL 对象，fallback 为默认名称。
 * 返回值说明：返回节点名。
 */
function getNodeName(url, fallback) {
  return url.hash ? decodeURIComponent(url.hash.slice(1)) : fallback;
}

/**
 * 功能说明：统一安全层名称。
 * 参数说明：security 为链接里的安全层参数。
 * 返回值说明：返回 Xray 可识别的 security 值。
 */
function getSecurity(security) {
  if (!security || security === 'none') {
    return 'none';
  }

  return security;
}

/**
 * 功能说明：拆分 Shadowsocks 链接里的用户信息和服务器地址。
 * 参数说明：shareLink 为 ss:// 链接。
 * 返回值说明：返回 userInfo 和 URL 对象。
 */
function parseShadowsocksParts(shareLink) {
  const bodyWithFragment = shareLink.slice('ss://'.length);
  const fragmentIndex = shareLink.indexOf('#');
  const fragment = fragmentIndex === -1 ? '' : bodyWithFragment.slice(fragmentIndex - 'ss://'.length);
  const body = fragmentIndex === -1 ? bodyWithFragment : bodyWithFragment.slice(0, fragmentIndex - 'ss://'.length);
  const atIndex = body.lastIndexOf('@');

  if (atIndex !== -1) {
    const userInfo = body.slice(0, atIndex);
    const serverPart = body.slice(atIndex + 1);
    return {
      userInfo,
      url: new URL(`ss://placeholder@${serverPart}${fragment}`),
    };
  }

  const decoded = decodeBase64(body);
  const decodedAtIndex = decoded.lastIndexOf('@');

  if (decodedAtIndex === -1) {
    throw new Error('invalid legacy ss link');
  }

  return {
    userInfo: decoded.slice(0, decodedAtIndex),
    url: new URL(`ss://placeholder@${decoded.slice(decodedAtIndex + 1)}${fragment}`),
  };
}

/**
 * 功能说明：在必要时解码 base64 用户信息。
 * 参数说明：value 为明文或 base64 字符串。
 * 返回值说明：返回明文字符串。
 */
function decodeBase64IfNeeded(value) {
  if (value.includes(':')) {
    return value;
  }

  return decodeBase64(value);
}

/**
 * 功能说明：兼容标准 base64 和 URL-safe base64。
 * 参数说明：value 为 base64 字符串。
 * 返回值说明：返回 utf8 明文。
 */
function decodeBase64(value) {
  const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddedValue = normalizedValue.padEnd(
    normalizedValue.length + ((4 - (normalizedValue.length % 4)) % 4),
    '=',
  );

  return Buffer.from(paddedValue, 'base64').toString('utf8');
}

module.exports = {
  parseShareLink,
};
