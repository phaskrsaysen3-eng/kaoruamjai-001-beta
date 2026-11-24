// ตรวจสอบความสมบูรณ์ของไฟล์ทรัพยากร ไอคอน และการเรนเดอร์ทุกหน้าจอของ health.js + extras.js แบบ End-to-End
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

// จำลองสภาพแวดล้อมเบราว์เซอร์ขั้นต่ำสำหรับรัน health.js และ extras.js ใน Node
globalThis.location = { hash: '#/step', protocol: 'http:', origin: 'http://localhost' };
globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { defaults, todayKey } = await import('../web/js/store.js');
const { addDays, startFreeze, endFreeze } = await import('../web/js/core/plan-progress.js');
const health = await import('../web/js/health.js');
const extras = await import('../web/js/extras.js');
const { ic } = await import('../web/js/ui.js');

describe('Asset, Icon & UI Flow Integrity Tests', () => {
  it('ทุกไฟล์ใน sw.js SHELL และรูปตัวละครทุกท่าใน POSES มีอยู่จริงบนดิสก์', async () => {
    const sw = await fs.readFile(path.join(WEB_DIR, 'sw.js'), 'utf8');
    const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || '';
    const entries = [...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(entries.length >= 30);
    for (const rel of entries) {
      if (rel === './' || rel === 'app' || rel === 'credits') continue;
      const full = path.join(WEB_DIR, rel);
      const st = await fs.stat(full);
      assert.ok(st.size > 0, `ไฟล์ ${rel} ต้องมีขนาดมากกว่า 0 ไบต์`);
    }
  });

  it('ทุกชื่อไอคอน ic("...") ใน app.js, health.js, extras.js มีอยู่จริงใน ui.js', async () => {
    for (const f of ['js/app.js', 'js/health.js', 'js/extras.js']) {
      const code = await fs.readFile(path.join(WEB_DIR, f), 'utf8');
      for (const m of code.matchAll(/ic\('([a-z0-9_]+)'/g)) {
        const svg = ic(m[1]);
        assert.ok(svg.includes('<path') || svg.includes('<circle') || svg.includes('<rect'), `ไม่พบไอคอน "${m[1]}" ใน ui.js (ใช้ใน ${f})`);
      }
    }
  });

  it('เรนเดอร์ทุกหน้าจอใน health.js + extras.js ผ่านครบทุกสถานะ (ACTIVE, FROZEN, WAITING_CLEARANCE, RECOVERING, ABSENCE)', async () => {
    const state = defaults();
    const toasts = [];
    const ctx = {
      S: () => state,
      commit: () => {},
      render: () => {},
      toast: (m) => toasts.push(m),
      sheet: () => {},
      setSpeech: () => {},
      currentAssessment: () => health.currentAssessment(),
      effectiveTier: () => health.effectiveTier(),
      isServerOnline: () => false,
    };
    health.initHealth(ctx);
    extras.initExtras(ctx);

    // 1. Active state views
    health.startCheck();
    assert.ok(health.viewCheck().includes('แบบประเมิน'));
    assert.ok(health.viewPlan().includes('ท่าออกกำลังกายวันนี้'));
    assert.ok(health.charPanel().includes('สแตก'));
    assert.ok(health.moodCard().includes('ท้องฟ้าในใจวันนี้'));
    assert.ok(health.viewTwoQ().includes('คุยเรื่องใจ'));

    // 2. Absence banner >= 7 days
    state.lastActiveDate = addDays(todayKey(), -10);
    const abHtml = health.absenceBanner();
    assert.ok(abHtml.includes('ไม่เจอกัน 10 วัน'));
    assert.ok(abHtml.includes('ใช่ พักรักษาตัว'));

    // 3. Frozen (surgery 35 days) -> viewPlan & Privacy-First viewReturn (NO medical certificate!)
    state.progress = startFreeze(state.progress, { date: addDays(todayKey(), -35), reason: 'surgery' });
    assert.equal(health.effectiveTier(), 0);
    const planFrozen = health.viewPlan();
    assert.ok(planFrozen.includes('กำลังพักฟื้น'));
    assert.ok(planFrozen.includes('ท่านั่งเบาๆ (ระดับ 0)'));

    const retHtml = health.viewReturn();
    assert.ok(retHtml.includes('ด่านที่ 1: คัดกรองสุขภาพ PAR-Q+ ใหม่'));
    assert.ok(retHtml.includes('ด่านที่ 2: แบบสอบถามยืนยันด้วยตนเอง'));
    assert.ok(retHtml.includes('ไม่ขอใบรับรองแพทย์'));
    assert.ok(!retHtml.includes('บัตรสรุปส่งต่อ'), 'ต้องไม่มีบัตรสรุปประวัติส่งต่อตามข้อกำหนดความเป็นส่วนตัว');

    // 4. Waiting clearance locks Tier 0
    const waitRes = endFreeze(state.progress, { date: todayKey(), screen: { parq: Array(7).fill(false), doctorCleared: false } });
    state.progress = waitRes.state;
    assert.equal(health.effectiveTier(), 0);
    assert.ok(health.viewPlan().includes('รอสอบถามแพทย์/เจ้าหน้าที่'));

    // 5. Hobby quest locked to movementMax: 0 when frozen/waitingClearance
    await extras.loadHobbyOptions(true);
    const hobbyFrozenHtml = extras.viewHobby();
    assert.ok(hobbyFrozenHtml.includes('movementMax: 0'));
    assert.ok(hobbyFrozenHtml.includes('นั่งนิ่ง'));

    // 6. Resume after self-report confirmation -> RECOVERING Zone 3
    const resOk = endFreeze(state.progress, { date: todayKey(), screen: { parq: Array(7).fill(false), doctorCleared: true }, currentSafetyCap: 2 });
    state.progress = resOk.state;
    assert.equal(health.effectiveTier(), 1);
    assert.equal(health.isRecoveryWalkMode(), true);
    const planRec = health.viewPlan();
    assert.ok(planRec.includes('โหมดค่อยๆ ฟื้นตัว'));

    // 7. Brain mini-game view renders cleanly
    assert.ok(extras.brainPromoCard().includes('มินิเกมฝึกสมอง'));
    assert.ok(extras.viewBrain().includes('จับคู่คำความจำ'));
  });

  it('โหลดและเรนเดอร์ app.js ครบทุกหน้าจอ (รวมก๊วนพักฟื้นทั้งก๊วน score === null) ไม่มี error', async () => {
    const mkEl = () => ({
      dataset: {},
      classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} },
      innerHTML: '',
      scrollTop: 0,
      addEventListener: () => {},
      querySelector: () => null,
      closest: () => null,
    });
    const appEl = mkEl();
    const demoEl = mkEl();
    const introEl = mkEl();
    const listeners = {};
    const storeMap = new Map();

    globalThis.localStorage = {
      getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
      setItem: (k, v) => storeMap.set(k, String(v)),
      removeItem: (k) => storeMap.delete(k),
    };
    globalThis.window = {
      addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
      scrollTo: () => {},
    };
    globalThis.matchMedia = () => ({ matches: false });
    globalThis.history = { replaceState: () => {} };
    globalThis.document = {
      title: '',
      hidden: false,
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      getElementById: (id) => ({ app: appEl, demo: demoEl, intro: introEl }[id] || null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    };
    const origSetInterval = globalThis.setInterval;
    const origSetTimeout = globalThis.setTimeout;
    const timers = [];
    globalThis.setInterval = (fn, ms) => { const id = origSetInterval(fn, ms); timers.push(['i', id]); return id; };
    globalThis.setTimeout = (fn, ms) => { const id = origSetTimeout(fn, ms); timers.push(['t', id]); return id; };

    try {
      // ตั้งข้อมูลตัวอย่างไว้ใน localStorage เพื่อให้เปิดเข้าหน้าแอปหลักได้ทันที
      localStorage.setItem('kaoruamjai.v2', JSON.stringify(defaults()));
      await import('../web/js/app.js');
      assert.equal(globalThis.window.__krjOk, true);

      const routes = ['step', 'plan', 'check', 'device', 'history', 'me', 'hobby', 'brain', 'twoq', 'team', 'league', 'invite', 'family', 'settings', 'welcome'];
      for (const r of routes) {
        globalThis.location.hash = `#/${r}`;
        for (const fn of listeners.hashchange || []) fn();
        assert.ok(appEl.innerHTML.length > 100, `หน้า #/${r} ต้องเรนเดอร์เนื้อหาได้สมบูรณ์`);
      }

      // ทดสอบกรณีสมาชิกในก๊วนทุกคนพักฟื้น (teamScore === null) ต้องไม่พังบนหน้า #/team และ #/league
      const allFrozen = defaults();
      for (const m of allFrozen.team.members) m.frozen = true;
      allFrozen.progress = startFreeze(allFrozen.progress, { date: todayKey(), reason: 'sick' });
      localStorage.setItem('kaoruamjai.v2', JSON.stringify(allFrozen));
      globalThis.location.hash = '#/team';
      for (const fn of listeners.hashchange || []) fn();
      assert.ok(appEl.innerHTML.includes('ก๊วนบ้านสวน'));
      globalThis.location.hash = '#/league';
      for (const fn of listeners.hashchange || []) fn();
      assert.ok(appEl.innerHTML.includes('ลีกตำบล'));
    } finally {
      for (const [kind, id] of timers) { if (kind === 'i') clearInterval(id); else clearTimeout(id); }
      globalThis.setInterval = origSetInterval;
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
