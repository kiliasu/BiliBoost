// ==UserScript==
// @name         BiliBoost
// @name:en      BiliBoost
// @namespace    bili-cdn-optimizer
// @version      4.0.0
// @description  面向海外用户的B站自适应CDN路由工具
// @description:en  Per-video adaptive CDN routing for Bilibili overseas users: micro-probe node selection, cold-resource fallback with background cache warming, stall circuit-breaking, and a structured diagnostics panel.
// @author       33DD99
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @match        https://www.bilibili.com/watchlater/*
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
  'use strict';

  // ═══════════════ §1 常量与节点池 ═══════════════

  const VERSION = '4.0.0';
  const CFG_KEY = 'bili_cdn_opt_cfg_v3';
  const HEALTH_KEY = 'bili_cdn_opt_health_v1';
  const PREMIUM = 'upos-sz-mirrorcosov.bilivideo.com';
  const FALLBACK_MAINLAND = 'upos-sz-mirrorali.bilivideo.com';

  const HOST_POOL = [
    { host: 'upos-sz-mirrorcosov.bilivideo.com', label: '腾讯云·海外', tier: 'overseas', coldReliable: false },
    { host: 'upos-sz-mirrorali.bilivideo.com',   label: '阿里云·大陆', tier: 'mainland', coldReliable: true },
    { host: 'upos-sz-mirrorhw.bilivideo.com',    label: '华为云·大陆', tier: 'mainland', coldReliable: true },
    { host: 'upos-sz-mirrorcos.bilivideo.com',   label: '腾讯云·大陆', tier: 'mainland', coldReliable: true },
    { host: 'upos-sz-mirror08c.bilivideo.com',   label: '金山云·大陆', tier: 'mainland', coldReliable: true },
    { host: 'upos-tf-all-tx.bilivideo.com',      label: '腾讯·免流',   tier: 'tf',       coldReliable: true },
    { host: 'upos-tf-all-hw.bilivideo.com',      label: '华为·免流',   tier: 'tf',       coldReliable: true },
  ];

  const RE_PCDN  = /(\.szbdyd\.com|\.mountaintoys\.cn|\.nexusedgeio\.com|\.ahdohpiechei\.com)$/i;
  const RE_MCDN  = /\.mcdn\.bilivideo\.(cn|com|net)$/i;
  const RE_IP    = /^\d{1,3}(\.\d{1,3}){3}$/;
  const RE_UPOS  = /^upos-[\w-]+\.(bilivideo\.com|akamaized\.net)$/i;
  const RE_CDN   = /(\.bilivideo\.(com|cn)|\.akamaized\.net)$/i;
  const RE_AKAM  = /akamaized\.net$/i;   // 不能作为切换目标；仅当它是URL原生主机时可用
  const RE_CID   = /\/upgcxcode\/\d+\/\d+\/(\d+)\//;
  const RE_API   = /api\.bilibili\.com\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/(v2\/)?playurl|pugv\/player\/web\/playurl)/;
  const BAD_OUTCOMES = ['首字节超时', '总超时', '超时', '连接失败', '传输中断'];

  const DEFAULTS = {
    enabled: true,
    mode: 'auto',
    pinHost: PREMIUM,
    customHosts: [],
    disabledHosts: [],
    avoidHosts: ['upos-sz-mirroraliov.bilivideo.com'],
    replacePcdn: true,
    replaceMcdn: true,
    probeSizeKB: 128,
    probeTimeoutMs: 2000,
    ttfbTimeoutMs: 2000,
    idleTimeoutMs: 4000,
    bodyDeadlineMs: 25000,
    hedge: true,
    hedgeDelayMs: 900,
    multiSource: true,          // 多源并行Range聚合引擎
    msLanes: 4,                 // 聚合路数：size 策略下为上限，fixed 策略下为目标路数
    msSplit: 'size',            // 切分策略：size=按分片尺寸派生路数 | fixed=按路数等分
    msMinSplitKB: 512,          // 达到此跨度才切分
    msPartKB: 768,              // size 策略的目标分片尺寸
    msMinPartKB: 128,           // fixed 策略的分片下限
    msPerHost: 2,               // 单节点并发连接上限；第二连接仅在候选节点用尽后分配
    stallMs: 2500,
    rescueJiggle: true,
    bgGuard: true,              // 后台播放保护（回前台快速恢复 + 后台缓冲维持）
    warmPremium: true,
    warmIntervalMs: 25000,
    accent: '#00aeec',
    theme: 'auto',              // 面板配色：auto=跟随页面 | light | dark
    panelPos: null,
  };

  // ═══════════════ §2 配置与节点档案 ═══════════════

  function jload(key, fallback) {
    try { const r = localStorage.getItem(key); if (r) return JSON.parse(r); } catch (e) {}
    return fallback;
  }
  function jsave(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  const cfg = Object.assign({}, DEFAULTS, jload(CFG_KEY, null) || jload('bili_cdn_opt_cfg_v2', null) || {});
  if (cfg.msMaxParts != null) {   // v3.8 键名迁移：msMaxParts → msLanes
    if (cfg.msLanes === DEFAULTS.msLanes) cfg.msLanes = cfg.msMaxParts;
    delete cfg.msMaxParts;
  }
  if (cfg.accent === '#00a1d6') cfg.accent = DEFAULTS.accent;   // 旧版默认强调色随新界面更新
  const saveCfg = () => jsave(CFG_KEY, cfg);

  const health = jload(HEALTH_KEY, {});
  let healthDirty = 0;
  function saveHealth() {
    if (healthDirty) return;
    healthDirty = setTimeout(() => { healthDirty = 0; jsave(HEALTH_KEY, health); }, 2000);
  }
  function H(host) {
    return health[host] || (health[host] = { mbps: 0, mbpsLow: 0, ttfb: 0, ok: 0, fail: 0, last: 0 });
  }
  function healthSample(host, mbps, ttfb) {
    const h = H(host);
    if (mbps > 0) {
      h.mbps = h.mbps ? +(h.mbps * 0.7 + mbps * 0.3).toFixed(1) : mbps;
      // 低位速率：非对称EWMA（快降慢升），突发峰值拉不高它
      if (!h.mbpsLow) h.mbpsLow = mbps;
      else if (mbps < h.mbpsLow) h.mbpsLow = +(h.mbpsLow * 0.5 + mbps * 0.5).toFixed(1);
      else h.mbpsLow = +(h.mbpsLow * 0.9 + mbps * 0.1).toFixed(1);
    }
    if (ttfb > 0) h.ttfb = h.ttfb ? Math.round(h.ttfb * 0.7 + ttfb * 0.3) : ttfb;
    h.ok++; h.last = Date.now();
    saveHealth();
  }
  function healthFail(host) { const h = H(host); h.fail++; saveHealth(); }
  function healthScore(host) {
    const h = health[host];
    if (!h || !h.ok) return 0;
    // 有效速率偏向低位值；可靠性按成功率平方连续降权
    const eff = h.mbpsLow > 0 ? (0.3 * h.mbps + 0.7 * h.mbpsLow) : h.mbps;
    const n = h.ok + h.fail;
    const reliability = n > 5 ? Math.pow(h.ok / n, 2) : 1;
    return eff * (400 / (400 + (h.ttfb || 0))) * reliability;
  }

  // ═══════════════ §3 运行时状态 / 日志 / 时间线 ═══════════════

  const PAGE_T0 = Date.now();

  const state = {
    verdictByCid: {},
    origHostByCid: {},
    warmTimers: {},
    activeCid: null,
    rewrites: 0, fallbacks: 0, stalls: 0, hedgeWins: 0,
    msLoads: 0, msParts: 0, msHoleFills: 0, msActive: 0,
    bgRecoveries: 0, bgKicks: 0, bgRefills: 0, bgLastHiddenMs: 0,
    msLanes: [],                // 在途分片实时进度（仅供UI可视化）
    hostFlow: [],               // {t, host, bytes} 各节点供给流水（仅供UI可视化）
    bytesWindow: [], liveMbps: 0, lastSegHost: '—', lastMediaUrl: null,
    log: [],
    reqLog: [],
    timeline: {},
    bootSource: null,
    lastVerdict: null,          // 近期裁决（多P沿用，降低探测风暴）
    probeInfoByCid: {},         // 各视频的双点采样明细（诊断页用）
    blindMode: false,           // 媒体流量未经过脚本网络层（疑似Worker发起）
  };

  function tl(cid) {
    return state.timeline[cid] || (state.timeline[cid] = { t0: performance.now() });
  }
  function mark(cid, key) {
    const t = tl(cid);
    if (t[key] == null) t[key] = performance.now();
  }

  function log(level, tag, msg) {
    state.log.push({ t: Date.now(), level, tag, msg });
    if (state.log.length > 300) state.log.splice(0, 60);
    uiDirty();
  }
  function pushReq(entry) {
    state.reqLog.push(entry);
    if (state.reqLog.length > 120) state.reqLog.splice(0, 30);
  }
  function pushFlow(host, bytes) {
    if (!bytes) return;
    state.hostFlow.push({ t: Date.now(), host, bytes });
    if (state.hostFlow.length > 400) state.hostFlow.splice(0, 100);
  }
  function shortHost(h) { return String(h || '—').replace('.bilivideo.com', '').replace('.akamaized.net', '·akam'); }
  // 极简主机名：仅保留区分性词根（cosov / ali / hw / 08c / akam）
  function tinyHost(h) {
    return String(h || '—')
      .replace(/\.bilivideo\.com$|\.akamaized\.net$/, '')
      .replace(/^upos-[a-z]{2}-mirror/, '').replace(/^upos-tf-all-/, 'tf·')
      .replace(/^upos-/, '') || '—';
  }
  // 面向用户的节点称呼：节点池内的用标签（如「阿里云·大陆」），其余用极简主机名
  function hostLabel(h) {
    const p = HOST_POOL.find(x => x.host === h);
    return p ? p.label : tinyHost(h);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtClock(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }
  function fmtRel(ts) { return '+' + ((ts - PAGE_T0) / 1000).toFixed(1) + 's'; }

  let bytesThisTick = 0;
  setInterval(() => {
    const tickBytes = bytesThisTick;
    bytesThisTick = 0;
    state.bytesWindow.push({ t: Date.now(), bytes: tickBytes });
    if (state.bytesWindow.length > 90) state.bytesWindow.shift();
    state.liveMbps = +(tickBytes * 8 / 1e6).toFixed(1);
    // 进度连续性监测：waiting 事件可能漏报（涓流/事件被 timeupdate 解除），以播放进度为最终事实
    try {
      const v = guardedVideo;
      if (v && cfg.enabled && !v.paused && !v.seeking && !v.ended) {
        const ct = v.currentTime;
        if (state._lastCt != null && ct - state._lastCt < 0.2) state._stuckTicks = (state._stuckTicks || 0) + 1;
        else state._stuckTicks = 0;
        state._lastCt = ct;
        if (cfg.mode === 'auto' && state._stuckTicks >= Math.max(3, Math.round(cfg.stallMs / 1000) + 1)) {
          state._stuckTicks = 0;
          log('warn', 'stall', '进度监测：播放进度持续停滞 → 熔断');
          onStall();
        }
        // 盲区检测：缓冲增长但脚本网络层零流量 → 分片请求未经过钩子（疑似 Worker 线程发起）
        const bufEnd = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        if (state._lastBufEnd != null && bufEnd - state._lastBufEnd > 0.5 && tickBytes < 51200) {
          state._blindTicks = (state._blindTicks || 0) + 1;
          if (state._blindTicks >= 5 && !state.blindMode) {
            state.blindMode = true;
            log('warn', 'sys', '媒体流量未经过脚本网络层（疑似 Worker 发起）→ 转清单级备用链与进度监测兜底');
          }
        } else if (tickBytes > 204800) {
          state._blindTicks = 0;   // 网络层可见流量恢复即复位，防止跨tick边界误累积
        }
        state._lastBufEnd = bufEnd;
      }
    } catch (e) {}
    uiTick();
  }, 1000);

  // ═══════════════ §4 路由核心 ═══════════════

  function poolHosts() {
    const extra = (cfg.customHosts || []).map(h => ({ host: h, label: '自定义', tier: 'custom', coldReliable: true }));
    return HOST_POOL.concat(extra);
  }
  function enabledHosts() {
    return poolHosts().filter(p => !cfg.disabledHosts.includes(p.host) && !RE_AKAM.test(p.host));
  }
  function coldReliableRanked() {
    return enabledHosts().filter(p => p.coldReliable).map(p => p.host)
      .sort((a, b) => healthScore(b) - healthScore(a));
  }
  function classify(u) {
    const h = u.hostname;
    const isPcdn = RE_PCDN.test(h) || RE_IP.test(h) || (u.port && u.port !== '443' && u.port !== '80');
    const isMcdn = RE_MCDN.test(h);
    const isMedia = u.pathname.includes('/upgcxcode/') && (isPcdn || isMcdn || RE_CDN.test(h));
    return { isMedia, isPcdn, isMcdn };
  }
  function cidOf(u) {
    const m = u.pathname.match(RE_CID);
    return m ? m[1] : null;
  }

  function bestByHealth(coldOnly, exclude) {
    let best = null, bestScore = -1;
    for (const p of enabledHosts()) {
      if (coldOnly && !p.coldReliable) continue;
      if (exclude && exclude.includes(p.host)) continue;
      const s = healthScore(p.host);
      if (s > bestScore && s > 0) { bestScore = s; best = p.host; }
    }
    return best;
  }
  function firstColdReliable() {
    const r = coldReliableRanked();
    return r.length ? r[0] : FALLBACK_MAINLAND;
  }

  function routeFor(u) {
    if (!cfg.enabled) return null;
    const { isMedia, isPcdn, isMcdn } = classify(u);
    if (!isMedia) return null;
    const from = u.hostname;

    if (cfg.mode === 'force') {
      const t = RE_AKAM.test(cfg.pinHost) ? PREMIUM : cfg.pinHost;
      return from === t ? null : t;
    }
    if (cfg.mode === 'smart') {
      const t = RE_AKAM.test(cfg.pinHost) ? PREMIUM : cfg.pinHost;
      if (isPcdn && cfg.replacePcdn) return t;
      if (isMcdn && cfg.replaceMcdn) return t;
      if (cfg.avoidHosts.includes(from)) return t;
      return null;
    }
    const cid = cidOf(u);
    const verdict = cid && state.verdictByCid[cid];
    // akam 裁决仅适用于 akam 原生签名的 URL；bilivideo 系 URL 不跨家族改写
    const vHost = verdict && (!RE_AKAM.test(verdict.host) || RE_AKAM.test(from)) ? verdict.host : null;
    if (isPcdn || isMcdn) return vHost || bestByHealth(false) || firstColdReliable();
    if (vHost && vHost !== from) return vHost;
    if (verdict) return null;
    if (cfg.avoidHosts.includes(from)) return bestByHealth(false) || firstColdReliable();
    return null;
  }

  function withHost(u, host) {
    const x = new URL(u.href);
    x.hostname = host; x.port = '';
    return x.href;
  }

  function rewriteMediaUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      const t = routeFor(u);
      if (!t) return null;
      // xy_usource 仅在本视频尚无裁决时用来还原PCDN的官方源；有裁决时裁决优先
      const cid = cidOf(u);
      const hasVerdict = cid && state.verdictByCid[cid];
      const usrc = !hasVerdict && u.searchParams.get('xy_usource');
      const dest = (usrc && RE_UPOS.test(usrc) && !RE_AKAM.test(usrc)) ? usrc : t;
      if (dest === u.hostname) return null;
      // 签名家族防火墙：akamaized 与 bilivideo 系签名不互通，跨家族改写必然 403
      if (RE_AKAM.test(dest) && !RE_AKAM.test(u.hostname)) return null;
      state.rewrites++;
      return withHost(u, dest);
    } catch (e) { return null; }
  }

  // 回退链：裁决节点 → URL原生主机(akam仅此处允许) → 调度主机 → 大陆池(按档案分排序)
  function candidateChain(u) {
    const routed = routeFor(u);
    const chain = [];
    const push = (h) => {
      if (!h || chain.includes(h)) return;
      if (RE_AKAM.test(h) && h !== u.hostname) return;   // akam只能以原生身份出现
      chain.push(h);
    };
    push(routed || u.hostname);
    push(u.hostname);
    const cid = cidOf(u);
    push(cid && state.origHostByCid[cid]);
    for (const h of coldReliableRanked()) { push(h); if (chain.length >= 5) break; }
    return chain;
  }

  function setVerdict(cid, host, why, src) {
    state.verdictByCid[cid] = { host, why, src, decidedAt: Date.now() };
    if (src !== 'carry') state.lastVerdict = { host, why, at: Date.now() };
    mark(cid, 'verdictAt');
    uiDirty();
  }

  function kickPlayerIfStarving() {
    if (!cfg.rescueJiggle) return;
    const v = guardedVideo || document.querySelector('video');
    if (v && !v.paused && !v.seeking && v.readyState < 3) {
      try { v.currentTime = v.currentTime + 0.05; log('info', 'route', '缓冲不足 → 微跳帧触发重新调度'); } catch (e) {}
    }
  }

  // ═══════════════ §5 playinfo 变换 ═══════════════

  const rwKeep = (url) => rewriteMediaUrl(url) || url;

  function transformPlayinfo(data) {
    if (!data || typeof data !== 'object') return;
    const roots = [data.data, data.result, data.result && data.result.video_info].filter(Boolean);
    const firstUrls = [];
    const grab = (s) => { const u = s && (s.baseUrl || s.base_url || s.url); if (u) firstUrls.push(u); };
    // 清单级备用链注入：backupUrl 重写为健康排名候选链。Worker 发起的分片请求
    // 对请求层钩子不可见，播放器原生 backupUrl 失效转移是该场景唯一生效的兜底。
    const rankedBackupsFor = (urlStr) => {
      try {
        const u = new URL(urlStr, location.href);
        const hosts = coldReliableRanked().filter(h => h !== u.hostname).slice(0, 3);
        return hosts.map(h => withHost(u, h));
      } catch (e) { return null; }
    };
    const injectBackups = (s, base) => {
      const injected = rankedBackupsFor(base);
      if (!injected || !injected.length) return;
      const orig = [].concat(s.backupUrl || s.backup_url || []).slice(0, 1).map(rwKeep)
        .filter(o => { try { const oh = new URL(o).hostname; return oh !== new URL(base).hostname && !injected.some(x => new URL(x).hostname === oh); } catch (e) { return false; } });
      const merged = injected.concat(orig);
      s.backupUrl = merged;
      s.backup_url = merged;
    };
    for (const r of roots) {
      if (r.dash) {
        const fix = (s) => {
          if (!s) return;
          grab(s);
          if (s.baseUrl)  s.baseUrl  = rwKeep(s.baseUrl);
          if (s.base_url) s.base_url = rwKeep(s.base_url);
          const base = s.baseUrl || s.base_url;
          if (base) injectBackups(s, base);
        };
        (r.dash.video || []).forEach(fix);
        (r.dash.audio || []).forEach(fix);
        if (r.dash.dolby && Array.isArray(r.dash.dolby.audio)) r.dash.dolby.audio.forEach(fix);
        if (r.dash.flac && r.dash.flac.audio) fix(r.dash.flac.audio);
      }
      if (Array.isArray(r.durl)) {
        r.durl.forEach((d) => {
          grab(d);
          if (d.url) d.url = rwKeep(d.url);
          if (d.url) injectBackups(d, d.url);
          else if (Array.isArray(d.backup_url)) d.backup_url = d.backup_url.map(rwKeep);
        });
      }
    }
    const vUrl = firstUrls[0];
    if (vUrl && cfg.enabled && cfg.mode === 'auto') registerVideo(vUrl, 'playinfo');
  }

  // 三路引导汇聚点：playinfo陷阱 / DOM兜底 / 请求嗅探 都在此注册并触发探测
  function registerVideo(urlStr, source) {
    try {
      const u = new URL(urlStr, location.href);
      const cid = cidOf(u);
      if (!cid) return;
      state.activeCid = cid;
      state.activeCidAt = Date.now();
      if (state.origHostByCid[cid]) return;
      // PCDN/MCDN 不作为原生主机记录：还原至官方源或大陆池
      let regHost = u.hostname;
      const cls = classify(u);
      if (cls.isPcdn || cls.isMcdn) {
        const usrc = u.searchParams.get('xy_usource');
        regHost = (usrc && RE_UPOS.test(usrc) && !RE_AKAM.test(usrc)) ? usrc : firstColdReliable();
      }
      state.origHostByCid[cid] = regHost;
      if (source === 'playinfo') mark(cid, 'playinfoAt'); else mark(cid, 'sniffAt');
      if (!state.bootSource) {
        state.bootSource = source;
        log('info', 'sys', `视频已注册（引导来源: ${source === 'playinfo' ? 'playinfo数据' : '请求嗅探'}）cid=${cid} 调度节点=${shortHost(regHost)}`);
      }
      // 多P/连播场景：45s 内沿用近期裁决，避免逐P全量探测与播放流量互相干扰
      const lv = state.lastVerdict;
      if (lv && Date.now() - lv.at < 45000 && !cfg.disabledHosts.includes(lv.host) && !RE_AKAM.test(lv.host)) {
        setVerdict(cid, lv.host, `沿用上一视频的线路（${lv.why}）`, 'carry');
        log('info', 'route', `cid${cid} 沿用近期裁决 → ${shortHost(lv.host)}，跳过重复探测`);
        return;
      }
      probeAndDecide(cid, withHost(u, regHost));
    } catch (e) {}
  }

  // ═══════════════ §6 微探测裁决 + 缓存预热 ═══════════════

  const nativeFetch = window.fetch;

  const DEEP_PROBE_OFFSET = 8 * 1024 * 1024;   // 深偏移采样点：检验节点对非头部Range的供给能力

  async function probeRange(srcUrl, host, offset, capKB, timeoutMs) {
    const href = withHost(new URL(srcUrl), host);
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const resp = await nativeFetch(href, { credentials: 'omit', cache: 'no-store',
        headers: { Range: 'bytes=' + offset + '-' + (offset + capKB * 1024 - 1) }, signal: ctrl.signal });
      const ttfb = Math.round(performance.now() - t0);
      if (resp.status === 416) { clearTimeout(killer); try { resp.body && resp.body.cancel(); } catch (e) {} return { skipped: true }; }
      if (!resp.ok && resp.status !== 206) { clearTimeout(killer); return { ok: false, status: resp.status, ttfb }; }
      const cr = resp.headers.get('Content-Range');
      const total = cr ? +(cr.match(/\/(\d+)/) || [0, 0])[1] : 0;
      const buf = await resp.arrayBuffer();
      clearTimeout(killer);
      const sec = (performance.now() - t0) / 1000;
      return { ok: true, ttfb, total, mbps: +((buf.byteLength * 8 / 1e6) / sec).toFixed(1) };
    } catch (e) {
      clearTimeout(killer);
      return { ok: false, timeout: String(e).includes('bort'), err: String(e).slice(0, 60) };
    }
  }

  // 双点采样（头部 + 深偏移，串行）按最差值聚合：
  // 边缘节点常仅缓存文件头部，深部Range才暴露突发-饥饿节点的真实供给
  async function probeHost(srcUrl, host, capKB, timeoutMs) {
    const head = await probeRange(srcUrl, host, 0, capKB, timeoutMs);
    if (!head.ok) return { host, ok: false, status: head.status, ttfb: head.ttfb, timeout: head.timeout, err: head.err };
    // 深偏移必须依据 Content-Range 总长选取安全位置：
    // cosov 对越界 Range 不返回 416 而是挂死，盲用固定偏移会在短视频上误杀节点
    let deepOff = DEEP_PROBE_OFFSET;
    const deepLen = Math.min(capKB, 64) * 1024;
    if (head.total > 0 && head.total < deepOff + deepLen) {
      if (head.total <= capKB * 1024 * 3) {
        return { host, ok: true, status: 206, ttfb: head.ttfb, mbps: head.mbps, headMbps: head.mbps, deepMbps: null };
      }
      deepOff = Math.max(0, head.total - Math.max(deepLen * 2, Math.floor(head.total * 0.25)));
    }
    const deep = await probeRange(srcUrl, host, deepOff, Math.min(capKB, 64), timeoutMs);
    if (deep.skipped) return { host, ok: true, status: 206, ttfb: head.ttfb, mbps: head.mbps, headMbps: head.mbps, deepMbps: null };
    if (!deep.ok) return { host, ok: false, deepFail: true, ttfb: head.ttfb, timeout: deep.timeout, err: deep.err };
    return { host, ok: true, status: 206,
             ttfb: Math.max(head.ttfb, deep.ttfb),
             mbps: Math.min(head.mbps, deep.mbps),
             headMbps: head.mbps, deepMbps: deep.mbps };
  }

  async function probeAndDecide(cid, srcUrl) {
    const assigned = state.origHostByCid[cid];
    mark(cid, 'probeStart');
    const targets = new Set([assigned]);
    if (!cfg.disabledHosts.includes(PREMIUM)) targets.add(PREMIUM);
    targets.add(bestByHealth(true) || firstColdReliable());
    const list = [...targets].filter(h => h && (!RE_AKAM.test(h) || h === assigned));
    log('info', 'probe', `cid${cid} 并行微探测: ${list.map(shortHost).join(' / ')}`);

    const results = await Promise.all(list.map(h => probeHost(srcUrl, h, cfg.probeSizeKB, cfg.probeTimeoutMs)));
    mark(cid, 'probeEnd');

    for (const r of results) {
      if (r.ok) healthSample(r.host, r.mbps, r.ttfb); else healthFail(r.host);
      const detail = r.ok
        ? `${r.mbps}Mbps${r.deepMbps != null ? `（头部 ${r.headMbps} / 深部 ${r.deepMbps}）` : ''} TTFB ${r.ttfb}ms`
        : (r.deepFail ? '深部Range失败（头部可达——典型突发-饥饿）' : (r.timeout ? '超时无响应' : (r.status ? 'HTTP' + r.status : '连接失败')));
      log(r.ok ? 'info' : 'warn', 'probe', `  ${shortHost(r.host)}: ` + detail);
      if (r.ok && r.deepMbps != null && r.headMbps / Math.max(0.1, r.deepMbps) > 5) {
        log('warn', 'probe', `  ${shortHost(r.host)} 呈突发-饥饿特征：头部速率为深部 ${Math.round(r.headMbps / Math.max(0.1, r.deepMbps))} 倍，已按最差值计分`);
      }
    }
    state.probeInfoByCid[cid] = results;
    const score = (r) => !r.ok ? -1 : r.mbps * (400 / (400 + r.ttfb));
    const sorted = results.slice().sort((a, b) => score(b) - score(a));
    const winner = sorted[0];
    const assignedR = results.find(r => r.host === assigned);

    const runtime = state.verdictByCid[cid];
    if (runtime && runtime.src !== 'probe') {
      // 运行时证据(对冲/回退/熔断)优先；仅当调度节点实测显著占优(≥10Mbps 且≥3×运行时节点档案)才回切
      const rH = health[runtime.host];
      const runtimeMbps = (rH && rH.mbps) || 0;
      const strongNative = assignedR && assignedR.ok && assignedR.mbps >= Math.max(10, runtimeMbps * 3);
      if (strongNative) {
        setVerdict(cid, assigned, `调度节点复测 ${assignedR.mbps} Mbps，已切回`, 'probe');
        log('ok', 'route', `cid${cid} 探测复核通过 → 回切调度节点 ${shortHost(assigned)}`);
      } else {
        log('info', 'route', `cid${cid} 维持运行时裁决 ${shortHost(runtime.host)}（${runtime.why}），探测结果仅计入节点档案`);
      }
      return;
    }

    if (!winner || !winner.ok) {
      // 探测常被启动流量挤占带宽而虚假全灭；引擎part持续产生真实健康数据，探测仅为辅助信号
      log('warn', 'probe', `cid${cid} 微探测全部超时 → 交由引擎按节点档案实时决策`);
      return;
    }
    const assignedBad = !assignedR || !assignedR.ok || score(assignedR) < score(winner) * 0.7;
    if (winner.host !== assigned && assignedBad) {
      setVerdict(cid, winner.host, `测速最快 ${winner.mbps} Mbps`, 'probe');
      log('ok', 'route', `cid${cid} 路由裁决 → ${shortHost(winner.host)} (${winner.mbps}Mbps)｜调度节点 ${shortHost(assigned)} ${assignedR && assignedR.ok ? assignedR.mbps + 'Mbps' : '不可用'}`);
      kickPlayerIfStarving();
    } else {
      setVerdict(cid, assigned, '调度节点状态良好', 'probe');
      log('ok', 'route', `cid${cid} 维持调度节点 ${shortHost(assigned)} (${assignedR.mbps}Mbps)`);
    }

    const v = state.verdictByCid[cid];
    const premiumR = results.find(r => r.host === PREMIUM);
    const premiumCold = premiumR && !premiumR.ok;
    if (cfg.warmPremium && v && v.host !== PREMIUM && premiumCold && !cfg.disabledHosts.includes(PREMIUM)) {
      // 触发边缘回源（带超时，不留悬挂连接）
      const tc = new AbortController();
      const tk = setTimeout(() => tc.abort(), 5000);
      nativeFetch(withHost(new URL(srcUrl), PREMIUM), { credentials: 'omit', cache: 'no-store',
        headers: { Range: 'bytes=0-0' }, signal: tc.signal }).catch(() => {}).finally(() => clearTimeout(tk));
      let hits = 0, tries = 0;
      log('info', 'warm', `cid${cid} 后台缓存预热启动: ${shortHost(PREMIUM)}（探测周期 ${cfg.warmIntervalMs / 1000}s）`);
      state.warmTimers[cid] = setInterval(async () => {
        if (++tries > 12 || state.activeCid !== cid) {
          clearInterval(state.warmTimers[cid]); delete state.warmTimers[cid]; return;
        }
        const r = await probeHost(srcUrl, PREMIUM, 64, 3000);
        if (r.ok && r.ttfb < 250 && r.mbps > 15) {
          if (++hits >= 2) {
            clearInterval(state.warmTimers[cid]); delete state.warmTimers[cid];
            setVerdict(cid, PREMIUM, `预热完成 ${r.mbps} Mbps`, 'warm');
            healthSample(PREMIUM, r.mbps, r.ttfb);
            mark(cid, 'warmUpgradeAt');
            log('ok', 'warm', `cid${cid} 缓存预热完成 → 路由升级至主力节点 (${r.mbps}Mbps)`);
          }
        } else hits = 0;
      }, cfg.warmIntervalMs);
    }
  }

  // ═══════════════ §7 网络层 ═══════════════

  // 引导路1：__playinfo__ 属性陷阱（先捕获已存在的值，保证数据完整性）
  (function trapPlayinfo() {
    let val;
    try {
      if ('__playinfo__' in window && window.__playinfo__) {
        val = window.__playinfo__;
        Promise.resolve().then(() => { try { transformPlayinfo(val); } catch (e) {} });
        state.bootSource = 'trap-existing';
      }
      Object.defineProperty(window, '__playinfo__', {
        configurable: true,
        get() { return val; },
        set(v) { try { transformPlayinfo(v); } catch (e) {} val = v; },
      });
    } catch (e) {}
  })();

  // 引导路2：DOM 就绪兜底
  document.addEventListener('DOMContentLoaded', () => {
    try {
      if (!state.activeCid && window.__playinfo__) transformPlayinfo(window.__playinfo__);
    } catch (e) {}
  });

  // 闲置停滞时同步换路，避免看门狗只掐不换的死循环
  function onIdleStall(host, cid) {
    if (cfg.mode !== 'auto' || !cid) return;
    const verdict = state.verdictByCid[cid];
    if (!verdict || verdict.host === host) {
      const next = nextCandidateAfter(host);
      if (next && next !== host) {
        setVerdict(cid, next, '传输停滞，已切换', 'stall');
        log('warn', 'route', `cid${cid} 节点 ${shortHost(host)} 传输停滞 → 切换 ${shortHost(next)}`);
      }
    }
    kickPlayerIfStarving();
  }

  // 直通计数流：计量+看门狗，同时正确传播取消与背压
  function meterStream(resp, host, t0, ctrl, entry, onDone) {
    if (!resp.body) { onDone && onDone(); return resp; }
    const reader = resp.body.getReader();
    let bytes = 0, lastChunk = performance.now(), finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(idleTimer);
      clearTimeout(bodyDeadline);
      entry.kb = Math.round(bytes / 1024);
      entry.ms = Math.round(performance.now() - t0);
      pushFlow(host, bytes);
      const sec = (performance.now() - t0) / 1000;
      if (bytes > 262144 && sec > 0.05) {
        entry.mbps = +((bytes * 8 / 1e6) / sec).toFixed(1);
        healthSample(host, entry.mbps, 0);
      }
      onDone && onDone();
    };
    const idleTimer = setInterval(() => {
      if (finished) { clearInterval(idleTimer); return; }
      if (performance.now() - lastChunk > cfg.idleTimeoutMs) {
        entry.outcome = '传输中断';
        healthFail(host);
        log('warn', 'net', `分片传输空闲超过 ${cfg.idleTimeoutMs / 1000}s @${shortHost(host)} → 中止`);
        onIdleStall(host, entry.cid);
        try { ctrl.abort(); } catch (e) {}
        finish();
      }
    }, 1000);
    const bodyDeadline = setTimeout(() => { if (!finished) { try { ctrl.abort(); } catch (e) {} } }, cfg.bodyDeadlineMs);
    state.lastSegHost = host;
    const out = new ReadableStream({
      pull(c) {
        return reader.read().then(({ done, value }) => {
          if (done) { finish(); c.close(); return; }
          bytes += value.length;
          bytesThisTick += value.length;
          lastChunk = performance.now();
          c.enqueue(value);
        }).catch(err => { finish(); c.error(err); });
      },
      cancel(reason) {
        finish();
        try { reader.cancel(reason); } catch (e) {}
        try { ctrl.abort(); } catch (e) {}
      },
    });
    return new Response(out, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  }

  function ttfbLimitFor(host) {
    const h = health[host];
    if (h && h.ok > 2 && h.ttfb) return Math.min(Math.max(h.ttfb * 5, 1200), cfg.ttfbTimeoutMs + 1500);
    return cfg.ttfbTimeoutMs;
  }

  // 单次尝试；holder.cancelledByPeer=true 的取消不计入节点失败
  async function attemptFetch(input, init, u, host, cs, note, holder) {
    const href = withHost(u, host);
    const ctrl = new AbortController();
    if (holder) holder.c = ctrl;
    const onCallerAbort = () => { try { ctrl.abort(); } catch (e) {} };
    if (cs.signal) cs.signal.addEventListener('abort', onCallerAbort);
    let unhooked = false;
    const unhook = () => {
      if (unhooked) return;
      unhooked = true;
      if (cs.signal) cs.signal.removeEventListener('abort', onCallerAbort);
    };
    const entry = { t: Date.now(), cid: cidOf(u), host, note: note || '',
                    outcome: '进行中', ttfb: -1, ms: 0, kb: 0, mbps: 0 };
    pushReq(entry);
    const ttfbTimer = setTimeout(() => { if (entry.outcome === '进行中') { entry.outcome = '首字节超时'; try { ctrl.abort(); } catch (e) {} } }, ttfbLimitFor(host));
    const t0 = performance.now();
    try {
      const req = (typeof input === 'string') ? href : new Request(href, input);
      const resp = await nativeFetch(req, Object.assign({}, init || {}, { signal: ctrl.signal }));
      clearTimeout(ttfbTimer);
      entry.ttfb = Math.round(performance.now() - t0);
      if (!resp.ok && resp.status !== 206) {
        entry.outcome = 'HTTP ' + resp.status;
        healthFail(host);
        unhook();
        return { ok: false, reason: entry.outcome };
      }
      entry.outcome = '成功';
      healthSample(host, 0, entry.ttfb);
      // caller-abort 桥由 meterStream 在流结束/取消时解除，
      // 保证正文传输中途 abort 也能真正掐断网络
      return { ok: true, resp: meterStream(resp, host, t0, ctrl, entry, unhook), host, entry };
    } catch (e) {
      clearTimeout(ttfbTimer);
      unhook();
      if (cs.aborted) { entry.outcome = '播放器取消'; return { ok: false, reason: 'caller-abort', err: e }; }
      if (holder && holder.cancelledByPeer) { entry.outcome = '对冲取消'; return { ok: false, reason: 'hedge-cancel', err: e }; }
      if (entry.outcome === '进行中') entry.outcome = String(e).includes('bort') ? '超时' : '连接失败';
      healthFail(host);
      return { ok: false, reason: entry.outcome, err: e };
    }
  }

  function pickHedgeHost(primary) {
    const byHealth = bestByHealth(true, [primary]);
    if (byHealth) return byHealth;
    const r = coldReliableRanked().filter(h => h !== primary);
    return r.length ? r[0] : null;
  }

  // 对冲：主请求超时未响应则向备选节点并行发起同一请求，采用先返回者；尊重播放器取消
  function hedgedAttempt(input, init, u, primaryHost, hedgeHost, cs, cid) {
    return new Promise((resolve) => {
      let settled = false, hedgeFired = false, pFail = null, hFail = null, hedgeTimer = null;
      const pH = {}, hH = {};
      const finish = (x) => { if (!settled) { settled = true; if (hedgeTimer) clearTimeout(hedgeTimer); resolve(x); } };
      const winner = (res, src) => {
        if (settled) { try { res.resp && res.resp.body && res.resp.body.cancel('late-winner'); } catch (e) {} return; }
        if (src === 'hedge') {
          if (pH.c) { pH.cancelledByPeer = true; try { pH.c.abort(); } catch (e) {} }
          state.hedgeWins++;
          res.entry.note = '对冲命中';
          if (cid && !state.verdictByCid[cid] && !cs.aborted) {
            setVerdict(cid, hedgeHost, '对冲请求命中', 'hedge');
            log('ok', 'route', `对冲命中: ${shortHost(hedgeHost)} 率先返回（${shortHost(primaryHost)} 未在 ${cfg.hedgeDelayMs}ms 内响应）→ 更新路由`);
          }
        } else {
          if (hH.c) { hH.cancelledByPeer = true; try { hH.c.abort(); } catch (e) {} }
        }
        finish(res);
      };
      const maybeFail = () => {
        if (settled) return;
        if (cs.aborted) { finish({ ok: false, reason: 'caller-abort', err: (pFail && pFail.err) || (hFail && hFail.err) }); return; }
        if (pFail && !hedgeFired) { fireHedge(); return; }
        if (pFail && hedgeFired && hFail) finish({ ok: false, reason: pFail.reason, err: pFail.err || hFail.err });
      };
      const fireHedge = () => {
        if (hedgeFired || settled || cs.aborted) return;
        hedgeFired = true;
        attemptFetch(input, init, u, hedgeHost, cs, '对冲', hH).then(r => {
          if (r.ok) winner(r, 'hedge'); else { hFail = r; maybeFail(); }
        });
      };
      attemptFetch(input, init, u, primaryHost, cs, '主请求', pH).then(r => {
        if (r.ok) winner(r, 'primary'); else { pFail = r; maybeFail(); }
      });
      hedgeTimer = setTimeout(fireHedge, cfg.hedgeDelayMs);
    });
  }

  function abortError() {
    try { return new DOMException('The user aborted a request.', 'AbortError'); }
    catch (e) { const err = new Error('aborted'); err.name = 'AbortError'; return err; }
  }

  // ═══════════════ §7.5 统一装载引擎：多源并行Range聚合 ═══════════════
  // 单TCP流被跨境限速时，跨节点并行聚合可达数倍吞吐；逐part看门狗+跨节点
  // 补洞（含短读校验）同时化解单流限速与深部Range停滞。

  let msLoadSeq = 0;
  // 各节点在途连接数（跨装载全局），供首发与补洞的节点分配参考
  const hostInflight = Object.create(null);

  // lane 为可选的UI遥测对象：仅写入进度，不参与任何控制流
  async function msFetchPart(u, host, lo, hi, cs, lane) {
    const href = withHost(u, host);
    const ctrl = new AbortController();
    if (cs) cs.ctrls.push(ctrl);
    if (lane) { lane.host = host; lane.bytes = 0; lane.failed = 0; }
    hostInflight[host] = (hostInflight[host] || 0) + 1;
    let gotHeaders = false, idleTimer = 0;
    const ttfbTimer = setTimeout(() => { if (!gotHeaders) { try { ctrl.abort(); } catch (e) {} } }, ttfbLimitFor(host));
    const hardTimer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, cfg.bodyDeadlineMs);
    const t0 = performance.now();
    try {
      const resp = await nativeFetch(href, { credentials: 'omit',
        headers: { Range: `bytes=${lo}-${hi}` }, signal: ctrl.signal });
      gotHeaders = true;
      clearTimeout(ttfbTimer);
      const ttfb = Math.round(performance.now() - t0);
      // 协议画像：hw/08c 系经 CORS 暴露 x-service-module（如 hw-h2-server）。h2 节点的
      // 并发流复用同一 TCP 连接，第二连接不增带宽，分配第二连接时靠后
      try { const sm = resp.headers.get('x-service-module'); if (sm) H(host).h2 = /h2/i.test(sm) ? 1 : 0; } catch (e) {}
      if (!resp.ok && resp.status !== 206) { clearTimeout(hardTimer); healthFail(host); return { ok: false, status: resp.status }; }
      const cr = resp.headers.get('Content-Range');
      const total = cr ? +(cr.match(/\/(\d+)/) || [0, 0])[1] : 0;
      const expected = hi - lo + 1;
      // part级中段看门狗：块间隔>2.5s 或 3s后速率<0.3Mbps 即处决换节点
      const chunks = [];
      let got = 0, lastChunk = performance.now();
      idleTimer = setInterval(() => {
        const now = performance.now();
        const sec = (now - t0) / 1000;
        const mbps = got * 8 / 1e6 / Math.max(0.2, sec);
        if (now - lastChunk > 2500 || (sec > 3 && mbps < 0.3)) { try { ctrl.abort(); } catch (e) {} }
      }, 500);
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        chunks.push(value);
        lastChunk = performance.now();
        if (lane) lane.bytes = got;
      }
      clearInterval(idleTimer); idleTimer = 0;
      clearTimeout(hardTimer);
      if (got !== expected && !(total && hi >= total - 1 && got === total - lo)) {
        healthFail(host);                       // 短读：服务器提前断流，需换节点补洞
        return { ok: false, short: true, got };
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      const sec = (performance.now() - t0) / 1000;
      healthSample(host, got > 262144 && sec > 0.05 ? +((got * 8 / 1e6) / sec).toFixed(1) : 0, ttfb);
      return { ok: true, buf: out.buffer, total };
    } catch (e) {
      clearTimeout(ttfbTimer); clearTimeout(hardTimer);
      if (idleTimer) clearInterval(idleTimer);
      if (!(cs && cs.aborted)) healthFail(host);
      if (lane) lane.failed = 1;
      return { ok: false, err: String(e).slice(0, 50), aborted: cs && cs.aborted };
    } finally {
      hostInflight[host] = Math.max(0, (hostInflight[host] || 0) - 1);
    }
  }

  // 引擎候选主机：按健康分排序（而非链位），优等节点自动承担part首发
  function engineHosts(u) {
    const set = new Set();
    const routed = routeFor(u);
    if (routed) set.add(routed);
    set.add(u.hostname);
    const cid = cidOf(u);
    const orig = cid && state.origHostByCid[cid];
    if (orig) set.add(orig);
    coldReliableRanked().forEach(h => set.add(h));
    const arr = [...set].filter(h => h && (!RE_AKAM.test(h) || h === u.hostname) && !cfg.disabledHosts.includes(h));
    const scored = arr.map((h, i) => ({ h, i, s: healthScore(h) }));
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    return scored.map(x => x.h).slice(0, Math.max(3, laneCount() + 1));
  }

  // 路数与单节点连接上限：配置可能来自导入，统一夹取
  function laneCount() { return Math.min(12, Math.max(1, Math.round(+cfg.msLanes) || 4)); }
  function perHostLimit() { return Math.min(3, Math.max(1, Math.round(+cfg.msPerHost) || 2)); }

  // 本次装载的分片数：size=按目标分片尺寸向上取整（路数为上限）；fixed=按路数等分，
  // 受分片下限约束；两者再受"候选节点数×单节点连接上限"封顶
  function planParts(span, hostCount) {
    const n = cfg.msSplit === 'fixed'
      ? Math.floor(span / (Math.max(64, +cfg.msMinPartKB || 128) * 1024))
      : Math.ceil(span / (Math.max(128, +cfg.msPartKB || 768) * 1024));
    return Math.max(1, Math.min(laneCount(), n, Math.max(1, hostCount) * perHostLimit()));
  }

  // 节点分配：在途连接数少者优先 → 第二连接起 h2 节点靠后 → 候选序位（健康分）；
  // 在途数已达单节点上限的节点仅在别无选择时启用
  function pickHost(hosts, exclude) {
    const cap = perHostLimit();
    let best = null, bestKey = Infinity;
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      if (exclude && exclude.has(h)) continue;
      const n = hostInflight[h] || 0;
      const h2 = n > 0 && health[h] && health[h].h2 ? 1 : 0;
      const key = (n >= cap ? 1e6 : 0) + n * 1000 + h2 * 100 + i;
      if (key < bestKey) { best = h; bestKey = key; }
    }
    return best;
  }

  // 将 [lo,hi] 切分为若干part跨节点并行拉取，返回 {buffer, total}；任一part全节点失败则整体reject
  async function multiSourceLoad(u, lo, hi, cs, onProgress) {
    const span = hi - lo + 1;
    const hosts = engineHosts(u);
    if (!hosts.length) throw new Error('no hosts');
    const nParts = planParts(span, hosts.length);
    const step = Math.ceil(span / nParts);
    const bounds = [];
    for (let i = 0; i < nParts; i++) bounds.push([lo + i * step, Math.min(hi, lo + (i + 1) * step - 1)]);
    const out = new Uint8Array(span);
    const t0 = performance.now();
    let fetched = 0, fileTotal = 0;
    // 实际填充到的绝对末端：跨度越过文件尾时尾段合法短于请求量；out 按 span
    // 预分配，不裁剪会把未填充区的零字节当媒体数据交给播放器
    let realEnd = lo - 1, lastHostUsed = hosts[0];
    const partStats = [];
    state.msActive++;
    const loadId = ++msLoadSeq;
    const lanes = bounds.map(([plo, phi], idx) =>
      ({ id: loadId + '-' + idx, idx, host: '', span: phi - plo + 1, bytes: 0, done: 0, failed: 0 }));
    state.msLanes = lanes;
    uiLive();
    try {
    await Promise.all(bounds.map(async ([plo, phi], idx) => {
      const pT0 = performance.now();
      const commit = (r, attempt, host) => {
        const lane = lanes[idx];
        const n = r.buf.byteLength, expect = phi - plo + 1;
        // 仅尾段允许短于请求量；中间段短读会在合成缓冲留下空洞
        if (n < expect && idx !== nParts - 1) throw new Error(`part${idx} 非尾段短读 ${n}/${expect}`);
        if (lane) { lane.host = host; lane.bytes = n; lane.done = 1; lane.failed = 0; }
        lastHostUsed = host;
        out.set(new Uint8Array(r.buf), plo - lo);
        const end = plo + n - 1;
        if (end > realEnd) realEnd = end;
        fetched += r.buf.byteLength;
        bytesThisTick += r.buf.byteLength;
        pushFlow(host, r.buf.byteLength);
        if (r.total) fileTotal = r.total;
        state.msParts++;
        partStats.push({ idx, host: shortHost(host), ms: Math.round(performance.now() - pT0), attempt: attempt + 1 });
        if (attempt > 0) { state.msHoleFills++; log('info', 'net', `多源补洞: part${idx} 由 ${shortHost(host)} 补齐（第${attempt + 1}次尝试）`); }
        if (onProgress) onProgress(fetched, span);
      };
      // 首发按在途连接数与健康分序位选节点（各 lane 的选择在首个 await 前同步完成，
      // 前序 lane 的记账对后序可见）；重试即对冲——两个未试过的节点并发先成者胜，
      // 候选耗尽时才允许回到已试节点
      const tried = new Set();
      const h0 = pickHost(hosts, tried);
      tried.add(h0);
      if (cs.aborted) throw abortError();
      const r0 = await msFetchPart(u, h0, plo, phi, cs, lanes[idx]);
      if (r0.ok) { commit(r0, 0, h0); return; }
      if (r0.aborted) throw abortError();
      for (let round = 1; round <= 2; round++) {
        if (cs.aborted) throw abortError();
        const hA = pickHost(hosts, tried) || pickHost(hosts, null);
        tried.add(hA);
        const hB = pickHost(hosts, tried);
        if (hB) tried.add(hB);
        const r = await new Promise((resolve) => {
          let settled = false, fails = 0;
          const need = hB ? 2 : 1;
          const settle = (x, h) => {
            if (settled) return;
            if (x.ok) { settled = true; resolve({ win: x, host: h }); }
            else if (++fails >= need) { settled = true; resolve({ win: x, host: h }); }
          };
          msFetchPart(u, hA, plo, phi, cs, lanes[idx]).then(x => settle(x, hA));
          if (hB) msFetchPart(u, hB, plo, phi, cs).then(x => settle(x, hB));
        });
        if (r.win.ok) { commit(r.win, round, r.host); return; }
        if (r.win.aborted) throw abortError();
      }
      throw new Error('part' + idx + ' 全部候选节点失败');
    }));
    } finally {
      state.msActive = Math.max(0, state.msActive - 1);
      setTimeout(() => { if (state.msLanes === lanes) state.msLanes = []; }, 450);   // 保留完成态闪光
    }
    state.msLoads++;
    state.lastSegHost = nParts > 1 ? `多源聚合×${nParts}` : lastHostUsed;
    const wallMs = Math.round(performance.now() - t0);
    if (wallMs > 4000) {
      log('warn', 'net', `装载偏慢 ${(wallMs / 1000).toFixed(1)}s (${Math.round(span / 1024)}KB): ` +
        partStats.map(p => `p${p.idx}:${p.host}${p.attempt > 1 ? '×' + p.attempt : ''} ${p.ms}ms`).join(' | '));
    }
    const filled = realEnd - lo + 1;
    if (filled > 0 && filled < span) {
      log('info', 'net', `尾段实际 ${filled}/${span} 字节，已按真实长度裁剪`);
    }
    return {
      buffer: (filled > 0 && filled < span) ? out.buffer.slice(0, filled) : out.buffer,
      total: fileTotal,
      end: filled > 0 ? realEnd : hi
    };
  }

  async function fetchMediaWithFallback(input, init, u) {
    const cid = cidOf(u);
    state.lastMediaUrl = u.href;
    // 引导路3：请求嗅探自举
    if (cfg.enabled && cfg.mode === 'auto' && cid && !state.origHostByCid[cid]) {
      registerVideo(u.href, 'sniff');
    }
    if (cid) { const t = tl(cid); if (t.firstReqAt == null) t.firstReqAt = performance.now(); }

    // caller 信号可能在 init 上，也可能在 Request 对象上
    const callerSignal = (init && init.signal) || (input instanceof Request ? input.signal : undefined);
    const cs = { signal: callerSignal, aborted: !!(callerSignal && callerSignal.aborted) };
    let csListener = null;
    if (callerSignal && !cs.aborted) {
      csListener = () => { cs.aborted = true; };
      callerSignal.addEventListener('abort', csListener, { once: true });
    }
    const cleanup = () => { if (callerSignal && csListener) callerSignal.removeEventListener('abort', csListener); };

    try {
      // 大跨度Range优先走多源聚合引擎（fetch装载器形态的播放器）
      if (cfg.multiSource && cfg.mode === 'auto') {
        let rangeHdr = null;
        try {
          if (init && init.headers) {
            rangeHdr = (typeof Headers !== 'undefined' && init.headers instanceof Headers)
              ? init.headers.get('range') : (init.headers.Range || init.headers.range);
          }
          if (!rangeHdr && input instanceof Request) rangeHdr = input.headers.get('range');
          if (rangeHdr && typeof rangeHdr !== 'string') rangeHdr = null;
        } catch (e) {}
        const rm = rangeHdr && rangeHdr.match(/^bytes=(\d+)-(\d+)$/);
        if (rm && (+rm[2] - +rm[1] + 1) >= cfg.msMinSplitKB * 1024) {
          const cs2 = { aborted: cs.aborted, ctrls: [] };
          const onAbort2 = () => { cs2.aborted = true; cs2.ctrls.forEach(c => { try { c.abort(); } catch (e) {} }); };
          if (callerSignal) callerSignal.addEventListener('abort', onAbort2, { once: true });
          try {
            const { buffer, total, end } = await multiSourceLoad(u, +rm[1], +rm[2], cs2, null);
            if (cid) mark(cid, 'firstOkAt');
            // 终点用实际取得的末端而非请求值：跨度越过文件尾时两者不同
            const hiReal = (typeof end === 'number' && end >= +rm[1]) ? end : +rm[2];
            return new Response(buffer, { status: 206, statusText: 'Partial Content',
              headers: { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
                         'Content-Range': `bytes ${rm[1]}-${hiReal}/${total || '*'}`, 'Content-Length': String(buffer.byteLength) } });
          } catch (e) {
            if (cs2.aborted || cs.aborted) throw abortError();
            log('warn', 'net', '多源聚合(fetch路径)失败 → 回退单源链');
          } finally {
            if (callerSignal) callerSignal.removeEventListener('abort', onAbort2);
          }
        }
      }
      const chain = candidateChain(u);
      const tried = new Set();
      const failedHosts = new Set();
      let lastErr = null;
      for (let i = 0; i < chain.length; i++) {
        if (cs.aborted) throw abortError();
        const host = chain[i];
        if (tried.has(host)) continue;

        if (i === 0 && cfg.hedge && cfg.mode === 'auto' && cid && !state.verdictByCid[cid]) {
          const hedgeHost = pickHedgeHost(host);
          if (hedgeHost && hedgeHost !== host) {
            tried.add(host); tried.add(hedgeHost);
            const res = await hedgedAttempt(input, init, u, host, hedgeHost, cs, cid);
            if (res.ok) { if (cid) mark(cid, 'firstOkAt'); return res.resp; }
            if (res.reason === 'caller-abort') throw abortError();
            failedHosts.add(host); failedHosts.add(hedgeHost);
            lastErr = res.err || lastErr;
            log('warn', 'net', `主请求与对冲均失败 (${shortHost(host)}/${shortHost(hedgeHost)}) → 继续回退链`);
            continue;
          }
        }

        tried.add(host);
        const r = await attemptFetch(input, init, u, host, cs, i > 0 ? '回退' : '');
        if (r.ok) {
          if (i > 0) {
            state.fallbacks++;
            // 仅当现有裁决节点确实刚失败过才改写裁决（防乒乓切换）
            const cur = cid && state.verdictByCid[cid];
            if (cid && (!cur || failedHosts.has(cur.host))) {
              setVerdict(cid, host, '原节点失败，已换用', 'fallback');
              log('ok', 'net', `回退成功 → ${shortHost(host)}，更新路由`);
            }
          }
          if (cid) mark(cid, 'firstOkAt');
          return r.resp;
        }
        if (r.reason === 'caller-abort') throw abortError();
        failedHosts.add(host);
        lastErr = r.err || new TypeError(r.reason);
        log('warn', 'net', `${r.reason} @${shortHost(host)}${i + 1 < chain.length ? ' → 尝试下一候选节点' : '（候选节点耗尽）'}`);
      }
      if (cs.aborted) throw abortError();
      throw lastErr || new TypeError('all cdn candidates failed');
    } finally {
      cleanup();
    }
  }

  window.fetch = function (input, init) {
    try {
      const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      const u = new URL(urlStr, location.href);
      if (cfg.enabled && classify(u).isMedia) {
        return fetchMediaWithFallback(input, init, u);
      }
      if (cfg.enabled && RE_API.test(urlStr)) {
        return nativeFetch.call(this, input, init).then(async (resp) => {
          try {
            const data = await resp.clone().json();
            transformPlayinfo(data);
            const headers = new Headers(resp.headers);
            headers.delete('content-length');
            return new Response(JSON.stringify(data), { status: resp.status, statusText: resp.statusText, headers });
          } catch (e) { return resp; }
        });
      }
    } catch (e) {}
    return nativeFetch.call(this, input, init);
  };

  // XHR 路径（实测为播放器分片主通道）
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bcoHost = null;
    this.__bcoApi = false;
    try {
      const s = String(url);
      const u = new URL(s, location.href);
      if (cfg.enabled && classify(u).isMedia) {
        state.lastMediaUrl = u.href;
        const cid = cidOf(u);
        if (cfg.mode === 'auto' && cid && !state.origHostByCid[cid]) registerVideo(u.href, 'sniff');
        const re = rewriteMediaUrl(s);
        if (re) { url = re; this.__bcoHost = new URL(re).hostname; }
        else this.__bcoHost = u.hostname;
        this.__bcoUrl = re || u.href;
        this.__bcoMethod = String(method).toUpperCase();
        this.__bcoRange = null;
        this.__bcoEntry = { t: Date.now(), cid, host: this.__bcoHost, note: 'XHR', outcome: '进行中', ttfb: -1, ms: 0, kb: 0, mbps: 0 };
      } else if (cfg.enabled && RE_API.test(s)) this.__bcoApi = true;
    } catch (e) {}
    return xhrOpen.call(this, method, url, ...rest);
  };
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (this.__bcoHost && /^range$/i.test(String(name))) this.__bcoRange = String(value); } catch (e) {}
    return xhrSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    // 引擎接管：大跨度媒体Range请求改由多源聚合装载（实测播放器分片主通道为XHR）
    if (this.__bcoHost && this.__bcoEntry && cfg.enabled && cfg.multiSource && cfg.mode === 'auto'
        && this.__bcoMethod === 'GET' && this.__bcoRange) {
      const rm = this.__bcoRange.match(/^bytes=(\d+)-(\d+)$/);
      if (rm && (+rm[2] - +rm[1] + 1) >= cfg.msMinSplitKB * 1024) {
        const xhr = this;
        const lo = +rm[1], hi = +rm[2];
        const entry = this.__bcoEntry;
        entry.note = '多源';
        pushReq(entry);
        const cs = { aborted: false, ctrls: [] };
        const t0 = performance.now();
        const u = new URL(this.__bcoUrl, location.href);
        const nativeAbort = xhr.abort.bind(xhr);
        xhr.abort = function () {
          cs.aborted = true;
          cs.ctrls.forEach(c => { try { c.abort(); } catch (e) {} });
          entry.outcome = '播放器取消';
          try { xhr.dispatchEvent(new ProgressEvent('abort')); xhr.dispatchEvent(new ProgressEvent('loadend')); } catch (e) {}
        };
        const def = (k, v) => { try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch (e) {} };
        const fireRS = (n) => { def('readyState', n); try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {} };
        // 合成响应必须遵循 XHR 事件时序：loadstart → RS2(头) → RS3 → progress* → RS4 → load；
        // 播放器 QoS 在 RS2 才建立请求记录，时序缺失会致其回调报错刷屏
        const span = hi - lo + 1;
        // realHi/realSpan 在装载完成后按实际末端修正：跨度越过文件尾时，
        // 响应头不得宣称超出实际交付的字节数
        let fileTotal = 0, headersSent = false, realHi = hi, realSpan = span;
        const setHeaders = () => {
          xhr.getResponseHeader = (k) => {
            const key = String(k).toLowerCase();
            if (key === 'content-length') return String(realSpan);
            if (key === 'content-range') return `bytes ${lo}-${realHi}/${fileTotal || '*'}`;
            if (key === 'content-type') return 'application/octet-stream';
            if (key === 'accept-ranges') return 'bytes';
            return null;
          };
          xhr.getAllResponseHeaders = () =>
            `content-type: application/octet-stream\r\naccept-ranges: bytes\r\ncontent-length: ${realSpan}\r\ncontent-range: bytes ${lo}-${realHi}/${fileTotal || '*'}\r\n`;
        };
        const emitHeaders = () => {
          if (headersSent || cs.aborted) return;
          headersSent = true;
          def('status', 206); def('statusText', 'Partial Content'); def('responseURL', u.href);
          const rt0 = xhr.responseType;
          def('response', (rt0 === '' || rt0 === 'text') ? '' : null);   // 规范：DONE 之前非文本响应为 null
          if (rt0 === '' || rt0 === 'text') def('responseText', '');
          setHeaders();
          fireRS(2);
          fireRS(3);
        };
        setTimeout(() => {
          if (cs.aborted) return;
          try { xhr.dispatchEvent(new ProgressEvent('loadstart', { lengthComputable: true, loaded: 0, total: span })); } catch (e) {}
        }, 0);
        multiSourceLoad(u, lo, hi, cs, (loaded, total) => {
          emitHeaders();
          try { xhr.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded, total })); } catch (e) {}
        }).then(({ buffer, total, end }) => {
          if (cs.aborted) return;
          fileTotal = total || 0;
          if (typeof end === 'number' && end >= lo) { realHi = end; realSpan = end - lo + 1; }
          entry.outcome = '成功';
          entry.ms = Math.round(performance.now() - t0);
          entry.kb = Math.round(realSpan / 1024);
          entry.ttfb = 0;
          const sec = entry.ms / 1000;
          if (sec > 0.05) entry.mbps = +((realSpan * 8 / 1e6) / sec).toFixed(1);
          emitHeaders();
          setHeaders();                                   // 此时 total 已知，刷新 Content-Range
          const rt = xhr.responseType;
          let resp;
          if (rt === '' || rt === 'text') { resp = new TextDecoder().decode(buffer); def('responseText', resp); }
          else if (rt === 'blob') resp = new Blob([buffer]);
          else resp = buffer;
          def('response', resp);
          fireRS(4);
          try {
            xhr.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: realSpan, total: realSpan }));
            xhr.dispatchEvent(new ProgressEvent('loadend', { lengthComputable: true, loaded: realSpan, total: realSpan }));
          } catch (e) {}
        }).catch((err) => {
          if (cs.aborted) return;
          entry.outcome = '聚合失败→原生';
          log('warn', 'net', `多源聚合失败(${String((err && err.message) || err).slice(0, 60)}) → 回退原生XHR`);
          // 清除已影子化的属性，交还原生 XHR 状态机（否则 readyState 等会被冻结在合成值）
          ['readyState', 'status', 'statusText', 'responseURL', 'response', 'responseText',
           'getResponseHeader', 'getAllResponseHeaders'].forEach(k => { try { delete xhr[k]; } catch (e) {} });
          xhr.abort = nativeAbort;
          try { xhrSend.apply(xhr, args); } catch (e2) {
            try { xhr.dispatchEvent(new ProgressEvent('error')); } catch (e3) {}
          }
        });
        return;   // 原生send不再调用，由引擎合成响应
      }
    }
    if (this.__bcoHost) {
      const host = this.__bcoHost;
      const entry = this.__bcoEntry;
      const t0 = performance.now();
      if (entry) pushReq(entry);
      this.addEventListener('readystatechange', function () {
        if (entry && this.readyState === 2 && entry.ttfb < 0) entry.ttfb = Math.round(performance.now() - t0);
      });
      this.addEventListener('load', function () {
        try {
          const n = (this.response && this.response.byteLength) || 0;
          bytesThisTick += n;
          pushFlow(host, n);
          state.lastSegHost = host;
          if (entry) {
            entry.outcome = (this.status === 200 || this.status === 206) ? '成功' : 'HTTP ' + this.status;
            entry.ms = Math.round(performance.now() - t0);
            entry.kb = Math.round(n / 1024);
            const sec = entry.ms / 1000;
            if (n > 262144 && sec > 0.05) { entry.mbps = +((n * 8 / 1e6) / sec).toFixed(1); healthSample(host, entry.mbps, 0); }
          }
        } catch (e) {}
      });
      this.addEventListener('error', function () { if (entry) entry.outcome = '连接失败'; healthFail(host); });
      this.addEventListener('timeout', function () { if (entry) entry.outcome = '超时'; healthFail(host); });
      this.addEventListener('abort', function () { if (entry) entry.outcome = '播放器取消'; });
    }
    if (this.__bcoApi) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4) return;
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const data = JSON.parse(this.responseText);
            transformPlayinfo(data);
            const txt = JSON.stringify(data);
            Object.defineProperty(this, 'responseText', { configurable: true, get: () => txt });
            Object.defineProperty(this, 'response', { configurable: true, get: () => txt });
          } else if (this.responseType === 'json' && this.response) {
            const d = this.response;
            transformPlayinfo(d);
            Object.defineProperty(this, 'response', { configurable: true, get: () => d });
          }
        } catch (e) {}
      });
    }
    return xhrSend.apply(this, args);
  };

  // ═══════════════ §8 卡顿哨兵 ═══════════════

  let guardedVideo = null, stallTimer = 0;

  function nextCandidateAfter(current) {
    const pool = coldReliableRanked();
    if (!pool.length) return current || FALLBACK_MAINLAND;
    if (pool.length === 1) return pool[0];
    const i = pool.indexOf(current);
    return pool[(i + 1) % pool.length];
  }

  function onStall() {
    stallTimer = 0;
    if (!cfg.enabled || cfg.mode !== 'auto') return;
    const v = guardedVideo;
    if (!v || v.paused || v.seeking) return;
    state.stalls++;
    const cid = state.activeCid;
    if (cid) { const t = tl(cid); (t.stallsAt = t.stallsAt || []).push(performance.now()); }
    const cur = (cid && state.verdictByCid[cid] && state.verdictByCid[cid].host) || (cid && state.origHostByCid[cid]) || state.lastSegHost;
    healthFail(String(cur));
    const next = nextCandidateAfter(String(cur));
    if (cid && next) setVerdict(cid, next, '播放卡顿，已切换', 'stall');
    log('warn', 'stall', `播放停滞超过 ${cfg.stallMs / 1000}s → 熔断节点 ${shortHost(String(cur))}，切换至 ${shortHost(next)}`);
    if (cfg.rescueJiggle) {
      try { v.currentTime = v.currentTime + 0.05; } catch (e) {}
    }
    uiDirty();
  }

  function bindGuardian() {
    const v = document.querySelector('video');
    if (!v || v === guardedVideo) return;
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }   // 换播放器时清掉旧定时器
    guardedVideo = v;
    const arm = () => { if (!stallTimer) stallTimer = setTimeout(onStall, cfg.stallMs); };
    const disarm = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; } };
    v.addEventListener('waiting', arm);
    v.addEventListener('stalled', arm);
    ['playing', 'canplay', 'timeupdate', 'pause', 'seeking'].forEach(ev => v.addEventListener(ev, disarm));
    v.addEventListener('timeupdate', bgHeartbeat);   // 后台缓冲维持的心跳源
    v.addEventListener('playing', () => { if (state.activeCid) mark(state.activeCid, 'firstFrameAt'); });   // 逐P标记首帧（mark按cid幂等）
    // 播放器报错哨兵：媒体错误（黑屏/解码失败）时清除可能中毒的裁决，让重试从干净路由开始
    v.addEventListener('error', () => {
      const err = v.error;
      state.playerErrors = (state.playerErrors || 0) + 1;
      const cid = state.activeCid;
      if (cid && state.verdictByCid[cid]) {
        log('error', 'sys', `播放器媒体错误 code=${err ? err.code : '?'} → 清除本视频裁决 ${shortHost(state.verdictByCid[cid].host)}`);
        delete state.verdictByCid[cid];
        state.lastVerdict = null;
      } else {
        log('error', 'sys', `播放器媒体错误 code=${err ? err.code : '?'}`);
      }
    });
    log('info', 'sys', '卡顿哨兵已绑定播放器');
  }
  setInterval(bindGuardian, 1500);

  // ═══════════════ §8.5 后台播放保护 ═══════════════
  // 页面隐藏时浏览器停解视频轨并节流定时器，播放器补给停摆；音频经 Web Audio
  // 继续消耗缓冲，回前台即饥饿。对策：timeupdate 心跳（媒体驱动，不受节流）
  // 监视可播余量，低于阈值微跳帧促使补给；回前台进入恢复监护。

  const bg = { hidden: false, hiddenAt: 0, kicks: 0, lastKickAt: 0, lastBgFillAt: 0, watchIv: 0 };

  const realHidden = (() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    return (d && d.get) ? () => { try { return d.get.call(document); } catch (e) { return !!document.hidden; } }
                        : () => !!document.hidden;
  })();

  // 当前播放位置所在缓冲区的剩余可播时长（跨区间的空洞不计入）
  function playableAhead(v) {
    if (!v || !v.buffered || !v.buffered.length) return 0;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (t >= v.buffered.start(i) - 0.15 && t <= v.buffered.end(i) + 0.15) return Math.max(0, v.buffered.end(i) - t);
    }
    return 0;
  }

  function bgKick(reason, tag) {
    const v = guardedVideo || document.querySelector('video');
    if (!v || v.paused || v.seeking || v.ended) return false;
    const now = Date.now();
    if (now - bg.lastKickAt < 1200) return false;
    bg.lastKickAt = now;
    state.bgKicks++;
    try { v.currentTime = v.currentTime + 0.04; } catch (e) { return false; }
    log('warn', 'sys', `${tag}：${reason} → 微跳帧触发重新调度`);
    return true;
  }

  // 回到前台后的恢复监护：250ms 粒度检测饥饿，最多三次微跳帧
  function bgRecoveryWatch() {
    if (bg.watchIv) clearInterval(bg.watchIv);
    bg.kicks = 0;
    let n = 0;
    bg.watchIv = setInterval(() => {
      const v = guardedVideo || document.querySelector('video');
      if (!v || ++n > 40 || realHidden()) { clearInterval(bg.watchIv); bg.watchIv = 0; return; }
      if (v.paused || v.seeking || v.ended) return;
      const ahead = playableAhead(v);
      if ((v.readyState < 3 || ahead < 0.5) && bg.kicks < 3) {
        // 仅在跳帧真正执行时才计入配额：被 1.2s 限流吞掉的调用不应消耗重试预算
        if (bgKick(`播放器饥饿（readyState=${v.readyState}，可播 ${ahead.toFixed(1)}s）`, '前台恢复')) bg.kicks++;
      } else if (v.readyState >= 3 && ahead > 2) {
        clearInterval(bg.watchIv); bg.watchIv = 0;    // 已恢复，提前结束监护
      }
    }, 250);
  }

  document.addEventListener('visibilitychange', () => {
    const h = realHidden();
    if (h) { bg.hidden = true; bg.hiddenAt = Date.now(); return; }
    if (!bg.hidden) return;
    bg.hidden = false;
    const ms = bg.hiddenAt ? Date.now() - bg.hiddenAt : 0;
    state.bgLastHiddenMs = ms;
    if (!cfg.bgGuard || !cfg.enabled) return;
    state.bgRecoveries++;
    log('info', 'sys', `标签页回到前台（后台驻留 ${(ms / 1000).toFixed(0)}s）→ 启动恢复监护`);
    bgRecoveryWatch();
  }, true);

  // 后台缓冲维持：timeupdate 在后台仍持续触发
  function bgHeartbeat() {
    if (!cfg.bgGuard || !cfg.enabled || !bg.hidden) return;
    const v = guardedVideo;
    if (!v || v.paused || v.seeking || v.ended) return;
    const ahead = playableAhead(v);
    const now = Date.now();
    // 仅在濒临断流时介入：40ms 跳帧代价远小于一次重新缓冲
    if (ahead < 3 && now - bg.lastBgFillAt > 15000) {
      bg.lastBgFillAt = now;
      if (bgKick(`后台可播余量降至 ${ahead.toFixed(1)}s`, '后台补给')) state.bgRefills++;
    }
  }

  // ═══════════════ §9 手动测速 ═══════════════

  function currentMediaUrl() {
    try {
      const pi = window.__playinfo__;
      const roots = pi ? [pi.data, pi.result, pi.result && pi.result.video_info].filter(Boolean) : [];
      for (const r of roots) {
        const s = r.dash && r.dash.video && r.dash.video[0];
        if (s) return s.baseUrl || s.base_url;
        if (r.durl && r.durl[0] && r.durl[0].url) return r.durl[0].url;
      }
    } catch (e) {}
    return state.lastMediaUrl;   // playinfo 不可用时用最近一次媒体请求的 URL
  }

  // onStart(host) 在每个节点开测前回调，供界面标出正在测的节点
  async function runSpeedTest(sizeKB, onRow, onStart) {
    const src = currentMediaUrl();
    if (!src) throw new Error('视频开始加载后才能测速');
    const hosts = enabledHosts().map(p => p.host);
    const orig = new URL(src).hostname;
    if (!hosts.includes(orig)) hosts.unshift(orig);
    for (const h of hosts) {
      if (RE_AKAM.test(h) && h !== orig) { onRow({ host: h, ok: false, skip: '签名限制' }); continue; }
      if (onStart) onStart(h);
      const r = await probeHost(src, h, sizeKB, 8000);
      if (r.ok) healthSample(r.host, r.mbps, r.ttfb); else healthFail(r.host);
      onRow(r);
    }
  }

  // ═══════════════ §10 自动诊断引擎 ═══════════════

  function diagnose() {
    const out = [];
    const cid = state.activeCid;
    const add = (sev, title, detail, advice) => out.push({ sev, title, detail, advice });

    if (!cid) {
      add('info', '暂无视频', '视频开始加载后自动分析');
      return out;
    }
    const t = state.timeline[cid] || {};
    const verdict = state.verdictByCid[cid];
    const assigned = state.origHostByCid[cid];
    const reqs = state.reqLog.filter(r => r.cid === cid);
    const failsOnAssigned = reqs.filter(r => r.host === assigned &&
      (BAD_OUTCOMES.includes(r.outcome) || (String(r.outcome).startsWith('HTTP') && r.outcome !== 'HTTP 403'))).length;
    const sig403 = state.reqLog.filter(r => r.outcome === 'HTTP 403').length;
    const hedgeWins = reqs.filter(r => r.note === '对冲命中').length;

    if (state.playerErrors > 0) {
      add('crit', `播放器报错 ${state.playerErrors} 次`,
        '已重置本视频的线路，重试时重新选择；若同时出现 403，说明视频链接签名失效');
    }
    if (sig403 >= 3) {
      add('crit', `视频链接被拒绝 ${sig403} 次（HTTP 403）`,
        '链接签名已过期或与节点不匹配',
        '刷新页面即可恢复');
    }

    if (state.bootSource === 'sniff') {
      add('warn', '脚本加载偏晚',
        '未能在页面初始化时接管，起播可能变慢',
        'Tampermonkey → 设置 → 配置模式选「高级」→ 实验性 → 注入模式选「即时 (Instant)」');
    } else if (state.bootSource === 'trap-existing') {
      add('info', '脚本加载偏晚（本次播放不受影响）', '可将 Tampermonkey 注入模式设为「即时 (Instant)」');
    }

    if (state.blindMode) {
      add('warn', '部分视频请求未经 BiliBoost',
        '播放器可能在后台线程加载视频，已改用备用线路与卡顿监测兜底');
    }
    if (verdict && verdict.host !== assigned) {
      add('ok', `已切换至 ${hostLabel(verdict.host)}`,
        `${verdict.why}；原调度节点 ${hostLabel(assigned)} 保留为备选`);
    }
    const aH = health[assigned];
    if (aH && (aH.ok + aH.fail) > 10 && aH.fail / (aH.ok + aH.fail) > 0.3) {
      add('warn', `调度节点失败率 ${Math.round(aH.fail / (aH.ok + aH.fail) * 100)}%`,
        `${hostLabel(assigned)} 成功 ${aH.ok} 次、失败 ${aH.fail} 次，已降低其优先级`);
    }
    if (state.bgRecoveries > 0) {
      const kicked = state.bgKicks > 0;
      add(kicked ? 'ok' : 'info', `后台播放保护：切回 ${state.bgRecoveries} 次`,
        `最近一次在后台 ${(state.bgLastHiddenMs / 1000).toFixed(0)} 秒，` +
        (kicked
          ? `重新调度 ${state.bgKicks} 次，后台补充缓冲 ${state.bgRefills} 次`
          : '切回时缓冲充足，无需处理'));
    }
    if (state.msLoads > 0) {
      add('ok', `多源并行加载 ${state.msLoads} 次`,
        `共 ${state.msParts} 个分片，其中 ${state.msHoleFills} 个由其他节点补齐；` +
        `${laneCount()} 路（${cfg.msSplit === 'fixed' ? '固定路数' : '按分片大小'}），每个节点最多 ${perHostLimit()} 个连接`);
    }
    const probeR = state.probeInfoByCid[cid];
    const burst = probeR && probeR.find(r => r.ok && r.deepMbps != null && r.headMbps / Math.max(0.1, r.deepMbps) > 5);
    if (burst) {
      add('warn', `${hostLabel(burst.host)} 后段加载缓慢`,
        `开头 ${burst.headMbps} Mbps，后段仅 ${burst.deepMbps} Mbps，已按后段速度评估`);
    }

    if (t.firstFrameAt != null) {
      const boot = Math.round(t.firstFrameAt - t.t0);
      const probeCost = t.probeEnd && t.probeStart ? Math.round(t.probeEnd - t.probeStart) : null;
      const waitCost = t.firstOkAt && t.firstReqAt ? Math.round(t.firstOkAt - t.firstReqAt) : null;
      const parts = [];
      if (probeCost != null) parts.push(`测速 ${probeCost} ms`);
      if (waitCost != null) parts.push(`等待首个分片 ${waitCost} ms`);
      if (boot > 6000) {
        add('crit', `起播较慢：${(boot / 1000).toFixed(1)} 秒`,
          parts.join('，'),
          '可在设置中调低「首字节超时」与「对冲延迟」');
      } else if (boot > 3000) {
        add('warn', `起播 ${(boot / 1000).toFixed(1)} 秒`, parts.join('，'));
      } else {
        add('ok', `起播 ${(boot / 1000).toFixed(1)} 秒`, parts.join('，') || '各阶段均无明显等待');
      }
    } else if (t.firstReqAt != null && performance.now() - t.firstReqAt > 6000) {
      add('crit', '视频尚未开始播放', '已发出加载请求，但画面还没出来；详见请求记录');
    }

    if (failsOnAssigned >= 2) {
      add('crit', `调度节点加载失败 ${failsOnAssigned} 次`,
        `${hostLabel(assigned)} 未缓存该视频，` +
        (verdict && verdict.host !== assigned ? `已切换至 ${hostLabel(verdict.host)}` : '正在尝试其他节点'));
    } else if (verdict && verdict.host === assigned && state.stalls === 0 && failsOnAssigned === 0) {
      add('ok', '调度节点状态良好', `${hostLabel(assigned)} 速度达标，保持不变`);
    }

    if (hedgeWins > 0) {
      add('ok', `对冲请求命中 ${hedgeWins} 次`,
        '主节点响应慢时，由备用节点抢先返回');
    }

    if (state.stalls > 0) {
      add('warn', `卡顿熔断 ${state.stalls} 次`,
        `播放停滞超过 ${cfg.stallMs / 1000} 秒会自动换节点；换节点后仍频繁卡顿，通常是整体网络拥塞`);
    }

    if (t.warmUpgradeAt != null) {
      add('ok', '预热完成，已切到主力节点',
        `第 ${Math.round((t.warmUpgradeAt - t.t0) / 1000)} 秒起由 ${hostLabel(PREMIUM)} 供给`);
    } else if (cid && state.warmTimers[cid]) {
      add('info', '正在预热主力节点', '就绪后自动切换');
    }

    const withData = enabledHosts().filter(p => p.coldReliable)
      .map(p => health[p.host]).filter(h => h && h.ok > 0 && h.mbps > 0);
    const allSlow = withData.length >= 2 && withData.every(h => h.mbps < 3);
    if (allSlow) {
      add('warn', '所有节点都低于 3 Mbps',
        '可能是跨境线路拥塞或本地网络受限，切换节点帮助有限');
    }
    if (!out.length) {
      add('info', '未发现异常', '出现卡顿时，这里会给出分析');
    }
    return out;
  }

  function buildDiagReport() {
    const cid = state.activeCid;
    const t = (cid && state.timeline[cid]) || {};
    const lines = [];
    lines.push(`BiliBoost 诊断报告 v${VERSION}  ${new Date().toLocaleString()}`);
    lines.push(`页面: ${location.href}`);
    lines.push(`引导来源: ${state.bootSource || '未激活'} | 模式: ${cfg.mode} | cid: ${cid || '-'}`);
    lines.push(`调度节点: ${cid ? state.origHostByCid[cid] : '-'} | 当前裁决: ${cid && state.verdictByCid[cid] ? state.verdictByCid[cid].host + ' (' + state.verdictByCid[cid].why + ')' : '-'}`);
    lines.push(`计数: 重写${state.rewrites} 回退${state.fallbacks} 对冲命中${state.hedgeWins} 熔断${state.stalls}`);
    lines.push('--- 自动诊断 ---');
    diagnose().forEach(d => lines.push(`[${d.sev}] ${d.title} — ${d.detail}${d.advice ? ' 建议: ' + d.advice : ''}`));
    lines.push('--- 时间线(ms, 相对本视频注册) ---');
    Object.entries(t).forEach(([k, v]) => { if (typeof v === 'number' && k !== 't0') lines.push(`${k}: ${Math.round(v - t.t0)}`); });
    lines.push('--- 最近请求 ---');
    state.reqLog.slice(-40).forEach(r =>
      lines.push(`${fmtClock(r.t)} ${shortHost(r.host)} ${r.note || '-'} ${r.outcome} ttfb=${r.ttfb}ms ${r.kb}KB ${r.mbps || '-'}Mbps`));
    lines.push('--- 事件日志 ---');
    state.log.slice(-60).forEach(l => lines.push(`${fmtClock(l.t)} [${l.level}/${l.tag}] ${l.msg}`));
    lines.push('--- 节点档案 ---');
    Object.entries(health).forEach(([h, v]) => lines.push(`${h}: ${v.mbps}Mbps(低位${v.mbpsLow || '-'}) ttfb${v.ttfb}ms 成${v.ok}/败${v.fail}`));
    return lines.join('\n');
  }

  // ═══════════════ §11 UI ═══════════════
  // 常驻胶囊显示实时吞吐，点开即面板：概览 / 节点 / 诊断 / 设置。
  // 界面挂在 Shadow DOM 里，与页面样式互不干扰；深浅色跟随页面。

  const VIEWS = [['overview', '概览'], ['nodes', '节点'], ['diag', '诊断'], ['settings', '设置']];
  const MODE_NAME = { auto: '自适应', smart: '轻量', force: '锁定' };
  const MODE_DESC = {
    auto: '逐个视频测速选路，多节点并行加载',
    smart: '只替换 PCDN、MCDN 与黑名单节点',
    force: '所有视频请求都走所选节点',
  };
  const ACCENTS = [['#00aeec', '哔哩蓝'], ['#ff6699', '哔哩粉'], ['#17a05d', '绿'], ['#f08a24', '橙'], ['ink', '墨']];
  const TEST_SIZES = [[512, '512K'], [1024, '1M'], [2048, '2M'], [5120, '5M']];
  const LOG_TAGS = [['all', '全部类型'], ['route', '路由'], ['net', '网络'], ['probe', '探测'],
                    ['stall', '熔断'], ['warm', '预热'], ['sys', '系统']];
  const SEV_RANK = { crit: 0, warn: 1, ok: 2, info: 3 };
  const PANEL_W = 360, GAP = 8, EDGE = 12;

  // 节点色：常用节点固定色位，其余按主机名散列；色值在 CSS 里按深浅色各定义一套
  const NODE_SLOT = {
    'upos-sz-mirrorcosov.bilivideo.com': 0, 'upos-sz-mirrorali.bilivideo.com': 1,
    'upos-sz-mirrorhw.bilivideo.com': 2,    'upos-sz-mirrorcos.bilivideo.com': 3,
    'upos-sz-mirror08c.bilivideo.com': 4,   'upos-tf-all-tx.bilivideo.com': 5,
    'upos-tf-all-hw.bilivideo.com': 6,
  };
  function nodeVar(host) {
    const h = String(host || '');
    let i = NODE_SLOT[h];
    if (i == null) {
      let s = 2166136261;
      for (let k = 0; k < h.length; k++) { s ^= h.charCodeAt(k); s = Math.imul(s, 16777619) >>> 0; }
      i = RE_AKAM.test(h) ? 7 : 8 + (s % 2);
    }
    return `var(--n${i})`;
  }
  function nodeName(host) {
    const p = poolHosts().find(x => x.host === host);
    const parts = String(p ? p.label : '调度分配').split('·');
    return { name: parts[0], region: parts[1] || '' };
  }
  const fmtRate = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
  const fmtDur = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
  const pct = (v, lo, hi) => Math.min(100, Math.max(0, (v - lo) / (hi - lo) * 100)).toFixed(1);
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function css() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.bb {
  --acc: #00aeec; --on-acc: #fff;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
  --num: "Bahnschrift", -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --out: cubic-bezier(.16, 1, .3, 1);
  font: 12px/1.5 var(--font); color: var(--ink);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
.bb[data-theme="light"] {
  --bg: #ffffff; --bg-2: #f4f5f7; --bg-3: #e9ebee;
  --ink: #18191c; --ink-2: #61666d; --ink-3: #9499a0;
  --line: #eceef1; --edge: rgba(0,0,0,.08);
  --track: #eaecef; --bar: #cfd3d9; --sw-off: #dcdfe3; --sel: #ffffff;
  --ok: #17a05d; --warn: #e39a0f; --err: #e5484d; --warn-ink: #b37500;
  --warn-bg: #fdf5e4; --err-bg: #fdecec;
  --cap-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 2px 4px rgba(0,0,0,.04), 0 6px 16px rgba(0,0,0,.08);
  --cap-shadow-h: 0 0 0 1px rgba(0,0,0,.07), 0 3px 6px rgba(0,0,0,.05), 0 10px 24px rgba(0,0,0,.12);
  --pnl-shadow: drop-shadow(0 12px 32px rgba(0,0,0,.13)) drop-shadow(0 2px 6px rgba(0,0,0,.06));
  --sel-shadow: 0 1px 2px rgba(0,0,0,.1), 0 0 0 .5px rgba(0,0,0,.05);
  --n0: #16a09a; --n1: #de8a14; --n2: #e25a42; --n3: #3f73dc; --n4: #4f9b2f;
  --n5: #9658c8; --n6: #d6508a; --n7: #a17c35; --n8: #6c7a8c; --n9: #1a90b4;
}
.bb[data-theme="dark"] {
  --bg: #1f2023; --bg-2: #2a2b2f; --bg-3: #34363a;
  --ink: #e7e8ea; --ink-2: #a3a7ad; --ink-3: #6f737a;
  --line: #2e3034; --edge: rgba(255,255,255,.07);
  --track: #34363b; --bar: #4c5058; --sw-off: #43464c; --sel: #3d3f44;
  --ok: #3cc47c; --warn: #f0ae3c; --err: #ff6b6b; --warn-ink: #f0ae3c;
  --warn-bg: rgba(240,174,60,.1); --err-bg: rgba(255,107,107,.1);
  --cap-shadow: 0 0 0 1px rgba(255,255,255,.07), 0 6px 18px rgba(0,0,0,.45);
  --cap-shadow-h: 0 0 0 1px rgba(255,255,255,.1), 0 10px 26px rgba(0,0,0,.55);
  --pnl-shadow: drop-shadow(0 16px 36px rgba(0,0,0,.5)) drop-shadow(0 2px 6px rgba(0,0,0,.3));
  --sel-shadow: 0 1px 2px rgba(0,0,0,.4);
  --n0: #3bc2b8; --n1: #f0a53a; --n2: #f47c64; --n3: #7299f2; --n4: #76bd55;
  --n5: #b688e2; --n6: #ec7ca6; --n7: #c9a45e; --n8: #9aa6b5; --n9: #4cb7d8;
}
.bb.gone { display: none; }
button { font: inherit; color: inherit; margin: 0; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
.mut { color: var(--ink-3); }
.bad { color: var(--err); }
.mono { font-family: var(--mono); }

/* ─── 胶囊 ─── */
.cap { position: fixed; z-index: 2; display: flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 12px 0 11px; border-radius: 16px;
  background: var(--bg); color: var(--ink); box-shadow: var(--cap-shadow);
  cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none;
  transition: box-shadow .2s var(--ease), transform .18s var(--ease), background-color .2s; }
.cap:hover { box-shadow: var(--cap-shadow-h); }
.cap:active { transform: scale(.96); }
.cap.dragging { cursor: grabbing; transform: scale(1.04); box-shadow: var(--cap-shadow-h); transition: none; }
.cap[aria-expanded="true"] { background: var(--bg-2); }
.cap-lanes { display: flex; gap: 2px; height: 12px; }
.cap-lanes:empty { display: none; }
.cap-lanes i { position: relative; width: 2px; border-radius: 1px; overflow: hidden; background: var(--track); }
.cap-lanes i::after { content: ''; position: absolute; inset: 0; background: var(--ink-2);
  transform: scaleY(var(--p, 0)); transform-origin: 50% 100%; transition: transform .14s linear; }
.cap-lanes i[data-f="1"]::after { background: var(--err); }
.cap-val { min-width: 24px; text-align: right; font: 600 13px/1 var(--num); font-variant-numeric: tabular-nums; }
.cap-unit { margin-left: -3px; font-size: 10px; line-height: 1; color: var(--ink-3); }
.cap[data-st="off"] .cap-val { min-width: 0; font: 500 12px/1 var(--font); color: var(--ink-3); }
.cap-dot { position: absolute; top: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--bg); background: var(--warn); transform: scale(0);
  transition: transform .25s var(--out), background-color .2s; }
.cap[data-st="warn"] .cap-dot { transform: scale(1); }
.cap[data-st="err"] .cap-dot { transform: scale(1); background: var(--err); }
.cap[aria-expanded="true"] .cap-dot { border-color: var(--bg-2); }

/* ─── 面板 ─── */
.pnl { position: fixed; z-index: 1; width: ${PANEL_W}px; filter: var(--pnl-shadow);
  visibility: hidden; pointer-events: none; }
.pnl[data-open="1"] { visibility: visible; pointer-events: auto; }
.pnl-in { display: flex; flex-direction: column; overflow: hidden; border-radius: 14px;
  background: var(--bg); border: 1px solid var(--edge); }
.hd { position: relative; display: flex; align-items: center; flex: none; height: 46px;
  padding: 0 14px 0 6px; border-bottom: 1px solid var(--line); }
.tabs { position: relative; display: flex; align-self: stretch; }
.tabs button { height: 100%; padding: 0 10px; border: 0; background: none; cursor: pointer;
  font-size: 13px; color: var(--ink-3); transition: color .15s; }
.tabs button:hover { color: var(--ink-2); }
.tabs button[aria-selected="true"] { color: var(--ink); }
.tabs button:focus-visible { outline-offset: -6px; border-radius: 8px; }
.tab-ind { position: absolute; left: 0; bottom: -1px; height: 2px; width: 0; border-radius: 1px;
  background: var(--ink); transition: transform .32s var(--out), width .32s var(--out); }

.bd { flex: 1 1 auto; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  transition: height .28s var(--out); scrollbar-width: thin; scrollbar-color: var(--bg-3) transparent; }
.bd.snap { transition: none; }
.bd::-webkit-scrollbar { width: 8px; }
.bd::-webkit-scrollbar-thumb { background: var(--bg-3); border-radius: 4px; border: 2px solid var(--bg); }
.vw { padding: 16px; }
.vw.enter { animation: vwIn .24s var(--out) both; }
@keyframes vwIn { from { opacity: 0; transform: translateY(4px); } }

/* ─── 控件 ─── */
.sw { position: relative; flex: none; width: 30px; height: 18px; padding: 0; border: 0; border-radius: 9px;
  cursor: pointer; background: var(--sw-off); transition: background-color .2s var(--ease); }
.sw > i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .26s var(--out); }
.sw[aria-checked="true"] { background: var(--acc); }
.sw[aria-checked="true"] > i { transform: translateX(12px); }

