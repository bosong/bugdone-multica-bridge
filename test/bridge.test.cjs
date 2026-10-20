const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// 测试侧提取纯函数，浏览器交付脚本不携带 Node 导出分支。
const source = fs.readFileSync(require.resolve('../bugdone-multica.user.js'), 'utf8');
const start = source.indexOf('(() => {');
const end = source.indexOf('  // 调试桩：');
assert.ok(start >= 0 && end > start);
assert.ok(!/\bmodule\b|\brequire\s*\(/.test(source));
const bridge = new Function('return ' + source.slice(start, end) +
  'return { parseResponse, mergeBug, marker, owns, isBugAPI, validateConfig, findExisting, submitOnce, shareURL };\n})();')();
const id = '7603f73c983242c1811852a53b26e2c3';
const c = { api: 'https://api.multica.ai', workspace: '11111111-1111-4111-8111-111111111111', token: 'test' };
const bug = { BugId: id };
const issue = { id: 'task-id', title: `${bridge.marker(id)} 测试 Bug`, status: 'done' };
const body = { title: issue.title };
test('分享地址采用官网项目与 Bug ID 路径，缺失或非法 ID 不生成链接', () => {
  const project = '45b65385f2a443dba353aa93fa2b8cf8';
  assert.equal(bridge.shareURL({ ProjectId: project, BugId: id }), `https://www.bugdone.cn/cn/bugPreview/${project}/${id}`);
  assert.equal(bridge.shareURL({ BugId: id }), '');
  assert.equal(bridge.shareURL({ ProjectId: '../other', BugId: id }), '');
  assert.equal(bridge.shareURL({ ProjectId: project, BugId: id + '。' }), '');
});
function storage(initial) {
  let value = initial;
  return { get: () => value, set: (_, x) => { value = x; }, read: () => value };
}
test('列表响应可解析，且不会误判为详情', () => {
  const raw = JSON.stringify({ Result: 1, ReturnObj: { ItemList: [
    { BugId: id, BugTitle: '测试缺陷', BugCode: 284, BugAccessoryList: [] }
  ] } });
  const bugs = bridge.parseResponse(raw);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].detail, false);
  assert.equal(bugs[0].attachments.length, 0);
});
test('空描述详情仍能提取附件，仅保留安全链接', () => {
  const r = { Result: 1, ReturnObj: { BugId: id, BugTitle: 'test', Description: '', PicCount: 1, BugAccessoryList: [
    { FullFileUrl: 'https://img.bugdone.cn/example.png', ext: 'png' },
    { FullFileUrl: 'javascript:alert(1)' },
    { FullFileUrl: 'https://img.bugdone.cn/deleted.png', ActiveFlg: false }
  ] } };
  const [b] = bridge.parseResponse(JSON.stringify(JSON.stringify(r)));
  assert.equal(b.detail, true);
  assert.equal(b.attachments.length, 1);
  assert.equal(b.attachments[0].image, true);
  assert.equal(bridge.mergeBug(b, { BugId: id, BugTitle: 'updated', detail: false }).attachments.length, 1);
});
test('捕获仅限同域已知接口，大小写和查询字符串兼容', () => {
  assert.equal(bridge.isBugAPI('/Service/Bugdone/BugAPI.ashx?time=123'), true);
  assert.equal(bridge.isBugAPI('https://evil.test/Service/BugDone/BugAPI.ashx'), false);
  assert.equal(bridge.isBugAPI('/Service/Login.ashx'), false);
});
test('拒绝带凭据、查询参数或明文远程 API 的配置', () => {
  for (const api of ['https://user:pass@example.com', 'https://api.multica.ai?token=x', 'http://example.com', 'https://api.multica.ai/api']) {
    assert.throws(() => bridge.validateConfig({ ...c, api }));
  }
  assert.equal(bridge.validateConfig({ ...c, api: 'http://localhost:8080' }).api, 'http://localhost:8080');
});
test('已完成任务也复用，搜索无误匹配并继续翻页', async () => {
  const s = storage(), calls = [];
  const unrelated = Array.from({ length: 50 }, () => ({ title: 'other' }));
  const result = await bridge.submitOnce({ c, bug, body, ...s, api: async (method, path) => {
    calls.push([method, path]);
    return { status: 200, data: { issues: path.includes('offset=50') ? [issue] : unrelated } };
  } });
  assert.equal(result.existing, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([m, p]) => m === 'GET' && p.includes('include_closed=true')));
});
test('创建成功后缓存 ID，下次仅查询已有 ID，不再 POST', async () => {
  const s = storage(), calls = [];
  const api = async (m, p) => {
    calls.push(m);
    if (m === 'POST') { assert.equal(s.read().pending, true); return { status: 201, data: issue }; }
    return { status: 200, data: p.includes('/search?') ? { issues: [] } : issue };
  };
  await bridge.submitOnce({ c, bug, body, api, ...s });
  assert.deepEqual(s.read(), { id: 'task-id' });
  const again = await bridge.submitOnce({ c, bug, body, api, ...s });
  assert.equal(again.existing, true);
  assert.equal(calls.filter(x => x === 'POST').length, 1);
});
test('截图准备失败时不创建任务，也不留下待确认标记', async () => {
  const s = storage(); let posts = 0;
  await assert.rejects(bridge.submitOnce({ c, bug, body, ...s,
    api: async m => { if (m === 'POST') posts++; return { status: 200, data: { issues: [] } }; },
    prepareBody: async () => { throw Error('图片下载失败'); }
  }), /图片下载失败/);
  assert.equal(posts, 0);
  assert.equal(s.read(), undefined);
});
test('请求超时后只核验，不自动重发 POST', async () => {
  const s = storage(); let posts = 0;
  const api = async m => {
    if (m === 'POST') { posts++; throw Error('timeout'); }
    return { status: 200, data: { issues: [] } };
  };
  await assert.rejects(bridge.submitOnce({ c, bug, body, api, ...s }), /timeout/);
  await assert.rejects(bridge.submitOnce({ c, bug, body, api, ...s }), /上次提交结果未确认/);
  assert.equal(posts, 1);
});
test('超时后搜索到已创建任务，恢复关联', async () => {
  const s = storage({ pending: true });
  const result = await bridge.submitOnce({ c, bug, body, ...s, api: async () => ({ status: 200, data: { issues: [issue] } }) });
  assert.equal(result.existing, true);
  assert.equal(s.read().id, issue.id);
});
test('只有明确属于此 Bug 的 409 冲突才复用', async () => {
  for (const same of [true, false]) {
    const s = storage();
    const p = bridge.submitOnce({ c, bug, body, ...s, api: async m => m === 'GET'
      ? { status: 200, data: { issues: [] } }
      : { status: 409, data: { code: 'active_duplicate_issue', issue: same ? issue : { ...issue, title: 'other' } } } });
    if (same) assert.equal((await p).existing, true);
    else await assert.rejects(p, /创建未确认/);
  }
});
test('搜索失败或缓存任务不可访问时禁止创建', async () => {
  for (const record of [null, { id: 'task-id' }]) {
    const s = storage(record); let posts = 0;
    await assert.rejects(bridge.submitOnce({ c, bug, body, ...s, api: async m => {
      if (m === 'POST') posts++;
      return { status: 403, data: null };
    } }));
    assert.equal(posts, 0);
  }
});
