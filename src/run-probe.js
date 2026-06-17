'use strict';

const { probeNodeIpv4 } = require('./probe');
const { publishPatchedSubscriptions } = require('./gist-publisher');
const { collectProbePlan } = require('./probe-inputs');

const DEFAULT_PROBE_CONCURRENCY = 4;
const MAX_PROBE_CONCURRENCY = 10;
const DEFAULT_PROBE_RETRIES = 1;
const MAX_PROBE_RETRIES = 3;

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

  const results = await probeNodes(probeInputs, getProbeConcurrency(process.env.PROBE_CONCURRENCY));

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
 * 功能说明：按固定并发探测节点，控制 Actions 时长和 runner 压力。
 * 参数说明：probeInputs 为节点输入数组，concurrency 为并发数量。
 * 返回值说明：返回与输入顺序一致的探测结果数组。
 */
async function probeNodes(probeInputs, concurrency) {
  const results = new Array(probeInputs.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, probeInputs.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < probeInputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await probeNode(probeInputs[currentIndex], currentIndex);
    }
  }));

  return results;
}

/**
 * 功能说明：执行单个节点输入的 IPv4 探测。
 * 参数说明：probeInput 为分享链接或 outbound 输入，index 为顺序号。
 * 返回值说明：返回单个节点探测结果。
 */
async function probeNode(probeInput, index) {
  let result = null;
  const retries = getProbeRetries(process.env.PROBE_RETRIES);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = await probeNodeOnce(probeInput, index);

    if (result.ok || attempt === retries) {
      return result;
    }

    await sleep(500 * (attempt + 1));
  }

  return result;
}

/**
 * 功能说明：执行一次节点 IPv4 探测。
 * 参数说明：probeInput 为分享链接或 outbound 输入，index 为顺序号。
 * 返回值说明：返回单次探测结果。
 */
function probeNodeOnce(probeInput, index) {
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
 * 功能说明：解析探测并发，避免同时启动过多 Xray 进程。
 * 参数说明：value 为 PROBE_CONCURRENCY 环境变量。
 * 返回值说明：返回 1 到 10 之间的整数。
 */
function getProbeConcurrency(value) {
  const concurrency = Number(value || DEFAULT_PROBE_CONCURRENCY);

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_PROBE_CONCURRENCY) {
    throw new Error(`PROBE_CONCURRENCY must be an integer between 1 and ${MAX_PROBE_CONCURRENCY}`);
  }

  return concurrency;
}

/**
 * 功能说明：解析失败重试次数，减少临时断连漏测。
 * 参数说明：value 为 PROBE_RETRIES 环境变量。
 * 返回值说明：返回 0 到 3 之间的整数。
 */
function getProbeRetries(value) {
  const retries = Number(value ?? DEFAULT_PROBE_RETRIES);

  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_PROBE_RETRIES) {
    throw new Error(`PROBE_RETRIES must be an integer between 0 and ${MAX_PROBE_RETRIES}`);
  }

  return retries;
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
    failureCategories: summarizeFailureCategories(summary.results),
    results: summary.results.map((result, index) => ({
      node: `node-${index + 1}`,
      ok: result.ok,
      hasIpv4: Boolean(result.ipv4),
      provider: result.provider,
      latencyMs: result.latencyMs,
      error: result.ok ? null : classifyProbeError(result.error),
    })),
  };
}

/**
 * 功能说明：汇总失败类别，帮助公开日志排查而不泄露节点详情。
 * 参数说明：results 为探测结果数组。
 * 返回值说明：返回按失败类别计数的对象。
 */
function summarizeFailureCategories(results) {
  const categories = {};

  for (const result of results) {
    if (result.ok) {
      continue;
    }

    const category = classifyProbeError(result.error);
    categories[category] = (categories[category] || 0) + 1;
  }

  return categories;
}

/**
 * 功能说明：把具体错误归类成安全标签。
 * 参数说明：error 为已脱敏错误字符串。
 * 返回值说明：返回不会泄露节点信息的失败类别。
 */
function classifyProbeError(error) {
  const message = String(error || '').toLowerCase();
  const aggregatedCategory = getAggregatedFailureCategory(message);

  if (aggregatedCategory) {
    return aggregatedCategory;
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }

  if (message.includes('xray exited') || message.includes('xray failed') || message.includes('not start')) {
    return 'xray-start';
  }

  if (message.includes('proxy connect failed')) {
    return 'proxy-connect';
  }

  if (message.includes('provider returned')) {
    return 'provider-response';
  }

  if (message.includes('econnrefused') || message.includes('connection refused')) {
    return 'connection-refused';
  }

  if (
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('unexpected eof') ||
    message.includes('connection closed') ||
    message.includes('closed pipe')
  ) {
    return 'connection-closed';
  }

  if (
    message.includes('network socket disconnected') ||
    message.includes('first record does not look like a tls handshake')
  ) {
    return 'tls-connect';
  }

  if (message.includes('enotfound') || message.includes('dns')) {
    return 'dns';
  }

  if (message.includes('tls') || message.includes('handshake')) {
    return 'tls';
  }

  return 'unknown';
}

/**
 * 功能说明：读取 provider 汇总错误中的主要失败类别。
 * 参数说明：message 为错误消息。
 * 返回值说明：返回出现次数最多的类别，无法识别返回空字符串。
 */
function getAggregatedFailureCategory(message) {
  const matches = Array.from(message.matchAll(/([a-z-]+)=(\d+)/g));

  if (matches.length === 0) {
    return '';
  }

  return matches
    .map((match) => ({ category: match[1], count: Number(match[2]) }))
    .sort((left, right) => right.count - left.count)[0].category;
}

/**
 * 功能说明：等待指定时间后重试，降低短暂网络抖动影响。
 * 参数说明：ms 为等待毫秒数。
 * 返回值说明：返回 Promise<void>。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runProbe().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