.seg { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 2px;
  border-radius: 8px; background: var(--bg-2); }
.seg button { position: relative; z-index: 1; min-width: 0; height: 26px; padding: 0 10px;
  border: 0; border-radius: 6px; background: none; cursor: pointer; white-space: nowrap;
  font-size: 12px; color: var(--ink-2); transition: color .15s; }
.seg button:hover { color: var(--ink); }
.seg button[aria-checked="true"] { color: var(--ink); }
.seg button:focus-visible { outline-offset: -2px; }
.seg .ind { position: absolute; z-index: 0; top: 2px; bottom: 2px; left: 2px; border-radius: 6px;
  width: calc((100% - 4px) / var(--n, 1)); transform: translateX(calc(var(--i, 0) * 100%));
  background: var(--sel); box-shadow: var(--sel-shadow); transition: transform .3s var(--out); }
.seg.sm button { height: 22px; font-size: 11.5px; padding: 0 7px; }

.btn, .btn-2 { flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: 7px; cursor: pointer;
  font-size: 12px; white-space: nowrap; transition: background-color .15s, filter .15s, transform .12s; }
.btn { background: var(--acc); color: var(--on-acc); font-weight: 500; }
.btn:hover { filter: brightness(1.07); }
.btn-2 { background: var(--bg-2); color: var(--ink); }
.btn-2:hover { background: var(--bg-3); }
.btn:active, .btn-2:active { transform: scale(.97); }
.btn:disabled { background: var(--bg-2); color: var(--ink-3); cursor: default; filter: none; transform: none; }
.btn.sm, .btn-2.sm { height: 24px; padding: 0 10px; font-size: 11.5px; }
.link { flex: none; padding: 0; border: 0; background: none; cursor: pointer; font-size: 12px; color: var(--ink-2); }
.link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.link.danger { color: var(--err); }

