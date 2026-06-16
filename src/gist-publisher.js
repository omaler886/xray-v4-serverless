'use strict';

const YAML = require('yaml');

const SHARE_LINK_PATTERN = /\b(?:vless|vmess|trojan|ss):\/\/[^\s"'<>]+/gi;

/**
 * 功能说明：把成功探测出的 IPv4 写入订阅并发布到私密 Gist。
 * 参数说明：plan 为探测计划，results 为探测结果，env 为环境变量，fetchImpl 为 fetch。
 * 返回值说明：发布成功返回 true，未启用发布返回 false。
 */
async function publishPatchedSubscriptions(plan, results, env = process.env, fetchImpl = globalThis.fetch) {
  if (env.PUBLISH_GIST !== '1') {
    return false;
  }

  const files = buildGistFiles(plan, results, env.GIST_FILENAME || 'patched-subscription.txt');

  if (Object.keys(files).length === 0) {
    throw new Error('no patched subscription content was generated');
  }

  if (env.PUBLISH_GIST_DRY_RUN === '1') {
    console.log(`patched subscription dry-run generated: ${Object.keys(files).length} file(s)`);
    return true;
  }

  validateGistEnv(env);
  await updateGist(env.GIST_ID, env.GIST_TOKEN, files, fetchImpl);
  console.log(`patched subscription published to secret gist: ${Object.keys(files).length} file(s)`);
  return true;
}

/**
 * 功能说明：校验发布 Gist 所需的 secret。
 * 参数说明：env 为环境变量。
 * 返回值说明：无，缺失时抛错。
 */
function validateGistEnv(env) {
  if (!env.GIST_TOKEN) {
    throw new Error('GIST_TOKEN secret is required when publish_gist is enabled');
  }

  if (!env.GIST_ID) {
    throw new Error('GIST_ID secret is required when publish_gist is enabled');
  }
}

/**
 * 功能说明：为 Gist 生成待更新文件。
 * 参数说明：plan 为探测计划，results 为探测结果，baseFilename 为文件名。
 * 返回值说明：返回 GitHub Gist files 对象。
 */
function buildGistFiles(plan, results, baseFilename) {
  const files = {};

  for (const document of plan.subscriptionDocuments || []) {
    const documentResults = getDocumentResults(plan.inputs, results, document.documentIndex);

    if (!hasPatchableResult(documentResults)) {
      continue;
    }

    const content = patchSubscriptionContent(document.content, documentResults);
    const filename = getGistFilename(baseFilename, document.documentIndex, plan.subscriptionDocuments.length);

    files[filename] = { content };
  }

  const directFile = buildDirectShareLinkFile(plan.inputs, results, baseFilename, files);

  if (directFile) {
    files[directFile.filename] = { content: directFile.content };
  }

  return files;
}

/**
 * 功能说明：获取属于某个订阅文档的探测结果。
 * 参数说明：inputs 为节点输入，results 为探测结果，documentIndex 为订阅索引。
 * 返回值说明：返回按订阅节点顺序排列的结果数组。
 */
function getDocumentResults(inputs, results, documentIndex) {
  return inputs
    .map((input, resultIndex) => ({ input, result: results[resultIndex] }))
    .filter((item) => item.input.source?.documentIndex === documentIndex)
    .sort((left, right) => left.input.source.nodeIndex - right.input.source.nodeIndex)
    .map((item) => item.result);
}

/**
 * 功能说明：生成直接分享链接输入对应的 Gist 文件。
 * 参数说明：inputs 为节点输入，results 为探测结果，baseFilename 为文件名，existingFiles 为已有文件。
 * 返回值说明：有可发布内容时返回文件名和内容，否则返回 null。
 */
function buildDirectShareLinkFile(inputs, results, baseFilename, existingFiles) {
  const directItems = inputs
    .map((input, resultIndex) => ({ input, result: results[resultIndex] }))
    .filter((item) => item.input.source?.type === 'direct' && item.input.shareLink);

  if (directItems.length === 0 || !hasPatchableResult(directItems.map((item) => item.result))) {
    return null;
  }

  const directContent = directItems.map((item) => item.input.shareLink).join('\n');
  const directResults = directItems.map((item) => item.result);
  const filename = Object.keys(existingFiles).length > 0
    ? getDirectGistFilename(baseFilename)
    : baseFilename;

  return {
    filename,
    content: patchSubscriptionContent(directContent, directResults),
  };
}

/**
 * 功能说明：判断结果列表中是否有可用于替换 server 的成功 IPv4。
 * 参数说明：results 为探测结果数组。
 * 返回值说明：存在成功 IPv4 返回 true。
 */
function hasPatchableResult(results) {
  return results.some((result) => result?.ok && result.ipv4);
}

/**
 * 功能说明：生成直接链接发布文件名，避免和订阅文件冲突。
 * 参数说明：baseFilename 为基础文件名。
 * 返回值说明：返回直接链接文件名。
 */
function getDirectGistFilename(baseFilename) {
  const dotIndex = baseFilename.lastIndexOf('.');

  if (dotIndex === -1) {
    return `${baseFilename}-direct`;
  }

  return `${baseFilename.slice(0, dotIndex)}-direct${baseFilename.slice(dotIndex)}`;
}

/**
 * 功能说明：把订阅内容中的服务器地址替换为对应探测 IPv4。
 * 参数说明：content 为订阅原文，results 为该订阅对应的探测结果。
 * 返回值说明：返回替换后的订阅内容。
 */
function patchSubscriptionContent(content, results) {
  const text = String(content);
  const shareLinkPatched = patchShareLinkContent(text, results);

  if (shareLinkPatched.didPatch) {
    return shareLinkPatched.content;
  }

  const yamlPatched = patchClashYamlContent(text, results);

  if (yamlPatched.didPatch) {
    return yamlPatched.content;
  }

  const jsonPatched = patchSingBoxJsonContent(text, results);

  if (jsonPatched.didPatch) {
    return jsonPatched.content;
  }

  if (isLikelyBase64(text)) {
    const decodedText = decodeBase64(text);
    const decodedPatched = patchSubscriptionContent(decodedText, results);

    if (decodedPatched !== decodedText) {
      return encodeBase64(decodedPatched);
    }
  }

  return text;
}

/**
 * 功能说明：替换分享链接订阅中的服务器地址。
 * 参数说明：content 为订阅文本，results 为探测结果。
 * 返回值说明：返回替换结果和是否替换。
 */
function patchShareLinkContent(content, results) {
  let linkIndex = 0;
  let didPatch = false;
  const patchedContent = String(content).replace(SHARE_LINK_PATTERN, (shareLink) => {
    const result = results[linkIndex];
    linkIndex += 1;

    if (!result?.ok || !result.ipv4) {
      return shareLink;
    }

    const patchedLink = patchShareLinkServer(shareLink, result.ipv4);
    didPatch = patchedLink !== shareLink || didPatch;
    return patchedLink;
  });

  return { content: patchedContent, didPatch };
}

/**
 * 功能说明：替换单个分享链接中的服务器地址。
 * 参数说明：shareLink 为节点链接，ipv4 为探测出的 IPv4。
 * 返回值说明：返回替换后的节点链接。
 */
function patchShareLinkServer(shareLink, ipv4) {
  if (shareLink.startsWith('vmess://')) {
    return patchVmessLink(shareLink, ipv4);
  }

  if (shareLink.startsWith('ss://')) {
    return patchShadowsocksLink(shareLink, ipv4);
  }

  const url = new URL(shareLink);
  url.hostname = ipv4;
  return url.toString();
}

/**
 * 功能说明：替换 VMess 分享链接中的 add 字段。
 * 参数说明：shareLink 为 vmess:// 链接，ipv4 为探测出的 IPv4。
 * 返回值说明：返回替换后的 vmess:// 链接。
 */
function patchVmessLink(shareLink, ipv4) {
  const fragmentIndex = shareLink.indexOf('#');
  const fragment = fragmentIndex === -1 ? '' : shareLink.slice(fragmentIndex);
  const encodedPayload = shareLink.slice('vmess://'.length, fragmentIndex === -1 ? undefined : fragmentIndex);
  const config = JSON.parse(decodeBase64(encodedPayload));

  config.add = ipv4;
  return `vmess://${encodeBase64(JSON.stringify(config))}${fragment}`;
}

/**
 * 功能说明：替换 Shadowsocks 分享链接中的服务器地址。
 * 参数说明：shareLink 为 ss:// 链接，ipv4 为探测出的 IPv4。
 * 返回值说明：返回替换后的 ss:// 链接。
 */
function patchShadowsocksLink(shareLink, ipv4) {
  const atIndex = shareLink.lastIndexOf('@');

  if (atIndex === -1) {
    return shareLink;
  }

  const url = new URL(`ss://placeholder@${shareLink.slice(atIndex + 1)}`);
  url.hostname = ipv4;
  return `${shareLink.slice(0, atIndex + 1)}${url.host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * 功能说明：替换 Clash/Mihomo YAML 中 proxies 的 server。
 * 参数说明：content 为 YAML 文本，results 为探测结果。
 * 返回值说明：返回替换结果和是否替换。
 */
function patchClashYamlContent(content, results) {
  const config = parseYaml(content);
  const proxies = Array.isArray(config?.proxies) ? config.proxies : [];

  if (proxies.length === 0) {
    return { content, didPatch: false };
  }

  const didPatch = patchServerFields(proxies, results, 'server', isSupportedClashProxy);
  return { content: YAML.stringify(config), didPatch };
}

/**
 * 功能说明：替换 sing-box JSON 中 outbounds 的 server。
 * 参数说明：content 为 JSON 文本，results 为探测结果。
 * 返回值说明：返回替换结果和是否替换。
 */
function patchSingBoxJsonContent(content, results) {
  const config = parseJson(content);
  const outbounds = Array.isArray(config?.outbounds) ? config.outbounds : [];

  if (outbounds.length === 0) {
    return { content, didPatch: false };
  }

  const didPatch = patchServerFields(outbounds, results, 'server', isSupportedSingBoxOutbound);
  return { content: JSON.stringify(config, null, 2), didPatch };
}

/**
 * 功能说明：按探测结果替换节点数组中的服务器字段。
 * 参数说明：nodes 为节点数组，results 为探测结果，fieldName 为服务器字段名，isSupported 为节点过滤函数。
 * 返回值说明：发生替换返回 true。
 */
function patchServerFields(nodes, results, fieldName, isSupported) {
  let resultIndex = 0;
  let didPatch = false;

  for (const node of nodes) {
    if (!isSupported(node)) {
      continue;
    }

    const result = results[resultIndex];
    resultIndex += 1;

    if (!result?.ok || !result.ipv4 || !node[fieldName]) {
      continue;
    }

    node[fieldName] = result.ipv4;
    didPatch = true;
  }

  return didPatch;
}

/**
 * 功能说明：判断 Clash 节点是否属于可探测代理类型。
 * 参数说明：node 为 Clash proxy。
 * 返回值说明：支持返回 true。
 */
function isSupportedClashProxy(node) {
  return ['vless', 'vmess', 'trojan', 'ss'].includes(node?.type);
}

/**
 * 功能说明：判断 sing-box outbound 是否属于可探测代理类型。
 * 参数说明：node 为 sing-box outbound。
 * 返回值说明：支持返回 true。
 */
function isSupportedSingBoxOutbound(node) {
  return ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(node?.type);
}

/**
 * 功能说明：更新已有 Gist 文件。
 * 参数说明：gistId 为 Gist ID，token 为 PAT，files 为 Gist files 对象，fetchImpl 为 fetch。
 * 返回值说明：返回 Promise<void>。
 */
async function updateGist(gistId, token, files, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'xray-v4-prober/1.0',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ files }),
  });

  if (!response.ok) {
    throw new Error(`gist update failed with status ${response.status}`);
  }
}

/**
 * 功能说明：生成 Gist 文件名，多订阅时自动加序号。
 * 参数说明：baseFilename 为基础文件名，documentIndex 为订阅索引，totalDocuments 为订阅数量。
 * 返回值说明：返回文件名。
 */
function getGistFilename(baseFilename, documentIndex, totalDocuments) {
  if (totalDocuments <= 1) {
    return baseFilename;
  }

  const dotIndex = baseFilename.lastIndexOf('.');

  if (dotIndex === -1) {
    return `${baseFilename}-${documentIndex + 1}`;
  }

  return `${baseFilename.slice(0, dotIndex)}-${documentIndex + 1}${baseFilename.slice(dotIndex)}`;
}

/**
 * 功能说明：安全解析 YAML。
 * 参数说明：content 为 YAML 文本。
 * 返回值说明：解析失败返回 null。
 */
function parseYaml(content) {
  try {
    return YAML.parse(String(content));
  } catch (error) {
    return null;
  }
}

/**
 * 功能说明：安全解析 JSON。
 * 参数说明：content 为 JSON 文本。
 * 返回值说明：解析失败返回 null。
 */
function parseJson(content) {
  try {
    return JSON.parse(String(content));
  } catch (error) {
    return null;
  }
}

/**
 * 功能说明：解码 base64 文本。
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

/**
 * 功能说明：粗略判断文本是否像 base64，避免对普通 HTML/错误页递归解码。
 * 参数说明：value 为候选文本。
 * 返回值说明：像 base64 返回 true。
 */
function isLikelyBase64(value) {
  const compactValue = String(value).replace(/\s+/g, '');

  if (compactValue.length < 16 || compactValue.length % 4 === 1) {
    return false;
  }

  return /^[A-Za-z0-9+/_=-]+$/.test(compactValue);
}

/**
 * 功能说明：编码 base64 文本。
 * 参数说明：value 为待编码文本。
 * 返回值说明：返回 base64 字符串。
 */
function encodeBase64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

module.exports = {
  buildGistFiles,
  patchSubscriptionContent,
  publishPatchedSubscriptions,
};
