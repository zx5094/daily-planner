/* 每日计划表 · 云同步模块（GitHub Gist 作为云端存储）
 * 读：无需令牌（匿名读 gist 原始文件）
 * 写：需要 GitHub 令牌（只勾 gist 权限），令牌只存在本机浏览器中
 * 冲突策略：谁的时间戳新用谁；本机保存后 2 秒自动上传
 */
(function () {
  'use strict';
  var CFG_KEY = 'planner-sync-cfg';
  var STORE = 'structured-planner-b1';
  var DEFAULT = { owner: 'zx5094', gist: '7d31fa0f0dabc734c93cbe3dcdcaa23c', file: 'planner.json' };

  function cfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { c = {}; }
    for (var k in DEFAULT) { if (!c[k]) c[k] = DEFAULT[k]; }
    return c;
  }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function rawUrl(c) {
    return 'https://gist.githubusercontent.com/' + c.owner + '/' + c.gist + '/raw/' + c.file + '?t=' + Date.now();
  }
  function localTS() { var n = parseInt(localStorage.getItem(CFG_KEY + '-ts') || '0', 10); return isNaN(n) ? 0 : n; }
  function setLocalTS(n) { try { localStorage.setItem(CFG_KEY + '-ts', String(n)); } catch (e) {} }

  var applying = false, ready = false, timer = null;

  function toast(msg) {
    var el = document.getElementById('planner-sync-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'planner-sync-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:78px;transform:translateX(-50%);max-width:80vw;' +
        'background:rgba(28,24,20,.92);color:#fff;font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;' +
        'padding:8px 14px;border-radius:10px;z-index:99999;opacity:0;transition:opacity .25s;pointer-events:none;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; }, 2200);
  }

  function applyRemote(obj) {
    var raw = typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data);
    if (!raw) return false;
    applying = true;
    try {
      Storage.prototype.setItem.call(localStorage, STORE, raw);
      setLocalTS(obj.updatedAt || 0);
    } finally { applying = false; }
    if (timer) { clearTimeout(timer); timer = null; }
    location.reload();
    return true;
  }

  var lastPull = 0;
  function pull(silent, force) {
    var now = Date.now();
    if (!force && now - lastPull < 30000) return Promise.resolve(null);   /* 免触发接口限流 */
    lastPull = now;
    var c = cfg();
    return fetch('https://api.github.com/gists/' + c.gist, {
      cache: 'no-store',
      headers: { 'Accept': 'application/vnd.github+json' }
    })
      .then(function (r) {
        if (r.status === 403 || r.status === 429) throw new Error('接口限流，稍后自动重试');
        if (r.status === 404) throw new Error('云端文件不存在');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var f = j && j.files && j.files[c.file];
        var t = f && f.content;
        if (!t) return null;
        var obj = JSON.parse(t);
        if (!obj || !obj.updatedAt || !obj.data) return null;
        if ((obj.updatedAt || 0) > localTS()) return applyRemote(obj);
        return null;
      })
      .catch(function (e) { if (!silent) toast('拉取失败：' + e.message); return null; });
  }

  function push(silent) {
    var c = cfg();
    if (!c.token) { if (!silent) toast('只读模式：未设置令牌，本机修改不会上传'); return Promise.resolve(false); }
    var data = localStorage.getItem(STORE);
    if (!data) return Promise.resolve(false);
    var body = { files: {} };
    body.files[c.file] = { content: JSON.stringify({ updatedAt: Date.now(), data: data }) };
    return fetch('https://api.github.com/gists/' + c.gist, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + c.token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 401) throw new Error('令牌无效或已过期');
      if (r.status === 404) throw new Error('找不到云端文件（令牌无 gist 权限？）');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var ts = j && j.updated_at ? Date.parse(j.updated_at) : Date.now();
      setLocalTS(isNaN(ts) ? Date.now() : ts);
      if (!silent) toast('已同步到云端');
      return true;
    }).catch(function (e) {
      if (!silent) toast('上传失败：' + e.message);
      return false;
    });
  }

  /* 本机保存 -> 自动上传（先确认云端没有更新的版本） */
  var _set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    _set.call(this, k, v);
    if (this !== localStorage || k !== STORE || applying || !ready) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      applying = true;              /* 防止 pull 期间触发递归 */
      pull(true).then(function (changed) {
        applying = false;
        if (!changed) return push(true);
        return false;
      });
    }, 2000);
  };

  function syncNow() {
    return pull(false, true).then(function (changed) {
      if (changed) return false;
      return push(false);
    });
  }

  function setup() {
    var c = cfg();
    var t = prompt('粘贴 GitHub 令牌（只需勾选 gist 权限；留空=只读模式）：', c.token || '');
    if (t === null) return;
    t = (t || '').trim();
    c.token = t;
    saveCfg(c);
    if (!t) { toast('已设为只读模式'); return; }
    syncNow();
  }

  function mount() {
    if (document.getElementById('planner-sync-btn')) return;
    var b = document.createElement('button');
    b.id = 'planner-sync-btn';
    b.type = 'button';
    b.title = '云同步（点击同步，长按设置令牌）';
    b.textContent = '☁';
    b.style.cssText = 'position:fixed;right:14px;bottom:16px;width:44px;height:44px;border-radius:50%;border:none;' +
      'background:rgba(28,24,20,.55);color:#fff;font-size:20px;line-height:44px;text-align:center;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.2);z-index:99998;cursor:pointer;-webkit-tap-highlight-color:transparent';
    var lp = null;
    b.addEventListener('touchstart', function () { lp = setTimeout(function () { lp = null; setup(); }, 700); }, { passive: true });
    b.addEventListener('touchend', function () { if (lp) { clearTimeout(lp); lp = null; } });
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); setup(); });
    b.addEventListener('click', function () {
      var c = cfg();
      if (!c.token) {
        if (confirm('当前是只读模式：能看到电脑上的修改，但手机上改的不会上传。\n要启用双向同步吗？（需粘贴一次 GitHub 令牌）')) { setup(); return; }
        return syncNow();
      }
      syncNow();
    });
    document.body.appendChild(b);
  }

  function boot() {
    mount();
    pull(true).then(function () { ready = true; });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && ready) pull(true);
    });
    window.addEventListener('focus', function () { if (ready) pull(true); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.__plannerSync = { syncNow: syncNow, setup: setup, pull: pull, push: push };
})();