input[type=text], textarea, select { width: 100%; padding: 6px 9px; border: 1px solid transparent; border-radius: 7px;
  outline: none; background: var(--bg-2); color: var(--ink); font: 12px/1.45 var(--font);
  transition: border-color .15s, background-color .15s; }
input[type=text]:focus, textarea:focus, select:focus { border-color: var(--acc); background: var(--bg); }
input[type=text]::placeholder, textarea::placeholder { color: var(--ink-3); }
input.bad { border-color: var(--err); }
textarea { display: block; resize: vertical; font: 11px/1.55 var(--mono); }
.sel { position: relative; display: block; }
.sel select { appearance: none; -webkit-appearance: none; padding-right: 26px; cursor: pointer; }
.sel::after { content: ''; position: absolute; right: 11px; top: 50%; width: 5px; height: 5px; margin-top: -4px;
  border-right: 1.5px solid var(--ink-3); border-bottom: 1.5px solid var(--ink-3); transform: rotate(45deg); pointer-events: none; }
select option { background: var(--bg); color: var(--ink); }

input[type=range] { -webkit-appearance: none; appearance: none; flex: 1 1 auto; min-width: 0; height: 18px;
  margin: 0; background: none; cursor: pointer; }
input[type=range]::-webkit-slider-runnable-track { height: 2px; border-radius: 1px;
  background: linear-gradient(to right, var(--acc) var(--p, 0%), var(--track) var(--p, 0%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -6px;
  border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.22);
  transition: transform .15s var(--ease); }
input[type=range]:hover::-webkit-slider-thumb { transform: scale(1.12); }
input[type=range]::-moz-range-track { height: 2px; border-radius: 1px; background: var(--track); }
input[type=range]::-moz-range-progress { height: 2px; border-radius: 1px; background: var(--acc); }
input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.22); }

