'use strict';

const { probeNodeIpv4 } = require('./probe');
const { publishPatchedSubscriptions } = require('./gist-publisher');
const { collectProbePlan } = require('./probe-inputs');

/**
 * 功能说明：从环境变量读取一个或多个节点并执行 IPv4 探测。
 * 参数说明：无，使用 XRAY_SHARE_LINK(S)、XRAY_SUBSCRIPTION_URLS 和 PROBE_MAX_NODES。
 * 返回值说明：通过 stdout 输出 JSON 探测结果汇总。
 */
async function runProbe() {
  const plan = await collectProbePlan();
  const probeInputs = plan.inputs;

  if (probeInputs.length === 0) {
    throw new Error('no supported nodes found in share links or subscriptions');
  }

  const results = [];
  for (const [index, probeInput] of probeInputs.entries()) {
    results.push(await probeNode(probeInput, index));
  }

  const summary = {
    ok: results.some((result) => result.ok),
    total: results.length,
    success: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };

  console.log(JSON.stringify(getPrintableSummary(summary), null, 2));

  if (summary.ok) {
    await publishPatchedSubscriptions(plan, summary.results);
  }

  if (!summary.ok || shouldRequireAllOk(summary)) {
    process.exitCode = 1;
  }
}

/**
 * 功能说明：执行单个节点输入的 IPv4 探测。
 * 参数说明：probeInput 为分享链接或 outbound 输入，index 为顺序号。
 * 返回值说明：返回单个节点探测结果。
 */
function probeNode(probeInput, index) {
  return probeNodeIpv4({
    node: probeInput.nodeName || buildNodeName(index),
    shareLink: probeInput.shareLink,
    outbound: probeInput.outbound,
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

/**
 * 功能说明：根据环境变量决定输出完整结果还是公开安全摘要。
 * 参数说明：summary 为原始探测结果汇总。
 * 返回值说明：返回适合打印到 Actions 日志的对象。
 */
function getPrintableSummary(summary) {
  if (process.env.REVEAL_RESULTS === '1') {
    return summary;
  }

  return redactSummary(summary);
}

/**
 * 功能说明：隐藏节点名、出口 IP 和详细错误，避免公开仓库日志泄露信息。
 * 参数说明：summary 为原始探测结果汇总。
 * 返回值说明：返回脱敏后的摘要对象。
 */
function redactSummary(summary) {
  return {
    ok: summary.ok,
    total: summary.total,
    success: summary.success,
    failed: summary.failed,
    results: summary.results.map((result, index) => ({
      node: `node-${index + 1}`,
      ok: result.ok,
      hasIpv4: Boolean(result.ipv4),
      provider: result.provider,
      latencyMs: result.latencyMs,
      error: result.ok ? null : 'probe failed',
    })),
  };
}

runProbe().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
