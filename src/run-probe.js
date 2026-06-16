'use strict';

const { probeNodeIpv4 } = require('./probe');
const { collectShareLinks } = require('./probe-inputs');

/**
 * 功能说明：从环境变量读取一个或多个节点并执行 IPv4 探测。
 * 参数说明：无，使用 XRAY_SHARE_LINK(S)、XRAY_SUBSCRIPTION_URLS 和 PROBE_MAX_NODES。
 * 返回值说明：通过 stdout 输出 JSON 探测结果汇总。
 */
async function runProbe() {
  const shareLinks = await collectShareLinks();

  if (shareLinks.length === 0) {
    throw new Error('XRAY_SHARE_LINK, XRAY_SHARE_LINKS, or XRAY_SUBSCRIPTION_URLS is required');
  }

  const results = [];
  for (const [index, shareLink] of shareLinks.entries()) {
    results.push(await probeShareLink(shareLink, index));
  }

  const summary = {
    ok: results.some((result) => result.ok),
    total: results.length,
    success: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok || shouldRequireAllOk(summary)) {
    process.exitCode = 1;
  }
}

/**
 * 功能说明：执行单个分享链接的 IPv4 探测。
 * 参数说明：shareLink 为节点链接，index 为顺序号。
 * 返回值说明：返回单个节点探测结果。
 */
function probeShareLink(shareLink, index) {
  return probeNodeIpv4({
    node: buildNodeName(index),
    shareLink,
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 15000),
  });
}

/**
 * 功能说明：生成节点显示名，避免输出真实链接。
 * 参数说明：index 为节点顺序号。
 * 返回值说明：返回显示名。
 */
function buildNodeName(index) {
  const baseName = process.env.PROBE_NODE_NAME || 'github-actions-probe';
  return `${baseName}-${index + 1}`;
}

/**
 * 功能说明：判断是否要求所有节点都探测成功。
 * 参数说明：summary 为结果汇总。
 * 返回值说明：需要失败退出时返回 true。
 */
function shouldRequireAllOk(summary) {
  return process.env.REQUIRE_ALL_OK === '1' && summary.failed > 0;
}

runProbe().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
