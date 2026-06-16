'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tls = require('node:tls');
const { parseShareLink } = require('./share-link');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PROVIDERS = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://ifconfig.co/ip',
];
const IP_V4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SENSITIVE_KEYS = new Set([
  'id',
  'password',
  'email',
  'secret',
  'privateKey',
  'publicKey',
  'shortId',
  'spiderX',
  'flow',
]);

/**
 * 功能说明：通过用户提供的 Xray outbound 探测节点出口 IPv4。
 * 参数说明：options.outbound 为 Xray outbound 对象，options.xrayPath 为 xray-core 路径。
 * 返回值说明：返回包含 ok、ipv4、latencyMs、provider 和 error 的探测结果。
 */
async function probeNodeIpv4(options) {
  const startedAt = Date.now();
  const normalizedOptions = normalizeProbeOptions(options);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-v4-probe-'));
  const proxyPort = await getFreePort();
  let xrayProcess = null;

  try {
    const configPath = path.join(workDir, 'config.json');
    const config = buildXrayConfig(normalizedOptions.outbound, proxyPort);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    xrayProcess = startXray(normalizedOptions.xrayPath, configPath);
    await waitForXrayProxy(xrayProcess, proxyPort, normalizedOptions.timeoutMs);

    const probeResult = await probeProviders(proxyPort, normalizedOptions);
    return {
      ok: true,
      ipv4: probeResult.ipv4,
      latencyMs: Date.now() - startedAt,
      provider: probeResult.provider,
      node: normalizedOptions.nodeName,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      ipv4: null,
      latencyMs: Date.now() - startedAt,
      provider: null,
      node: normalizedOptions.nodeName,
      error: sanitizeError(error),
    };
  } finally {
    await stopProcess(xrayProcess);
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 功能说明：统一补齐探测参数，避免调用方传入不完整配置。
 * 参数说明：options 为 API 或 CLI 传入的原始配置。
 * 返回值说明：返回已校验和补默认值的配置对象。
 */
function normalizeProbeOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('request body must be an object');
  }

  const parsedNode = getOutboundFromPayload(options);
  const xrayPath = options.xrayPath || process.env.XRAY_BIN || getDefaultXrayPath();
  const timeoutMs = Number(options.timeoutMs || process.env.PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const providers = getProviders(options.providers);

  if (!xrayPath) {
    throw new Error('XRAY_BIN is required or bin/xray must exist');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('timeoutMs must be an integer between 1000 and 60000');
  }

  return {
    outbound: parsedNode.outbound,
    xrayPath,
    timeoutMs,
    providers,
    nodeName: String(options.node || parsedNode.nodeName || parsedNode.outbound.tag || 'xray-node'),
  };
}

/**
 * 功能说明：从请求中提取 Xray outbound，兼容完整配置或单个 outbound。
 * 参数说明：payload 为用户提交的 JSON 请求体。
 * 返回值说明：返回可放入 Xray 配置的 outbound 对象。
 */
function getOutboundFromPayload(payload) {
  const shareLink = payload.shareLink || payload.link || payload.url || payload.nodeUrl;

  if (shareLink) {
    return parseShareLink(shareLink);
  }

  if (payload.outbound && typeof payload.outbound === 'object') {
    return { outbound: validateOutbound(payload.outbound), nodeName: payload.outbound.tag };
  }

  if (Array.isArray(payload.outbounds) && payload.outbounds.length > 0) {
    return { outbound: validateOutbound(payload.outbounds[0]), nodeName: payload.outbounds[0].tag };
  }

  if (Array.isArray(payload.config?.outbounds) && payload.config.outbounds.length > 0) {
    return {
      outbound: validateOutbound(payload.config.outbounds[0]),
      nodeName: payload.config.outbounds[0].tag,
    };
  }

  throw new Error('shareLink, outbound, outbounds[0], or config.outbounds[0] is required');
}

/**
 * 功能说明：校验 outbound 基本结构，避免无意义启动 Xray。
 * 参数说明：outbound 为用户提供的 Xray outbound 配置。
 * 返回值说明：返回原 outbound 对象。
 */
function validateOutbound(outbound) {
  if (!outbound.protocol || typeof outbound.protocol !== 'string') {
    throw new Error('outbound.protocol is required');
  }

  if (!outbound.settings || typeof outbound.settings !== 'object') {
    throw new Error('outbound.settings is required');
  }

  return outbound;
}

/**
 * 功能说明：生成临时 Xray 配置，让所有探测流量走用户节点。
 * 参数说明：outbound 为节点出口，proxyPort 为本地 HTTP 入站端口。
 * 返回值说明：返回完整 Xray 配置对象。
 */
function buildXrayConfig(outbound, proxyPort) {
  return {
    log: { loglevel: 'warning' },
    dns: {
      queryStrategy: 'UseIPv4',
      servers: ['1.1.1.1', '8.8.8.8'],
    },
    inbounds: [
      {
        tag: 'probe-http-in',
        listen: '127.0.0.1',
        port: proxyPort,
        protocol: 'http',
        settings: { timeout: 0 },
      },
    ],
    outbounds: [
      {
        ...outbound,
        tag: 'probe-node-out',
      },
    ],
    routing: {
      domainStrategy: 'UseIPv4',
      rules: [{ type: 'field', inboundTag: ['probe-http-in'], outboundTag: 'probe-node-out' }],
    },
  };
}

/**
 * 功能说明：启动 xray-core 子进程执行临时配置。
 * 参数说明：xrayPath 为二进制路径，configPath 为临时配置路径。
 * 返回值说明：返回已启动的 ChildProcess。
 */
function startXray(xrayPath, configPath) {
  const xrayProcess = spawn(xrayPath, ['run', '-config', configPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  xrayProcess.startupError = null;
  xrayProcess.stderrText = '';
  xrayProcess.on('error', (error) => {
    xrayProcess.startupError = error;
  });
  xrayProcess.stderr.on('data', (data) => {
    xrayProcess.stderrText = `${xrayProcess.stderrText}${data.toString('utf8')}`.slice(-2000);
  });

  return xrayProcess;
}

/**
 * 功能说明：按顺序请求 IPv4-only 服务，返回第一个有效 IPv4。
 * 参数说明：proxyPort 为本地 HTTP 代理端口，options 包含超时和服务列表。
 * 返回值说明：返回 provider 与 ipv4。
 */
async function probeProviders(proxyPort, options) {
  let lastError = null;

  for (const provider of options.providers) {
    try {
      const body = await requestViaHttpProxy(provider, proxyPort, options.timeoutMs);
      const ipv4 = body.trim();

      if (IP_V4_PATTERN.test(ipv4)) {
        return { provider, ipv4 };
      }

      throw new Error(`provider returned non-ipv4 response: ${ipv4.slice(0, 64)}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('all providers failed');
}

/**
 * 功能说明：通过 Xray 本地 HTTP 代理发起 HTTPS GET。
 * 参数说明：targetUrl 为探测地址，proxyPort 为本地代理端口，timeoutMs 为超时。
 * 返回值说明：返回响应正文字符串。
 */
function requestViaHttpProxy(targetUrl, proxyPort, timeoutMs) {
  const url = new URL(targetUrl);

  if (url.protocol !== 'https:') {
    return Promise.reject(new Error('provider url must use https'));
  }

  return new Promise((resolve, reject) => {
    const connectOptions = {
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${url.hostname}:443`,
      timeout: timeoutMs,
    };
    const request = http.request(connectOptions);

    request.once('connect', (response, socket) => {
      handleProxyConnect(response, socket, url, timeoutMs, resolve, reject);
    });
    request.once('timeout', () => request.destroy(new Error('proxy connect timeout')));
    request.once('error', reject);
    request.end();
  });
}

/**
 * 功能说明：在 HTTP CONNECT 建立后切换为 TLS 并读取探测响应。
 * 参数说明：response/socket 为代理连接结果，url 为目标地址，resolve/reject 为 Promise 回调。
 * 返回值说明：无直接返回，通过 Promise 回调输出正文。
 */
function handleProxyConnect(response, socket, url, timeoutMs, resolve, reject) {
  if (response.statusCode !== 200) {
    socket.destroy();
    reject(new Error(`proxy connect failed with status ${response.statusCode}`));
    return;
  }

  const secureSocket = tls.connect({ socket, servername: url.hostname });
  const chunks = [];

  secureSocket.setTimeout(timeoutMs, () => secureSocket.destroy(new Error('provider timeout')));
  secureSocket.once('secureConnect', () => {
    secureSocket.write(`GET ${url.pathname || '/'} HTTP/1.1\r\n`);
    secureSocket.write(`Host: ${url.hostname}\r\n`);
    secureSocket.write('User-Agent: xray-v4-prober/1.0\r\n');
    secureSocket.write('Connection: close\r\n\r\n');
  });
  secureSocket.on('data', (chunk) => chunks.push(chunk));
  secureSocket.once('error', reject);
  secureSocket.once('end', () => {
    try {
      resolve(parseHttpResponse(Buffer.concat(chunks)));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 功能说明：从原始 HTTP 响应中校验状态码并提取正文。
 * 参数说明：rawResponse 为包含响应头和响应体的 Buffer。
 * 返回值说明：返回响应体字符串。
 */
function parseHttpResponse(rawResponse) {
  const rawText = rawResponse.toString('utf8');
  const statusLine = rawText.slice(0, rawText.indexOf('\r\n'));
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);

  if (!statusMatch || Number(statusMatch[1]) >= 400) {
    throw new Error(`provider returned invalid status: ${statusLine || 'empty response'}`);
  }

  return parseHttpBody(rawResponse);
}

/**
 * 功能说明：从 HTTP 响应 Buffer 中提取正文并兼容 chunked 编码。
 * 参数说明：rawResponse 为包含响应头和响应体的 Buffer。
 * 返回值说明：返回响应正文字符串。
 */
function parseHttpBody(rawResponse) {
  const rawText = rawResponse.toString('utf8');
  const separatorIndex = rawResponse.indexOf('\r\n\r\n');

  if (separatorIndex === -1) {
    throw new Error('invalid provider response');
  }

  const headerText = rawText.slice(0, separatorIndex).toLowerCase();
  const bodyBuffer = rawResponse.subarray(separatorIndex + 4);

  if (headerText.includes('transfer-encoding: chunked')) {
    return decodeChunkedBody(bodyBuffer);
  }

  return bodyBuffer.toString('utf8');
}

/**
 * 功能说明：解码简单的 HTTP chunked 响应体。
 * 参数说明：bodyBuffer 为响应体 Buffer。
 * 返回值说明：返回解码后的正文字符串。
 */
function decodeChunkedBody(bodyBuffer) {
  let offset = 0;
  const chunks = [];

  while (offset < bodyBuffer.length) {
    const lineEnd = bodyBuffer.indexOf('\r\n', offset);

    if (lineEnd === -1) {
      break;
    }

    const chunkSize = Number.parseInt(bodyBuffer.subarray(offset, lineEnd).toString('ascii'), 16);
    if (!chunkSize) {
      break;
    }

    offset = lineEnd + 2;
    chunks.push(bodyBuffer.subarray(offset, offset + chunkSize));
    offset += chunkSize + 2;
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 功能说明：等待 Xray 本地代理启动，并捕获二进制启动失败。
 * 参数说明：xrayProcess 为子进程，proxyPort 为本地代理端口，timeoutMs 为超时。
 * 返回值说明：成功时返回 undefined，失败时抛出明确错误。
 */
async function waitForXrayProxy(xrayProcess, proxyPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (xrayProcess.startupError) {
      throw new Error(`xray failed to start: ${xrayProcess.startupError.message}`);
    }

    if (xrayProcess.exitCode !== null) {
      throw new Error(
        `xray exited before local proxy was ready: ${xrayProcess.exitCode}${formatXrayStderr(
          xrayProcess,
        )}`,
      );
    }

    if (await canConnect('127.0.0.1', proxyPort)) {
      return;
    }

    await sleep(100);
  }

  throw new Error('xray local proxy did not start before timeout');
}

/**
 * 功能说明：格式化脱敏后的 Xray stderr，便于定位配置错误。
 * 参数说明：xrayProcess 为子进程。
 * 返回值说明：返回可拼接到错误里的日志片段。
 */
function formatXrayStderr(xrayProcess) {
  const stderrText = redactSensitiveText(String(xrayProcess.stderrText || '').trim());

  if (!stderrText) {
    return '';
  }

  return `; stderr: ${stderrText.replace(/\s+/g, ' ').slice(0, 1000)}`;
}

/**
 * 功能说明：测试 TCP 端口是否已开放。
 * 参数说明：host/port 为目标地址。
 * 返回值说明：可连接返回 true，否则返回 false。
 */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 500 });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * 功能说明：获取一个本机空闲端口用于临时代理。
 * 参数说明：无。
 * 返回值说明：返回端口号。
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * 功能说明：停止子进程并等待退出，防止 Serverless 复用环境残留进程。
 * 参数说明：childProcess 为需要停止的进程。
 * 返回值说明：返回 Promise<void>。
 */
function stopProcess(childProcess) {
  if (!childProcess || childProcess.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      childProcess.kill('SIGKILL');
      resolve();
    }, 1000);

    childProcess.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    childProcess.kill('SIGTERM');
  });
}

/**
 * 功能说明：等待指定毫秒，减少轮询 CPU 消耗。
 * 参数说明：ms 为等待时间。
 * 返回值说明：返回 Promise<void>。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 功能说明：获取默认 xray 二进制路径。
 * 参数说明：无。
 * 返回值说明：返回当前平台约定的默认路径。
 */
function getDefaultXrayPath() {
  const binaryName = process.platform === 'win32' ? 'xray.exe' : 'xray';
  return path.resolve(__dirname, '..', 'bin', binaryName);
}

/**
 * 功能说明：整理探测服务列表，防止空数组导致无效探测。
 * 参数说明：providers 为用户自定义探测地址数组。
 * 返回值说明：返回可用的 HTTPS 地址数组。
 */
function getProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    return DEFAULT_PROVIDERS;
  }

  return providers.map(String).filter((provider) => provider.startsWith('https://'));
}

