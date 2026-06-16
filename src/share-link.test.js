'use strict';

const assert = require('node:assert/strict');
const { parseShareLink } = require('./share-link');

const vlessResult = parseShareLink(
  'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&security=tls&type=ws&sni=example.com&host=cdn.example.com&path=%2Fws#vless-test',
);
assert.equal(vlessResult.nodeName, 'vless-test');
assert.equal(vlessResult.outbound.protocol, 'vless');
assert.equal(vlessResult.outbound.settings.vnext[0].address, 'example.com');
assert.equal(vlessResult.outbound.streamSettings.network, 'ws');
assert.equal(vlessResult.outbound.streamSettings.security, 'tls');
assert.equal(vlessResult.outbound.streamSettings.wsSettings.headers.Host, 'cdn.example.com');

const vmessConfig = Buffer.from(
  JSON.stringify({
    ps: 'vmess-test',
    add: 'example.net',
    port: '8443',
    id: '11111111-1111-1111-1111-111111111111',
    aid: '0',
    scy: 'auto',
    net: 'grpc',
    tls: 'tls',
    sni: 'example.net',
    path: 'grpc-service',
  }),
).toString('base64');
const vmessResult = parseShareLink(`vmess://${vmessConfig}`);
assert.equal(vmessResult.nodeName, 'vmess-test');
assert.equal(vmessResult.outbound.protocol, 'vmess');
assert.equal(vmessResult.outbound.streamSettings.grpcSettings.serviceName, 'grpc-service');

const trojanResult = parseShareLink(
  'trojan://password@example.org:443?security=reality&type=tcp&sni=www.example.org&pbk=public-key&sid=abcd#trojan-test',
);
assert.equal(trojanResult.nodeName, 'trojan-test');
assert.equal(trojanResult.outbound.protocol, 'trojan');
assert.equal(trojanResult.outbound.streamSettings.security, 'reality');
assert.equal(trojanResult.outbound.streamSettings.realitySettings.shortId, 'abcd');

const ssResult = parseShareLink('ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@example.org:8388#ss-test');
assert.equal(ssResult.nodeName, 'ss-test');
assert.equal(ssResult.outbound.protocol, 'shadowsocks');
assert.equal(ssResult.outbound.settings.servers[0].method, 'aes-256-gcm');
assert.equal(ssResult.outbound.settings.servers[0].password, 'password');

const legacySsPayload = Buffer.from('chacha20-ietf-poly1305:secret@example.org:8388').toString(
  'base64',
);
const legacySsResult = parseShareLink(`ss://${legacySsPayload}#legacy-ss-test`);
assert.equal(legacySsResult.nodeName, 'legacy-ss-test');
assert.equal(legacySsResult.outbound.settings.servers[0].method, 'chacha20-ietf-poly1305');
assert.equal(legacySsResult.outbound.settings.servers[0].password, 'secret');

console.log('share link parser tests passed');