.fold-h { display: flex; align-items: center; gap: 8px; width: 100%; height: 26px; padding: 0; border: 0;
  background: none; cursor: pointer; font-size: 12px; color: var(--ink-2); text-align: left; }
.fold-h:hover { color: var(--ink); }
.fold-h .n { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.chev { margin-left: auto; width: 6px; height: 6px; border-right: 1.5px solid var(--ink-3); border-bottom: 1.5px solid var(--ink-3);
  transform: translateY(-1px) rotate(-45deg); transition: transform .22s var(--out); }
.fold[data-open="1"] .chev { transform: translateY(-2px) rotate(45deg); }
.fold-b { display: none; padding-top: 10px; }
.fold[data-open="1"] > .fold-b { display: block; animation: vwIn .22s var(--out) both; }
.empty { padding: 10px 0; color: var(--ink-3); font-size: 12px; }

/* ─── 概览 ─── */
.ov-off { display: none; padding: 26px 0 18px; text-align: center; }
.ov-off b { display: block; font-size: 15px; font-weight: 600; }
.ov-off p { margin: 4px 0 16px; color: var(--ink-3); }
.ov[data-off="1"] .ov-off { display: block; }
.ov[data-off="1"] .ov-on { display: none; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.hero-rate { display: flex; align-items: baseline; min-width: 0; }
.hero-rate b { font: 300 42px/.86 var(--num); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.hero-rate span { margin-left: 6px; font-size: 12px; color: var(--ink-3); }
.hero-buf { flex: none; text-align: right; }
.hero-buf b { display: block; font: 400 18px/1.1 var(--num); font-variant-numeric: tabular-nums; transition: color .3s; }
.hero-buf b small { margin-left: 2px; font: 11px var(--font); color: var(--ink-3); }
.hero-buf span { font-size: 11px; color: var(--ink-3); }
.hero-buf[data-low="1"] b { color: var(--warn-ink); }
.chart { position: relative; height: 58px; margin-top: 16px; }
.chart canvas { display: block; width: 100%; height: 100%; }
.chart-max { position: absolute; left: 0; top: -3px; font-size: 10px; line-height: 1; color: var(--ink-3);
  font-variant-numeric: tabular-nums; pointer-events: none; }
.asm { margin-top: 18px; }
.asm-h { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px;
  font-size: 12px; color: var(--ink-2); }
.asm-h span + span { font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.strip { display: flex; gap: 3px; height: 6px; }
.part { position: relative; flex: 1 1 0; min-width: 0; overflow: hidden; border-radius: 3px; background: var(--track); }
.part > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px; background: var(--c, var(--ink-3));
  transition: width .14s linear, background-color .3s, opacity .4s; }
.part::after { content: ''; position: absolute; inset: 0; border-radius: inherit; opacity: 0; pointer-events: none;
  background: repeating-linear-gradient(-45deg, var(--err) 0 2px, transparent 2px 5px); transition: opacity .5s; }
.part.retry::after, .part[data-s="fail"]::after { opacity: .6; transition-duration: .1s; }
.part[data-s="done"] > i { width: 100%; }
.asm[data-idle="1"] .part > i { opacity: .55; }
.strip-lb { display: flex; gap: 3px; margin-top: 6px; }
.strip-lb span { flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: 10.5px/1.2 var(--mono); color: var(--ink-3); }
.strip-lb[data-dense="1"] { display: none; }
.route { display: flex; align-items: flex-start; gap: 12px; margin-top: 18px; padding-top: 12px;
  border-top: 1px solid var(--line); }
.route .k { flex: none; font-size: 12px; color: var(--ink-3); }
.route .v { min-width: 0; margin-left: auto; text-align: right; }
.route-main { display: flex; align-items: center; justify-content: flex-end; gap: 6px;
  font: 12px/1.4 var(--mono); color: var(--ink); }
.route-main .sq { width: 7px; height: 7px; border-radius: 2px; background: var(--c); flex: none; }
.route-main .to { color: var(--ink-3); font-family: var(--font); }
.route-why { margin-top: 2px; font-size: 11px; color: var(--ink-3); }
.note { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 14px; padding: 9px 11px;
  border: 0; border-radius: 8px; background: var(--warn-bg); cursor: pointer; text-align: left; font-size: 12px; color: var(--ink); }
.note > i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
.note em { margin-left: auto; font-style: normal; color: var(--ink-3); white-space: nowrap; }
.note:hover em { color: var(--ink); }
.note[data-st="err"] { background: var(--err-bg); }
.note[data-st="err"] > i { background: var(--err); }

/* ─── 节点 ─── */
.tools { display: flex; align-items: center; gap: 10px; }
.tools > span { font-size: 12px; color: var(--ink-3); }
.tools .btn { margin-left: auto; }
.nlist { margin-top: 8px; }
.nrow { position: relative; border-top: 1px solid var(--line); }
.nrow:first-child { border-top: 0; }
.nrow-main { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 9px 0; border: 0;
  background: none; cursor: pointer; text-align: left; }
.nrow-main:focus-visible { outline-offset: -2px; border-radius: 6px; }
.ndot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); transition: background-color .3s, box-shadow .3s; }
.ndot[data-act="0"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--c); }
.nrow-id { flex: 1 1 auto; min-width: 0; }
.nrow-name { display: block; font-size: 13px; color: var(--ink); }
.nrow-name span { margin-left: 6px; font-size: 11px; color: var(--ink-3); }
.nrow-meta { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  margin-top: 1px; font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.nrow-rate { flex: none; text-align: right; line-height: 1.15; }
.nrow-rate b { font: 500 15px/1 var(--num); font-variant-numeric: tabular-nums; }
.nrow-rate small { margin-left: 3px; font-size: 10px; color: var(--ink-3); }
.nrow-rate em { display: block; margin-top: 3px; font-style: normal; font-size: 10.5px; color: var(--ok); }
.nrow-rate .bad { font-size: 12px; }
.nrow[data-off="1"] .nrow-main { opacity: .45; }
.nrow-more { display: none; padding: 0 0 12px 18px; }
.nrow[data-open="1"] .nrow-more { display: block; animation: vwIn .22s var(--out) both; }
.nrow-host { font: 11px/1.4 var(--mono); color: var(--ink-2); user-select: text; -webkit-user-select: text; word-break: break-all; }
.kv { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; margin: 10px 0 0; }
.kv div { min-width: 0; }
.kv dt { font-size: 11px; color: var(--ink-3); }
.kv dd { margin: 0; font-size: 12px; color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.acts { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.nrow-prog { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; display: none; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--acc), transparent) no-repeat; background-size: 36% 100%;
  animation: prog 1.1s linear infinite; }
.nrow[data-testing="1"] .nrow-prog { display: block; }
@keyframes prog { from { background-position: -60% 0; } to { background-position: 160% 0; } }
.add { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.foot-row { display: flex; align-items: center; gap: 12px; min-height: 20px; margin-top: 10px; }
.foot-row .link { margin-left: auto; }
.msg { font-size: 11.5px; color: var(--ink-3); }
.msg.bad { color: var(--err); }

/* ─── 诊断 ─── */
.dg-top { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.dg-sum { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11.5px; color: var(--ink-3); }
.dg-top .btn { margin-left: auto; }
.find { display: flex; gap: 10px; padding: 11px 0; border-top: 1px solid var(--line); }
.find:first-child { padding-top: 0; border-top: 0; }
.find > i { flex: none; width: 6px; height: 6px; margin-top: 7px; border-radius: 50%; background: var(--ink-3); }
.find[data-sev="ok"] > i { background: var(--ok); }
.find[data-sev="warn"] > i { background: var(--warn); }
.find[data-sev="crit"] > i { background: var(--err); }
.find-c { min-width: 0; }
.find-t { font-size: 13px; color: var(--ink); }
.find-d { margin-top: 2px; font-size: 12px; color: var(--ink-2); }
.find-a { margin-top: 7px; padding: 7px 10px; border-radius: 7px; background: var(--bg-2); font-size: 12px; color: var(--ink); }
.sec { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.sec > h3 { margin: 0 0 8px; font-size: 12px; font-weight: 400; color: var(--ink-2); }
.tl-row { display: grid; grid-template-columns: 58px minmax(0, 1fr) 52px; align-items: center; gap: 10px; height: 22px; font-size: 11.5px; }
.tl-k { color: var(--ink-2); white-space: nowrap; }
.tl-bar { position: relative; height: 2px; border-radius: 1px; background: var(--track); }
.tl-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 1px; background: var(--bar); }
.tl-bar i::after { content: ''; position: absolute; right: -3px; top: -2px; width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.tl-v { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
table.rq { width: 100%; border-collapse: collapse; font: 11px/1.4 var(--mono); }
.rq th { padding: 0 4px 6px; text-align: left; font: 11px var(--font); color: var(--ink-3); }
.rq td { padding: 5px 4px; border-top: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
.rq th:first-child, .rq td:first-child { padding-left: 0; }
.rq th:last-child, .rq td:last-child { padding-right: 0; }
.rq .r { text-align: right; }
.rq .sq { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 1.5px; background: var(--c); vertical-align: 1px; }
.rq .nt { margin-left: 5px; font: 10.5px var(--font); color: var(--ink-3); }
.log-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.log-tools .sel { flex: 0 1 120px; }
.log-tools select { padding-top: 4px; padding-bottom: 4px; }
.chip { flex: none; height: 24px; padding: 0 9px; border: 0; border-radius: 12px; background: var(--bg-2); cursor: pointer;
  font-size: 11.5px; color: var(--ink-2); transition: background-color .15s, color .15s; }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); }
.log-tools .link:first-of-type { margin-left: auto; }
.log { font: 11px/1.6 var(--mono); }
.log > div { display: flex; gap: 8px; padding: 1px 0; }
.log .tm { flex: none; color: var(--ink-3); }
.log .mg { min-width: 0; color: var(--ink-2); word-break: break-all; }
.log .warn .mg { color: var(--warn-ink); }
.log .error .mg { color: var(--err); }

/* ─── 设置 ─── */
.ss { padding: 12px 0; border-top: 1px solid var(--line); }
.ss:first-child { padding-top: 0; border-top: 0; }
.ss-h { margin-bottom: 8px; font-size: 12px; color: var(--ink-3); }
.ss-cap { margin: 8px 0 0; font-size: 11.5px; color: var(--ink-3); }
.row { display: flex; align-items: center; gap: 12px; min-height: 32px; }
.row > .lb { flex: none; font-size: 13px; color: var(--ink); cursor: default; }
.row > .ctl { display: flex; align-items: center; gap: 10px; min-width: 0; margin-left: auto; }
.row.sld > .lb { width: 84px; white-space: nowrap; }
.row.col { flex-direction: column; align-items: stretch; gap: 6px; padding: 4px 0; }
.sld-v { flex: none; width: 50px; text-align: right; font-size: 12px; color: var(--ink); font-variant-numeric: tabular-nums; }
.sub { margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--line); transition: opacity .2s; }
.sub .row > .lb { font-size: 12px; color: var(--ink-2); }
.sub .row.sld > .lb { width: 59px; }
.sub[data-off="1"] { opacity: .38; pointer-events: none; }
.row .sel { width: 188px; }
.modebox:not([data-mode="auto"]) .m-auto,
.modebox[data-mode="auto"] .m-pin,
.modebox:not([data-mode="smart"]) .m-smart { display: none; }
.adv[data-split="size"] .m-fixed, .adv[data-split="fixed"] .m-size { display: none; }
.sws { display: flex; align-items: center; gap: 9px; }
.swc { position: relative; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: var(--c); box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
.swc::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--ink-2);
  opacity: 0; transform: scale(.8); transition: opacity .2s, transform .25s var(--out); }
.swc[aria-checked="true"]::after { opacity: 1; transform: none; }
.swc.custom { overflow: visible; background: conic-gradient(#f66, #fc4, #6d6, #4cf, #86f, #f6c, #f66); }
.swc.custom[data-set="1"] { background: var(--c); }
.swc.custom input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
.io { margin-top: 8px; }
.foot { padding-top: 14px; text-align: center; font-size: 11px; color: var(--ink-3); }

@media (prefers-reduced-motion: reduce) {
  .bb *, .bb *::before, .bb *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
  }

  // ═══ UI 运行时状态 ═══
  let ui = null, activeView = 'overview', rafId = 0, uiRefreshQueued = 0;
  let heroShown = 0, chartMax = 8, lastLanes = null, lastLanesCid = null, stripSig = '';
  let testSize = 2048, testing = null, expandedNode = null;
  const testResults = {};
  const diagFold = { reqs: false, logs: false };
  const logFilter = { tag: 'all', onlyProblem: false };

  const isOpen = () => !!(ui && ui.open);
  function panelHasFocusedInput() {
    const ae = ui && ui.root.activeElement;
    return !!(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  }

  // 近 3 秒平均吞吐：分片按完成时刻计量，逐秒值起伏大，显示用平均值
  function recentMbps() {
    const w = state.bytesWindow, k = Math.min(3, w.length);
    if (!k) return 0;
    let b = 0;
    for (let i = w.length - k; i < w.length; i++) b += w[i].bytes;
    return b * 8 / 1e6 / k;
  }

  // 胶囊状态只反映影响观看的事件：播放器报错（60 秒内）→ err；卡顿熔断（30 秒内）或流量盲区 → warn
  function statusInfo() {
    if (!cfg.enabled) return { st: 'off' };
    const now = Date.now();
    for (let i = state.log.length - 1; i >= 0 && now - state.log[i].t < 60000; i--) {
      if (state.log[i].level === 'error') return { st: 'err', msg: '播放器报错，已重置本视频的线路' };
    }
    for (let i = state.log.length - 1; i >= 0 && now - state.log[i].t < 30000; i--) {
      if (state.log[i].tag === 'stall') return { st: 'warn', msg: '刚刚出现卡顿，已自动切换节点' };
    }
    if (state.blindMode) return { st: 'warn', msg: '部分视频请求未经 BiliBoost，已启用备用线路' };
    return { st: 'ok' };
  }

  const engineOn = () => cfg.enabled && cfg.multiSource && cfg.mode === 'auto';

  function refreshCap() {
    if (!ui) return;
    const c = ui.cap, s = statusInfo();
    c.setAttribute('data-st', s.st);
    const v = recentMbps();
    ui.capVal.textContent = !cfg.enabled ? '已停用' : (v >= 0.05 ? fmtRate(v) : '—');
    ui.capUnit.hidden = !cfg.enabled;
    const n = engineOn() ? Math.min(6, laneCount()) : 0;
    if (ui.capLanes.children.length !== n) ui.capLanes.innerHTML = '<i></i>'.repeat(n);
    c.title = `BiliBoost · ${cfg.enabled ? MODE_NAME[cfg.mode] + '模式' : '已停用'}`;
  }

  // 胶囊里的小竖条 = 当前装载的各路进度
  function syncCapLanes() {
    const bars = ui.capLanes.children, lanes = state.msLanes || [];
    for (let i = 0; i < bars.length; i++) {
      const l = lanes[i];
      const p = !l ? '0' : (l.done ? '1' : (l.span > 0 ? Math.min(1, l.bytes / l.span) : 0).toFixed(2));
      if (bars[i]._p !== p) { bars[i]._p = p; bars[i].style.setProperty('--p', p); }
      const f = l && l.failed ? '1' : '0';
      if (bars[i]._f !== f) { bars[i]._f = f; bars[i].setAttribute('data-f', f); }
    }
  }

  function frame() {
    syncCapLanes();
    if (isOpen() && activeView === 'overview' && cfg.enabled) { tweenHero(); drawChart(); syncStrip(); }
  }

  // 仅在概览打开或有装载在途时跑逐帧循环；装载结束后多跑一帧把胶囊归零
  function startRaf() {
    if (rafId || !ui) return;
    const loop = () => {
      rafId = 0;
      const live = !!(state.msLanes && state.msLanes.length);
      const watching = isOpen() && activeView === 'overview' && cfg.enabled;
      if (!watching && !live && !ui.capBusy) return;
      ui.capBusy = live;
      frame();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function uiLive() { if (ui) startRaf(); }

  function uiDirty() {
    if (!ui || uiRefreshQueued) return;
    uiRefreshQueued = setTimeout(() => {
      uiRefreshQueued = 0;
      refreshCap();
      if (isOpen()) syncView();
    }, 400);
  }
  function uiTick() {
    if (!ui) return;
    applyTheme();
    refreshCap();
    updateFullscreenVisibility();
    if (isOpen()) syncView();
  }

  function updateFullscreenVisibility() {
    let hide = !!document.fullscreenElement;
    if (!hide) {
      const c = document.querySelector('.bpx-player-container');
      const s = c && c.getAttribute('data-screen');
      hide = s === 'web' || s === 'full';
    }
    if (hide === !!ui.hidden) return;
    ui.hidden = hide;
    ui.wrap.classList.toggle('gone', hide);
    if (hide) closePanel(true);
  }

  // ═══ 主题与强调色 ═══
  // 跟随页面：B 站深色模式（根元素 bili_dark），或页面实际背景偏暗（如 Dark Reader 等插件）时用深色
  function pageLooksDark() {
    const de = document.documentElement;
    if (de.classList.contains('bili_dark')) return true;
    for (const el of [document.body, de]) {
      if (!el) continue;
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor);
      if (!m || (m[4] != null && +m[4] < 0.5)) continue;   // 透明则看外层
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.4;
    }
    return false;
  }
  function resolveTheme() {
    if (cfg.theme === 'light' || cfg.theme === 'dark') return cfg.theme;
    return pageLooksDark() ? 'dark' : 'light';
  }
  function applyTheme() {
    if (!ui) return;
    const t = resolveTheme();
    if (ui.theme === t) return;
    ui.theme = t;
    ui.wrap.setAttribute('data-theme', t);
    readColors();
  }
  function applyAccent() {
    if (!ui) return;
    const a = cfg.accent || DEFAULTS.accent, s = ui.wrap.style;
    if (a === 'ink') {
      s.setProperty('--acc', 'var(--ink)');
      s.setProperty('--on-acc', 'var(--bg)');
    } else {
      const m = /^#?([0-9a-f]{6})$/i.exec(a);
      const rgb = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) : [0, 0, 0];
      const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      s.setProperty('--acc', a);
      s.setProperty('--on-acc', lum > 0.62 ? '#18191c' : '#ffffff');
    }
    readColors();
  }
  function readColors() {
    const cs = getComputedStyle(ui.wrap);
    ui.colors = { bar: cs.getPropertyValue('--bar').trim(), line: cs.getPropertyValue('--line').trim(),
                  acc: cs.getPropertyValue('--acc').trim() };
  }

  // ═══ 胶囊位置与面板开合 ═══
  function clampPos(p) {
    const w = (ui && ui.cap.offsetWidth) || 110, h = (ui && ui.cap.offsetHeight) || 32;
    const maxR = Math.max(4, (window.innerWidth || 1200) - w - 4);
    const maxB = Math.max(4, (window.innerHeight || 800) - h - 4);
    return { right: Math.min(Math.max(4, p.right), maxR), bottom: Math.min(Math.max(4, p.bottom), maxB) };
  }
  function applyPos() {
    const p = clampPos(cfg.panelPos || { right: 24, bottom: 120 });
    ui.cap.style.right = p.right + 'px';
    ui.cap.style.bottom = p.bottom + 'px';
  }

  // 面板贴着胶囊展开：胶囊在下半屏就向上开，在右半屏就右对齐
  function placePanel() {
    const r = ui.cap.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const up = r.top + r.height / 2 > vh / 2;
    const room = up ? r.top - GAP - EDGE : vh - r.bottom - GAP - EDGE;
    const maxH = Math.max(220, Math.min(640, room));
    const alignRight = r.left + r.width / 2 > vw / 2;
    const x = Math.max(EDGE, Math.min(alignRight ? r.right - PANEL_W : r.left, vw - PANEL_W - EDGE));
    const s = ui.pnl.style;
    s.left = x + 'px';
    if (up) { s.top = 'auto'; s.bottom = (vh - r.top + GAP) + 'px'; }
    else { s.bottom = 'auto'; s.top = (r.bottom + GAP) + 'px'; }
    ui.pnlIn.style.maxHeight = maxH + 'px';
    ui.maxBody = maxH - ui.hd.offsetHeight - 2;
    ui.place = { up, capL: r.left - x, capW: r.width, capH: r.height };
  }

  // 内容高度变化时面板随之伸缩（超出上限则内部滚动）
  function fitBody(instant) {
    if (!ui || !ui.open) return;
    const full = ui.view.offsetHeight, max = ui.maxBody || 480, h = Math.min(full, max);
    if (instant) ui.body.classList.add('snap');
    ui.body.style.height = h + 'px';
    ui.body.style.overflowY = full > max ? 'auto' : 'hidden';   // 放得下就不出滚动条（入场位移也不会撑出来）
    if (instant) { void ui.body.offsetHeight; ui.body.classList.remove('snap'); }
  }

  // 开合：面板从胶囊处长出，收起时缩回胶囊
  function animatePanel(opening, instant) {
    const el = ui.pnlIn;
    [ui.anim, ui.fadeA, ui.fadeB].forEach(a => { if (a) a.cancel(); });
    ui.anim = ui.fadeA = ui.fadeB = null;
    const hide = () => { if (!ui.open) ui.pnl.removeAttribute('data-open'); };
    if (instant || !el.animate) { hide(); return; }
    if (reducedMotion()) {
      ui.anim = el.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: 140, direction: opening ? 'normal' : 'reverse', fill: opening ? 'none' : 'forwards' });
      ui.anim.onfinish = () => { hide(); if (ui.anim) ui.anim.cancel(); ui.anim = null; };
      return;
    }
    const { up, capL, capW, capH } = ui.place;
    const W = el.offsetWidth, H = el.offsetHeight;
    const l = Math.max(0, Math.min(W - capW, capL)), r = Math.max(0, W - l - capW);
    const from = { clipPath: `inset(${up ? H - capH : 0}px ${r}px ${up ? 0 : H - capH}px ${l}px round ${capH / 2}px)`,
                   transform: `translateY(${(up ? 1 : -1) * (capH + GAP)}px)` };
    const to = { clipPath: 'inset(0px 0px 0px 0px round 14px)', transform: 'translateY(0px)' };
    const parts = [ui.hd, ui.body];
    if (opening) {
      ui.anim = el.animate([from, to], { duration: 440, easing: 'cubic-bezier(.25,1,.5,1)' });
      [ui.fadeA, ui.fadeB] = parts.map(p => p.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: 240, delay: 120, easing: 'ease-out', fill: 'backwards' }));
      ui.anim.onfinish = () => { ui.anim = null; };
    } else {
      ui.anim = el.animate([to, from], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
      [ui.fadeA, ui.fadeB] = parts.map(p => p.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: 110, easing: 'ease-in', fill: 'forwards' }));
      ui.anim.onfinish = () => {
        hide();
        [ui.anim, ui.fadeA, ui.fadeB].forEach(a => { if (a) a.cancel(); });
        ui.anim = ui.fadeA = ui.fadeB = null;
      };
    }
  }

  function openPanel() {
    if (!ui || ui.open || ui.hidden) return;
    ui.open = true;
    ui.pnl.setAttribute('data-open', '1');
    ui.cap.setAttribute('aria-expanded', 'true');
    placePanel();
    syncPower();
    renderView();
    fitBody(true);
    animatePanel(true);
    startRaf();
  }
  function closePanel(instant) {
    if (!ui || !ui.open) return;
    ui.open = false;
    ui.cap.setAttribute('aria-expanded', 'false');
    animatePanel(false, instant);
  }
  function togglePanel() { if (isOpen()) closePanel(); else openPanel(); }

  // ═══ 视图切换 ═══
  const RENDER = { overview: viewOverview, nodes: viewNodes, diag: viewDiag, settings: viewSettings };

  function setView(v) {
    if (!RENDER[v] || v === activeView) return;
    activeView = v;
    renderView();
  }
  function renderView() {
    const el = ui.view;
    stripSig = '';
    el.classList.remove('enter');
    void el.offsetWidth;                 // 重启入场动画
    RENDER[activeView](el);
    el.classList.add('enter');
    ui.body.scrollTop = 0;
    ui.tabs.forEach(b => {
      const on = b.getAttribute('data-v') === activeView;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    moveTabInd();
    syncView();
    startRaf();
  }
  function syncView() {
    if (activeView === 'overview') syncOverview();
    else if (activeView === 'nodes') syncNodes();
    else if (activeView === 'diag') syncDiag();
  }
  function moveTabInd() {
    const b = ui.tabs.find(x => x.getAttribute('data-v') === activeView);
    if (!b || !b.offsetWidth) return;
    ui.tabInd.style.width = (b.offsetWidth - 20) + 'px';
    ui.tabInd.style.transform = `translateX(${b.offsetLeft + 10}px)`;
  }
  function syncPower() {
    const sw = ui && ui.view.querySelector('#st-enable');
    if (sw) sw.setAttribute('aria-checked', String(!!cfg.enabled));
  }
  function setEnabled(on) {
    cfg.enabled = on; saveCfg();
    log('info', 'sys', on ? '已启用' : '已停用');
    syncPower(); refreshCap();
    if (isOpen()) { if (activeView === 'overview') renderView(); else syncView(); }
  }

  // ═══ 小工具 ═══
  function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
  function copyText(txt) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(() => true, fallback);
    return Promise.resolve(fallback());
  }
  function flashLabel(btn, txt, ms) {
    if (btn._label == null) btn._label = btn.textContent;
    btn.textContent = txt;
    clearTimeout(btn._ft);
    btn._ft = setTimeout(() => { btn.textContent = btn._label; }, ms || 1600);
  }
  // 危险操作二次确认：第一次点击改为确认文案，3 秒内再点才执行
  function confirmClick(btn, ask, action) {
    btn.addEventListener('click', () => {
      if (btn._armed) {
        btn._armed = false; clearTimeout(btn._ft); btn.textContent = btn._label;
        action();
        return;
      }
      btn._armed = true;
      flashLabel(btn, ask, 3000);
      setTimeout(() => { btn._armed = false; }, 3000);
    });
  }

  const segHTML = (id, opts, val, size) => {
    const i = Math.max(0, opts.findIndex(o => o[0] === val));
    return `<div class="seg${size ? ' ' + size : ''}" id="${id}" role="radiogroup" style="--n:${opts.length};--i:${i}">` +
      opts.map(([v, l], k) => `<button role="radio" data-v="${v}" aria-checked="${k === i}" tabindex="${k === i ? 0 : -1}">${l}</button>`).join('') +
      '<i class="ind"></i></div>';
  };
  function bindSeg(root, id, onPick) {
    const seg = root.querySelector('#' + id);
    const btns = [...seg.querySelectorAll('button')];
    const pick = (b) => {
      if (b.getAttribute('aria-checked') === 'true') return;
      btns.forEach(x => { const on = x === b; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
      seg.style.setProperty('--i', btns.indexOf(b));
      onPick(b.getAttribute('data-v'));
    };
    btns.forEach(b => b.addEventListener('click', () => pick(b)));
    seg.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const cur = btns.findIndex(x => x.getAttribute('aria-checked') === 'true');
      const nb = btns[(cur + d + btns.length) % btns.length];
      pick(nb); nb.focus();
    });
  }
  const swRow = (id, label, on) =>
    `<div class="row"><label class="lb" for="${id}">${label}</label><div class="ctl">` +
    `<button class="sw" id="${id}" role="switch" aria-checked="${!!on}"><i></i></button></div></div>`;
  function bindSw(root, id, key, after) {
    const b = root.querySelector('#' + id);
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      cfg[key] = on; saveCfg(); refreshCap();
      if (after) after(on);
    });
  }
  const sldRow = (id, label, min, max, step, val, fmt, extra) =>
    `<div class="row sld${extra ? ' ' + extra : ''}"><label class="lb" for="${id}">${label}</label>` +
    `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" style="--p:${pct(val, min, max)}%">` +
    `<output class="sld-v" id="${id}-v">${fmt(val)}</output></div>`;
  function bindSld(root, id, key, fmt) {
    const r = root.querySelector('#' + id), out = root.querySelector('#' + id + '-v');
    r.addEventListener('input', () => {
      cfg[key] = +r.value;
      out.textContent = fmt(cfg[key]);
      r.style.setProperty('--p', pct(+r.value, +r.min, +r.max) + '%');
    });
    r.addEventListener('change', saveCfg);
  }

  // ═══ 概览 ═══
  function viewOverview(el) {
    el.innerHTML = `
      <div class="ov">
        <div class="ov-off">
          <b>BiliBoost 已停用</b>
          <p>视频按 B 站默认线路加载</p>
          <button class="btn" id="ov-enable">启用</button>
        </div>
        <div class="ov-on">
          <div class="hero">
            <div class="hero-rate"><b id="ov-rate">${fmtRate(heroShown)}</b><span>Mbps</span></div>
            <div class="hero-buf" id="ov-bufw"><b id="ov-buf">—</b><span>已缓冲</span></div>
          </div>
          <div class="chart"><canvas id="ov-chart" aria-hidden="true"></canvas><span class="chart-max" id="ov-max"></span></div>
          <div class="asm" id="ov-asm" hidden>
            <div class="asm-h"><span>多源加载</span><span id="ov-asm-m"></span></div>
            <div class="strip" id="ov-strip"></div>
            <div class="strip-lb" id="ov-lb"></div>
          </div>
          <div class="route">
            <span class="k">线路</span>
            <div class="v"><div class="route-main" id="ov-route"></div><div class="route-why" id="ov-why"></div></div>
          </div>
          <button class="note" id="ov-note" hidden><i></i><span id="ov-note-t"></span><em>查看诊断</em></button>
        </div>
      </div>`;
    el.querySelector('#ov-enable').addEventListener('click', () => setEnabled(true));
    el.querySelector('#ov-note').addEventListener('click', () => setView('diag'));
  }

  function routeView() {
    const hostHTML = (h) => `<i class="sq" style="--c:${nodeVar(h)}"></i><span>${esc(tinyHost(h))}</span>`;
    if (cfg.mode === 'force') return { main: hostHTML(cfg.pinHost), why: '已锁定节点' };
    if (cfg.mode === 'smart') {
      const t = RE_AKAM.test(cfg.pinHost) ? PREMIUM : cfg.pinHost;
      return { main: `<span class="to">替换为</span>${hostHTML(t)}`, why: '轻量模式' };
    }
    const cid = state.activeCid;
    if (!cid) return { main: '<span class="to">等待视频</span>', why: '' };
    const orig = state.origHostByCid[cid], verdict = state.verdictByCid[cid];
    let main = hostHTML(orig);
    if (verdict && verdict.host !== orig) main += `<span class="to">→</span>${hostHTML(verdict.host)}`;
    const probed = state.timeline[cid] && state.timeline[cid].probeEnd != null;
    let why = verdict ? verdict.why : (probed ? '使用调度节点' : '测速中…');
    if (state.warmTimers[cid]) why += ` · 正在预热 ${tinyHost(PREMIUM)}`;
    return { main, why };
  }

  function syncOverview() {
    const el = ui.view, ov = el.querySelector('.ov');
    if (!ov) return;
    ov.setAttribute('data-off', cfg.enabled ? '0' : '1');
    if (!cfg.enabled) return;
    const v = guardedVideo;
    const ahead = v ? playableAhead(v) : null;
    setHTML(el.querySelector('#ov-buf'), ahead == null ? '—'
      : `${ahead >= 10 ? Math.floor(ahead) : ahead.toFixed(1)}<small>s</small>`);
    el.querySelector('#ov-bufw').setAttribute('data-low', v && !v.paused && ahead != null && ahead < 3 ? '1' : '0');
    const r = routeView();
    setHTML(el.querySelector('#ov-route'), r.main);
    setText(el.querySelector('#ov-why'), r.why);
    const s = statusInfo(), note = el.querySelector('#ov-note');
    note.hidden = !s.msg;
    if (s.msg) { note.setAttribute('data-st', s.st); setText(el.querySelector('#ov-note-t'), s.msg); }
    syncStrip();
    if (!rafId) { tweenHero(); drawChart(); }
  }

  function tweenHero() {
    const el = ui.view.querySelector('#ov-rate');
    if (!el) return;
    const target = recentMbps();
    heroShown += (target - heroShown) * 0.12;
    if (Math.abs(target - heroShown) < 0.05) heroShown = target;
    setText(el, fmtRate(heroShown));
  }

  // 近 60 秒逐秒吞吐；最右一根是正在累计的这一秒，整体随时间平滑左移
  function drawChart() {
    const cv = ui.view.querySelector('#ov-chart');
    if (!cv) return;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const N = 60, win = state.bytesWindow;
    const vals = win.slice(-N).map(x => x.bytes * 8 / 1e6);
    const last = win[win.length - 1];
    const phase = last ? Math.min(1, Math.max(0, (Date.now() - last.t) / 1000)) : 0;
    const live = bytesThisTick * 8 / 1e6;
    let peak = live;
    for (const x of vals) if (x > peak) peak = x;
    chartMax += (Math.max(4, peak * 1.15) - chartMax) * 0.08;
    const pitch = W / N, bw = Math.max(1, pitch * 0.58), top = 12, base = H - 1;
    const hOf = (x) => (x <= 0 ? 0 : Math.max(1.5, Math.min(1, x / chartMax) * (base - top)));
    const bar = (x, h) => {
      const r = Math.min(bw / 2, 1.5);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, base - h, bw, h, [r, r, 0, 0]); else ctx.rect(x, base - h, bw, h);
      ctx.fill();
    };
    ctx.fillStyle = ui.colors.line;
    ctx.fillRect(0, base, W, 1);
    const xLive = W - phase * pitch, inset = (pitch - bw) / 2;
    ctx.fillStyle = ui.colors.bar;
    for (let k = 0; k < vals.length; k++) {
      const x = xLive - (k + 1) * pitch;
      if (x + pitch < 0) break;
      const h = hOf(vals[vals.length - 1 - k]);
      if (!h) continue;
      ctx.globalAlpha = 1 - 0.65 * Math.min(1, (W - x) / W);   // 越早越淡
      bar(x + inset, h);
    }
    ctx.globalAlpha = 1;
    const hl = hOf(live);
    if (hl) { ctx.fillStyle = ui.colors.acc; bar(xLive + inset, hl); }
    setText(ui.view.querySelector('#ov-max'), peak >= 0.1 ? `峰值 ${fmtRate(peak)}` : '');
  }

  // 多源加载条：一次装载的字节区间按路切开，各路按来源节点着色、同时填充；空闲时保留上一次的完成态。
  // 分段小于切分阈值时不会拆分，本视频还没有可展示的装载就整块隐藏
  function syncStrip() {
    const asm = ui.view.querySelector('#ov-asm');
    if (!asm) return;
    const live = state.msLanes && state.msLanes.length ? state.msLanes : null;
    if (live) { lastLanes = live; lastLanesCid = state.activeCid; }
    else if (lastLanesCid !== state.activeCid) lastLanes = null;
    const lanes = live || lastLanes;
    const show = engineOn() && !!lanes;
    if (asm.hidden === show) asm.hidden = !show;
    if (!show) return;
    const strip = asm.querySelector('#ov-strip'), lb = asm.querySelector('#ov-lb'), meta = asm.querySelector('#ov-asm-m');
    const sig = lanes.map(l => l.id).join(',');
    if (sig !== stripSig) {
      stripSig = sig;
      strip.innerHTML = lanes.map(l => `<div class="part" style="flex:${l.span} 1 0"><i></i></div>`).join('');
      lb.innerHTML = lanes.map(l => `<span style="flex:${l.span} 1 0"></span>`).join('');
      lb.setAttribute('data-dense', lanes.length > 6 ? '1' : '0');
    }
    let busy = false, total = 0;
    lanes.forEach((l, i) => {
      const part = strip.children[i], label = lb.children[i];
      if (!part) return;
      total += l.span;
      if (!l.done) busy = true;
      const s = l.failed ? 'fail' : (l.done ? 'done' : 'live');
      if (part._s !== s) { part._s = s; part.setAttribute('data-s', s); }
      if (part._h !== l.host) {
        // 分片中途换了节点 = 原节点失败、由其他节点补洞：短暂标出这一段
        if (part._h && l.host && !l.done) {
          part.classList.add('retry');
          clearTimeout(part._rt);
          part._rt = setTimeout(() => part.classList.remove('retry'), 700);
        }
        part._h = l.host;
        part.style.setProperty('--c', nodeVar(l.host));
        label.textContent = l.host ? tinyHost(l.host) : '…';
        label.title = l.host || '';
      }
      const w = l.done ? '' : (l.span > 0 ? Math.min(100, l.bytes / l.span * 100) : 0).toFixed(1) + '%';
      if (part._w !== w) { part._w = w; part.firstChild.style.width = w; }
    });
    asm.setAttribute('data-idle', busy ? '0' : '1');
    setText(meta, `${lanes.length} 路 · ${(total / 1048576).toFixed(1)} MB`);
  }

  // ═══ 节点 ═══
  function recentShares() {
    const now = Date.now(), agg = {};
    let total = 0;
    for (const f of state.hostFlow) {
      if (now - f.t > 20000) continue;
      agg[f.host] = (agg[f.host] || 0) + f.bytes;
      total += f.bytes;
    }
    const out = {};
    for (const h in agg) out[h] = total ? agg[h] / total : 0;
    return out;
  }
  function nodeHosts() {
    const pool = poolHosts().map(p => p.host);
    const cid = state.activeCid, orig = cid && state.origHostByCid[cid];
    const extra = [orig].concat(Object.keys(testResults)).filter(h => h && !pool.includes(h));
    return [...new Set(extra.concat(pool))];
  }
  // 停用的沉底；有本次测速结果时按测速排，否则按健康分
  function sortHosts(hosts) {
    const val = (h) => {
      const t = testResults[h];
      if (t) return t.ok ? 1e6 + t.mbps : -1;
      return healthScore(h);
    };
    return hosts.slice().sort((a, b) => {
      const oa = cfg.disabledHosts.includes(a), ob = cfg.disabledHosts.includes(b);
      if (oa !== ob) return oa ? 1 : -1;
      return val(b) - val(a);
    });
  }
  function fastestTested() {
    let best = null, bv = 0;
    for (const h in testResults) { const t = testResults[h]; if (t.ok && t.mbps > bv) { bv = t.mbps; best = h; } }
    return best;
  }
  const testFailText = (t) => t.skip || (t.timeout ? '超时' : (t.deepFail ? '后段失败' : (t.status ? 'HTTP ' + t.status : '失败')));

  function nodeRowHTML(host) {
    const inPool = poolHosts().some(p => p.host === host);
    const { name, region } = nodeName(host);
    const open = expandedNode === host;
    const custom = (cfg.customHosts || []).includes(host);
    const canPin = !RE_AKAM.test(host);
    return `<div class="nrow" data-host="${esc(host)}" data-open="${open ? 1 : 0}">
      <button class="nrow-main" aria-expanded="${open}">
        <i class="ndot" style="--c:${nodeVar(host)}"></i>
        <span class="nrow-id"><span class="nrow-name">${esc(name)}${region ? `<span>${esc(region)}</span>` : ''}</span><span class="nrow-meta"></span></span>
        <span class="nrow-rate"></span>
      </button>
      <div class="nrow-more">
        <div class="nrow-host">${esc(host)}</div>
        <dl class="kv"></dl>
        <div class="acts">
          ${canPin ? `<button class="btn-2 sm" data-pin="${esc(host)}"></button>` : ''}
          ${inPool ? `<button class="btn-2 sm" data-en="${esc(host)}"></button>` : ''}
          ${custom ? `<button class="link danger" data-rm="${esc(host)}">移除</button>` : ''}
        </div>
      </div>
      <i class="nrow-prog"></i>
    </div>`;
  }

  function nodeStatsHTML(host, shares) {
    const h = health[host] || {}, t = testResults[host], share = shares[host];
    const kv = [
      ['平均', h.mbps ? fmtRate(h.mbps) + ' Mbps' : '—'],
      ['低位', h.mbpsLow ? fmtRate(h.mbpsLow) + ' Mbps' : '—'],
      ['首字节', h.ttfb ? h.ttfb + ' ms' : '—'],
      ['成功 / 失败', `${h.ok || 0} / ${h.fail || 0}`],
      ['近 20 秒', share ? `承担 ${Math.round(share * 100)}% 流量` : '未使用'],
    ];
    if (h.h2 != null) kv.push(['协议', h.h2 ? 'HTTP/2' : 'HTTP/1.1']);
    if (t && t.ok) kv.push(['本次测速', t.deepMbps != null ? `开头 ${t.headMbps} · 后段 ${t.deepMbps} Mbps` : `${t.mbps} Mbps`]);
    return kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  }

  function viewNodes(el) {
    el.innerHTML = `
      <div class="tools">
        <span>采样</span>
        ${segHTML('nd-size', TEST_SIZES.map(([v, l]) => [String(v), l]), String(testSize), 'sm')}
        <button class="btn" id="nd-test">${testing ? '测速中…' : (Object.keys(testResults).length ? '重新测速' : '测速')}</button>
      </div>
      <div class="nlist" id="nd-list">${sortHosts(nodeHosts()).map(nodeRowHTML).join('')}</div>
      <div class="add">
        <input type="text" id="nd-host" placeholder="添加节点，如 upos-sz-mirrorxx.bilivideo.com" spellcheck="false" autocomplete="off">
        <button class="btn-2" id="nd-add">添加</button>
      </div>
      <div class="foot-row"><span class="msg" id="nd-msg"></span><button class="link" id="nd-reset">重置统计</button></div>`;
    const list = el.querySelector('#nd-list');
    el.querySelector('#nd-test').disabled = !!testing;
    bindSeg(el, 'nd-size', (v) => { testSize = +v; });
    el.querySelector('#nd-test').addEventListener('click', startSpeedTest);

    list.addEventListener('click', (e) => {
      const main = e.target.closest('.nrow-main');
      const en = e.target.closest('[data-en]');
      const pin = e.target.closest('[data-pin]');
      const rm = e.target.closest('[data-rm]');
      if (en) return toggleNode(en);
      if (pin) return pinNode(pin.getAttribute('data-pin'));
      if (rm) return removeNode(rm.getAttribute('data-rm'));
      if (main) {
        const row = main.closest('.nrow'), host = row.getAttribute('data-host');
        const opening = row.getAttribute('data-open') !== '1';
        list.querySelectorAll('.nrow[data-open="1"]').forEach(r => {
          r.setAttribute('data-open', '0');
          r.querySelector('.nrow-main').setAttribute('aria-expanded', 'false');
        });
        expandedNode = opening ? host : null;
        row.setAttribute('data-open', opening ? '1' : '0');
        main.setAttribute('aria-expanded', String(opening));
        syncNodes();
      }
    });

    const inp = el.querySelector('#nd-host');
    const add = () => {
      const v = inp.value.trim().toLowerCase();
      let err = '';
      if (!v) { inp.focus(); return; }
      if (!/^[a-z0-9][\w.-]*\.[a-z]{2,}$/.test(v)) err = '主机名格式不正确';
      else if (RE_AKAM.test(v)) err = '不支持 akamaized.net 节点';
      else if (poolHosts().some(p => p.host === v)) err = '该节点已在列表中';
      if (err) {
        inp.classList.add('bad'); nodeMsg(err, true);
        setTimeout(() => inp.classList.remove('bad'), 1400);
        return;
      }
      cfg.customHosts = (cfg.customHosts || []).concat([v]); saveCfg();
      inp.value = '';
      log('info', 'sys', '添加自定义节点 ' + v);
      renderNodeList();
      nodeMsg('已添加 ' + tinyHost(v));
    };
    el.querySelector('#nd-add').addEventListener('click', add);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    confirmClick(el.querySelector('#nd-reset'), '确认重置？', () => {
      Object.keys(health).forEach(k => delete health[k]);
      Object.keys(testResults).forEach(k => delete testResults[k]);
      jsave(HEALTH_KEY, {});
      log('info', 'sys', '节点统计已重置');
      renderNodeList();
      nodeMsg('统计已清空');
    });
  }

  function nodeMsg(txt, bad) {
    const m = ui.view.querySelector('#nd-msg');
    if (!m) return;
    m.textContent = txt;
    m.classList.toggle('bad', !!bad);
    clearTimeout(m._t);
    m._t = setTimeout(() => { m.textContent = ''; }, 3200);
  }
  function renderNodeList() {
    const list = ui.view.querySelector('#nd-list');
    if (!list) return;
    list.innerHTML = sortHosts(nodeHosts()).map(nodeRowHTML).join('');
    syncNodes();
  }

  function syncNodes() {
    const list = ui.view.querySelector('#nd-list');
    if (!list) return;
    const shares = recentShares(), best = fastestTested();
    for (const row of list.children) {
      const host = row.getAttribute('data-host');
      const h = health[host] || {}, t = testResults[host];
      const off = cfg.disabledHosts.includes(host);
      row.setAttribute('data-off', off ? '1' : '0');
      row.setAttribute('data-testing', testing && testing.host === host ? '1' : '0');
      row.querySelector('.ndot').setAttribute('data-act', shares[host] > 0 ? '1' : '0');
      const n = (h.ok || 0) + (h.fail || 0);
      const ttfb = t && t.ok ? t.ttfb : h.ttfb;
      const meta = [`<span class="mono">${esc(tinyHost(host))}</span>`];
      if (off) meta.push('已停用');
      else {
        if (ttfb) meta.push(ttfb + ' ms');
        if (n) meta.push(`成功 ${Math.round((h.ok || 0) / n * 100)}%`);
      }
      setHTML(row.querySelector('.nrow-meta'), meta.join(' · '));
      let rate;
      if (t && !t.ok) rate = `<span class="bad">${esc(testFailText(t))}</span>`;
      else if (t) rate = `<b>${fmtRate(t.mbps)}</b><small>Mbps</small>${best === host ? '<em>最快</em>' : ''}`;
      else if (testing && !off) rate = '<span class="mut">待测</span>';
      else if (h.mbps) rate = `<b>${fmtRate(h.mbps)}</b><small>Mbps</small>`;
      else rate = '<span class="mut">—</span>';
      setHTML(row.querySelector('.nrow-rate'), rate);
      if (row.getAttribute('data-open') === '1') {
        setHTML(row.querySelector('.kv'), nodeStatsHTML(host, shares));
        const pin = row.querySelector('[data-pin]'), en = row.querySelector('[data-en]');
        if (pin) setText(pin, cfg.mode === 'force' && cfg.pinHost === host ? '解除锁定' : '锁定此节点');
        if (en) setText(en, off ? '启用' : '停用');
      }
    }
  }

  function toggleNode(btn) {
    const h = btn.getAttribute('data-en');
    const on = !cfg.disabledHosts.includes(h);
    const next = on ? cfg.disabledHosts.concat([h]) : cfg.disabledHosts.filter(x => x !== h);
    if (!poolHosts().some(p => p.coldReliable && !next.includes(p.host))) {
      nodeMsg('至少保留一个大陆节点', true);
      return;
    }
    cfg.disabledHosts = next; saveCfg();
    syncNodes();
  }
  function pinNode(host) {
    if (cfg.mode === 'force' && cfg.pinHost === host) {
      cfg.mode = 'auto';
      log('info', 'sys', '解除锁定 → 自适应模式');
      nodeMsg('已恢复自适应模式');
    } else {
      cfg.pinHost = host; cfg.mode = 'force';
      log('ok', 'sys', `已锁定 ${host}`);
      nodeMsg('已锁定 ' + tinyHost(host));
    }
    saveCfg(); refreshCap(); syncNodes();
  }
  function removeNode(host) {
    cfg.customHosts = cfg.customHosts.filter(x => x !== host);
    cfg.disabledHosts = cfg.disabledHosts.filter(x => x !== host);
    if (cfg.pinHost === host) { cfg.pinHost = PREMIUM; if (cfg.mode === 'force') cfg.mode = 'auto'; }
    saveCfg();
    delete testResults[host];
    if (expandedNode === host) expandedNode = null;
    log('info', 'sys', '移除自定义节点 ' + host);
    renderNodeList();
  }

  async function startSpeedTest() {
    if (testing) return;
    Object.keys(testResults).forEach(k => delete testResults[k]);
    testing = { host: null };
    const btn = () => ui.view.querySelector('#nd-test');
    const b0 = btn();
    if (b0) { b0.disabled = true; b0.textContent = '测速中…'; }
    renderNodeList();
    try {
      await runSpeedTest(testSize,
        (r) => { testResults[r.host] = r; syncNodes(); },
        (h) => {
          testing.host = h;
          const list = ui.view.querySelector('#nd-list');
          if (list && !list.querySelector(`.nrow[data-host="${CSS.escape(h)}"]`)) list.insertAdjacentHTML('afterbegin', nodeRowHTML(h));
          syncNodes();
        });
    } catch (e) {
      nodeMsg(e.message, true);
    }
    testing = null;
    const b = btn();
    if (b) { b.disabled = false; b.textContent = '重新测速'; }
    reorderNodes();
    syncNodes();
  }

  // 测速完成后按新排名重排，行位移用 FLIP 过渡
  function reorderNodes() {
    const list = ui.view.querySelector('#nd-list');
    if (!list) return;
    const rows = [...list.children];
    const before = new Map(rows.map(r => [r, r.getBoundingClientRect().top]));
    sortHosts(rows.map(r => r.getAttribute('data-host'))).forEach(h => {
      const r = rows.find(x => x.getAttribute('data-host') === h);
      if (r) list.appendChild(r);
    });
    if (reducedMotion()) return;
    rows.forEach(r => {
      const dy = before.get(r) - r.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && r.animate) {
        r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
  }

  // ═══ 诊断 ═══
  function viewDiag(el) {
    el.innerHTML = `
      <div class="dg-top">
        <span class="dg-sum" id="dg-sum"></span>
        <button class="btn" id="dg-copy">复制诊断报告</button>
      </div>
      <div id="dg-finds"></div>
      <section class="sec" id="dg-tl-sec" hidden><h3>起播时间线</h3><div id="dg-tl"></div></section>
      <section class="sec fold" data-open="${diagFold.reqs ? 1 : 0}">
        <button class="fold-h" data-fold="reqs" aria-expanded="${diagFold.reqs}"><span>请求记录</span><span class="n" id="dg-reqs-n"></span><i class="chev"></i></button>
        <div class="fold-b" id="dg-reqs"></div>
      </section>
      <section class="sec fold" data-open="${diagFold.logs ? 1 : 0}">
        <button class="fold-h" data-fold="logs" aria-expanded="${diagFold.logs}"><span>事件日志</span><span class="n" id="dg-logs-n"></span><i class="chev"></i></button>
        <div class="fold-b">
          <div class="log-tools">
            <span class="sel"><select id="dg-tag" aria-label="日志类型">${LOG_TAGS.map(([k, n]) =>
              `<option value="${k}"${logFilter.tag === k ? ' selected' : ''}>${n}</option>`).join('')}</select></span>
            <button class="chip" id="dg-prob" aria-pressed="${logFilter.onlyProblem}">仅问题</button>
            <button class="link" id="dg-logcopy">复制</button>
            <button class="link" id="dg-logclear">清空</button>
          </div>
          <div class="log" id="dg-log"></div>
        </div>
      </section>`;
    el.querySelector('#dg-copy').addEventListener('click', (e) => {
      const b = e.currentTarget;
      copyText(buildDiagReport()).then(ok => flashLabel(b, ok ? '已复制' : '复制失败'));
    });
    el.querySelectorAll('[data-fold]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-fold');
      diagFold[k] = !diagFold[k];
      b.closest('.fold').setAttribute('data-open', diagFold[k] ? '1' : '0');
      b.setAttribute('aria-expanded', String(diagFold[k]));
      el.querySelector(k === 'reqs' ? '#dg-reqs' : '#dg-log')._html = null;
      syncDiag();
    }));
    el.querySelector('#dg-tag').addEventListener('change', (e) => { logFilter.tag = e.target.value; syncDiag(); });
    el.querySelector('#dg-prob').addEventListener('click', (e) => {
      logFilter.onlyProblem = !logFilter.onlyProblem;
      e.currentTarget.setAttribute('aria-pressed', String(logFilter.onlyProblem));
      syncDiag();
    });
    el.querySelector('#dg-logcopy').addEventListener('click', (e) => {
      const b = e.currentTarget;
      const txt = state.log.map(l => `[${fmtClock(l.t)} ${fmtRel(l.t)}][${l.level}/${l.tag}] ${l.msg}`).join('\n');
      copyText(txt).then(ok => flashLabel(b, ok ? '已复制' : '失败'));
    });
    confirmClick(el.querySelector('#dg-logclear'), '确认清空？', () => { state.log = []; syncDiag(); });
  }

  function findingsHTML() {
    return diagnose().map((f, i) => ({ f, i }))
      .sort((a, b) => (SEV_RANK[a.f.sev] - SEV_RANK[b.f.sev]) || (a.i - b.i))
      .map(({ f }) => `<div class="find" data-sev="${f.sev}"><i></i><div class="find-c">
        <div class="find-t">${esc(f.title)}</div>
        ${f.detail ? `<div class="find-d">${esc(f.detail)}</div>` : ''}
        ${f.advice ? `<div class="find-a">${esc(f.advice)}</div>` : ''}
      </div></div>`).join('');
  }
  function timelineHTML() {
    const cid = state.activeCid, t = cid && state.timeline[cid];
    if (!t) return '';
    const marks = [
      ['播放数据', t.playinfoAt != null ? t.playinfoAt : t.sniffAt],
      ['测速完成', t.probeEnd],
      ['选定线路', t.verdictAt],
      ['首个分片', t.firstOkAt],
      ['首帧', t.firstFrameAt],
    ].filter(m => m[1] != null).map(m => [m[0], Math.max(0, m[1] - t.t0)]);
    if (!marks.length) return '';
    const max = Math.max(600, ...marks.map(m => m[1]));
    return marks.map(([k, ms]) => `<div class="tl-row"><span class="tl-k">${k}</span>` +
      `<span class="tl-bar"><i style="width:${Math.max(1, ms / max * 100).toFixed(1)}%"></i></span>` +
      `<span class="tl-v">${fmtDur(ms)}</span></div>`).join('');
  }
  function reqsHTML() {
    const reqs = state.reqLog.slice(-30).reverse();
    if (!reqs.length) return '<div class="empty">暂无请求</div>';
    return '<table class="rq"><thead><tr><th>时间</th><th>节点</th><th>结果</th><th class="r">首字节</th><th class="r">速度</th></tr></thead><tbody>' +
      reqs.map(r => {
        const bad = BAD_OUTCOMES.includes(r.outcome) || String(r.outcome).startsWith('HTTP') || r.outcome === '聚合失败→原生';
        return `<tr><td class="mut">${fmtClock(r.t)}</td>` +
          `<td title="${esc(r.host)}"><i class="sq" style="--c:${nodeVar(r.host)}"></i>${esc(tinyHost(r.host))}${r.note ? `<span class="nt">${esc(r.note)}</span>` : ''}</td>` +
          `<td class="${bad ? 'bad' : (r.outcome === '成功' ? '' : 'mut')}">${esc(r.outcome)}</td>` +
          `<td class="r">${r.ttfb > 0 ? r.ttfb + 'ms' : '—'}</td>` +
          `<td class="r">${r.mbps ? r.mbps + 'M' : (r.kb ? r.kb + 'K' : '—')}</td></tr>`;
      }).join('') + '</tbody></table>';
  }
  function logsHTML() {
    const items = state.log.filter(l =>
      (logFilter.tag === 'all' || l.tag === logFilter.tag) &&
      (!logFilter.onlyProblem || l.level === 'warn' || l.level === 'error')).slice(-120).reverse();
    if (!items.length) return '<div class="empty">没有符合条件的日志</div>';
    return items.map(l => `<div class="${l.level}"><span class="tm">${fmtClock(l.t)}</span><span class="mg">${esc(l.msg)}</span></div>`).join('');
  }
  function syncDiag() {
    const el = ui.view, finds = el.querySelector('#dg-finds');
    if (!finds) return;
    const cid = state.activeCid;
    setText(el.querySelector('#dg-sum'), cid ? `cid ${cid} · ${cfg.enabled ? MODE_NAME[cfg.mode] + '模式' : '已停用'}` : '暂无视频');
    setHTML(finds, findingsHTML());
    const tl = timelineHTML();
    el.querySelector('#dg-tl-sec').hidden = !tl;
    setHTML(el.querySelector('#dg-tl'), tl);
    setText(el.querySelector('#dg-reqs-n'), String(state.reqLog.length));
    setText(el.querySelector('#dg-logs-n'), String(state.log.length));
    if (diagFold.reqs) setHTML(el.querySelector('#dg-reqs'), reqsHTML());
    if (diagFold.logs) setHTML(el.querySelector('#dg-log'), logsHTML());
  }

  // ═══ 设置 ═══
  const fMs = (v) => v + ' ms', fSec = (v) => (v / 1000).toFixed(2).replace(/0$/, '') + ' s', fKB = (v) => v + ' KB';

  function pinOptionsHTML() {
    const pool = enabledHosts();
    const opts = pool.map(p => `<option value="${esc(p.host)}"${cfg.pinHost === p.host ? ' selected' : ''}>` +
      `${esc(p.label.replace('·', ' · '))}（${esc(tinyHost(p.host))}）</option>`);
    if (!pool.some(p => p.host === cfg.pinHost)) {
      opts.unshift(`<option value="${esc(cfg.pinHost)}" selected>${esc(tinyHost(cfg.pinHost))}（已停用）</option>`);
    }
    return opts.join('');
  }
  function swatchesHTML() {
    const cur = cfg.accent || DEFAULTS.accent;
    const preset = ACCENTS.some(a => a[0] === cur);
    return ACCENTS.map(([c, name]) => `<button class="swc" role="radio" data-c="${c}" aria-checked="${c === cur}" ` +
        `aria-label="${name}" title="${name}" style="--c:${c === 'ink' ? 'var(--ink)' : c}"></button>`).join('') +
      `<label class="swc custom" title="自定义颜色" aria-checked="${!preset}" data-set="${preset ? 0 : 1}" style="--c:${preset ? 'transparent' : esc(cur)}">` +
      `<input type="color" id="st-color" value="${preset ? '#00aeec' : esc(cur)}" aria-label="自定义颜色"></label>`;
  }

  function viewSettings(el) {
    el.innerHTML = `
      <section class="ss">
        <div class="row"><label class="lb" for="st-enable">启用 BiliBoost</label><div class="ctl">
          <button class="sw" id="st-enable" role="switch" aria-checked="${!!cfg.enabled}"><i></i></button></div></div>
      </section>
      <section class="ss">
        <div class="ss-h">运行模式</div>
        ${segHTML('st-mode', [['auto', '自适应'], ['smart', '轻量'], ['force', '锁定']], cfg.mode)}
        <p class="ss-cap" id="st-mode-cap">${MODE_DESC[cfg.mode] || ''}</p>
      </section>
      <div class="modebox" id="st-modebox" data-mode="${cfg.mode}">
        <section class="ss m-auto">
          ${swRow('st-ms', '多源并行加载', cfg.multiSource)}
          <div class="sub" data-dep="multiSource">
            ${sldRow('st-lanes', '并行路数', 1, 12, 1, laneCount(), v => v + ' 路')}
            <div class="row"><span class="lb">切分方式</span><div class="ctl">
              ${segHTML('st-split', [['size', '按分片大小'], ['fixed', '固定路数']], cfg.msSplit, 'sm')}</div></div>
          </div>
        </section>
        <section class="ss m-auto">
          ${swRow('st-hedge', '对冲请求', cfg.hedge)}
          <div class="sub" data-dep="hedge">${sldRow('st-hedged', '对冲延迟', 300, 2000, 100, cfg.hedgeDelayMs, fMs)}</div>
          ${sldRow('st-stall', '卡顿熔断', 1000, 6000, 250, cfg.stallMs, fSec)}
          ${swRow('st-warm', '后台缓存预热', cfg.warmPremium)}
          ${swRow('st-jiggle', '切换节点后立即重试', cfg.rescueJiggle)}
        </section>
        <section class="ss m-pin">
          <div class="row"><span class="lb" id="st-pin-lb">${cfg.mode === 'force' ? '锁定节点' : '替换为'}</span>
            <div class="ctl"><span class="sel"><select id="st-pin" aria-labelledby="st-pin-lb">${pinOptionsHTML()}</select></span></div></div>
          <div class="m-smart">
            ${swRow('st-pcdn', '替换 PCDN 节点', cfg.replacePcdn)}
            ${swRow('st-mcdn', '替换 MCDN 节点', cfg.replaceMcdn)}
          </div>
        </section>
      </div>
      <section class="ss">
        ${swRow('st-bg', '后台播放保护', cfg.bgGuard)}
        ${sldRow('st-ttfb', '首字节超时', 1000, 4000, 250, cfg.ttfbTimeoutMs, fSec)}
      </section>
      <section class="ss">
        <div class="row"><span class="lb">外观</span><div class="ctl">
          ${segHTML('st-theme', [['auto', '跟随页面'], ['light', '浅色'], ['dark', '深色']], cfg.theme || 'auto', 'sm')}</div></div>
        <div class="row"><span class="lb">强调色</span><div class="ctl sws" id="st-acc" role="radiogroup" aria-label="强调色">${swatchesHTML()}</div></div>
      </section>
      <section class="ss fold adv" id="st-adv" data-open="0" data-split="${cfg.msSplit === 'fixed' ? 'fixed' : 'size'}">
        <button class="fold-h" aria-expanded="false"><span>高级</span><i class="chev"></i></button>
        <div class="fold-b">
          ${sldRow('st-psize', '选路采样', 64, 512, 64, cfg.probeSizeKB, fKB)}
          ${sldRow('st-idle', '传输空闲超时', 2000, 8000, 500, cfg.idleTimeoutMs, fSec)}
          ${sldRow('st-partkb', '分片大小', 256, 2048, 128, cfg.msPartKB, fKB, 'm-size')}
          ${sldRow('st-minpart', '最小分片', 64, 512, 64, cfg.msMinPartKB, fKB, 'm-fixed')}
          ${sldRow('st-splitkb', '切分阈值', 256, 2048, 128, cfg.msMinSplitKB, fKB)}
          ${sldRow('st-perhost', '单节点连接', 1, 3, 1, perHostLimit(), v => v + ' 个')}
          <div class="row col"><label class="lb" for="st-avoid">节点黑名单</label>
            <textarea id="st-avoid" rows="3" spellcheck="false" placeholder="每行一个主机名">${esc((cfg.avoidHosts || []).join('\n'))}</textarea></div>
          <div class="row"><span class="lb">胶囊位置</span><div class="ctl"><button class="link" id="st-pos">恢复默认</button></div></div>
          <div class="row"><span class="lb">配置</span><div class="ctl">
            <button class="btn-2 sm" id="st-export">导出</button>
            <button class="btn-2 sm" id="st-import">导入</button>
            <button class="link danger" id="st-reset">恢复默认</button></div></div>
          <div class="io" id="st-io-wrap" hidden>
            <textarea id="st-io" rows="5" spellcheck="false"></textarea>
            <div class="foot-row"><span class="msg" id="st-io-msg"></span></div>
          </div>
        </div>
      </section>
      <div class="foot">BiliBoost ${VERSION}</div>`;

    const $ = (s) => el.querySelector(s);
    $('#st-enable').addEventListener('click', () => setEnabled(!cfg.enabled));
    const syncDeps = () => el.querySelectorAll('.sub[data-dep]').forEach(s =>
      s.setAttribute('data-off', cfg[s.getAttribute('data-dep')] ? '0' : '1'));
    syncDeps();

    bindSeg(el, 'st-mode', (v) => {
      cfg.mode = v; saveCfg(); refreshCap();
      $('#st-modebox').setAttribute('data-mode', v);
      $('#st-mode-cap').textContent = MODE_DESC[v];
      $('#st-pin-lb').textContent = v === 'force' ? '锁定节点' : '替换为';
      log('info', 'sys', '模式 → ' + MODE_NAME[v]);
    });
    bindSw(el, 'st-ms', 'multiSource', syncDeps);
    bindSw(el, 'st-hedge', 'hedge', syncDeps);
    bindSw(el, 'st-warm', 'warmPremium');
    bindSw(el, 'st-jiggle', 'rescueJiggle');
    bindSw(el, 'st-pcdn', 'replacePcdn');
    bindSw(el, 'st-mcdn', 'replaceMcdn');
    bindSw(el, 'st-bg', 'bgGuard');
    bindSld(el, 'st-lanes', 'msLanes', v => v + ' 路');
    bindSld(el, 'st-hedged', 'hedgeDelayMs', fMs);
    bindSld(el, 'st-stall', 'stallMs', fSec);
    bindSld(el, 'st-ttfb', 'ttfbTimeoutMs', fSec);
    bindSld(el, 'st-psize', 'probeSizeKB', fKB);
    bindSld(el, 'st-idle', 'idleTimeoutMs', fSec);
    bindSld(el, 'st-partkb', 'msPartKB', fKB);
    bindSld(el, 'st-minpart', 'msMinPartKB', fKB);
    bindSld(el, 'st-splitkb', 'msMinSplitKB', fKB);
    bindSld(el, 'st-perhost', 'msPerHost', v => v + ' 个');
    $('#st-lanes').addEventListener('input', refreshCap);
    bindSeg(el, 'st-split', (v) => {
      cfg.msSplit = v; saveCfg();
      $('#st-adv').setAttribute('data-split', v);
      log('info', 'sys', '切分方式 → ' + (v === 'fixed' ? '固定路数' : '按分片大小'));
    });
    $('#st-pin').addEventListener('change', (e) => { cfg.pinHost = e.target.value; saveCfg(); });
    bindSeg(el, 'st-theme', (v) => { cfg.theme = v; saveCfg(); applyTheme(); });

    const acc = $('#st-acc');
    const markAccent = () => {
      const cur = cfg.accent, preset = ACCENTS.some(a => a[0] === cur);
      acc.querySelectorAll('.swc').forEach(s => s.setAttribute('aria-checked',
        String(s.classList.contains('custom') ? !preset : s.getAttribute('data-c') === cur)));
      const cu = acc.querySelector('.custom');
      cu.setAttribute('data-set', preset ? '0' : '1');
      cu.style.setProperty('--c', preset ? 'transparent' : cur);
    };
    acc.addEventListener('click', (e) => {
      const s = e.target.closest('button.swc');
      if (!s) return;
      cfg.accent = s.getAttribute('data-c'); saveCfg(); applyAccent(); markAccent();
    });
    const color = $('#st-color');
    color.addEventListener('click', () => { ui.holdOpen = Date.now() + 60000; });
    color.addEventListener('input', () => { cfg.accent = color.value; applyAccent(); markAccent(); });
    color.addEventListener('change', () => { saveCfg(); ui.holdOpen = 0; });

    const adv = $('#st-adv');
    adv.querySelector('.fold-h').addEventListener('click', (e) => {
      const open = adv.getAttribute('data-open') !== '1';
      adv.setAttribute('data-open', open ? '1' : '0');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    $('#st-avoid').addEventListener('change', (e) => {
      cfg.avoidHosts = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); saveCfg();
    });
    $('#st-pos').addEventListener('click', () => { cfg.panelPos = null; saveCfg(); closePanel(true); applyPos(); });

    const io = $('#st-io'), ioWrap = $('#st-io-wrap'), ioMsg = $('#st-io-msg');
    let ioMode = '';
    const say = (txt, bad) => { ioMsg.textContent = txt; ioMsg.classList.toggle('bad', !!bad); };
    $('#st-export').addEventListener('click', (e) => {
      const b = e.currentTarget, json = JSON.stringify({ cfg, health }, null, 1);
      ioMode = 'export'; ioWrap.hidden = false; io.value = json; io.select();
      say('');
      copyText(json).then(ok => { flashLabel(b, ok ? '已复制' : '导出'); if (!ok) say('请手动复制上方内容'); });
    });
    $('#st-import').addEventListener('click', () => {
      if (ioMode !== 'import') {
        ioMode = 'import'; ioWrap.hidden = false; io.value = '';
        io.placeholder = '粘贴配置后，再点一次「导入」';
        say(''); io.focus();
        return;
      }
      try {
        const obj = JSON.parse(io.value);
        if (obj.cfg) { Object.assign(cfg, obj.cfg); saveCfg(); }
        if (obj.health) { Object.assign(health, obj.health); jsave(HEALTH_KEY, health); }
        applyTheme(); applyAccent(); applyPos(); refreshCap(); syncPower();
        log('ok', 'sys', '配置已导入');
        renderView();
      } catch (err) {
        say('无法解析：' + err.message, true);
      }
    });
    confirmClick($('#st-reset'), '确认恢复？', () => {
      Object.assign(cfg, JSON.parse(JSON.stringify(DEFAULTS)), { panelPos: cfg.panelPos });   // 深拷贝，避免与默认值共用数组
      saveCfg();
      applyTheme(); applyAccent(); refreshCap(); syncPower();
      log('info', 'sys', '已恢复默认配置');
      renderView();
    });
  }

  // ═══ 构建 ═══
  function buildUI() {
    if (ui || !document.body) return;
    const host = document.createElement('biliboost-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css()}</style>
      <div class="bb" data-theme="light">
        <div class="cap" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false" aria-label="BiliBoost">
          <span class="cap-lanes"></span><span class="cap-val">—</span><span class="cap-unit">Mbps</span><i class="cap-dot"></i>
        </div>
        <section class="pnl" role="dialog" aria-label="BiliBoost">
          <div class="pnl-in">
            <header class="hd">
              <nav class="tabs" role="tablist">${VIEWS.map(([k, n]) =>
                `<button role="tab" data-v="${k}" aria-selected="false" tabindex="-1">${n}</button>`).join('')}<i class="tab-ind"></i></nav>
            </header>
            <div class="bd"><div class="vw"></div></div>
          </div>
        </section>
      </div>`;
    document.body.appendChild(host);
    const $ = (s) => root.querySelector(s);
    ui = {
      host, root, wrap: $('.bb'), cap: $('.cap'), capLanes: $('.cap-lanes'), capVal: $('.cap-val'), capUnit: $('.cap-unit'),
      pnl: $('.pnl'), pnlIn: $('.pnl-in'), hd: $('.hd'), body: $('.bd'), view: $('.vw'),
      tabs: [...root.querySelectorAll('.tabs button')], tabInd: $('.tab-ind'),
      open: false, hidden: false, theme: null, colors: {}, place: null, maxBody: 0, holdOpen: 0, capBusy: false,
    };
    applyTheme();
    applyAccent();
    applyPos();
    refreshCap();

    // 标签：点击切换，左右方向键移动
    ui.tabs.forEach((b, i) => {
      b.addEventListener('click', () => setView(b.getAttribute('data-v')));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const nb = ui.tabs[(i + d + ui.tabs.length) % ui.tabs.length];
        setView(nb.getAttribute('data-v')); nb.focus();
      });
    });

    // 胶囊：拖动换位置，轻点开合
    const cap = ui.cap;
    let drag = null;
    cap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = clampPos(cfg.panelPos || { right: 24, bottom: 120 });
      drag = { x: e.clientX, y: e.clientY, right: p.right, bottom: p.bottom, moved: false };
      try { cap.setPointerCapture(e.pointerId); } catch (err) {}
    });
    cap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = drag.x - e.clientX, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        cap.classList.add('dragging');
        closePanel(true);
      }
      if (!drag.moved) return;
      cfg.panelPos = clampPos({ right: drag.right + dx, bottom: drag.bottom - dy });
      applyPos();
    });
    const endDrag = (cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      cap.classList.remove('dragging');
      if (d.moved) saveCfg();
      else if (!cancelled) togglePanel();
    };
    cap.addEventListener('pointerup', () => endDrag(false));
    cap.addEventListener('pointercancel', () => endDrag(true));
    cap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
    });

    // 面板内的按键不外传，避免触发播放器快捷键；Esc 先退出输入框，再收起面板
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Escape' || !isOpen()) return;
      if (panelHasFocusedInput()) root.activeElement.blur();
      else { closePanel(); cap.focus(); }
    });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keypress', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

    // 点面板外、窗口失焦时收起（取色器打开期间除外）
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !e.composedPath().includes(host)) closePanel();
    }, true);
    window.addEventListener('blur', () => { if (isOpen() && Date.now() > ui.holdOpen) closePanel(); });
    window.addEventListener('resize', () => {
      applyPos();
      if (isOpen()) { placePanel(); fitBody(true); moveTabInd(); }
    });
    document.addEventListener('fullscreenchange', updateFullscreenVisibility);

    if (window.ResizeObserver) new ResizeObserver(() => fitBody()).observe(ui.view);
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    log('info', 'sys', `v${VERSION} 就绪 · 模式=${cfg.mode} · ${location.pathname.slice(0, 40)}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();

  // SPA 软导航：清理预热计时器与旧视频指针
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      Object.values(state.warmTimers).forEach(clearInterval);
      state.warmTimers = {};
      // 仅当新视频尚未注册时才清空：连播时 playinfo 常先于本轮轮询到达，
      // 无条件清空会抹掉刚注册的新 cid
      if (Date.now() - (state.activeCidAt || 0) > 3000) state.activeCid = null;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }
      log('info', 'sys', '页面切换 → ' + lastPath.slice(0, 50));
    }
  }, 1000);

  // 调试出口
  window.__biliCdnOpt = { cfg, state, health, probeHost, rewriteMediaUrl, diagnose, buildDiagReport,
                          bg, playableAhead, bgRecoveryWatch, realHidden, version: VERSION };
})();
