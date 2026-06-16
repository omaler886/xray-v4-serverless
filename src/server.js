'use strict';

const http = require('node:http');
const handler = require('../api/probe-v4');

const DEFAULT_PORT = 8787;

/**
 * 功能说明：启动本地开发服务器，复用 Serverless handler。
 * 参数说明：无，通过 PORT 环境变量指定端口。
 * 返回值说明：返回 HTTP Server 实例。
 */
function startServer() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/probe-v4') {
      sendNotFound(response);
      return;
    }

    handler(request, response);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`xray-v4-prober listening on http://127.0.0.1:${port}/api/probe-v4`);
  });

  return server;
}

/**
 * 功能说明：返回 404，避免未知路径误触发探测。
 * 参数说明：response 为 HTTP 响应对象。
 * 返回值说明：无。
 */
function sendNotFound(response) {
  response.statusCode = 404;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: false, error: 'not found' }));
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
