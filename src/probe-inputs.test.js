'use strict';

const assert = require('node:assert/strict');
const {
  collectProbeInputs,
  collectShareLinks,
  extractProbeInputs,
  extractShareLinks,
  splitMultilineSecret,
} = require('./probe-inputs');

const vlessLink =
  'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none#one';
const trojanLink = 'trojan://password@example.net:443#two';
const ssLink = 'ss://YWVzLTI1Ni1nY206cGFzcw@example.org:8388#three';

assert.deepEqual(splitMultilineSecret(`\n${vlessLink}\r\n${trojanLink}\n`), [
  vlessLink,
  trojanLink,
]);

assert.deepEqual(extractShareLinks(`${vlessLink}\n${trojanLink}`), [vlessLink, trojanLink]);

const encodedSubscription = Buffer.from(`${vlessLink}\n${ssLink}`).toString('base64');
assert.deepEqual(extractShareLinks(encodedSubscription), [vlessLink, ssLink]);

const clashYaml = `
proxies:
  - name: yaml-vless
    type: vless
    server: example.com
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    network: ws
    tls: true
    servername: example.com
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
`;
const yamlInputs = extractProbeInputs(clashYaml);
assert.equal(yamlInputs.length, 1);
assert.equal(yamlInputs[0].nodeName, 'yaml-vless');
assert.equal(yamlInputs[0].outbound.protocol, 'vless');
assert.equal(yamlInputs[0].outbound.streamSettings.wsSettings.headers.Host, 'cdn.example.com');

const singBoxJson = JSON.stringify({
  outbounds: [
    {
      type: 'vless',
      tag: 'sing-box-vless',
      server: 'example.com',
      server_port: 443,
      uuid: '00000000-0000-0000-0000-000000000000',
      tls: {
        enabled: true,
        server_name: 'example.com',
        utls: { enabled: true, fingerprint: 'chrome' },
      },
      transport: {
        type: 'ws',
        path: '/ws',
        headers: { Host: 'cdn.example.com' },
      },
    },
  ],
});
const singBoxInputs = extractProbeInputs(singBoxJson);
assert.equal(singBoxInputs.length, 1);
assert.equal(singBoxInputs[0].nodeName, 'sing-box-vless');
assert.equal(singBoxInputs[0].outbound.protocol, 'vless');
assert.equal(singBoxInputs[0].outbound.streamSettings.tlsSettings.fingerprint, 'chrome');

(async () => {
  const fakeFetch = async () => ({
    ok: true,
    text: async () => encodedSubscription,
  });
  const links = await collectShareLinks(
    {
      XRAY_SHARE_LINKS: `${vlessLink}\n${trojanLink}`,
      XRAY_SUBSCRIPTION_URLS: 'https://example.com/sub',
      PROBE_MAX_NODES: '2',
    },
    fakeFetch,
  );

  assert.deepEqual(links, [vlessLink, trojanLink]);

  const userAgents = [];
  const fallbackFetch = async (_url, options) => {
    userAgents.push(options.headers['user-agent']);

    if (userAgents.length === 1) {
      return { ok: false, status: 403 };
    }

    return {
      ok: true,
      text: async () => vlessLink,
    };
  };
  const fallbackLinks = await collectShareLinks(
    {
      XRAY_SUBSCRIPTION_URLS: 'https://example.com/sub',
      SUBSCRIPTION_USER_AGENT: 'BlockedClient/1.0',
      PROBE_MAX_NODES: '1',
    },
    fallbackFetch,
  );

  assert.deepEqual(fallbackLinks, [vlessLink]);
  assert.deepEqual(userAgents.slice(0, 2), ['BlockedClient/1.0', 'ClashforWindows/0.20.39']);

  const yamlFetch = async () => ({
    ok: true,
    text: async () => clashYaml,
  });
  const probeInputs = await collectProbeInputs(
    {
      XRAY_SUBSCRIPTION_URLS: 'https://example.com/clash.yaml',
      PROBE_MAX_NODES: '1',
    },
    yamlFetch,
  );

  assert.equal(probeInputs.length, 1);
  assert.equal(probeInputs[0].outbound.protocol, 'vless');

  const singBoxFetch = async () => ({
    ok: true,
    text: async () => singBoxJson,
  });
  const singBoxProbeInputs = await collectProbeInputs(
    {
      XRAY_SUBSCRIPTION_URLS: 'https://example.com/sing-box.json',
      PROBE_MAX_NODES: '1',
    },
    singBoxFetch,
  );

  assert.equal(singBoxProbeInputs.length, 1);
  assert.equal(singBoxProbeInputs[0].outbound.protocol, 'vless');
  console.log('probe input tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
