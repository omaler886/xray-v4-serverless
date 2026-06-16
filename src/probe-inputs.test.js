'use strict';

const assert = require('node:assert/strict');
const {
  collectShareLinks,
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
  console.log('probe input tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