/**
 * 功能说明：脱敏错误，避免把节点配置暴露给调用方。
 * 参数说明：error 为捕获到的异常。
 * 返回值说明：返回适合 API 响应的错误字符串。
 */
function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}

/**
 * 功能说明：对字符串中的潜在敏感字段做简单脱敏。
 * 参数说明：text 为待处理文本。
 * 返回值说明：返回脱敏后的文本。
 */
function redactSensitiveText(text) {
  let redactedText = text;

  for (const key of SENSITIVE_KEYS) {
    const pattern = new RegExp(`("${key}"\\s*:\\s*")[^"]+(")`, 'gi');
    redactedText = redactedText.replace(pattern, `$1${hashSecret(key)}$2`);
  }

  return redactedText
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[redacted:uuid]',
    )
    .replace(/\b(?:vless|vmess|trojan|ss):\/\/[^\s"'<>]+/gi, '[redacted:share-link]');
}

/**
 * 功能说明：生成稳定的脱敏占位符，便于排查同类字段而不泄密。
 * 参数说明：value 为敏感字段名。
 * 返回值说明：返回短哈希占位符。
 */
function hashSecret(value) {
  return `[redacted:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}]`;
}

module.exports = {
  IP_V4_PATTERN,
  buildXrayConfig,
  probeNodeIpv4,
  requestViaHttpProxy,
};
