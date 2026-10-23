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
  'return { parseResponse, mergeBug, marker, owns, isBugAPI, validateConfig, findExisting, submitOnce, shareURL, agentChoices, agentCacheKey, listItems, buildIssueBody, bugTaskTitle, connectionCacheTag, needsCatalogRefresh, connectionBadge, verifyConnection, lookupSubmittedIssue, issueStatusLabel, loadSubmittedStatuses, shortcutFromEvent, shortcutMatches, normalizeShortcutConfig, startBugDoneProcessing };\n})();')();
const id = '7603f73c983242c1811852a53b26e2c3';
const c = { api: 'https://api.multica.ai', workspace: '11111111-1111-4111-8111-111111111111', token: 'test' };
const bug = { BugId: id };
const issue = { id: 'task-id', title: `${bridge.marker(id)} 测试 Bug`, status: 'done' };
const body = { title: issue.title };
test('快捷键须包含主修饰键，并能准确区分组合', () => {
  const event = { key: 'm', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false };
  assert.equal(bridge.shortcutFromEvent(event), 'Alt+Shift+M');
  assert.equal(bridge.shortcutMatches(event, 'Alt+Shift+M'), true);
  assert.equal(bridge.shortcutMatches({ ...event, shiftKey: false }, 'Alt+Shift+M'), false);
  assert.equal(bridge.shortcutFromEvent({ ...event, altKey: false }), '');
  assert.equal(bridge.shortcutFromEvent({ ...event, key: 'Shift' }), '');
});
test('升级时将旧默认键迁移到 Ctrl+Shift+M，保留主动设置的组合', () => {
  assert.equal(bridge.normalizeShortcutConfig({ shortcut: 'Alt+Shift+M' }).shortcut, 'Ctrl+Shift+M');
  assert.equal(bridge.normalizeShortcutConfig({ shortcut: 'Alt+Shift+M', shortcutCustomized: true }).shortcut, 'Alt+Shift+M');
  assert.equal(bridge.normalizeShortcutConfig({ shortcut: 'Meta+Shift+K', shortcutCustomized: true }).shortcut, 'Meta+Shift+K');
});
test('Multica 成功后只把同一待处理 Bug 改为处理中，并再次读取确认', async () => {
  const calls = [];
  const responses = [
    { Result: 1, ReturnObj: { BugId: id, StrBugStatus: '待处理' } },
    { Result: 1, ReturnObj: null },
    { Result: 1, ReturnObj: { BugId: id, StrBugStatus: '处理中' } }
  ];
  const result = await bridge.startBugDoneProcessing({ BugId: id }, async params => {
    calls.push(params); return responses.shift();
  });
  assert.deepEqual(result, { kind: 'started', state: '处理中' });
  assert.deepEqual(calls, [
    { Method: 'getBugInfo', bugId: id },
    { Method: 'addBugAssign', bugId: id, actionType: 'toprocessing', reason: '' },
    { Method: 'getBugInfo', bugId: id }
  ]);
});
test('BugDone 已处理中或进入其他流程时不重复操作；更新失败明确报错', async () => {
  const calls = [];
  const read = state => async params => {
    calls.push(params); return { Result: 1, ReturnObj: { BugId: id, StrBugStatus: state } };
  };
  assert.deepEqual(await bridge.startBugDoneProcessing({ BugId: id }, read('处理中')), { kind: 'already-processing', state: '处理中' });
  assert.deepEqual(await bridge.startBugDoneProcessing({ BugId: id }, read('待审核')), { kind: 'skipped', state: '待审核' });
  assert.equal(calls.length, 2);
  await assert.rejects(bridge.startBugDoneProcessing({ BugId: id }, async () => ({ Result: 0, Message: '无权限' })), /无权限/);
  await assert.rejects(bridge.startBugDoneProcessing({ BugId: id }, async params => params.Method === 'getBugInfo'
    ? { Result: 1, ReturnObj: { BugId: 'other', StrBugStatus: '待处理' } }
    : { Result: 1 }), /Bug ID/);
});
test('连接列表兼容数组与包装结果；任务选项正确写入创建请求', () => {
  assert.deepEqual(bridge.listItems({ workspaces: [{ id: 'w', name: '研发' }] }, 'workspaces'), [{ id: 'w', name: '研发' }]);
  assert.deepEqual(bridge.listItems([{ id: 'p', name: '项目' }], 'projects'), [{ id: 'p', name: '项目' }]);
  const finalTitle = `[BugDone] #284 标题 [BugDone:${id}]`;
  assert.equal(bridge.bugTaskTitle({ BugCode: 284, BugTitle: '标题', BugId: id }), finalTitle);
  assert.deepEqual(bridge.buildIssueBody({ title: finalTitle, description: '描述', agent: c.workspace,
    project: c.workspace, status: 'in_progress', priority: 'high', label: c.workspace,
    startDate: '2026-10-22', dueDate: '2026-10-24' }), {
    title: finalTitle, description: '描述', status: 'in_progress', priority: 'high',
    assignee_type: 'agent', assignee_id: c.workspace, allow_duplicate: false,
    project_id: c.workspace, label_ids: [c.workspace], start_date: '2026-10-22', due_date: '2026-10-24'
  });
  assert.throws(() => bridge.buildIssueBody({ title: '标题', description: '描述', bugId: id,
    agent: c.workspace, startDate: '2026-10-24', dueDate: '2026-10-22' }), /截止日期/);
  assert.equal(bridge.buildIssueBody({ title: '用户编辑后的最终标题', description: '最终内容',
    agent: c.workspace }).title, '用户编辑后的最终标题');
});
test('已有连接缓存无需启动时重复拉取；Token 变化或缓存缺失会刷新', () => {
  const tag = bridge.connectionCacheTag('https://api.multica.ai', 'token-one');
  const ready = { api: 'https://api.multica.ai', token: 'token-one', workspace: c.workspace };
  assert.equal(bridge.needsCatalogRefresh(ready, tag, [{ id: c.workspace }], { agents: [], projects: [], labels: [] }), false);
  assert.equal(bridge.needsCatalogRefresh({ ...ready, token: 'token-two' }, tag, [{ id: c.workspace }], { agents: [], projects: [], labels: [] }), true);
  assert.equal(bridge.needsCatalogRefresh(ready, tag, [{ id: c.workspace }], null), true);
});
test('入口状态区分未配置、连接中、已连接和失败；缓存恢复须验证 Token', async () => {
  assert.equal(bridge.connectionBadge({ api: c.api, token: '' }, 'connected').text, '未配置');
  assert.equal(bridge.connectionBadge({ api: c.api, token: c.token }, 'idle').text, '待连接');
  assert.equal(bridge.connectionBadge({ api: c.api, token: c.token }, 'connecting').text, '连接中');
  assert.equal(bridge.connectionBadge({ api: c.api, token: c.token }, 'connected').text, '已连接');
  assert.equal(bridge.connectionBadge({ api: c.api, token: c.token }, 'error').text, '连接失败');
  const calls = [];
  await bridge.verifyConnection(async (method, path) => { calls.push([method, path]); return { status: 200 }; });
  assert.deepEqual(calls, [['GET', '/api/me']]);
  await assert.rejects(bridge.verifyConnection(async () => ({ status: 401 })), /HTTP 401/);
});
test('新旧 BugDone 标题均可识别为同一个 Bug，避免升级后重复创建', () => {
  assert.equal(bridge.owns({ title: `[BugDone] #284 测试 [BugDone:${id}]` }, id), true);
  assert.equal(bridge.owns({ title: `用户编辑标题 [BugDone:${id}]` }, id), true);
  assert.equal(bridge.owns({ title: `[BugDone:${id}] 测试` }, id), true);
  assert.equal(bridge.owns({ title: `[BugDone] #284 其他` }, id), false);
});
test('已保存的智能体无需重新读取即可在设置和接入页恢复', () => {
  const saved = { api: 'https://api.multica.ai', workspace: c.workspace, agent: '', defaultAgent: 'agent-default' };
  assert.equal(bridge.agentCacheKey(saved), `agents:1:https://api.multica.ai:${c.workspace}`);
  assert.deepEqual(bridge.agentChoices(saved, []), {
    agents: [{ id: 'agent-default', name: '已保存的智能体 · agent-default' }],
    selectedAgent: 'agent-default', selectedDefault: 'agent-default'
  });
  assert.deepEqual(bridge.agentChoices(saved, [
    { id: 'agent-default', name: '修复智能体' }, { id: 'archived', name: '旧智能体', is_archived: true }
  ]), {
    agents: [{ id: 'agent-default', name: '修复智能体' }],
    selectedAgent: 'agent-default', selectedDefault: 'agent-default'
  });
});
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
test('处理列表优先按已保存任务 ID 查询最新状态', async () => {
  const calls = [];
  const item = { issueId: 'task-id', bugId: id };
  const found = await bridge.lookupSubmittedIssue(async (method, path) => {
    calls.push([method, path]);
    return { status: 200, data: { id: 'task-id', title: `${bridge.marker(id)} 测试`, status: 'in_progress' } };
  }, item);
  assert.equal(found.status, 'in_progress');
  assert.deepEqual(calls, [['GET', '/api/issues/task-id']]);
  assert.equal(bridge.issueStatusLabel(found.status), '进行中');
});
test('旧记录没有任务 ID 时按查重标记查找，查不到时保持未知', async () => {
  const paths = [];
  const api = async (_, path) => {
    paths.push(path);
    return { status: 200, data: { issues: [{ id: 'found', title: `${bridge.marker(id)} 测试`, status: 'done' }] } };
  };
  const found = await bridge.lookupSubmittedIssue(api, { bugId: id });
  assert.equal(found.id, 'found');
  assert.equal(bridge.issueStatusLabel(found.status), '已完成');
  assert.ok(paths[0].includes(encodeURIComponent(bridge.marker(id))));
  assert.equal(bridge.issueStatusLabel('custom_state'), 'custom_state');
  assert.equal(bridge.issueStatusLabel(null), '未知');
});
test('处理列表任务读取失败时不把失败当作未创建', async () => {
  await assert.rejects(bridge.lookupSubmittedIssue(async () => ({ status: 403, data: null }),
    { issueId: 'task-id', bugId: id }), /HTTP 403/);
});
test('处理列表只查询当前服务与工作区，并逐项报告状态或失败', async () => {
  const items = [
    { issueId: 'a', bugId: id, api: c.api, workspace: c.workspace },
    { issueId: 'b', bugId: id, api: 'https://other.example', workspace: c.workspace },
    { issueId: 'c', bugId: id, api: c.api, workspace: 'other-workspace' },
    { issueId: 'd', bugId: id, api: c.api, workspace: c.workspace }
  ];
  const results = new Map(), paths = [];
  await bridge.loadSubmittedStatuses(items, c, async (_, path) => {
    paths.push(path);
    if (path.endsWith('/d')) return { status: 403, data: null };
    return { status: 200, data: { id: 'a', status: 'todo' } };
  }, (item, result) => results.set(item.issueId, result));
  assert.deepEqual(paths.sort(), ['/api/issues/a', '/api/issues/d']);
  assert.equal(results.get('a').status, 'todo');
  assert.equal(results.get('b').kind, 'unavailable');
  assert.equal(results.get('c').kind, 'unavailable');
  assert.equal(results.get('d').kind, 'error');
});
