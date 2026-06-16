'use strict';

const { probeNodeIpv4 } = require('../src/probe');

/**
 * 功能说明：Serverless HTTP 入口，处理 IPv4 探测请求。
 * 参数说明：request/response 为 Vercel 或 Node 兼容的请求响应对象。
 * 返回值说明：通过 response 返回 JSON 探测结果。
 */
module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const result = await probeNodeIpv4(body);
    sendJson(response, result.ok ? 200 : 502, result);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      ipv4: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 功能说明：校验访问 token，避免探测接口被公网滥用。
 * 参数说明：request 为 HTTP 请求对象。
 * 返回值说明：授权成功返回 true，否则返回 false。
 */
function isAuthorized(request) {
  const expectedToken = process.env.PROBE_TOKEN;

  if (!expectedToken && process.env.ALLOW_UNAUTHENTICATED_PROBE === '1') {
    return true;
  }

  if (!expectedToken) {
    return false;
  }

  const authorization = request.headers.authorization || '';
  return authorization === `Bearer ${expectedToken}`;
}

/**
 * 功能说明：读取并解析 JSON 请求体。
 * 参数说明：request 为 HTTP 请求对象。
 * 返回值说明：返回解析后的对象。
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error('request body must be valid JSON'));
      }
    });
  });
}

/**
 * 功能说明：发送 JSON 响应。
 * 参数说明：response 为 HTTP 响应对象，statusCode 为状态码，payload 为响应体。
 * 返回值说明：无。
 */
function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload, null, 2));
}
