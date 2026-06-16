'use strict';

const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  buildGistFiles,
  patchSubscriptionContent,
  publishPatchedSubscriptions,
} = require('./gist-publisher');

const results = [
  {
    ok: true,
    ipv4: '203.0.113.10',
  },
];

const clashYaml = `
proxies:
  - name: test
    type: vless
    server: old.example.com
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
`;
const patchedYaml = YAML.parse(patchSubscriptionContent(clashYaml, results));
assert.equal(patchedYaml.proxies[0].server, '203.0.113.10');

const singBoxJson = JSON.stringify({
  outbounds: [
    {
      type: 'vless',
      tag: 'test',
      server: 'old.example.com',
      server_port: 443,
      uuid: '00000000-0000-0000-0000-000000000000',
    },
  ],
});
const patchedJson = JSON.parse(patchSubscriptionContent(singBoxJson, results));
assert.equal(patchedJson.outbounds[0].server, '203.0.113.10');

const shareLinks = 'vless://00000000-0000-0000-0000-000000000000@old.example.com:443?encryption=none#test';
const patchedShareLinks = patchSubscriptionContent(shareLinks, results);
assert.equal(patchedShareLinks.includes('@203.0.113.10:443'), true);

const plan = {
  subscriptionDocuments: [{ documentIndex: 0, content: singBoxJson }],
  inputs: [
    {
      outbound: {},
      source: { type: 'subscription', documentIndex: 0, nodeIndex: 0 },
    },
  ],
};
const files = buildGistFiles(plan, results, 'patched.json');
assert.equal(Object.keys(files)[0], 'patched.json');
assert.equal(JSON.parse(files['patched.json'].content).outbounds[0].server, '203.0.113.10');

const directPlan = {
  subscriptionDocuments: [],
  inputs: [
    {
      shareLink: shareLinks,
      source: { type: 'direct' },
    },
  ],
};
const directFiles = buildGistFiles(directPlan, results, 'patched.txt');
assert.equal(Object.keys(directFiles)[0], 'patched.txt');
assert.equal(directFiles['patched.txt'].content.includes('@203.0.113.10:443'), true);

const failedFiles = buildGistFiles(plan, [{ ok: false, ipv4: null }], 'patched.json');
assert.deepEqual(failedFiles, {});

(async () => {
  let didCallFetch = false;
  const didPublish = await publishPatchedSubscriptions(
    plan,
    results,
    {
      PUBLISH_GIST: '1',
      PUBLISH_GIST_DRY_RUN: '1',
    },
    async () => {
      didCallFetch = true;
      return { ok: true };
    },
  );

  assert.equal(didPublish, true);
  assert.equal(didCallFetch, false);
  console.log('gist publisher tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
