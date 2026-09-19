// ==UserScript==
// @name         BiliBoost
// @name:en      BiliBoost
// @namespace    bili-cdn-optimizer
// @version      3.9.0
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

  const VERSION = '3.9.0';
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
    accent: '#00a1d6',
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
        setVerdict(cid, lv.host, `沿用近期裁决(${lv.why})`, 'carry');
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
        setVerdict(cid, assigned, `探测复核：调度节点实测 ${assignedR.mbps}Mbps，显著占优`, 'probe');
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
      setVerdict(cid, winner.host, `探测优选 ${winner.mbps}Mbps`, 'probe');
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
            setVerdict(cid, PREMIUM, `预热完成 ${r.mbps}Mbps`, 'warm');
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
        setVerdict(cid, next, '传输停滞切换', 'stall');
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
              setVerdict(cid, host, '回退验证可用', 'fallback');
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
    if (cid && next) setVerdict(cid, next, '卡顿熔断切换', 'stall');
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

  async function runSpeedTest(sizeKB, onRow) {
    const src = currentMediaUrl();
    if (!src) throw new Error('未获取到媒体流 URL，请在视频加载后重试。');
    const hosts = enabledHosts().map(p => p.host);
    const orig = new URL(src).hostname;
    if (!hosts.includes(orig)) hosts.unshift(orig);
    for (const h of hosts) {
      if (RE_AKAM.test(h) && h !== orig) { onRow({ host: h, ok: false, skip: '签名限制' }); continue; }
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
      add('info', '未检测到活动视频', '视频开始加载后自动分析。');
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
      add('crit', `播放器已报告媒体错误 ${state.playerErrors} 次`,
        '已清除当时的路由裁决，重试将重新决策。若与 403 记录同时出现，根因为签名校验失败。');
    }
    if (sig403 >= 3) {
      add('crit', `媒体 URL 被拒绝 ${sig403} 次（HTTP 403）`,
        '签名校验失败。成因：跨签名家族改写（已由防火墙拦截）或 URL 签名过期。',
        '原生节点持续 403 属签名过期，刷新页面恢复。');
    }

    if (state.bootSource === 'sniff') {
      add('warn', '脚本注入时机晚于页面脚本（已由请求嗅探接管）',
        'playinfo 未能第一时间捕获，由请求嗅探完成引导，接管存在延迟。',
        'Tampermonkey → 设置 → 配置模式「高级」→ 实验性 → 注入模式「即时(Instant)」。');
    } else if (state.bootSource === 'trap-existing') {
      add('info', '注入时机偏晚（playinfo 数据已完整捕获）', '建议同样将 Tampermonkey 注入模式调整为「即时(Instant)」。');
    }

    if (state.blindMode) {
      add('warn', '媒体流量未经过脚本网络层',
        '缓冲增长但网络层无对应流量，分片请求疑似由 Worker 发起。当前由清单级备用链与进度监测兜底。');
    }
    if (verdict && verdict.host !== assigned) {
      add('ok', `已切换至备选节点 ${shortHost(verdict.host)}`,
        `依据：${verdict.why}。调度节点 ${shortHost(assigned)} 保留在候选链中，显著改善时回切。`);
    }
    const aH = health[assigned];
    if (aH && (aH.ok + aH.fail) > 10 && aH.fail / (aH.ok + aH.fail) > 0.3) {
      add('warn', `调度节点历史失败率 ${Math.round(aH.fail / (aH.ok + aH.fail) * 100)}%`,
        `${shortHost(assigned)} 成功 ${aH.ok} / 失败 ${aH.fail}，评分已按可靠性降权；高失败率叠加高峰值速率为突发-饥饿档案特征。`);
    }
    if (state.bgRecoveries > 0) {
      const kicked = state.bgKicks > 0;
      add(kicked ? 'ok' : 'info', `后台标签页保护：已处理 ${state.bgRecoveries} 次前台恢复`,
        `最近后台驻留 ${(state.bgLastHiddenMs / 1000).toFixed(0)} 秒。` +
        (kicked
          ? `触发重新调度 ${state.bgKicks} 次，后台补给 ${state.bgRefills} 次。`
          : '回前台缓冲充足，未干预。'));
    }
    if (state.msLoads > 0) {
      add('ok', `多源聚合引擎生效：${state.msLoads} 次装载`,
        `共 ${state.msParts} 个并行 part，跨节点补洞 ${state.msHoleFills} 次；` +
        `路数 ${laneCount()}（${cfg.msSplit === 'fixed' ? '固定路数' : '按分片尺寸'}），单节点连接上限 ${perHostLimit()}。`);
    }
    const probeR = state.probeInfoByCid[cid];
    const burst = probeR && probeR.find(r => r.ok && r.deepMbps != null && r.headMbps / Math.max(0.1, r.deepMbps) > 5);
    if (burst) {
      add('warn', `${shortHost(burst.host)} 呈突发-饥饿特征`,
        `头部 ${burst.headMbps}Mbps / 深部 ${burst.deepMbps}Mbps：边缘仅缓存文件头部，已按最差值计分。`);
    }

    if (t.firstFrameAt != null) {
      const boot = Math.round(t.firstFrameAt - t.t0);
      const probeCost = t.probeEnd && t.probeStart ? Math.round(t.probeEnd - t.probeStart) : null;
      const waitCost = t.firstOkAt && t.firstReqAt ? Math.round(t.firstOkAt - t.firstReqAt) : null;
      const parts = [];
      if (probeCost != null) parts.push(`微探测耗时 ${probeCost}ms`);
      if (waitCost != null) parts.push(`首个可用分片等待 ${waitCost}ms`);
      if (boot > 6000) {
        add('crit', `起播耗时偏高：${(boot / 1000).toFixed(1)} 秒`,
          `${parts.join('；')}。主要耗时通常来自对不可用调度节点的判定等待。`,
          '可下调「首字节超时」与「对冲触发延迟」。');
      } else if (boot > 3000) {
        add('warn', `起播耗时 ${(boot / 1000).toFixed(1)} 秒`, parts.join('；'));
      } else {
        add('ok', `起播耗时 ${(boot / 1000).toFixed(1)} 秒`, parts.join('；') || '各阶段均无显著等待。');
      }
    } else if (t.firstReqAt != null && performance.now() - t.firstReqAt > 6000) {
      add('crit', '视频尚未完成起播', '媒体请求已发出但首帧尚未渲染，见下方失败记录。');
    }

    if (failsOnAssigned >= 2) {
      add('crit', `调度节点缓存未命中（已失败 ${failsOnAssigned} 次）`,
        `${shortHost(assigned)} 边缘缓存未命中且回源失败。` +
        (verdict && verdict.host !== assigned ? `已切换至 ${shortHost(verdict.host)}。` : '正沿候选链尝试。'));
    } else if (verdict && verdict.host === assigned && state.stalls === 0 && failsOnAssigned === 0) {
      add('ok', '调度节点运行正常', `${shortHost(assigned)} 探测达标，未做干预。`);
    }

    if (hedgeWins > 0) {
      add('ok', `对冲请求命中 ${hedgeWins} 次`,
        '主请求超过对冲窗口未响应，备选节点率先返回。');
    }

    if (state.stalls > 0) {
      add('warn', `播放期间触发 ${state.stalls} 次卡顿熔断`,
        `停滞超过 ${cfg.stallMs / 1000} 秒即熔断切换；切换后仍频繁停滞表明整体链路拥塞。`);
    }

    if (t.warmUpgradeAt != null) {
      add('ok', '缓存预热完成，已升级至主力节点',
        `第 ${Math.round((t.warmUpgradeAt - t.t0) / 1000)} 秒起流量切换至主力节点。`);
    } else if (cid && state.warmTimers[cid]) {
      add('info', '后台缓存预热进行中', '周期性探测主力节点缓存，就绪后自动升级路由。');
    }

    const withData = enabledHosts().filter(p => p.coldReliable)
      .map(p => health[p.host]).filter(h => h && h.ok > 0 && h.mbps > 0);
    const allSlow = withData.length >= 2 && withData.every(h => h.mbps < 3);
    if (allSlow) {
      add('warn', '全部备选节点吞吐低于 3Mbps',
        '瓶颈疑为跨境链路整体拥塞或本地网络受限，节点切换收益有限。');
    }
    if (!out.length) {
      add('info', '未检测到显著异常', '会话数据有限，卡顿发生后点击「刷新分析」复查。');
    }
    return out;
  }

  function buildDiagReport() {
    const cid = state.activeCid;
    const t = (cid && state.timeline[cid]) || {};
    const lines = [];
    lines.push(`B站CDN优化器 诊断报告 v${VERSION}  ${new Date().toLocaleString()}`);
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

  // ═══════════════ §11 UI（设计语言 "Aurora"） ═══════════════
  // 核心可视化：多源装载并行泳道，空闲时降级为近20秒节点供给分布

  const TABS = [
    ['status', '状态'],
    ['diag', '诊断'],
    ['nodes', '节点'],
    ['test', '测速'],
    ['settings', '设置'],
    ['logs', '日志'],
  ];

  // 节点色彩编码：主机名 → 稳定色相，全UI一致
  const hueCache = {};
  function hostHue(h) {
    if (hueCache[h] != null) return hueCache[h];
    let s = 2166136261;
    for (let i = 0; i < h.length; i++) { s ^= h.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
    return (hueCache[h] = s % 360);
  }
  function hostColor(h, l) { return `hsl(${hostHue(String(h))} 68% ${l || 62}%)`; }
  // 极简主机名：仅保留区分性词根（cosov / ali / hw / 08c / akam），用于泳道与图例
  function tinyHost(h) {
    return String(h || '—')
      .replace(/\.bilivideo\.com$|\.akamaized\.net$/, '')
      .replace(/^upos-[a-z]{2}-mirror/, '').replace(/^upos-tf-all-/, 'tf·')
      .replace(/^upos-/, '') || '—';
  }

  function css() {
    const A = cfg.accent;
    return `
#bco-fab, #bco-panel { --bco-a:${A}; --bco-t1:#eef1f5; --bco-t2:#9aa4af; --bco-t3:#6b747f;
  --bco-ok:#54c974; --bco-warn:#e6a23c; --bco-err:#e05c5c;
  --bco-line:rgba(255,255,255,.075); --bco-fill:rgba(255,255,255,.045);
  --bco-ease:cubic-bezier(.33,.9,.25,1); --bco-spring:cubic-bezier(.34,1.35,.4,1);
  font-family:-apple-system,"SF Pro Text","Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased; }
#bco-fab *, #bco-panel * { box-sizing:border-box; }

/* ═══ 悬浮球 ═══ */
#bco-fab { position:fixed; z-index:2147483000; right:24px; bottom:120px; width:58px; height:58px;
  border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center;
  background:radial-gradient(120% 120% at 30% 18%, rgba(255,255,255,.15), rgba(255,255,255,0) 45%),
             linear-gradient(150deg, rgba(38,43,51,.96), rgba(21,24,29,.96));
  color:var(--bco-t1); cursor:pointer; user-select:none; border:1px solid rgba(255,255,255,.1);
  box-shadow:0 6px 22px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(8px); opacity:.94;
  transition:transform .2s var(--bco-spring), box-shadow .2s var(--bco-ease), opacity .2s; }
#bco-fab:hover { transform:scale(1.07); opacity:1; box-shadow:0 10px 30px rgba(0,0,0,.55); }
#bco-fab:active { transform:scale(.95); transition-duration:.08s; }
#bco-fab.bco-dragging { transform:scale(1.1); cursor:grabbing; }
#bco-fab::before { content:''; position:absolute; inset:-3px; border-radius:50%; padding:2px; opacity:0;
  background:conic-gradient(from 0deg, var(--bco-a), rgba(255,255,255,0) 30%, rgba(255,255,255,0) 62%, var(--bco-a) 92%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude;
  transition:opacity .35s var(--bco-ease); }
#bco-fab[data-live="1"]::before { opacity:.95; animation:bcoSpin 1.5s linear infinite; }
@keyframes bcoSpin { to { transform:rotate(360deg); } }
#bco-fab .bco-spd { font-size:14px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.05; }
#bco-fab .bco-unit { font-size:7.5px; color:var(--bco-t3); letter-spacing:.1em; margin-top:1px; }
#bco-fab[data-st="off"] .bco-spd { color:var(--bco-t3); font-size:12px; }
#bco-fab .bco-led { position:absolute; top:7px; right:9px; width:7px; height:7px; border-radius:50%;
  background:var(--bco-t3); transition:background .3s, box-shadow .3s; }
#bco-fab[data-st="ok"] .bco-led { background:var(--bco-ok); box-shadow:0 0 6px var(--bco-ok); }
#bco-fab[data-st="warn"] .bco-led { background:var(--bco-warn); box-shadow:0 0 6px var(--bco-warn); }
#bco-fab[data-st="err"] .bco-led { background:var(--bco-err); box-shadow:0 0 7px var(--bco-err); animation:bcoBlink 1.1s ease infinite; }
@keyframes bcoBlink { 50% { opacity:.3; } }
#bco-fab.bco-hidden, #bco-panel.bco-hidden { display:none !important; }

/* ═══ 面板骨架 · 开合动画 ═══ */
#bco-panel { position:fixed; z-index:2147483001; right:24px; bottom:190px; width:406px; max-height:76vh;
  display:flex; flex-direction:column; overflow:hidden; border-radius:18px; color:var(--bco-t1);
  background:linear-gradient(180deg, rgba(27,30,36,.975), rgba(18,20,25,.975));
  backdrop-filter:blur(26px) saturate(1.5); border:1px solid rgba(255,255,255,.085);
  box-shadow:0 28px 70px rgba(0,0,0,.62), 0 4px 16px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06);
  font-size:12px; line-height:1.6;
  transform-origin:calc(100% - 28px) calc(100% + 46px);
  opacity:0; transform:translateY(12px) scale(.94); visibility:hidden; pointer-events:none;
  transition:opacity .2s var(--bco-ease), transform .34s var(--bco-spring), visibility 0s linear .34s; }
#bco-panel[data-open="1"] { opacity:1; transform:none; visibility:visible; pointer-events:auto;
  transition:opacity .2s var(--bco-ease), transform .38s var(--bco-spring), visibility 0s; }

#bco-head { display:flex; align-items:center; gap:9px; padding:13px 14px 10px 16px; flex:none; }
#bco-head .bco-hled { width:8px; height:8px; border-radius:50%; background:var(--bco-ok); flex:none;
  box-shadow:0 0 8px var(--bco-ok); transition:background .3s, box-shadow .3s; }
#bco-head .bco-hled[data-st="off"] { background:var(--bco-t3); box-shadow:none; }
#bco-head .bco-hled[data-st="warn"] { background:var(--bco-warn); box-shadow:0 0 8px var(--bco-warn); }
#bco-head .bco-hled[data-st="err"] { background:var(--bco-err); box-shadow:0 0 8px var(--bco-err); }
#bco-head .bco-htxt { display:flex; flex-direction:column; line-height:1.25; }
#bco-head .bco-title { font-size:13.5px; font-weight:700;
  background:linear-gradient(92deg, var(--bco-a), #8fd3ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
#bco-head .bco-sub { font-size:9.5px; color:var(--bco-t3); font-variant-numeric:tabular-nums; }
#bco-head .bco-x { margin-left:auto; width:26px; height:26px; border-radius:8px; border:none; cursor:pointer;
  background:transparent; color:var(--bco-t3); font-size:15px; line-height:1; display:flex; align-items:center; justify-content:center;
  transition:background .16s, color .16s, transform .16s var(--bco-spring); }
#bco-head .bco-x:hover { background:rgba(255,255,255,.08); color:var(--bco-t1); }
#bco-head .bco-x:active { transform:scale(.88); }

/* ═══ 标签栏 · 滑动指示器 ═══ */
#bco-tabs { position:relative; display:flex; padding:0 10px; flex:none;
  border-bottom:1px solid var(--bco-line); }
#bco-tabs button { flex:1; background:none; border:none; color:var(--bco-t2); font-size:12px;
  padding:7px 0 9px; cursor:pointer; position:relative; z-index:1; font-family:inherit;
  transition:color .18s var(--bco-ease); }
#bco-tabs button:hover { color:var(--bco-t1); }
#bco-tabs button.bco-on { color:var(--bco-a); font-weight:600; }
#bco-tabind { position:absolute; bottom:-1px; height:2px; border-radius:2px 2px 0 0;
  background:linear-gradient(90deg, transparent, var(--bco-a) 22%, var(--bco-a) 78%, transparent);
  transition:transform .36s var(--bco-spring), width .36s var(--bco-spring); pointer-events:none; }

/* ═══ 内容区 ═══ */
#bco-body { overflow-y:auto; overflow-x:hidden; padding:12px 14px 16px; flex:1 1 auto;
  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.16) transparent; }
#bco-body::-webkit-scrollbar { width:7px; }
#bco-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.14); border-radius:4px;
  border:2px solid transparent; background-clip:padding-box; }
#bco-body::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.24); background-clip:padding-box; }
#bco-body.bco-enter > * { animation:bcoRise .34s var(--bco-ease) both; animation-delay:calc(var(--i, 0) * 42ms); }
@keyframes bcoRise { from { opacity:0; transform:translateY(9px); } to { opacity:1; transform:none; } }

/* ═══ 卡片与排版 ═══ */
.bco-card { background:var(--bco-fill); border:1px solid var(--bco-line); border-radius:13px;
  padding:11px 12px; margin-bottom:9px; transition:border-color .2s, background .2s; }
.bco-card.bco-hov:hover { border-color:rgba(255,255,255,.13); background:rgba(255,255,255,.058); }
.bco-ct { font-size:10px; font-weight:700; color:var(--bco-t3); letter-spacing:.06em; margin:0 0 8px;
  display:flex; align-items:center; gap:6px; }
.bco-ct .bco-ct-r { margin-left:auto; font-weight:500; letter-spacing:0; }
.bco-row { display:flex; align-items:center; gap:8px; font-size:11.5px; padding:3px 0; }
.bco-row .k { color:var(--bco-t2); flex:none; }
.bco-row .v { margin-left:auto; text-align:right; color:var(--bco-t1); font-variant-numeric:tabular-nums;
  word-break:break-all; }
.bco-hint { color:var(--bco-t3); font-size:10.5px; line-height:1.55; }
.bco-num { font-variant-numeric:tabular-nums; }
.bco-good { color:var(--bco-ok); } .bco-bad { color:var(--bco-err); } .bco-mut { color:var(--bco-t3); }
.bco-dot { width:7px; height:7px; border-radius:50%; flex:none; display:inline-block;
  background:var(--c, var(--bco-a)); box-shadow:0 0 6px var(--c, var(--bco-a)); }
.bco-chip { display:inline-flex; align-items:center; gap:4px; padding:1px 8px; border-radius:999px;
  font-size:10px; line-height:16px; background:rgba(255,255,255,.07); color:var(--bco-t2); white-space:nowrap; }
.bco-chip.ok { background:rgba(84,201,116,.14); color:var(--bco-ok); }
.bco-chip.warn { background:rgba(230,162,60,.14); color:var(--bco-warn); }
.bco-chip.err { background:rgba(224,92,92,.14); color:var(--bco-err); }
.bco-chip.acc { background:color-mix(in srgb, var(--bco-a) 18%, transparent); color:var(--bco-a); }

/* ═══ 状态页 · 吞吐主表 ═══ */
#bco-hero { padding:13px 14px 12px; }
.bco-hero-top { display:flex; align-items:flex-end; gap:8px; margin-bottom:11px; }
#bco-hero-val { font-size:32px; font-weight:250; line-height:.94; letter-spacing:-.02em;
  font-variant-numeric:tabular-nums; color:var(--bco-t1);
  text-shadow:0 0 26px color-mix(in srgb, var(--bco-a) 40%, transparent); }
.bco-hero-unit { font-size:11px; color:var(--bco-t3); padding-bottom:3px; }
.bco-hero-meta { margin-left:auto; text-align:right; font-size:10px; color:var(--bco-t3); line-height:1.5; }
.bco-hero-meta b { color:var(--bco-t2); font-weight:600; font-variant-numeric:tabular-nums; }
.bco-gauge { position:relative; height:9px; border-radius:999px; background:rgba(255,255,255,.06);
  overflow:hidden; margin-bottom:5px; }
#bco-gauge-fill { position:absolute; inset:0 auto 0 0; width:0; border-radius:999px;
  background:linear-gradient(90deg, color-mix(in srgb, var(--bco-a) 55%, transparent), var(--bco-a));
  box-shadow:0 0 12px color-mix(in srgb, var(--bco-a) 55%, transparent);
  transition:width .32s var(--bco-ease); }
#bco-gauge-fill::after { content:''; position:absolute; right:0; top:0; bottom:0; width:22px;
  background:linear-gradient(90deg, transparent, rgba(255,255,255,.5)); }
#bco-gauge-peak { position:absolute; top:-2px; bottom:-2px; width:2px; border-radius:2px;
  background:rgba(255,255,255,.55); box-shadow:0 0 6px rgba(255,255,255,.35);
  transition:left .4s var(--bco-ease); }
#bco-spark { width:100%; height:44px; display:block; margin-top:7px; }

/* ═══ 状态页 · 多源装载器（核心可视化） ═══ */
.bco-par { display:inline-flex; gap:3px; margin-left:auto; align-items:center; }
.bco-par i { width:5px; height:5px; border-radius:50%; background:rgba(255,255,255,.16);
  transition:background .25s, transform .25s var(--bco-spring); }
.bco-par i.on { background:var(--bco-a); box-shadow:0 0 6px var(--bco-a); transform:scale(1.25); }
#bco-lanes { display:flex; flex-direction:column; gap:6px; }
.bco-lane { display:flex; align-items:center; gap:8px; animation:bcoLaneIn .3s var(--bco-spring) both; }
@keyframes bcoLaneIn { from { opacity:0; transform:translateX(-8px); } to { opacity:1; transform:none; } }
.bco-lane-host { width:74px; flex:none; font-size:10px; color:var(--bco-t2); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:5px; }
.bco-lane-track { flex:1; height:7px; border-radius:999px; background:rgba(255,255,255,.06);
  overflow:hidden; position:relative; }
.bco-lane-track > i { position:absolute; inset:0 auto 0 0; width:0; border-radius:999px;
  background:linear-gradient(90deg, color-mix(in srgb, var(--c) 45%, transparent), var(--c));
  transition:width .16s linear; }
.bco-lane[data-s="done"] .bco-lane-track > i { width:100% !important; animation:bcoFlash .5s var(--bco-ease); }
.bco-lane[data-s="fail"] .bco-lane-track > i { background:var(--bco-err); opacity:.5; }
@keyframes bcoFlash { 40% { filter:brightness(1.9); } }
.bco-lane-kb { width:46px; flex:none; text-align:right; font-size:9.5px; color:var(--bco-t3);
  font-variant-numeric:tabular-nums; }
.bco-dist { display:flex; height:11px; border-radius:999px; overflow:hidden; background:rgba(255,255,255,.05); }
.bco-dist > i { background:var(--c); transition:flex-grow .5s var(--bco-ease); position:relative; }
.bco-dist > i + i { box-shadow:inset 1px 0 0 rgba(0,0,0,.28); }
.bco-legend { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:9px; }
.bco-legend > div { display:flex; align-items:center; gap:5px; font-size:10px; color:var(--bco-t2);
  font-variant-numeric:tabular-nums; }
.bco-legend b { color:var(--bco-t1); font-weight:600; }
.bco-mstat { display:grid; grid-template-columns:repeat(4,1fr); gap:7px; margin-top:10px;
  padding-top:9px; border-top:1px solid var(--bco-line); }
.bco-mstat > div { text-align:center; }
.bco-mstat .n { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; line-height:1.2; }
.bco-mstat .l { font-size:9px; color:var(--bco-t3); margin-top:1px; }

/* ═══ 状态页 · 路由链路 ═══ */
.bco-route { display:flex; align-items:center; gap:9px; }
.bco-route .bco-node { flex:1; min-width:0; padding:7px 9px; border-radius:9px; background:rgba(255,255,255,.045);
  border:1px solid var(--bco-line); }
.bco-route .bco-node.act { border-color:color-mix(in srgb, var(--bco-a) 45%, transparent);
  background:color-mix(in srgb, var(--bco-a) 9%, transparent); }
.bco-route .bco-node .t { font-size:9px; color:var(--bco-t3); margin-bottom:2px; }
.bco-route .bco-node .h { font-size:11px; color:var(--bco-t1); display:flex; align-items:center; gap:5px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bco-arrow { flex:none; color:var(--bco-t3); font-size:13px; animation:bcoArrow 2.2s var(--bco-ease) infinite; }
@keyframes bcoArrow { 0%,100% { opacity:.35; transform:translateX(0); } 50% { opacity:1; transform:translateX(2px); } }

/* ═══ 诊断页 ═══ */
.bco-diag { position:relative; padding-left:11px; }
.bco-diag::before { content:''; position:absolute; left:0; top:11px; bottom:11px; width:3px; border-radius:3px; background:var(--bco-t3); }
.bco-diag.ok::before { background:var(--bco-ok); } .bco-diag.info::before { background:#6aa9ff; }
.bco-diag.warn::before { background:var(--bco-warn); } .bco-diag.crit::before { background:var(--bco-err); }
.bco-diag b { display:block; font-size:12px; font-weight:600; margin-bottom:3px; }
.bco-diag .d { color:var(--bco-t2); font-size:11px; line-height:1.6; }
.bco-diag .a { margin-top:7px; padding:6px 8px; border-radius:8px; background:rgba(154,208,232,.07);
  color:#9ad0e8; font-size:10.5px; line-height:1.55; }
.bco-wf { margin:5px 0; }
.bco-wf .lbl { font-size:10px; color:var(--bco-t2); display:flex; }
.bco-wf .lbl span { margin-left:auto; color:var(--bco-t3); font-variant-numeric:tabular-nums; }
.bco-wf .bar { height:7px; margin-top:3px; border-radius:999px; width:0;
  background:linear-gradient(90deg, color-mix(in srgb, var(--bco-a) 45%, transparent), var(--bco-a));
  animation:bcoGrow .7s var(--bco-ease) both; }
@keyframes bcoGrow { from { width:0 !important; } }

/* ═══ 表格 ═══ */
table.bco-t { width:100%; border-collapse:collapse; font-size:10.5px; }
.bco-t th { color:var(--bco-t3); font-weight:600; text-align:left; padding:4px 5px; font-size:9.5px;
  border-bottom:1px solid var(--bco-line); }
.bco-t td { padding:5px; border-bottom:1px solid rgba(255,255,255,.04); vertical-align:middle;
  font-variant-numeric:tabular-nums; }
.bco-t tr:last-child td { border-bottom:none; }
.bco-t tbody tr { transition:background .16s; }
.bco-t tbody tr:hover { background:rgba(255,255,255,.035); }

/* ═══ 节点页 ═══ */
.bco-nrow { display:flex; align-items:center; gap:9px; padding:9px 4px; border-bottom:1px solid rgba(255,255,255,.045); }
.bco-nrow:last-of-type { border-bottom:none; }
.bco-nrow.off { opacity:.4; }
.bco-nrow .bco-nid { flex:1; min-width:0; }
.bco-nrow .bco-nname { font-size:11.5px; display:flex; align-items:center; gap:6px; }
.bco-nrow .bco-nhost { font-size:9.5px; color:var(--bco-t3); margin-top:1px; }
.bco-nbar { height:4px; border-radius:999px; background:rgba(255,255,255,.07); margin-top:5px; overflow:hidden; }
.bco-nbar > i { display:block; height:100%; border-radius:999px; background:var(--c);
  transition:width .5s var(--bco-ease); }
.bco-nmet { width:74px; flex:none; text-align:right; font-size:10.5px; font-variant-numeric:tabular-nums; }
.bco-nmet .lo { font-size:9px; color:var(--bco-t3); }

/* ═══ 控件：开关 / 分段 / 滑杆 / 按钮 ═══ */
.bco-sw { position:relative; width:36px; height:21px; flex:none; border-radius:999px; border:none; cursor:pointer;
  background:rgba(255,255,255,.14); padding:0; transition:background .25s var(--bco-ease); }
.bco-sw > i { position:absolute; top:2.5px; left:2.5px; width:16px; height:16px; border-radius:50%;
  background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.4);
  transition:transform .28s var(--bco-spring), width .2s var(--bco-ease); }
.bco-sw:active > i { width:20px; }
.bco-sw[data-on="1"] { background:var(--bco-a); box-shadow:0 0 12px color-mix(in srgb, var(--bco-a) 45%, transparent); }
.bco-sw[data-on="1"] > i { transform:translateX(15px); }
.bco-sw:active { transform:scale(.94); }
.bco-swrow { display:flex; align-items:flex-start; gap:10px; padding:8px 0; cursor:pointer; }
.bco-swrow + .bco-swrow { border-top:1px solid rgba(255,255,255,.045); }
.bco-swrow .bco-swtxt { flex:1; min-width:0; }
.bco-swrow .bco-swtxt b { display:block; font-size:12px; font-weight:500; color:var(--bco-t1); }

.bco-seg { position:relative; display:flex; padding:3px; border-radius:10px; background:rgba(0,0,0,.28);
  border:1px solid var(--bco-line); }
.bco-seg > button { flex:1; position:relative; z-index:1; background:none; border:none; cursor:pointer;
  color:var(--bco-t2); font-size:11.5px; padding:5px 4px; border-radius:8px; font-family:inherit;
  transition:color .2s var(--bco-ease); white-space:nowrap; }
.bco-seg > button.on { color:#fff; font-weight:600; }
.bco-seg > .bco-segind { position:absolute; top:3px; bottom:3px; left:3px; border-radius:8px; z-index:0;
  background:linear-gradient(145deg, color-mix(in srgb, var(--bco-a) 92%, #fff), var(--bco-a));
  box-shadow:0 2px 10px color-mix(in srgb, var(--bco-a) 42%, transparent);
  transition:transform .34s var(--bco-spring), width .34s var(--bco-spring); }

.bco-sld { display:flex; align-items:center; gap:9px; padding:6px 0; }
.bco-sld .lb { font-size:11.5px; color:var(--bco-t2); flex:none; }
.bco-sld input[type=range] { flex:1; -webkit-appearance:none; appearance:none; height:4px; border-radius:999px;
  background:rgba(255,255,255,.12); outline:none; cursor:pointer; }
.bco-sld input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px;
  border-radius:50%; background:#fff; box-shadow:0 1px 5px rgba(0,0,0,.45);
  transition:transform .18s var(--bco-spring); }
.bco-sld input[type=range]::-webkit-slider-thumb:hover { transform:scale(1.22); }
.bco-sld input[type=range]:active::-webkit-slider-thumb { transform:scale(1.35); }
.bco-sld .vb { width:52px; flex:none; text-align:right; font-size:11px; font-weight:600; color:var(--bco-a);
  font-variant-numeric:tabular-nums; }

#bco-panel button.bco-btn, #bco-panel button.bco-ghost { border:none; border-radius:9px; padding:6px 13px;
  font-size:11.5px; cursor:pointer; font-family:inherit; transition:filter .16s, transform .12s var(--bco-spring), background .16s; }
#bco-panel button.bco-btn { background:linear-gradient(145deg, color-mix(in srgb, var(--bco-a) 92%, #fff), var(--bco-a));
  color:#fff; font-weight:600; box-shadow:0 2px 10px color-mix(in srgb, var(--bco-a) 32%, transparent); }
#bco-panel button.bco-btn:hover { filter:brightness(1.1); }
#bco-panel button.bco-ghost { background:rgba(255,255,255,.08); color:var(--bco-t1); }
#bco-panel button.bco-ghost:hover { background:rgba(255,255,255,.14); }
#bco-panel button.bco-btn:active, #bco-panel button.bco-ghost:active { transform:scale(.95); }
#bco-panel button.bco-btn:disabled { background:rgba(255,255,255,.1); color:var(--bco-t3); box-shadow:none; cursor:wait; }
#bco-panel button.bco-mini { padding:2px 9px; font-size:10px; border-radius:7px; }
.bco-btnrow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:9px; }

#bco-panel input[type=text], #bco-panel textarea, #bco-panel select {
  width:100%; background:rgba(0,0,0,.3); color:var(--bco-t1); border:1px solid var(--bco-line);
  border-radius:9px; padding:6px 9px; font-size:11.5px; outline:none; font-family:inherit;
  transition:border-color .2s, box-shadow .2s; }
#bco-panel input[type=text]:focus, #bco-panel textarea:focus, #bco-panel select:focus {
  border-color:var(--bco-a); box-shadow:0 0 0 3px color-mix(in srgb, var(--bco-a) 16%, transparent); }
#bco-panel textarea { font-family:Consolas,monospace; resize:vertical; line-height:1.55; }
#bco-panel input[type=color] { width:38px; height:26px; border:none; background:none; cursor:pointer; padding:0; }

.bco-chiprow { display:flex; flex-wrap:wrap; gap:5px; }
.bco-fchip { padding:2px 10px; border-radius:999px; font-size:10.5px; cursor:pointer; border:1px solid transparent;
  background:rgba(255,255,255,.06); color:var(--bco-t2); font-family:inherit;
  transition:background .18s, color .18s, transform .12s var(--bco-spring); }
.bco-fchip:hover { background:rgba(255,255,255,.12); color:var(--bco-t1); }
.bco-fchip:active { transform:scale(.93); }
.bco-fchip.on { background:var(--bco-a); color:#fff; font-weight:600;
  box-shadow:0 2px 8px color-mix(in srgb, var(--bco-a) 38%, transparent); }

#bco-log { font-family:Consolas,monospace; font-size:10px; line-height:1.65; max-height:300px; overflow-y:auto;
  background:rgba(0,0,0,.3); border-radius:10px; padding:8px 10px; border:1px solid var(--bco-line); }
#bco-log > div { display:flex; gap:7px; padding:1px 0; word-break:break-all; }
#bco-log .lv { width:5px; height:5px; border-radius:50%; flex:none; margin-top:6px; background:var(--bco-t3); }
#bco-log .info .lv { background:#6aa9ff; } #bco-log .ok .lv { background:var(--bco-ok); }
#bco-log .warn .lv { background:var(--bco-warn); } #bco-log .error .lv { background:var(--bco-err); }
#bco-log .tm { color:var(--bco-t3); flex:none; }
#bco-log .warn .mg { color:var(--bco-warn); } #bco-log .error .mg { color:var(--bco-err); }
#bco-log .ok .mg { color:#8fdca4; } #bco-log .mg { color:var(--bco-t2); }

details.bco-adv { margin-top:10px; border-top:1px solid var(--bco-line); padding-top:9px; }
details.bco-adv > summary { cursor:pointer; color:var(--bco-a); font-size:11px; font-weight:600; list-style:none;
  display:flex; align-items:center; gap:6px; user-select:none; }
details.bco-adv > summary::-webkit-details-marker { display:none; }
details.bco-adv > summary::before { content:'▸'; transition:transform .25s var(--bco-spring); display:inline-block; }
details.bco-adv[open] > summary::before { transform:rotate(90deg); }
details.bco-adv > div { animation:bcoRise .3s var(--bco-ease) both; padding-top:6px; }

.bco-sec { margin-bottom:13px; }
.bco-sec > h4 { margin:0 0 6px; font-size:10px; font-weight:700; color:var(--bco-t3); letter-spacing:.06em; }
.bco-empty { text-align:center; color:var(--bco-t3); font-size:11px; padding:18px 0; }

@media (prefers-reduced-motion:reduce) {
  #bco-fab, #bco-panel, #bco-panel * { animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
`;
  }

  // ═══ UI 运行时状态 ═══
  let ui = null, uiRefreshQueued = 0, activeTab = 'status', rafId = 0;
  let logFilter = { tag: 'all', onlyProblem: false };
  let heroShown = 0, gaugeCeil = 10, sessionPeak = 0;
  const AUTO_REFRESH_TABS = ['diag', 'logs'];   // 状态页走增量同步；含表单的页不自动重渲染

  function panelHasFocusedInput() {
    const ae = document.activeElement;
    return !!(ui && ae && ui.panel.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  }
  function isOpen() { return !!(ui && ui.panel.getAttribute('data-open') === '1'); }

  function openPanel() {
    if (!ui || isOpen()) return;
    ui.panel.setAttribute('data-open', '1');
    renderTab();
    startRaf();
  }
  function closePanel() {
    if (!ui || !isOpen()) return;
    ui.panel.removeAttribute('data-open');
    stopRaf();
  }

  function startRaf() {
    if (rafId || !ui) return;
    const loop = () => {
      rafId = 0;
      if (!isOpen()) return;
      if (activeTab === 'status') { tweenHero(); syncLoader(); }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function stopRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  function uiDirty() {
    if (!ui || uiRefreshQueued) return;
    uiRefreshQueued = setTimeout(() => {
      uiRefreshQueued = 0;
      if (isOpen()) {
        if (activeTab === 'status') syncStatus();
        else if (AUTO_REFRESH_TABS.includes(activeTab) && !panelHasFocusedInput()) renderTab();
      }
      refreshFab();
    }, 400);
  }
  function uiTick() {
    if (!ui) return;
    refreshFab();
    updateFullscreenVisibility();
    if (isOpen() && activeTab === 'status') { syncStatus(); drawSpark(); }
  }

  function updateFullscreenVisibility() {
    let hide = !!document.fullscreenElement;
    if (!hide) {
      const c = document.querySelector('.bpx-player-container');
      const s = c && c.getAttribute('data-screen');
      hide = s === 'web' || s === 'full';
    }
    ui.fab.classList.toggle('bco-hidden', hide);
    if (hide) closePanel();
  }

  function healthState() {
    if (!cfg.enabled) return 'off';
    const recent = state.log.slice(-6);
    if (recent.some(l => l.level === 'error')) return 'err';
    if (recent.some(l => l.level === 'warn')) return 'warn';
    return 'ok';
  }

  function refreshFab() {
    if (!ui) return;
    const f = ui.fab, st = healthState();
    f.setAttribute('data-st', st);
    f.setAttribute('data-live', (cfg.enabled && state.msActive > 0) ? '1' : '0');
    f.querySelector('.bco-spd').textContent = cfg.enabled ? (state.liveMbps > 0 ? state.liveMbps.toFixed(1) : '—') : 'OFF';
    f.querySelector('.bco-unit').textContent = cfg.enabled ? 'Mbps' : '已停用';
    const modeTxt = { auto: '自适应', smart: '轻量', force: '锁定' }[cfg.mode] || cfg.mode;
    f.title = `B站CDN优化器 v${VERSION} · ${modeTxt}模式`;
    const hled = ui.panel.querySelector('.bco-hled');
    if (hled) hled.setAttribute('data-st', st);
  }

  function drawSpark() {
    const cv = ui.panel.querySelector('#bco-spark');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const data = state.bytesWindow.map(x => x.bytes * 8 / 1e6);
    if (data.length < 2) return;
    const max = Math.max(4, ...data);
    const pad = 3 * dpr;
    const pts = data.map((v, i) => [(i / (data.length - 1)) * (W - pad * 2) + pad, H - pad - (v / max) * (H - pad * 3)]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {   // 平滑曲线：中点二次贝塞尔
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      ctx.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const stroke = ctx.getLineDash ? cfg.accent : cfg.accent;
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineTo(W - pad, H); ctx.lineTo(pad, H); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, cfg.accent + '4d'); g.addColorStop(1, cfg.accent + '00');
    ctx.fillStyle = g; ctx.fill();
  }

  // ═══ 状态页 ═══
  const STATUS_HTML = `
    <div class="bco-card" id="bco-hero" style="--i:0">
      <div class="bco-hero-top">
        <span id="bco-hero-val" class="bco-num">0.0</span><span class="bco-hero-unit">Mbps</span>
        <div class="bco-hero-meta">
          峰值 <b id="bco-m-peak">—</b><br>数据源 <b id="bco-m-src">—</b>
        </div>
      </div>
      <div class="bco-gauge"><div id="bco-gauge-fill"></div><div id="bco-gauge-peak"></div></div>
      <canvas id="bco-spark"></canvas>
    </div>

    <div class="bco-card" style="--i:1">
      <h4 class="bco-ct">多源并行装载<span class="bco-ct-r" id="bco-ms-state">空闲</span>
        <span class="bco-par" id="bco-par"></span></h4>
      <div id="bco-ms-body"></div>
      <div class="bco-mstat">
        <div><div class="n" id="bco-s-loads">0</div><div class="l">装载</div></div>
        <div><div class="n" id="bco-s-parts">0</div><div class="l">分片</div></div>
        <div><div class="n" id="bco-s-holes">0</div><div class="l">补洞</div></div>
        <div><div class="n" id="bco-s-stalls">0</div><div class="l">熔断</div></div>
      </div>
    </div>

    <div class="bco-card bco-hov" style="--i:2">
      <h4 class="bco-ct">本视频路由<span class="bco-ct-r" id="bco-warm-chip"></span></h4>
      <div class="bco-route">
        <div class="bco-node"><div class="t">调度分配</div><div class="h" id="bco-r-orig">—</div></div>
        <div class="bco-arrow">→</div>
        <div class="bco-node act"><div class="t">当前生效</div><div class="h" id="bco-r-cur">—</div></div>
      </div>
      <div style="margin-top:8px" id="bco-r-why"></div>
    </div>

    <div class="bco-card" style="--i:3">
      <h4 class="bco-ct">会话计数</h4>
      <div class="bco-row"><span class="k">URL 重写</span><span class="v" id="bco-c-rw">0</span></div>
      <div class="bco-row"><span class="k">回退成功 / 对冲命中</span><span class="v" id="bco-c-fb">0 / 0</span></div>
      <div class="bco-row"><span class="k">签名拒绝 (403)</span><span class="v" id="bco-c-403">0</span></div>
      <div class="bco-row"><span class="k">后台恢复 / 补给</span><span class="v" id="bco-c-bg">0 / 0</span></div>
      <div class="bco-row"><span class="k">运行模式</span><span class="v" id="bco-c-mode">—</span></div>
    </div>`;

  function renderStatus(el) {
    if (!el.querySelector('#bco-hero')) el.innerHTML = STATUS_HTML;
    syncStatus();
    syncLoader();
    drawSpark();
  }

  function tweenHero() {
    if (!ui) return;
    const elv = ui.panel.querySelector('#bco-hero-val');
    if (!elv) return;
    const target = cfg.enabled ? state.liveMbps : 0;
    heroShown += (target - heroShown) * 0.16;
    if (Math.abs(target - heroShown) < 0.05) heroShown = target;
    elv.textContent = heroShown.toFixed(1);
    const fill = ui.panel.querySelector('#bco-gauge-fill');
    if (fill) fill.style.width = Math.min(100, (heroShown / gaugeCeil) * 100).toFixed(1) + '%';
  }

  function syncStatus() {
    if (!ui) return;
    const p = ui.panel;
    const $ = (s) => p.querySelector(s);
    if (!$('#bco-hero')) return;
    const cid = state.activeCid;
    const verdict = cid && state.verdictByCid[cid];
    const orig = cid && state.origHostByCid[cid];
    const cur = (verdict && verdict.host) || orig;

    sessionPeak = Math.max(sessionPeak, state.liveMbps);
    gaugeCeil += (Math.max(8, sessionPeak * 1.05) - gaugeCeil) * 0.25;
    $('#bco-m-peak').textContent = sessionPeak > 0 ? sessionPeak.toFixed(1) : '—';
    $('#bco-m-src').textContent = shortHost(state.lastSegHost);
    const pk = $('#bco-gauge-peak');
    if (pk) pk.style.left = Math.min(99.4, (sessionPeak / gaugeCeil) * 100).toFixed(1) + '%';

    $('#bco-s-loads').textContent = state.msLoads;
    $('#bco-s-parts').textContent = state.msParts;
    $('#bco-s-holes').textContent = state.msHoleFills;
    $('#bco-s-holes').className = 'n' + (state.msHoleFills > 0 ? ' bco-good' : '');
    $('#bco-s-stalls').textContent = state.stalls;
    $('#bco-s-stalls').className = 'n' + (state.stalls > 0 ? ' bco-bad' : '');

    $('#bco-r-orig').innerHTML = orig
      ? `<i class="bco-dot" style="--c:${hostColor(orig)}"></i>${esc(shortHost(orig))}` : '<span class="bco-mut">等待视频…</span>';
    $('#bco-r-cur').innerHTML = cur
      ? `<i class="bco-dot" style="--c:${hostColor(cur)}"></i>${esc(shortHost(cur))}` : '<span class="bco-mut">—</span>';
    $('#bco-r-why').innerHTML = verdict
      ? `<span class="bco-chip ${verdict.host === orig ? '' : 'acc'}">${esc(verdict.why)}</span>`
      : (cid ? '<span class="bco-chip">微探测进行中</span>' : '');
    const warm = cid && state.warmTimers[cid];
    $('#bco-warm-chip').innerHTML = warm ? '<span class="bco-chip warn">缓存预热中</span>' : '';

    $('#bco-c-rw').textContent = state.rewrites;
    $('#bco-c-fb').textContent = `${state.fallbacks} / ${state.hedgeWins}`;
    const n403 = state.reqLog.filter(r => r.outcome === 'HTTP 403').length;
    $('#bco-c-403').innerHTML = n403 > 0 ? `<span class="bco-bad">${n403}</span>` : '0';
    $('#bco-c-bg').textContent = `${state.bgRecoveries} / ${state.bgRefills}`;
    $('#bco-c-mode').textContent = cfg.enabled
      ? ({ auto: '自适应', smart: '轻量替换', force: '锁定节点' }[cfg.mode] || cfg.mode) : '已停用';
  }

  // 多源装载器：在途时渲染并行泳道，空闲时渲染近20秒节点供给分布
  let laneSig = '';
  function syncLoader() {
    if (!ui) return;
    const body = ui.panel.querySelector('#bco-ms-body');
    if (!body) return;
    const lanes = (state.msLanes || []).filter(Boolean);
    const stEl = ui.panel.querySelector('#bco-ms-state');
    const par = ui.panel.querySelector('#bco-par');
    if (par) {
      const want = Math.max(laneCount(), lanes.length);
      if (par.children.length !== want) par.innerHTML = '<i></i>'.repeat(want);
      const live = lanes.filter(l => !l.done && !l.failed).length;
      [...par.children].forEach((c, i) => c.classList.toggle('on', i < live));
    }

    if (lanes.length) {
      if (stEl) stEl.textContent = `${lanes.length} 路并行`;
      const sig = 'L' + lanes.map(l => l.id + ':' + (l.host || '')).join(',');
      if (sig !== laneSig) {
        laneSig = sig;
        body.innerHTML = `<div id="bco-lanes">` + lanes.map(l => {
          const c = hostColor(l.host || '');
          return `<div class="bco-lane" data-id="${l.id}" data-s="live" style="--c:${c}" title="${esc(shortHost(l.host || ''))}">
            <span class="bco-lane-host"><i class="bco-dot" style="--c:${c}"></i>${esc(tinyHost(l.host || '…'))}</span>
            <div class="bco-lane-track"><i></i></div>
            <span class="bco-lane-kb">0K</span></div>`;
        }).join('') + `</div>`;
      }
      const nodes = body.querySelectorAll('.bco-lane');
      lanes.forEach((l, i) => {
        const n = nodes[i];
        if (!n) return;
        const pct = l.span > 0 ? Math.min(100, (l.bytes / l.span) * 100) : 0;
        n.querySelector('.bco-lane-track > i').style.width = pct.toFixed(1) + '%';
        n.querySelector('.bco-lane-kb').textContent = Math.round(l.bytes / 1024) + 'K';
        n.setAttribute('data-s', l.failed ? 'fail' : (l.done ? 'done' : 'live'));
      });
      return;
    }

    // 空闲：节点供给分布（近20秒）
    laneSig = '';
    if (stEl) stEl.textContent = '空闲';
    const now = Date.now();
    const agg = {};
    let total = 0;
    for (const f of state.hostFlow) {
      if (now - f.t > 20000) continue;
      agg[f.host] = (agg[f.host] || 0) + f.bytes;
      total += f.bytes;
    }
    const rows = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    if (!rows.length || total < 1024) {
      body.innerHTML = '<div class="bco-empty">等待媒体流量…</div>';
      return;
    }
    body.innerHTML =
      `<div class="bco-dist">` + rows.map(([h, b]) =>
        `<i style="--c:${hostColor(h)};flex:${(b / total * 1000).toFixed(0)} 0 0"></i>`).join('') + `</div>` +
      `<div class="bco-legend">` + rows.map(([h, b]) =>
        `<div title="${esc(shortHost(h))}"><i class="bco-dot" style="--c:${hostColor(h)}"></i>${esc(tinyHost(h))}
          <b>${(b / 1048576).toFixed(1)}MB</b><span class="bco-mut">${Math.round(b / total * 100)}%</span></div>`).join('') + `</div>` +
      `<div class="bco-hint" style="margin-top:8px">近 20 秒供给份额 · 共 ${(total / 1048576).toFixed(1)}MB</div>`;
  }

  // ═══ 诊断页 ═══
  function renderDiag(el) {
    const findings = diagnose();
    const icon = { ok: '✅', info: 'ℹ️', warn: '⚠️', crit: '🔴' };
    let i = 0;
    const cards = findings.map(f => `
      <div class="bco-card bco-diag ${f.sev}" style="--i:${i++}">
        <b>${icon[f.sev]} ${esc(f.title)}</b>
        <div class="d">${esc(f.detail)}</div>
        ${f.advice ? `<div class="a">💡 ${esc(f.advice)}</div>` : ''}
      </div>`).join('');

    const cid = state.activeCid;
    const t = (cid && state.timeline[cid]) || null;
    let wf = '';
    if (t) {
      const marks = [
        ['播放数据就绪', t.playinfoAt != null ? t.playinfoAt : t.sniffAt],
        ['微探测完成', t.probeEnd],
        ['路由裁决', t.verdictAt],
        ['首个分片到达', t.firstOkAt],
        ['首帧渲染', t.firstFrameAt],
      ].filter(m => m[1] != null).map(m => [m[0], Math.max(0, Math.round(m[1] - t.t0))]);
      if (marks.length) {
        const maxMs = Math.max(600, ...marks.map(m => m[1]));
        wf = `<div class="bco-card" style="--i:${i++}"><h4 class="bco-ct">起播时间线<span class="bco-ct-r">相对本视频注册</span></h4>` +
          marks.map((m, k) => `<div class="bco-wf">
            <div class="lbl">${m[0]}<span>${m[1] >= 1000 ? (m[1] / 1000).toFixed(1) + 's' : m[1] + 'ms'}</span></div>
            <div class="bar" style="width:${Math.max(2, m[1] / maxMs * 100).toFixed(1)}%;animation-delay:${k * 70}ms"></div>
          </div>`).join('') + `</div>`;
      }
    }

    const reqs = state.reqLog.slice(-24).reverse();
    const reqRows = reqs.map(r => {
      const bad = BAD_OUTCOMES.includes(r.outcome) || String(r.outcome).startsWith('HTTP');
      const cls = bad ? 'bco-bad' : (r.outcome === '成功' ? 'bco-good' : 'bco-mut');
      return `<tr>
        <td class="bco-mut">${fmtClock(r.t)}</td>
        <td title="${esc(r.host)}"><i class="bco-dot" style="--c:${hostColor(r.host || '')};width:6px;height:6px"></i> ${esc(shortHost(r.host))}${r.note ? `<br><span class="bco-mut" style="font-size:9px">${esc(r.note)}</span>` : ''}</td>
        <td class="${cls}">${esc(r.outcome)}</td>
        <td>${r.ttfb >= 0 ? r.ttfb + 'ms' : '—'}</td>
        <td>${r.mbps ? r.mbps + 'M' : (r.kb ? r.kb + 'K' : '—')}</td>
      </tr>`;
    }).join('');

    el.innerHTML = cards + wf + `
      <div class="bco-card" style="--i:${i++}">
        <h4 class="bco-ct">最近媒体请求<span class="bco-ct-r">新 → 旧</span></h4>
        <table class="bco-t">
          <thead><tr><th>时间</th><th>节点</th><th>结果</th><th>TTFB</th><th>速度</th></tr></thead>
          <tbody>${reqRows || '<tr><td colspan="5" class="bco-mut">暂无请求记录</td></tr>'}</tbody>
        </table>
      </div>
      <div class="bco-btnrow" style="--i:${i++}">
        <button class="bco-btn" id="bco-diag-export">复制完整诊断报告</button>
        <button class="bco-ghost" id="bco-diag-refresh">刷新分析</button>
      </div>`;

    el.querySelector('#bco-diag-export').addEventListener('click', (e) => {
      const btn = e.target, txt = buildDiagReport();
      const done = () => { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制完整诊断报告'; }, 1600); };
      const fb = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove(); done();
        } catch (err) { btn.textContent = '复制失败'; }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb);
      else fb();
    });
    el.querySelector('#bco-diag-refresh').addEventListener('click', () => renderTab());
  }

  // ═══ 节点页 ═══
  function renderNodes(el) {
    const pool = poolHosts().slice().sort((a, b) => healthScore(b.host) - healthScore(a.host));
    const best = Math.max(1, ...pool.map(p => (health[p.host] && health[p.host].mbps) || 0));
    const tierChip = { overseas: '<span class="bco-chip warn">海外</span>', mainland: '<span class="bco-chip ok">大陆</span>',
                       tf: '<span class="bco-chip">免流</span>', custom: '<span class="bco-chip">自定义</span>' };
    const rows = pool.map(p => {
      const h = health[p.host] || {};
      const off = cfg.disabledHosts.includes(p.host);
      const n = (h.ok || 0) + (h.fail || 0);
      const rate = n > 0 ? Math.round((h.ok || 0) / n * 100) : null;
      return `<div class="bco-nrow ${off ? 'off' : ''}">
        <div class="bco-nid">
          <div class="bco-nname"><i class="bco-dot" style="--c:${hostColor(p.host)}"></i>${esc(p.label)} ${tierChip[p.tier] || ''}</div>
          <div class="bco-nhost">${esc(shortHost(p.host))} · 成 ${h.ok || 0} / 败 <span class="${h.fail ? 'bco-bad' : ''}">${h.fail || 0}</span>${rate != null ? ` · ${rate}%` : ''}</div>
          <div class="bco-nbar" style="--c:${hostColor(p.host)}"><i style="width:${Math.min(100, ((h.mbps || 0) / best) * 100).toFixed(0)}%"></i></div>
        </div>
        <div class="bco-nmet">
          ${h.mbps ? `<b class="${h.mbps > 20 ? 'bco-good' : ''}">${h.mbps}</b>M` : '<span class="bco-mut">—</span>'}
          <div class="lo">${h.mbpsLow ? '低位 ' + h.mbpsLow + 'M' : ''}${h.ttfb ? ' · ' + h.ttfb + 'ms' : ''}</div>
        </div>
        <button class="bco-sw" data-en="${esc(p.host)}" data-on="${off ? '0' : '1'}" title="启用/停用该节点"><i></i></button>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="bco-card" style="--i:0">
        <h4 class="bco-ct">节点档案<span class="bco-ct-r">按健康分排序</span></h4>
        ${rows}
      </div>
      <div class="bco-btnrow" style="--i:1">
        <input type="text" id="bco-addhost" placeholder="upos-xxx.bilivideo.com" style="flex:1;min-width:170px">
        <button class="bco-btn" id="bco-addbtn">添加</button>
      </div>
      <div class="bco-btnrow" style="--i:2">
        <button class="bco-ghost" id="bco-resethealth">重置节点档案</button>
        ${(cfg.customHosts || []).length ? `<span class="bco-hint">自定义：${(cfg.customHosts || []).map(h => esc(shortHost(h))).join('、')}</span>` : ''}
      </div>`;

    el.querySelectorAll('[data-en]').forEach(sw => sw.addEventListener('click', () => {
      const h = sw.getAttribute('data-en');
      const on = sw.getAttribute('data-on') === '1';
      const next = on ? cfg.disabledHosts.concat([h]) : cfg.disabledHosts.filter(x => x !== h);
      const remain = poolHosts().filter(p => p.coldReliable && !next.includes(p.host));
      if (!remain.length) { log('warn', 'sys', '需至少保留一个冷内容可用节点'); return; }
      cfg.disabledHosts = next;
      sw.setAttribute('data-on', on ? '0' : '1');
      sw.closest('.bco-nrow').classList.toggle('off', on);
      saveCfg();
    }));
    el.querySelector('#bco-addbtn').addEventListener('click', () => {
      const inp = el.querySelector('#bco-addhost');
      const v = inp.value.trim();
      if (!v || RE_AKAM.test(v) || cfg.customHosts.includes(v) || !/^[\w.-]+$/.test(v)) {
        inp.style.borderColor = '#e05c5c';
        setTimeout(() => { inp.style.borderColor = ''; }, 900);
        return;
      }
      cfg.customHosts.push(v); saveCfg(); renderTab();
    });
    el.querySelector('#bco-resethealth').addEventListener('click', () => {
      Object.keys(health).forEach(k => delete health[k]);
      jsave(HEALTH_KEY, {}); renderTab();
    });
  }

  // ═══ 测速页 ═══
  let testSize = 2048;
  function renderTest(el) {
    const sizes = [[512, '512K'], [1024, '1M'], [2048, '2M'], [5120, '5M']];
    el.innerHTML = `
      <div class="bco-card" style="--i:0">
        <h4 class="bco-ct">每节点采样大小</h4>
        <div class="bco-seg" id="bco-tsize">
          ${sizes.map(([v, l]) => `<button data-v="${v}" class="${v === testSize ? 'on' : ''}">${l}</button>`).join('')}
          <i class="bco-segind"></i>
        </div>
        <div class="bco-btnrow"><button class="bco-btn" id="bco-teststart" style="flex:1">开始测速</button></div>
      </div>
      <table class="bco-t bco-card" id="bco-tres" style="--i:1;display:none"></table>`;

    const seg = el.querySelector('#bco-tsize');
    const moveSeg = () => {
      const btns = [...seg.querySelectorAll('button')];
      const idx = btns.findIndex(b => +b.getAttribute('data-v') === testSize);
      const ind = seg.querySelector('.bco-segind');
      ind.style.width = `calc((100% - 6px) / ${btns.length})`;
      ind.style.transform = `translateX(calc(${idx} * 100%))`;
    };
    requestAnimationFrame(moveSeg);
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      testSize = +b.getAttribute('data-v');
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      moveSeg();
    }));

    el.querySelector('#bco-teststart').addEventListener('click', async () => {
      const btn = el.querySelector('#bco-teststart');
      const table = el.querySelector('#bco-tres');
      btn.disabled = true; btn.textContent = '测速中…';
      table.style.display = '';
      const head = '<thead><tr><th>节点</th><th>TTFB</th><th>速度</th><th></th></tr></thead>';
      table.innerHTML = head + '<tbody></tbody>';
      const rows = [];
      const paint = () => {
        const best = Math.max(0, ...rows.map(x => x.ok ? x.mbps : 0));
        table.innerHTML = head + '<tbody>' + rows.map(x => {
          const p = poolHosts().find(pp => pp.host === x.host);
          const win = x.ok && x.mbps === best && best > 0;
          const speed = x.ok
            ? `<b class="${win ? 'bco-good' : ''}">${x.mbps} Mbps</b>`
            : `<span class="bco-bad">${esc(x.skip || (x.timeout ? '超时' : (x.deepFail ? '深部失败' : (x.status ? 'HTTP ' + x.status : '连接失败'))))}</span>`;
          return `<tr>
            <td title="${esc(x.host)}"><i class="bco-dot" style="--c:${hostColor(x.host)}"></i> ${esc(p ? p.label : '当前分配')}
              <br><span class="bco-mut" style="font-size:9px">${esc(shortHost(x.host))}</span></td>
            <td>${x.ttfb >= 0 && x.ttfb != null ? x.ttfb + 'ms' : '—'}</td>
            <td>${speed}${x.deepMbps != null ? `<br><span class="bco-mut" style="font-size:9px">头 ${x.headMbps} / 深 ${x.deepMbps}</span>` : ''}</td>
            <td>${x.ok ? `<button class="bco-mini bco-ghost" data-pick="${esc(x.host)}">锁定</button>` : ''}</td>
          </tr>`;
        }).join('') + '</tbody>';
        table.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
          cfg.pinHost = b.getAttribute('data-pick'); cfg.mode = 'force'; saveCfg();
          b.textContent = '已锁定 ✓'; b.className = 'bco-mini bco-btn';
          log('ok', 'sys', `手动锁定 ${cfg.pinHost}（已切到锁定模式）`); refreshFab();
        }));
      };
      try {
        await runSpeedTest(testSize, (r) => { rows.push(r); paint(); });
      } catch (e) {
        table.innerHTML = `<tbody><tr><td class="bco-bad">${esc(e.message)}</td></tr></tbody>`;
      }
      btn.disabled = false; btn.textContent = '重新测速';
    });
  }

  // ═══ 设置页 ═══
  function renderSettings(el) {
    const modes = [['auto', '自适应'], ['smart', '轻量'], ['force', '锁定']];
    const splits = [['size', '按分片尺寸'], ['fixed', '固定路数']];
    const pinOpts = enabledHosts().map(p =>
      `<option value="${esc(p.host)}" ${cfg.pinHost === p.host ? 'selected' : ''}>${esc(p.label)} — ${esc(shortHost(p.host))}</option>`);
    if (!enabledHosts().some(p => p.host === cfg.pinHost)) {
      pinOpts.unshift(`<option value="${esc(cfg.pinHost)}" selected>${esc(shortHost(cfg.pinHost))}（已停用）</option>`);
    }
    const sw = (id, on, title) => `
      <label class="bco-swrow"><div class="bco-swtxt"><b>${title}</b></div>
        <button class="bco-sw" id="${id}" data-on="${on ? '1' : '0'}"><i></i></button></label>`;
    const sld = (id, label, min, max, step, val, fmt) => `
      <div class="bco-sld"><span class="lb">${label}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
        <span class="vb" id="${id}-v">${fmt}</span></div>`;

    el.innerHTML = `
      <div class="bco-card" style="--i:0">
        ${sw('bco-en', cfg.enabled, '启用 CDN 优化')}
      </div>

      <div class="bco-card" style="--i:1">
        <h4 class="bco-ct">运行模式</h4>
        <div class="bco-seg" id="bco-mode">
          ${modes.map(([v, l]) => `<button data-v="${v}" class="${cfg.mode === v ? 'on' : ''}">${l}</button>`).join('')}
          <i class="bco-segind"></i>
        </div>
        <div id="bco-pin-wrap" style="margin-top:8px;${cfg.mode === 'force' ? '' : 'display:none'}">
          <select id="bco-pin">${pinOpts.join('')}</select>
        </div>
      </div>

      <div class="bco-card" style="--i:2">
        <h4 class="bco-ct">熔断与对冲参数</h4>
        ${sld('bco-stall', '卡顿熔断阈值', 1000, 6000, 250, cfg.stallMs, (cfg.stallMs / 1000).toFixed(2) + 's')}
        ${sld('bco-ttfb', '首字节超时', 1000, 4000, 250, cfg.ttfbTimeoutMs, (cfg.ttfbTimeoutMs / 1000).toFixed(2) + 's')}
        ${sld('bco-hedged', '对冲触发延迟', 300, 2000, 100, cfg.hedgeDelayMs, cfg.hedgeDelayMs + 'ms')}
      </div>

      <div class="bco-card" style="--i:3">
        <h4 class="bco-ct">多源聚合</h4>
        ${sw('bco-ms', cfg.multiSource, '多源并行聚合')}
        ${sld('bco-lanes', '聚合路数', 1, 12, 1, laneCount(), laneCount() + ' 路')}
        <div class="bco-seg" id="bco-split" style="margin-top:4px">
          ${splits.map(([v, l]) => `<button data-v="${v}" class="${cfg.msSplit === v ? 'on' : ''}">${l}</button>`).join('')}
          <i class="bco-segind"></i>
        </div>
      </div>

      <div class="bco-card" style="--i:4">
        <h4 class="bco-ct">功能开关</h4>
        ${sw('bco-hedge', cfg.hedge, '对冲请求')}
        ${sw('bco-bg', cfg.bgGuard, '后台标签页保护')}
        ${sw('bco-warm', cfg.warmPremium, '后台缓存预热')}
        ${sw('bco-jiggle', cfg.rescueJiggle, '切换后触发重新调度')}
        ${sw('bco-pcdn', cfg.replacePcdn, '重写 PCDN 节点')}
        ${sw('bco-mcdn', cfg.replaceMcdn, '重写 MCDN 节点')}
      </div>

      <details class="bco-adv" style="--i:5"><summary>高级参数与备份</summary><div>
        ${sld('bco-psize', '微探测采样', 64, 512, 64, cfg.probeSizeKB, cfg.probeSizeKB + 'KB')}
        ${sld('bco-idle', '传输空闲超时', 2000, 8000, 500, cfg.idleTimeoutMs, (cfg.idleTimeoutMs / 1000).toFixed(1) + 's')}
        ${sld('bco-partkb', '分片目标尺寸', 256, 2048, 128, cfg.msPartKB, cfg.msPartKB + 'KB')}
        ${sld('bco-minpart', '固定路数分片下限', 64, 512, 64, cfg.msMinPartKB, cfg.msMinPartKB + 'KB')}
        ${sld('bco-splitkb', '切分阈值', 256, 2048, 128, cfg.msMinSplitKB, cfg.msMinSplitKB + 'KB')}
        ${sld('bco-perhost', '单节点连接上限', 1, 3, 1, perHostLimit(), perHostLimit() + ' 连接')}
        <div class="bco-sec" style="margin-top:10px">
          <h4>节点黑名单（每行一个主机名）</h4>
          <textarea id="bco-avoid" rows="2">${esc((cfg.avoidHosts || []).join('\n'))}</textarea>
        </div>
        <div class="bco-sec">
          <h4>外观</h4>
          <div class="bco-btnrow" style="margin-top:0">
            <span class="bco-hint">主题色</span>
            <input type="color" id="bco-accent" value="${esc(cfg.accent)}">
            <button class="bco-ghost bco-mini" id="bco-posreset">悬浮球位置复位</button>
          </div>
        </div>
        <div class="bco-sec">
          <h4>配置备份</h4>
          <div class="bco-btnrow" style="margin-top:0">
            <button class="bco-ghost bco-mini" id="bco-export">导出</button>
            <button class="bco-ghost bco-mini" id="bco-import">导入</button>
            <button class="bco-ghost bco-mini" id="bco-reset">恢复默认</button>
          </div>
          <textarea id="bco-io" rows="3" style="margin-top:7px;display:none" placeholder="粘贴配置 JSON 后再点一次导入"></textarea>
        </div>
      </div></details>`;

    const $ = (s) => el.querySelector(s);
    const bindSw = (id, key, after) => {
      const b = $('#' + id);
      b.addEventListener('click', () => {
        const on = b.getAttribute('data-on') !== '1';
        b.setAttribute('data-on', on ? '1' : '0');
        cfg[key] = on; saveCfg(); refreshFab();
        if (after) after(on);
      });
    };
    bindSw('bco-en', 'enabled', (on) => log('info', 'sys', on ? '已启用' : '已停用'));
    bindSw('bco-ms', 'multiSource');
    bindSw('bco-hedge', 'hedge');
    bindSw('bco-bg', 'bgGuard');
    bindSw('bco-warm', 'warmPremium');
    bindSw('bco-jiggle', 'rescueJiggle');
    bindSw('bco-pcdn', 'replacePcdn');
    bindSw('bco-mcdn', 'replaceMcdn');

    const seg = $('#bco-mode');
    const moveSeg = () => {
      const btns = [...seg.querySelectorAll('button')];
      const idx = btns.findIndex(b => b.getAttribute('data-v') === cfg.mode);
      const ind = seg.querySelector('.bco-segind');
      ind.style.width = `calc((100% - 6px) / ${btns.length})`;
      ind.style.transform = `translateX(calc(${Math.max(0, idx)} * 100%))`;
      $('#bco-pin-wrap').style.display = cfg.mode === 'force' ? '' : 'none';
    };
    requestAnimationFrame(moveSeg);
    moveSeg();
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      cfg.mode = b.getAttribute('data-v');
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      saveCfg(); refreshFab(); moveSeg();
      log('info', 'sys', '模式切换 → ' + cfg.mode);
    }));
    $('#bco-pin').addEventListener('change', e => { cfg.pinHost = e.target.value; saveCfg(); });

    const bindSld = (id, key, fmt) => {
      const r = $('#' + id), v = $('#' + id + '-v');
      r.addEventListener('input', () => { cfg[key] = +r.value; v.textContent = fmt(cfg[key]); saveCfg(); });
    };
    bindSld('bco-stall', 'stallMs', v => (v / 1000).toFixed(2) + 's');
    bindSld('bco-ttfb', 'ttfbTimeoutMs', v => (v / 1000).toFixed(2) + 's');
    bindSld('bco-hedged', 'hedgeDelayMs', v => v + 'ms');
    bindSld('bco-psize', 'probeSizeKB', v => v + 'KB');
    bindSld('bco-idle', 'idleTimeoutMs', v => (v / 1000).toFixed(1) + 's');
    bindSld('bco-lanes', 'msLanes', v => v + ' 路');
    bindSld('bco-partkb', 'msPartKB', v => v + 'KB');
    bindSld('bco-minpart', 'msMinPartKB', v => v + 'KB');
    bindSld('bco-splitkb', 'msMinSplitKB', v => v + 'KB');
    bindSld('bco-perhost', 'msPerHost', v => v + ' 连接');

    const splitSeg = $('#bco-split');
    const moveSplit = () => {
      const btns = [...splitSeg.querySelectorAll('button')];
      const idx = btns.findIndex(b => b.getAttribute('data-v') === cfg.msSplit);
      const ind = splitSeg.querySelector('.bco-segind');
      ind.style.width = `calc((100% - 6px) / ${btns.length})`;
      ind.style.transform = `translateX(calc(${Math.max(0, idx)} * 100%))`;
    };
    requestAnimationFrame(moveSplit);
    moveSplit();
    splitSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      cfg.msSplit = b.getAttribute('data-v');
      splitSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      saveCfg(); moveSplit();
      log('info', 'sys', '切分策略 → ' + (cfg.msSplit === 'fixed' ? '固定路数' : '按分片尺寸'));
    }));

    $('#bco-avoid').addEventListener('change', e => {
      cfg.avoidHosts = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); saveCfg();
    });
    $('#bco-accent').addEventListener('input', e => { cfg.accent = e.target.value; saveCfg(); ui.style.textContent = css(); });
    $('#bco-posreset').addEventListener('click', () => { cfg.panelPos = null; saveCfg(); applyPos(); });
    $('#bco-export').addEventListener('click', () => {
      const t = $('#bco-io'); t.style.display = 'block';
      t.value = JSON.stringify({ cfg, health }, null, 1);
      t.select(); try { document.execCommand('copy'); } catch (e) {}
    });
    $('#bco-import').addEventListener('click', () => {
      const t = $('#bco-io');
      if (t.style.display === 'none') { t.style.display = 'block'; t.value = ''; t.focus(); return; }
      try {
        const obj = JSON.parse(t.value);
        if (obj.cfg) { Object.assign(cfg, obj.cfg); saveCfg(); }
        if (obj.health) { Object.assign(health, obj.health); jsave(HEALTH_KEY, health); }
        ui.style.textContent = css(); renderTab(); refreshFab(); log('ok', 'sys', '配置已导入');
      } catch (e) { alert('JSON 解析失败: ' + e.message); }
    });
    $('#bco-reset').addEventListener('click', () => {
      Object.assign(cfg, DEFAULTS, { panelPos: cfg.panelPos }); saveCfg();
      ui.style.textContent = css(); renderTab(); refreshFab(); log('info', 'sys', '已恢复默认配置');
    });
  }

  // ═══ 日志页 ═══
  function renderLog(el) {
    const TAGS = [['all', '全部'], ['route', '路由'], ['net', '网络'], ['probe', '探测'],
                  ['stall', '熔断'], ['warm', '预热'], ['sys', '系统']];
    const items = state.log.filter(l =>
      (logFilter.tag === 'all' || l.tag === logFilter.tag) &&
      (!logFilter.onlyProblem || l.level === 'warn' || l.level === 'error'));
    const lines = items.slice(-150).reverse().map(l =>
      `<div class="${l.level}"><i class="lv"></i><span class="tm">${fmtClock(l.t)}</span><span class="mg">${esc(l.msg)}</span></div>`).join('');
    el.innerHTML = `
      <div class="bco-chiprow" style="--i:0">
        ${TAGS.map(([k, n]) => `<button class="bco-fchip ${logFilter.tag === k ? 'on' : ''}" data-tag="${k}">${n}</button>`).join('')}
        <button class="bco-fchip ${logFilter.onlyProblem ? 'on' : ''}" id="bco-onlyprob">仅警告/错误</button>
      </div>
      <div id="bco-log" style="--i:1;margin-top:9px">${lines || '<div class="bco-empty">当前筛选条件下无日志</div>'}</div>
      <div class="bco-btnrow" style="--i:2">
        <button class="bco-ghost bco-mini" id="bco-logcopy">复制全部日志</button>
        <button class="bco-ghost bco-mini" id="bco-logclear">清空</button>
        <span class="bco-hint" style="margin-left:auto">共 ${state.log.length} 条 · 最新在前</span>
      </div>`;
    el.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => {
      logFilter.tag = b.getAttribute('data-tag'); renderTab();
    }));
    el.querySelector('#bco-onlyprob').addEventListener('click', () => { logFilter.onlyProblem = !logFilter.onlyProblem; renderTab(); });
    el.querySelector('#bco-logcopy').addEventListener('click', (e) => {
      const txt = state.log.map(l => `[${fmtClock(l.t)} ${fmtRel(l.t)}][${l.level}/${l.tag}] ${l.msg}`).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(() => {
          e.target.textContent = '已复制 ✓';
          setTimeout(() => { e.target.textContent = '复制全部日志'; }, 1500);
        }, () => {});
      }
    });
    el.querySelector('#bco-logclear').addEventListener('click', () => { state.log = []; renderTab(); });
  }

  const RENDERERS = { status: renderStatus, diag: renderDiag, nodes: renderNodes,
                      test: renderTest, settings: renderSettings, logs: renderLog };

  function moveTabInd() {
    if (!ui) return;
    const btn = ui.panel.querySelector(`#bco-tabs button[data-tab="${activeTab}"]`);
    const ind = ui.panel.querySelector('#bco-tabind');
    if (!btn || !ind) return;
    ind.style.width = btn.offsetWidth + 'px';
    ind.style.transform = `translateX(${btn.offsetLeft}px)`;
  }

  function renderTab() {
    if (!ui) return;
    const body = ui.panel.querySelector('#bco-body');
    const fn = RENDERERS[activeTab];
    if (!fn) return;
    body.classList.remove('bco-enter');
    void body.offsetWidth;              // 强制回流以重启入场动画
    body.scrollTop = 0;
    fn(body);
    body.classList.add('bco-enter');
    ui.panel.querySelectorAll('#bco-tabs button').forEach(b =>
      b.classList.toggle('bco-on', b.getAttribute('data-tab') === activeTab));
    moveTabInd();
    requestAnimationFrame(moveTabInd);   // 面板首帧布局完成后校正指示器
  }

  function clampPos(p) {
    const maxR = Math.max(4, (window.innerWidth || 1200) - 70);
    const maxB = Math.max(4, (window.innerHeight || 800) - 70);
    return { right: Math.min(Math.max(4, p.right), maxR), bottom: Math.min(Math.max(4, p.bottom), maxB) };
  }
  function applyPos() {
    const p = clampPos(cfg.panelPos || { right: 24, bottom: 120 });
    ui.fab.style.right = p.right + 'px';
    ui.fab.style.bottom = p.bottom + 'px';
    ui.panel.style.right = Math.min(p.right, Math.max(4, (window.innerWidth || 1200) - 418)) + 'px';
    ui.panel.style.bottom = (p.bottom + 70) + 'px';
  }

  function buildUI() {
    if (ui || !document.body) return;
    const style = document.createElement('style');
    style.textContent = css();
    document.head.appendChild(style);

    const fab = document.createElement('div');
    fab.id = 'bco-fab';
    fab.setAttribute('data-st', 'ok');
    fab.innerHTML = '<i class="bco-led"></i><span class="bco-spd">—</span><span class="bco-unit">Mbps</span>';

    const panel = document.createElement('div');
    panel.id = 'bco-panel';
    panel.innerHTML = `
      <div id="bco-head">
        <i class="bco-hled"></i>
        <div class="bco-htxt"><span class="bco-title">B站CDN优化器</span><span class="bco-sub">v${VERSION} · 实测调校</span></div>
        <button class="bco-x" title="收起面板（Esc）">✕</button>
      </div>
      <div id="bco-tabs">${TABS.map(t => `<button data-tab="${t[0]}">${t[1]}</button>`).join('')}<i id="bco-tabind"></i></div>
      <div id="bco-body"></div>`;

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    ui = { fab, panel, style };
    applyPos();

    panel.querySelectorAll('#bco-tabs button').forEach(b => b.addEventListener('click', () => {
      if (activeTab === b.getAttribute('data-tab')) return;
      activeTab = b.getAttribute('data-tab');
      renderTab();
    }));
    panel.querySelector('.bco-x').addEventListener('click', closePanel);

    // 拖拽移动 / 单击开合
    let drag = null;
    fab.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false,
               right: parseInt(fab.style.right || '24', 10), bottom: parseInt(fab.style.bottom || '120', 10) };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = drag.x - e.clientX, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; fab.classList.add('bco-dragging'); }
      if (!drag.moved) return;
      cfg.panelPos = clampPos({ right: drag.right + dx, bottom: drag.bottom - dy });
      applyPos();
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      fab.classList.remove('bco-dragging');
      if (drag.moved) saveCfg();
      else if (isOpen()) closePanel(); else openPanel();
      drag = null;
    });

    // 失焦自动收起：面板外点击 / 窗口失焦 / Esc
    document.addEventListener('mousedown', (e) => {
      if (!isOpen()) return;
      if (panel.contains(e.target) || fab.contains(e.target)) return;
      closePanel();
    }, true);
    window.addEventListener('blur', () => { if (isOpen()) closePanel(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen() && !panelHasFocusedInput()) closePanel();
    });
    window.addEventListener('resize', () => { if (ui) { applyPos(); moveTabInd(); } });

    refreshFab();
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
