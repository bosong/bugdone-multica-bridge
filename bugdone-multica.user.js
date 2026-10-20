// ==UserScript==
// @name         BugDone 接入 Multica
// @namespace    local.bugdone.multica
// @version      0.9.2
// @description  BugDone桥接Multica智能体
// @updateURL    https://raw.githubusercontent.com/bosong/bugdone-multica-bridge/main/bugdone-multica.user.js
// @downloadURL  https://raw.githubusercontent.com/bosong/bugdone-multica-bridge/main/bugdone-multica.user.js
// @match        https://www.bugdone.cn/*
// @run-at       document-start
// @fastlane-network
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.multica.ai
// @connect      img.bugdone.cn
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(() => {
  'use strict';
  // 按当前浏览器实测使用宽匹配；先限制域名，再执行提示和接口监听。
  if (typeof window !== 'undefined') {
    if (!['http:', 'https:'].includes(window.location.protocol) ||
        !['www.bugdone.cn', 'bugdone.cn'].includes(window.location.hostname)) return;
    console.warn('toton');
    //window.alert('toton：油猴脚本入口已执行');
  }
  const UI_DELAY_MS = 300; // 可改为 1000：页面就绪后延迟 1 秒显示按钮。
  const VERSION = 1;
  const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  const BUGID = /^[a-f\d]{32}$/i;
  // 与官网 #btnShare 使用同一规则；二维码接口不负责生成此网页链接。
  function shareURL(b) {
    if (!BUGID.test(b.ProjectId || '') || !BUGID.test(b.BugId || '')) return '';
    return `https://www.bugdone.cn/cn/bugPreview/${b.ProjectId}/${b.BugId}`;
  }
  const marker = id => `[BugDone:${id.toLowerCase()}]`;
  const isBugAPI = value => {
    try {
      const u = new URL(String(value), 'https://www.bugdone.cn');
      return u.origin === 'https://www.bugdone.cn' && u.pathname.toLowerCase() === '/service/bugdone/bugapi.ashx';
    } catch { return false; }
  };
  function parseResponse(value) {
    let x = value;
    for (let i = 0; i < 2 && typeof x === 'string'; i++) x = JSON.parse(x);
    if (!x || x.Result !== 1 || !x.ReturnObj) return [];
    const r = x.ReturnObj;
    const detail = !Array.isArray(r.ItemList);
    return (detail ? [r] : r.ItemList).filter(b =>
      b && BUGID.test(b.BugId || '') && typeof b.BugTitle === 'string'
    ).map(b => ({
      BugId: b.BugId.toLowerCase(), BugCode: b.BugCode, BugTitle: b.BugTitle,
      ProjectId: b.ProjectId || '', ProjectName: b.ProjectName || '',
      ProductName: b.ProductName || '', ModuleName: b.ModuleName || '',
      StrPriority: b.StrPriority || '', StrBugStatus: b.StrBugStatus || '',
      Description: typeof b.Description === 'string' ? b.Description : '',
      Environment: b.Environment || '', PicCount: b.PicCount || 0,
      AttachmentCount: b.AttachmentCount || 0,
      detail, sourceUrl: '',
      attachments: (Array.isArray(b.BugAccessoryList) ? b.BugAccessoryList : [])
        .filter(a => a && a.ActiveFlg !== false && a.FullFileUrl)
        .map(a => ({ url: safeURL(a.FullFileUrl), name: String(a.FileName || a.AccessoryName || a.FileUrl || '附件'), image: /^(png|jpe?g|gif|webp|bmp)$/i.test(a.ext || '') }))
        .filter(a => a.url)
    }));
  }
  function safeURL(value) {
    try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; }
    catch { return ''; }
  }
  function mergeBug(old, next) {
    // 列表里的 null/空字段不能覆盖已经捕获到的详情。
    if (old?.detail && !next.detail) return { ...next, ...old, BugTitle: next.BugTitle, StrBugStatus: next.StrBugStatus };
    return { ...old, ...next };
  }
  function validateConfig(c) {
    const u = new URL(c.api);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('API 地址请填写服务根地址，例如 https://api.multica.ai');
    const loopback = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw Error('远程 API 必须使用 HTTPS');
    if (!c.token?.trim() || !UUID.test(c.workspace)) throw Error('请填写 Token 和工作区完整 UUID');
    if (c.project && !UUID.test(c.project)) throw Error('Multica 项目 ID 必须是完整 UUID');
    return { ...c, api: u.origin, token: c.token.trim() };
  }
  function agentCacheKey(c) { return `agents:${VERSION}:${c.api}:${c.workspace}`; }
  function agentChoices(c, list) {
    const agents = [], seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.id !== 'string' || !item.id || item.is_archived === true || seen.has(item.id)) continue;
      seen.add(item.id);
      agents.push({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : item.id });
    }
    for (const id of [c.agent, c.defaultAgent]) {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id); agents.push({ id, name: `已保存的智能体 · ${id}` });
      }
    }
    return { agents, selectedAgent: c.agent || c.defaultAgent || '', selectedDefault: c.defaultAgent || '' };
  }
  const owns = (issue, id) => typeof issue?.title === 'string' && issue.title.startsWith(marker(id) + ' ');
  function cacheKey(c, id) { return `task:${VERSION}:${c.api}:${c.workspace}:${id}`; }
  async function findExisting(api, id) {
    // 搜索含已完成任务；分页全部读完才允许认定不存在。
    for (let offset = 0; offset < 5000; offset += 50) {
      const r = await api('GET', `/api/issues/search?q=${encodeURIComponent(marker(id))}&include_closed=true&limit=50&offset=${offset}`);
      if (r.status !== 200 || !Array.isArray(r.data?.issues)) throw Error('查询已有任务失败；已停止创建以防重复');
      const hit = r.data.issues.find(x => x.id && owns(x, id));
      if (hit) return hit;
      if (r.data.issues.length < 50) return null;
    }
    throw Error('搜索结果过多，无法确认是否重复；请人工核对');
  }
  async function submitOnce({ c, bug, body, api, get, set, prepareBody }) {
    const key = cacheKey(c, bug.BugId);
    const record = get(key, null);
    if (record?.id) {
      const r = await api('GET', `/api/issues/${encodeURIComponent(record.id)}`);
      if (r.status === 200 && owns(r.data, bug.BugId)) return { issue: r.data, existing: true };
      throw Error('已有本地关联，但任务暂时无法核验；请检查权限、归档或标题修改，已停止重复创建');
    }
    const hit = await findExisting(api, bug.BugId);
    if (hit) { set(key, { id: hit.id }); return { issue: hit, existing: true }; }
    if (record?.pending) throw Error('上次提交结果未确认，当前搜索仍未找到任务。请在 Multica 人工核对；脚本不会自动再次创建。');
    if (prepareBody) body = await prepareBody(body);
    set(key, { pending: true, time: new Date().toISOString() });
    // 请求超时/断网/5xx时保留 pending，下一次只核验，不盲目重试。
    const r = await api('POST', '/api/issues', body);
    let issue;
    if (r.status === 201 && owns(r.data, bug.BugId) && r.data.id) issue = r.data;
    else if (r.status === 409 && r.data?.code === 'active_duplicate_issue' && r.data.issue?.id && owns(r.data.issue, bug.BugId)) issue = r.data.issue;
    else {
      if ([400, 401, 403, 404, 422, 429].includes(r.status)) set(key, null);
      throw Error(`创建未确认（HTTP ${r.status}）：${String(r.data?.error || '请在 Multica 核对后处理').slice(0, 250)}`);
    }
    set(key, { id: issue.id });
    return { issue, existing: r.status === 409 };
  }
  // 调试桩：仅打印阶段、数量和 HTTP 状态，不打印令牌、请求头或 Bug 正文。
  const DEBUG = true;
  const SCRIPT_VERSION = '0.9.2';
  function debug(stage, data = {}, level = 'info') {
    if (DEBUG) console[level](`[BugDone→Multica] ${stage}`, data);
  }
  debug('脚本已启动', {
    version: SCRIPT_VERSION, path: location.pathname, readyState: document.readyState,
    unsafeWindow: typeof unsafeWindow !== 'undefined',
    GM_xmlhttpRequest: typeof GM_xmlhttpRequest === 'function',
    FastlaneNativeNetwork: typeof window.FastlaneNativeNetwork?.request === 'function',
    fetch: typeof fetch === 'function',
    abortController: typeof AbortController === 'function',
    webLocks: !!navigator.locks
  });

  const bugs = new Map();
  let currentId = '', root, busy = false, previewFingerprint = '';
  // Mac App WebView 不提供 GM_getValue/GM_setValue；存储完全走 Web Storage，避免触发不存在的油猴 API。
  const hasGMStorage = false;
  const storagePrefix = 'bugdone-multica:';
  let storageMode = '网页本地存储';
  let storageFailed = false;
  const memoryStore = new Map();
  function readValue(key, fallback) {
    const storageKey = storagePrefix + key;
    try { const raw = window.localStorage.getItem(storageKey); if (raw !== null) return JSON.parse(raw); } catch (e) { debug('localStorage 不可用，尝试 sessionStorage', { errorType: e.name }, 'warn'); }
    try { const raw = window.sessionStorage.getItem(storageKey); if (raw !== null) { storageMode = '网页会话存储'; return JSON.parse(raw); } } catch (e) { debug('sessionStorage 不可用，使用内存缓存', { errorType: e.name }, 'warn'); }
    return memoryStore.has(key) ? memoryStore.get(key) : fallback;
  }
  function writeValue(key, value) {
    const storageKey = storagePrefix + key; const serialized = JSON.stringify(value);
    try { window.localStorage.setItem(storageKey, serialized); storageMode = '网页本地存储'; return; } catch (e) { debug('localStorage 写入失败，尝试 sessionStorage', { errorType: e.name }, 'warn'); }
    try { window.sessionStorage.setItem(storageKey, serialized); storageMode = '网页会话存储'; return; } catch (e) { debug('sessionStorage 写入失败，使用内存缓存', { errorType: e.name }, 'warn'); }
    memoryStore.set(key, value); storageMode = '页面内存缓存';
  }
  let config = { api: 'https://api.multica.ai', workspace: '', workspaceAlias: '', token: '', agent: '', defaultAgent: '', project: '', projectAlias: '' };
  config.hideNativeAI = true;
  let submittedBugs = [];
  let launchPosition = readValue('launchPosition', null);
  config = { ...config, ...(readValue('config', config) || {}) };
  const savedBugs = readValue('submittedBugs', []);
  submittedBugs = Array.isArray(savedBugs) ? savedBugs.slice(0, 100) : [];
  function submittedFor(id) { return submittedBugs.find(x => x && x.bugId === id); }
  function rememberSubmitted(b, issue, c) {
    const item = { bugId: b.BugId, bugCode: b.BugCode, title: b.BugTitle, issueId: issue.id,
      identifier: issue.identifier || '', issueTitle: issue.title || '', submittedAt: new Date().toISOString(),
      workspace: c.workspace, workspaceAlias: c.workspaceAlias || '', project: c.project || '', projectAlias: c.projectAlias || '' };
    submittedBugs = [item, ...submittedBugs.filter(x => x.bugId !== b.BugId || x.workspace !== c.workspace)].slice(0, 100);
    try { writeValue('submittedBugs', submittedBugs); } catch (e) { debug('已处理列表保存失败', { errorType: e.name }, 'warn'); }
    return item;
  }
  function forgetSubmitted(item) {
    submittedBugs = submittedBugs.filter(x => x !== item && !(x.bugId === item.bugId && x.workspace === item.workspace));
    try { writeValue('submittedBugs', submittedBugs); } catch (e) { debug('已处理列表删除失败', { errorType: e.name }, 'warn'); }
  }
  function setNativeAIVisibility(hidden) {
    document.querySelectorAll('#openIntelligentTracking').forEach(el => { el.style.display = hidden ? 'none' : ''; });
  }
  function watchNativeAI() {
    setNativeAIVisibility(config.hideNativeAI !== false);
    if (!document.body) return;
    const observer = new MutationObserver(() => setNativeAIVisibility(config.hideNativeAI !== false));
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
  const $ = id => root.getElementById(id);
  function collect(data) {
    try {
      const items = parseResponse(data);
      debug('响应解析完成', { bugs: items.length, details: items.filter(b => b.detail).length });
      for (const b of items) {
        b.sourceUrl = location.href;
        bugs.set(b.BugId, mergeBug(bugs.get(b.BugId), b));
        if (b.detail) currentId = b.BugId;
      }
      if (items.length && root) renderBugs();
    } catch (e) {
      debug('响应解析跳过', { errorType: e.name }, 'warn');
    }
  }
  // Mac App WebView 可能把用户脚本和网页放在不同的 JS 世界；在网页世界再安装一层桥接。
  function installPageBridge() {
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    function receive(event) {
      const data = event.data;
      if ((event.origin === location.origin || event.origin === 'null') && data && data.__bugdoneMulticaBridge === true && typeof data.text === 'string') {
        debug('收到页面上下文 BugAPI 响应', { bytes: data.text.length });
        collect(data.text);
      }
    }
    window.addEventListener('message', receive, false);
    const pageBridge = function() {
      if (window.__bugdoneMulticaPageBridge) return;
      window.__bugdoneMulticaPageBridge = true;
      const isBugAPI = value => { try { const u = new URL(String(value), location.href); return u.origin === location.origin && u.pathname.toLowerCase() === '/service/bugdone/bugapi.ashx'; } catch (_) { return false; } };
      const send = value => { if (typeof value !== 'string' || value.length > 4000000) return; window.postMessage({ __bugdoneMulticaBridge: true, text: value }, '*'); };
      const xhrURLs = new WeakMap();
      const XHR = window.XMLHttpRequest;
      if (XHR?.prototype) {
        const open = XHR.prototype.open, sendOriginal = XHR.prototype.send;
        XHR.prototype.open = function(method, url, ...args) { xhrURLs.set(this, String(url)); return open.call(this, method, url, ...args); };
        XHR.prototype.send = function(...args) { if (isBugAPI(xhrURLs.get(this))) this.addEventListener('load', function() { if (this.status === 200) { try { send(this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); } catch (_) {} } }, { once: true }); return sendOriginal.apply(this, args); };
      }
      if (typeof window.fetch === 'function') {
        const fetchOriginal = window.fetch;
        window.fetch = function(...args) { const result = fetchOriginal.apply(this, args); const url = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url; if (isBugAPI(url)) Promise.resolve(result).then(response => { if (response.ok) return response.clone().text().then(send); }).catch(() => {}); return result; };
      }
    };
    const inject = () => {
      try {
        if (!page.document?.documentElement) { setTimeout(inject, 50); return; }
        const script = page.document.createElement('script');
        script.textContent = `(${pageBridge.toString()})();`;
        (page.document.head || page.document.documentElement).appendChild(script);
        script.remove();
        debug('页面上下文桥接已安装');
      } catch (e) { debug('页面上下文桥接安装失败', { errorType: e.name }, 'warn'); }
    };
    inject();
  }
  installPageBridge();
  // 只旁观已知 BugAPI 的成功响应；不读取请求体、Cookie 或 Authorization。
  let captureHookFailed = false;
  try {
  const page = unsafeWindow;
  const xhrURLs = new WeakMap();
  const originalOpen = page.XMLHttpRequest.prototype.open;
  const originalSend = page.XMLHttpRequest.prototype.send;
  page.XMLHttpRequest.prototype.open = function(method, url, ...args) {
    xhrURLs.set(this, String(url));
    return originalOpen.call(this, method, url, ...args);
  };
  page.XMLHttpRequest.prototype.send = function(...args) {
    if (isBugAPI(xhrURLs.get(this))) {
      debug('捕获 BugAPI XHR 请求');
      this.addEventListener('load', function() {
        debug('BugAPI XHR 响应', { status: this.status, responseType: this.responseType });
        try { if (this.status === 200) collect(this.responseType === 'json' ? this.response : this.responseText); }
        catch (e) { debug('XHR 响应读取失败', { errorType: e.name }, 'warn'); }
      }, { once: true });
      this.addEventListener('error', () => debug('BugAPI XHR 网络错误', {}, 'warn'), { once: true });
    }
    return originalSend.apply(this, args);
  };
  if (typeof page.fetch === 'function') {
    const originalFetch = page.fetch;
    async function observeBugFetch(promise) {
      try {
        const response = await promise;
        debug('BugAPI fetch 响应', { status: response.status });
        if (response.ok) {
          const text = await response.clone().text();
          collect(text);
        }
      } catch (error) {
        debug('BugAPI fetch 捕获失败', { errorType: error.name }, 'warn');
      }
    }
    page.fetch = function(...args) {
      const result = originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
      if (isBugAPI(url)) {
        debug('捕获 BugAPI fetch 请求');
        void observeBugFetch(result);
      }
      return result;
    };
  }
  debug('接口监听已安装', { xhr: true, fetch: typeof page.fetch === 'function' });
  } catch (e) {
    captureHookFailed = true;
    debug('接口监听安装失败', { errorType: e.name }, 'error');
  }
  function message(text, kind = 'info') { const el = $('message'); el.textContent = text; el.className = `status-${kind}`; }
  function settings() {
    return validateConfig({ api: $('api').value.trim(), workspace: $('workspace').value.trim(), workspaceAlias: $('workspaceAlias').value.trim(), token: $('token').value, project: $('project').value.trim(), projectAlias: $('projectAlias').value.trim(), agent: $('agent').value, defaultAgent: $('default-agent').value, hideNativeAI: $('hide-native-ai').checked });
  }
  function request(c) {
    return (method, path, body) => new Promise((resolve, reject) => {
      let done = false, handle;
      const finish = (fn, x) => { if (!done) { done = true; clearTimeout(timer); fn(x); } };
      const timer = setTimeout(() => { finish(reject, Error('请求超时；提交结果可能未知，请勿盲目重复创建')); handle?.abort(); }, 30000);
      const headers = { Authorization: `Bearer ${c.token}`, 'X-Workspace-ID': c.workspace, 'Content-Type': 'application/json' };
      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          handle = GM_xmlhttpRequest({ method, url: c.api + path, anonymous: true, redirect: 'error', headers,
            data: body ? JSON.stringify(body) : undefined,
            onload: r => {
              let data; try { data = JSON.parse(r.responseText); } catch { data = null; }
              if (r.finalUrl && new URL(r.finalUrl).origin !== c.api) return finish(reject, Error('API 发生跨域跳转，已停止'));
              finish(resolve, { status: r.status, data });
            }, onerror: () => finish(reject, Error('网络失败：检查 API 地址、油猴 @connect 权限和浏览器网络设置')),
            onabort: () => finish(reject, Error('请求已中止'))
          });
        } else if (typeof window.FastlaneNativeNetwork?.request === 'function') {
          const options = { method, url: c.api + path, headers, timeoutMs: 30000, responseType: 'text' };
          if (body) options.body = JSON.stringify(body);
          window.FastlaneNativeNetwork.request(options).then(response => {
            if (response.url && new URL(response.url).origin !== c.api) throw Error('API 发生跨域跳转，已停止');
            let data; try { data = JSON.parse(response.body); } catch { data = null; }
            finish(resolve, { status: response.status, data });
          }).catch(error => finish(reject, Error(`原生网络桥请求失败：${error.message || String(error)}`)));
          debug('Multica API 使用 Fastlane 原生网络桥');
        } else if (typeof fetch === 'function' && typeof AbortController === 'function') {
          const controller = new AbortController(); handle = { abort: () => controller.abort() };
          fetch(c.api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: controller.signal })
            .then(response => {
              if (response.url && new URL(response.url).origin !== c.api) throw Error('API 发生跨域跳转，已停止');
              return response.text().then(text => { let data; try { data = JSON.parse(text); } catch { data = null; } return { status: response.status, data }; });
            })
            .then(result => finish(resolve, result))
            .catch(error => {
              if (error.name === 'AbortError') return finish(reject, Error('请求已中止'));
              const detail = error.message === 'Load failed' || error.message === 'Failed to fetch'
                ? 'WebView 跨域请求被拒绝（通常是 API CORS、TLS 证书或网络策略）。请更新带原生网络桥的 Mac App，或让 API 允许来源 https://www.bugdone.cn 及 Authorization、X-Workspace-ID、Content-Type 请求头。'
                : (error.message || '请检查 API 地址和网络连接');
              finish(reject, Error(`WebView API 请求失败：${detail}`));
            });
          debug('Multica API 使用 WebView fetch 兼容通道');
        } else throw Error('当前 WebView 没有 GM_xmlhttpRequest、FastlaneNativeNetwork 或 fetch/AbortController，无法访问 Multica API');
      } catch (e) { finish(reject, e); }
    });
  }
  function gmCall(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ ...options, anonymous: true, redirect: 'error', timeout: 60000,
        onload: resolve, onerror: () => reject(Error('网络请求失败')),
        ontimeout: () => reject(Error('网络请求超时')),
        onabort: () => reject(Error('网络请求已中止')) });
    });
  }
  async function uploadImage(c, attachment) {
    const source = new URL(attachment.url);
    if (source.protocol !== 'https:' || source.hostname !== 'img.bugdone.cn') throw Error('图片地址不属于允许的 BugDone 图片域');
    const target = `${c.api}/api/upload-file`;
    let status, data;
    if (typeof window.FastlaneNativeNetwork?.request === 'function') {
      const response = await window.FastlaneNativeNetwork.request({ method: 'POST', url: target,
        sourceUrl: source.href, filename: attachment.name,
        headers: { Authorization: `Bearer ${c.token}`, 'X-Workspace-ID': c.workspace },
        timeoutMs: 60000, responseType: 'text' });
      status = response.status; try { data = JSON.parse(response.body); } catch { data = null; }
    } else if (typeof GM_xmlhttpRequest === 'function') {
      const image = await gmCall({ method: 'GET', url: source.href, responseType: 'blob' });
      if (image.status !== 200 || !(image.response instanceof Blob)) throw Error(`读取图片失败（HTTP ${image.status}）`);
      if (image.response.size > 20 * 1024 * 1024) throw Error('图片超过 20 MiB');
      if (!image.response.type.startsWith('image/')) throw Error('BugDone 返回的不是图片');
      const form = new FormData(); form.append('file', image.response, attachment.name);
      const uploaded = await gmCall({ method: 'POST', url: target, headers: {
        Authorization: `Bearer ${c.token}`, 'X-Workspace-ID': c.workspace }, data: form });
      status = uploaded.status; try { data = JSON.parse(uploaded.responseText); } catch { data = null; }
    } else {
      throw Error('当前环境没有可用的跨域图片上传通道');
    }
    if (status < 200 || status >= 300 || !data?.id) throw Error(`上传失败（HTTP ${status}）：${String(data?.error || data?.message || '请检查 Multica 文件存储配置').slice(0, 150)}`);
    return data;
  }
  async function prepareIssueAttachments(c, b, body) {
    const images = b.attachments.filter(a => a.image);
    if (!images.length) return body;
    const ids = [];
    for (let i = 0; i < images.length; i++) {
      message(`正在上传截图 ${i + 1}/${images.length}：${images[i].name}`);
      try { ids.push((await uploadImage(c, images[i])).id); }
      catch (error) { throw Error(`截图「${images[i].name}」${error.message}；任务尚未创建。已上传的附件可能暂存在 Multica。`); }
    }
    return { ...body, attachment_ids: ids,
      description: `${body.description}\n\nMultica 附件 ID（请优先使用附件，不依赖上方 BugDone 外链）：\n${ids.map((id, i) => `- ${images[i].name}：${id}；使用 multica attachment download ${id} 获取`).join('\n')}` };
  }
  function htmlText(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style,iframe,object').forEach(x => x.remove());
    doc.querySelectorAll('img').forEach(x => {
      const url = safeURL(x.getAttribute('src'));
      x.replaceWith(doc.createTextNode(url ? `\n[内嵌图片](${url})\n` : ''));
    });
    doc.querySelectorAll('br').forEach(x => x.replaceWith(doc.createTextNode('\n')));
    doc.querySelectorAll('p,div,li').forEach(x => x.appendChild(doc.createTextNode('\n')));
    return doc.body.textContent.trim();
  }
  function description(b) {
    const mdLabel = s => String(s).replace(/[\[\]\\\r\n]/g, '_');
    const links = b.attachments.map(a => `${a.image ? '!' : ''}[${mdLabel(a.name)}](${a.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`).join('\n');
    return `${marker(b.BugId)}\n\n来源：${b.sourceUrl}\n只读分享：${shareURL(b) || '未生成（缺少有效的 ProjectId 或 BugId）'}\nBug ID：${b.BugId}\n编号：${b.BugCode}\n项目：${b.ProjectName || b.ProjectId || '未提供'}\n产品：${b.ProductName}\n模块：${b.ModuleName}\n优先级：${b.StrPriority}\nBugDone 状态：${b.StrBugStatus}\n环境：${b.Environment}\n\n任务要求：\n${b.BugTitle}\n\n详细描述：\n${htmlText(b.Description) || '原始详情未填写描述，请结合标题与附件分析。'}\n\n截图与附件：\n${links || '无已捕获附件'}\n\n请分析问题并修复，在交付时说明根因、修改和验证结果；遇到信息不足时先在任务中说明。`;
  }
  function renderBugs() {
    const select = $('bug');
    const selected = currentId || select.value;
    select.replaceChildren();
    for (const b of bugs.values()) {
      const o = document.createElement('option'); o.value = b.BugId;
      o.textContent = `#${b.BugCode} ${b.detail ? '✓详情' : '列表'} ${submittedFor(b.BugId) ? '· 已提交 Multica-AI 处理 ·' : ''}${b.BugTitle}`; select.append(o);
    }
    if (bugs.has(selected)) select.value = selected;
    currentId = select.value;
    $('count').textContent = bugs.size ? `已捕获 ${bugs.size} 个 Bug · ${[...bugs.values()].filter(b => b.detail).length} 个详情` : '等待捕获 · 请打开一个 Bug 的详情';
    const b = bugs.get(currentId);
    if (b && JSON.stringify(b) !== previewFingerprint) {
      $('reviewed').checked = false;
      preview();
    }
  }
  function preview() {
    const b = bugs.get($('bug').value);
    if (!b) return;
    currentId = b.BugId;
    previewFingerprint = JSON.stringify(b);
    $('title').value = b.BugTitle;
    $('description').value = description(b);
    $('share-url').value = shareURL(b);
    $('bug-state').textContent = b.detail ? '详情已就绪' : '等待详情';
    $('handoff-title').textContent = `#${b.BugCode} ${b.BugTitle}`;
    $('handoff-meta').textContent = `${b.ProjectName || '未提供项目'} · ${b.StrPriority || '未提供优先级'} · ${b.attachments.length} 个附件`;
    const expected = Number(b.PicCount) + Number(b.AttachmentCount);
    $('warning').textContent = !b.detail ? '仅捕获列表：请先打开此 Bug 的详情，待出现“✓详情”后提交。' :
      b.attachments.length < expected ? `原始记录有 ${expected} 个附件，目前仅捕获 ${b.attachments.length} 个；请核对附件是否完整。` :
      '已捕获详情。提交时会先上传截图到 Multica，再创建并指派任务。';
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    root.querySelectorAll('button[data-action]').forEach(x => x.disabled = true);
    try { await action(); } catch (e) { message(e.message || String(e), 'error'); }
    finally { busy = false; root.querySelectorAll('button[data-action]').forEach(x => x.disabled = false); }
  }
  function renderAgentChoices(c, list) {
    const choices = agentChoices(c, list);
    for (const [id, label, selected] of [
      ['agent', '先读取智能体', choices.selectedAgent],
      ['default-agent', '未设置默认智能体', choices.selectedDefault]
    ]) {
      const select = $(id);
      select.replaceChildren();
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = label; select.append(empty);
      for (const agent of choices.agents) {
        const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; select.append(option);
      }
      select.value = selected;
    }
    return choices.agents.length;
  }
  async function loadAgents() {
    const c = settings(); message('正在读取智能体…');
    const r = await request(c)('GET', '/api/agents');
    if (r.status !== 200) throw Error(`读取智能体失败（HTTP ${r.status}），请检查 Token 和工作区`);
    const agents = Array.isArray(r.data) ? r.data : r.data?.agents;
    if (!Array.isArray(agents)) throw Error('智能体返回结构与预期不符，请提供脱敏响应以适配');
    const count = renderAgentChoices(c, agents);
    writeValue(agentCacheKey(c), agentChoices({ agent: '', defaultAgent: '' }, agents).agents);
    message(`已读取 ${count} 个智能体，已保存供下次打开使用。`);
  }
  async function submit() {
    const c = settings(), b = bugs.get($('bug').value);
    if (!b?.detail) throw Error('请先在 BugDone 打开此 Bug 的详情，或导入详情 JSON，再提交');
    if (!UUID.test(c.agent)) throw Error('请先读取并选择智能体');
    if (!$('title').value.trim() || !$('description').value.trim()) throw Error('标题和描述不能为空');
    if (!$('reviewed').checked) throw Error('请先核对预览内容，并勾选提交确认');
    if (!navigator.locks) throw Error('当前浏览器不支持提交锁，请使用新版 Chrome/Edge');
    const body = { title: `${marker(b.BugId)} ${$('title').value.trim()}`, description: $('description').value,
      status: 'todo', assignee_type: 'agent', assignee_id: c.agent, allow_duplicate: false };
    if (c.project) body.project_id = c.project;
    message('正在核对已有任务；确认不存在后创建并指派…');
    const result = await navigator.locks.request(cacheKey(c, b.BugId), () => submitOnce({
      c, bug: b, body, api: request(c), get: readValue, set: writeValue,
      prepareBody: draft => prepareIssueAttachments(c, b, draft)
    }));
    $('reviewed').checked = false;
    rememberSubmitted(b, result.issue, c);
    renderBugs(); renderProcessing();
    const taskText = `任务已创建并指派，执行状态请到 Multica 查看：${result.issue.identifier || ''}\n任务 ID：${result.issue.id}`;
    message(result.existing ? `已找到并复用已有任务，未重复创建：${result.issue.identifier || ''}\n任务 ID：${result.issue.id}` : taskText, result.existing ? 'warning' : 'success');
    if (!result.existing) showSuccess(taskText);
  }
  function switchTab(name, focus = false) {
    root.querySelectorAll('[role="tab"]').forEach(tab => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    root.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== `view-${name}`; });
    $('target-api').textContent = $('api').value.trim() || '尚未配置 API 地址';
    $('target-workspace').textContent = $('workspace').value.trim() ? `${$('workspaceAlias').value.trim() || '工作区'} · ${$('workspace').value.trim()}` : '请先在设置中填写工作区和 PAT';
    $('target-project').textContent = $('project').value.trim() ? `${$('projectAlias').value.trim() || 'Multica 项目'} · ${$('project').value.trim()}` : '未指定 Multica 项目';
    if (name === 'processing') renderProcessing();
  }
  function showSuccess(text) {
    const box = $('success'); box.querySelector('.success-copy').textContent = text;
    box.hidden = false; box.classList.remove('success-pop'); void box.offsetWidth; box.classList.add('success-pop');
    clearTimeout(showSuccess.timer); showSuccess.timer = setTimeout(() => { box.hidden = true; }, 5500);
  }
  function renderProcessing() {
    const list = $('processing-list'); if (!list) return; list.replaceChildren();
    $('processing-count').textContent = `共 ${submittedBugs.length} 条，最多保留 100 条`;
    if (!submittedBugs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有已提交给 Multica-AI 的 Bug。'; list.append(empty); return; }
    for (const item of submittedBugs) {
      const row = document.createElement('article'); row.className = 'processing-item';
      const time = new Date(item.submittedAt).toLocaleString('zh-CN', { hour12: false });
      row.innerHTML = `<div class="processing-main"><div class="processing-title"></div><div class="processing-meta"></div></div><button class="text-button processing-delete">删除</button>`;
      row.querySelector('.processing-title').textContent = `#${item.bugCode || '-'} ${item.title || item.bugId}`;
      row.querySelector('.processing-meta').textContent = `${item.identifier || item.issueId || '任务 ID 未返回'} · ${time}${item.workspaceAlias ? ` · ${item.workspaceAlias}` : ''}`;
      row.querySelector('.processing-delete').onclick = () => { forgetSubmitted(item); renderProcessing(); renderBugs(); message('已从本地处理列表删除；不会删除 Multica 中的任务。'); };
      list.append(row);
    }
  }
  function mount() {
    debug('开始挂载按钮');
    const host = document.createElement('div'); host.id = 'bugdone-multica-bridge';
    document.body.append(host); root = host.attachShadow({ mode: 'closed' });
    document.documentElement.setAttribute('data-bugdone-multica-started', SCRIPT_VERSION);
    watchNativeAI();
    root.innerHTML = `<style>
      :host{all:initial;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#243247;font-size:14px;line-height:1.5;color-scheme:light}
      *,*::before,*::after{box-sizing:border-box} [hidden]{display:none!important}
      button,input,select,textarea{font:inherit} button{cursor:pointer;border:1px solid transparent;border-radius:10px;background:#4f46e5;color:#fff;padding:10px 16px;font-weight:600;transition:background .15s,box-shadow .15s}
      button:hover{background:#4338ca} button:disabled{opacity:.5;cursor:wait} button:focus-visible,a:focus-visible{outline:3px solid #a5b4fc;outline-offset:3px}
      #launch{position:fixed;right:24px;bottom:28px;z-index:2147483646;display:flex;align-items:center;gap:7px;padding:11px 17px;background:linear-gradient(to right,#fff,#F5F7FA,#EEF2F6,#E6EBF2);box-shadow:0 0 5px #00000024;color:#475569;font-size:14px;border:1px solid #e2e8f0;border-radius:10px;touch-action:none;user-select:none}
      #launch:hover{background:linear-gradient(to right,#fff,#F5F7FA,#EEF2F6);box-shadow:0 4px 18px #47556926} #launch img{width:22px;height:22px;object-fit:contain} .status-dot{width:6px;height:6px;border-radius:50%;background:#22c55e}
      #panel{position:fixed;right:24px;top:24px;bottom:88px;width:min(680px,calc(100vw - 48px));z-index:2147483647;display:flex;flex-direction:column;background:#f7f8fc;border:1px solid #e1e5ee;border-radius:20px;box-shadow:0 20px 70px #1e293b35;overflow:hidden}
      header{display:flex;justify-content:space-between;align-items:center;padding:23px 24px 18px;background:#fff;gap:12px}.brand{display:flex;align-items:center;gap:12px}.brand-icon{width:42px;height:42px;padding:9px;border:1px solid #e9e7ff;border-radius:13px;background:#f3f2ff}.brand h2{font-size:19px;line-height:1.3;margin:0;letter-spacing:-.4px}.brand small{font-size:12px;color:#8993a3}.icon-button{background:#f4f5f8;color:#677489;font-size:22px;line-height:1;padding:8px 12px}.icon-button:hover{background:#e8eaf0}
      .tabs{display:flex;padding:0 24px;gap:23px;background:#fff;border-bottom:1px solid #e7eaf1}.tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;padding:13px 2px;color:#7c8697;background:transparent;white-space:nowrap}.tabs button[aria-selected=true]{color:#4f46e5;border-bottom-color:#6366f1}.tabs button:hover{color:#4f46e5}
      .content{overflow-y:auto;min-height:0;flex:1;overscroll-behavior:contain;padding:22px 24px}.section-intro{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}.eyebrow{font-size:11px;letter-spacing:1.6px;color:#9399aa;font-weight:700}.section-intro h3{margin:3px 0 0;font-size:17px;color:#273449}.badge{font-size:12px;padding:4px 9px;border-radius:20px;color:#4f46e5;background:#eeedff;white-space:nowrap}.empty{padding:30px 8px;text-align:center;color:#94a3b8}.processing-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #edf0f5}.processing-item:last-child{border-bottom:0}.processing-main{min-width:0}.processing-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.processing-meta{margin-top:4px;color:#8791a3;font-size:12px;overflow-wrap:anywhere}.processing-delete{flex:none}.success{position:fixed;left:50%;top:18%;transform:translate(-50%,-50%);z-index:2147483648;display:flex;align-items:center;gap:12px;min-width:290px;max-width:calc(100vw - 40px);padding:15px 18px;background:#fff;border:1px solid #bbf7d0;border-radius:14px;box-shadow:0 18px 55px #14532d30}.success-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#22c55e;color:#fff;font-size:21px;font-weight:800}.success strong{display:block;color:#166534}.success-copy{display:block;margin-top:3px;color:#64748b;font-size:12px;white-space:pre-line}.success-pop{animation:success-pop .35s ease-out}@keyframes success-pop{0%{opacity:0;transform:translate(-50%,-65%) scale(.9)}100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}
      .card{padding:18px;border:1px solid #e5e8f0;background:#fff;border-radius:14px;margin-bottom:16px}.card-title{font-weight:650;margin:0 0 12px}.field{margin-top:16px}.field:first-child{margin-top:0}label{display:block;font-size:13px;font-weight:600;color:#46536a;margin:0 0 7px}input,select,textarea{width:100%;padding:10px 12px;border:1px solid #dce1ec;border-radius:9px;background:#fff;color:#273449;outline:none}input:focus,select:focus,textarea:focus{border-color:#818cf8;box-shadow:0 0 0 3px #6366f112}textarea{resize:vertical;line-height:1.7;font-size:13px}input[readonly]{background:#f8f9fc;color:#64748b;font-size:12px}.hint,small{font-size:12px;line-height:1.7;color:#8791a3}.hint{margin:7px 0 0}.row{display:flex;gap:10px;margin-top:16px;align-items:center;flex-wrap:wrap}.row.end{justify-content:flex-end}.secondary{background:#fff;border-color:#dfe3ed;color:#526075}.secondary:hover{background:#f1f3f9}.text-button{padding:4px 0;background:transparent;color:#6366f1;font-size:12px}.text-button:hover{background:transparent;color:#4338ca}.label-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.label-row label{margin:0}
      #count{margin:0 0 14px;font-size:12px;color:#8290a5}#warning{margin:10px 0 0;font-size:12px;line-height:1.7;color:#896a31}#handoff-title{margin:0;color:#334155;font-weight:600;overflow-wrap:anywhere}#handoff-meta{margin:8px 0 0}.target{display:grid;gap:4px;overflow-wrap:anywhere}.target small{font-size:11px;text-transform:uppercase;letter-spacing:.8px}.target strong{font-weight:500;font-size:13px}.divider{height:1px;background:#edf0f5;margin:14px 0}.check{display:flex;align-items:flex-start;gap:9px;font-weight:400;line-height:1.7;margin-top:17px}.check input{width:16px;height:16px;flex:none;margin:3px 0;accent-color:#6366f1}.check span{font-size:12px;color:#66758b}.submit{width:100%;margin-top:16px}
      footer{flex:none;padding:12px 24px;background:#fff;border-top:1px solid #e7eaf1}#message{white-space:pre-wrap;margin:0;font-size:12px;color:#64748b;overflow-wrap:anywhere;max-height:110px;overflow:auto;display:flex;align-items:flex-start;gap:8px}#message::before{content:"";width:9px;height:9px;flex:none;margin-top:4px;border-radius:50%;background:#94a3b8}.status-success::before{background:#22c55e!important}.status-warning::before{background:#eab308!important}.status-error::before{background:#ef4444!important}details summary{cursor:pointer;font-size:13px;font-weight:600;color:#536078}details textarea{margin-top:12px}.version{font-size:11px;color:#9aa3b2;text-align:center;margin:18px 0 0}
      @media(max-width:520px){#panel{right:8px;top:8px;bottom:76px;width:calc(100vw - 16px);border-radius:15px}header{padding:16px}.tabs{padding:0 16px;gap:22px}.content{padding:16px}footer{padding:12px 16px}.card{padding:14px}#launch{right:12px;bottom:16px}}
      </style>
      <div id="success" class="success" hidden role="status" aria-live="polite"><span class="success-mark">✓</span><div><strong>创建成功</strong><span class="success-copy"></span></div></div>
      <button id="launch" aria-expanded="false" aria-controls="panel"><img src="/Templates/Default/Images/ai.webp" alt=""><span>Multica-AI · 已启动</span><span class="status-dot" aria-hidden="true"></span></button>
      <section id="panel" role="dialog" aria-label="Multica-AI Bug 工作台" hidden>
        <header><div class="brand"><img class="brand-icon" src="/Templates/Default/Images/ai.webp" alt=""><div><h2>Multica-AI</h2><small>BugDone 智能体工作台</small></div></div><button id="close" class="icon-button" aria-label="关闭面板">×</button></header>
        <nav class="tabs" role="tablist" aria-label="工作台栏目">
          <button id="tab-bug" role="tab" data-tab="bug" aria-selected="true" aria-controls="view-bug">Bug 详情</button>
          <button id="tab-multica" role="tab" data-tab="multica" aria-selected="false" aria-controls="view-multica" tabindex="-1">Multica 接入</button>
          <button id="tab-processing" role="tab" data-tab="processing" aria-selected="false" aria-controls="view-processing" tabindex="-1">处理列表</button>
          <button id="tab-settings" role="tab" data-tab="settings" aria-selected="false" aria-controls="view-settings" tabindex="-1">设置</button>
        </nav>
        <div class="content">
          <section id="view-bug" role="tabpanel" aria-labelledby="tab-bug">
            <div class="section-intro"><div><div class="eyebrow">BUG CONTEXT</div><h3>确认问题与上下文</h3></div><span id="bug-state" class="badge">等待详情</span></div>
            <p id="count">等待捕获 · 请打开一个 Bug 的详情</p>
            <div class="card"><label for="bug">选择 Bug</label><select id="bug" aria-describedby="warning"></select><p id="warning">打开 Bug 详情后，内容会自动同步到这里。</p></div>
            <div class="card">
              <div class="field"><label for="title">任务标题</label><input id="title" placeholder="捕获 Bug 后自动填入"><p class="hint">提交时自动添加 Bug ID 前缀，用于查找已有任务。</p></div>
              <div class="field"><label for="share-url">只读分享链接</label><input id="share-url" readonly placeholder="捕获项目 ID 和 Bug ID 后生成"><p class="hint">采用 BugDone 原生分享地址规则，已同步到下方预览。</p></div>
              <div class="field"><div class="label-row"><label for="description">提交内容预览（可编辑）</label><button id="restore" class="text-button">重新生成</button></div><textarea id="description" rows="13" placeholder="捕获详情后，将显示来源、只读分享、问题描述与附件链接。"></textarea></div>
            </div>
            <div class="row end"><button id="next">下一步：AI 处理 →</button></div>
          </section>
          <section id="view-multica" role="tabpanel" aria-labelledby="tab-multica" hidden>
            <div class="section-intro"><div><div class="eyebrow">AGENT HANDOFF</div><h3>交给智能体处理</h3></div><span class="badge">提交前查重</span></div>
            <div class="card"><div class="label-row"><p class="card-title">当前 Bug</p><button id="edit-bug" class="text-button">查看 / 编辑</button></div><p id="handoff-title">尚未选择 Bug</p><p id="handoff-meta" class="hint">请先在 Bug 详情中核对提交内容。</p></div>
            <div class="card"><div class="label-row"><p class="card-title">Multica 连接</p><button id="edit-settings" class="text-button">修改设置</button></div><div class="target"><small>API 服务</small><strong id="target-api"></strong></div><div class="divider"></div><div class="target"><small>工作区</small><strong id="target-workspace"></strong></div><div class="divider"></div><div class="target"><small>项目</small><strong id="target-project"></strong></div></div>
            <div class="card"><div class="label-row"><label for="agent">处理智能体</label><button id="agents" data-action class="text-button">刷新智能体</button></div><select id="agent"><option value="">先读取智能体</option></select><p class="hint">已保存的选择会自动恢复；首次使用请先在“设置”中填写服务地址、工作区和 PAT。</p>
              <label class="check"><input type="checkbox" id="reviewed"><span>我已核对内容和附件链接，同意提交到当前 Multica 服务并指派所选智能体处理。</span></label>
              <button id="submit" data-action class="submit">提交</button><p class="hint">提交前仍会自动查重；找到已有任务时直接复用，不重复创建或触发执行。</p>
            </div>
          </section>
          <section id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
            <div class="section-intro"><div><div class="eyebrow">CONNECTION</div><h3>连接你的 Multica</h3></div></div>
            <div class="card">
              <div class="field"><label for="api">API 服务根地址</label><input id="api" placeholder="https://api.multica.ai" spellcheck="false"></div>
              <div class="field"><label for="workspace">工作区 UUID</label><input id="workspace" autocomplete="off" spellcheck="false"></div>
              <div class="field"><label for="workspaceAlias">工作区显示别名（可选）</label><input id="workspaceAlias" placeholder="例如：研发测试工作区"></div>
              <div class="field"><label for="token">个人访问令牌（PAT）</label><input id="token" type="password" autocomplete="off"></div>
              <div class="field"><label for="project">Multica 项目 UUID（可选）</label><input id="project" autocomplete="off" spellcheck="false"></div>
              <div class="field"><label for="projectAlias">Multica 项目显示别名（可选）</label><input id="projectAlias" placeholder="例如：iOS 主仓库"><p class="hint">别名只用于界面识别，不会替代 UUID 发给 API。</p></div>
              <div class="field"><div class="label-row"><label for="default-agent">默认处理智能体</label><button id="default-agents" data-action class="text-button">读取 / 刷新智能体</button></div><select id="default-agent"><option value="">未设置默认智能体</option></select><p class="hint">已保存的默认智能体会自动恢复；刷新列表仅在首次读取或需要更新时使用。</p></div>
              <label class="check"><input type="checkbox" id="hide-native-ai"><span>隐藏 BugDone 原有 AI 按钮（openIntelligentTracking）</span></label>
              <div class="row"><button id="save" data-action>保存连接设置</button></div><p class="hint">令牌保存在当前可用的脚本存储中，不包含在任务描述里。远程自建服务需在脚本头部增加对应的 @connect 域名。</p>
            </div>
            <details class="card"><summary>手动导入 BugDone 响应</summary><p class="hint">自动捕获不可用时，可导入列表或详情接口的响应。</p><textarea id="json" rows="6" aria-label="BugDone 响应 JSON" placeholder="粘贴 Result / ReturnObj 格式 JSON，不要粘贴请求头或 Cookie"></textarea><div class="row"><button id="import" data-action class="secondary">导入响应</button></div></details>
            <p class="version">BugDone → Multica · v${SCRIPT_VERSION}</p>
          </section>
          <section id="view-processing" role="tabpanel" aria-labelledby="tab-processing" hidden>
            <div class="section-intro"><div><div class="eyebrow">LOCAL HISTORY</div><h3>处理列表</h3></div><span id="processing-count" class="badge">共 0 条</span></div>
            <div class="card"><p class="hint">这里记录本浏览器中已提交给 Multica-AI 的 Bug，仅保存在当前可用的脚本存储。删除只移除本地记录，不会删除 Multica 任务。</p><div id="processing-list"></div></div>
          </section>
        </div>
        <footer><p id="message" role="status" aria-live="polite">尚未提交 · 请先核对 Bug 详情。</p></footer>
      </section>`;
    for (const id of ['api', 'workspace', 'workspaceAlias', 'token', 'project', 'projectAlias']) $(id).value = config[id] || '';
    $('hide-native-ai').checked = config.hideNativeAI !== false;
    const launch = $('launch');
    if (launchPosition && Number.isFinite(Number(launchPosition.left)) && Number.isFinite(Number(launchPosition.top))) {
      launch.style.left = `${Number(launchPosition.left)}px`; launch.style.top = `${Number(launchPosition.top)}px`; launch.style.right = 'auto'; launch.style.bottom = 'auto';
    }
    let drag = null, suppressLaunchClick = false;
    launch.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      const rect = launch.getBoundingClientRect(); launch.setPointerCapture?.(e.pointerId);
      drag = { pointerId: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: e.clientX, y: e.clientY, moved: false };
    });
    launch.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (!drag.moved) return;
      const maxX = Math.max(0, window.innerWidth - launch.offsetWidth), maxY = Math.max(0, window.innerHeight - launch.offsetHeight);
      const left = Math.min(maxX, Math.max(0, e.clientX - drag.dx)), top = Math.min(maxY, Math.max(0, e.clientY - drag.dy));
      launch.style.left = `${left}px`; launch.style.top = `${top}px`; launch.style.right = 'auto'; launch.style.bottom = 'auto';
    });
    launch.addEventListener('pointerup', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.moved) { suppressLaunchClick = true; try { writeValue('launchPosition', { left: launch.getBoundingClientRect().left, top: launch.getBoundingClientRect().top }); } catch (_) {} setTimeout(() => { suppressLaunchClick = false; }, 0); }
      drag = null;
    });
    launch.onclick = () => { if (suppressLaunchClick) return; $('panel').hidden = !$('panel').hidden; launch.setAttribute('aria-expanded', String(!$('panel').hidden)); if (!$('panel').hidden) root.querySelector('[role=tab][aria-selected=true]').focus(); };
    $('launch').title = `脚本已运行 v${SCRIPT_VERSION}；F12 Console 搜索 BugDone→Multica 查看日志`;
    $('close').onclick = () => { $('panel').hidden = true; $('launch').setAttribute('aria-expanded', 'false'); $('launch').focus(); };
    $('panel').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); $('close').click(); } });
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab, index) => {
      tab.onclick = () => switchTab(tab.dataset.tab);
      tab.onkeydown = e => {
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { e.preventDefault(); switchTab(tabs[next].dataset.tab, true); }
      };
    });
    $('next').onclick = () => switchTab('multica', true);
    $('edit-bug').onclick = () => switchTab('bug', true);
    $('edit-settings').onclick = () => switchTab('settings', true);
    switchTab('bug');
    $('bug').onchange = () => { $('reviewed').checked = false; preview(); };
    $('restore').onclick = () => { $('reviewed').checked = false; preview(); };
    for (const id of ['title', 'description', 'api', 'workspace', 'workspaceAlias', 'project', 'projectAlias']) $(id).addEventListener('input', () => { $('reviewed').checked = false; });
    $('agent').addEventListener('change', () => { config.agent = $('agent').value; try { writeValue('config', { ...config, agent: config.agent }); } catch (e) { debug('智能体选择保存失败', { errorType: e.name }, 'warn'); } });
    renderAgentChoices(config, readValue(agentCacheKey(config), []));
    $('default-agent').addEventListener('change', () => {
      const previous = config.defaultAgent;
      config.defaultAgent = $('default-agent').value;
      if (!$('agent').value || $('agent').value === previous) $('agent').value = config.defaultAgent;
      config.agent = $('agent').value;
      try { writeValue('config', { ...config }); message('默认处理智能体已保存。', 'success'); }
      catch (e) { message('默认处理智能体保存失败。', 'error'); }
    });
    $('agents').onclick = () => run(loadAgents);
    $('default-agents').onclick = () => run(loadAgents);
    for (const id of ['api', 'workspace']) $(id).addEventListener('change', () => {
      const next = { api: $('api').value.trim(), workspace: $('workspace').value.trim() };
      const same = next.api === config.api && next.workspace === config.workspace;
      renderAgentChoices({ ...next, agent: same ? config.agent : '', defaultAgent: same ? config.defaultAgent : '' }, readValue(agentCacheKey(next), []));
    });
    $('hide-native-ai').addEventListener('change', () => { config.hideNativeAI = $('hide-native-ai').checked; setNativeAIVisibility(config.hideNativeAI); try { writeValue('config', { ...config }); message(config.hideNativeAI ? '已隐藏 BugDone 原有 AI 按钮。' : '已显示 BugDone 原有 AI 按钮。', 'success'); } catch (e) { message('AI 按钮显示设置保存失败。', 'error'); } });
    $('save').onclick = () => run(async () => { config = settings(); writeValue('config', config); message(`连接设置已保存（${storageMode}）。`); });
    $('submit').onclick = () => run(submit);
    $('import').onclick = () => run(async () => {
      const text = $('json').value;
      if (!parseResponse(text).length) throw Error('未找到有效的 BugDone Bug 数据');
      collect(text); $('json').value = ''; switchTab('bug', true); message('响应已导入，请选择 Bug 核对预览。');
    });
    renderBugs();
    renderProcessing();
    if (captureHookFailed) message('当前环境未能安装自动捕获。可在“设置”中使用“手动导入 BugDone 响应”继续操作。');
    if (!hasGMStorage) message('当前使用网页本地存储保存配置和处理列表。');
    if (storageFailed) message('浏览器存储不可用，请允许 BugDone 保存站点数据后刷新。');
    debug('界面挂载完成', { buttonConnected: host.isConnected, capturedBugs: bugs.size });
  }
  function mountWithDiagnostics() {
    try { mount(); }
    catch (e) { debug('界面挂载失败', { errorType: e.name }, 'error'); }
  }
  let uiScheduled = false;
  function scheduleDelayedMount() {
    if (uiScheduled) return;
    uiScheduled = true;
    debug('页面已就绪，安排延迟初始化', { delayMs: UI_DELAY_MS });
    setTimeout(function delayedFunction() {
      debug('延迟回调已执行', { bodyReady: !!document.body });
      if (!document.body) {
        uiScheduled = false;
        debug('页面主体尚不可用，等待后重试', {}, 'warn');
        setTimeout(scheduleDelayedMount, 300);
        return;
      }
      if (!document.getElementById('bugdone-multica-bridge')) mountWithDiagnostics();
    }, UI_DELAY_MS);
  }
  if (document.readyState !== 'loading') scheduleDelayedMount();
  else {
    debug('等待 DOMContentLoaded，再延迟初始化');
    document.addEventListener('DOMContentLoaded', scheduleDelayedMount, { once: true });
  }
})();
