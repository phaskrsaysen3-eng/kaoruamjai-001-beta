// ชุดเทสต์แกนหลักทุกโมดูล + Integration Tests ของเซิร์ฟเวอร์ Node.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { assess, bmiOf, siScore } from '../web/js/core/assess.js';
import { bodyStats, balanceLevel, mindStat, socialStat, addTraining, trainingWeek } from '../web/js/core/stats.js';
import { readinessCheck, planModifiers } from '../web/js/core/safety.js';
import { exercisePlan } from '../web/js/core/exercises.js';
import { analyze, synth } from '../web/js/core/gait.js';
import { signSession, verifySession } from '../web/js/core/sign.js';
import { addMood, moodPrompt, score2Q, familyNotice } from '../web/js/core/mood.js';
import { minutesByDay, streak, badges } from '../web/js/core/progress.js';
import { checkOption, hobbyTags, getHobbyOptions } from '../web/js/core/hobby.js';
import { createHandler } from '../server/index.mjs';

const sampleInput = () => ({
  consent: true, age: 66, sex: 'F', heightCm: 152, weightKg: 56, activityMin: 60,
  parq: [true, false, false, false, true, false, false], parqFollowUp: 'all_no', doctorCleared: false,
  stayIndependent: Array(12).fill(false), falls: 0, fallInjury: false, unableToGetUp: false, syncope: false,
  conditions: ['hypertension'], surgery: [], aids: [], meds: [],
  test: { chairStand: 13, usedArms: false, armCurl: 15, armStdWeight: false, step2min: 80, upGoSec: 5.5, balanceSecs: [10, 10, 10, 4] },
});

describe('Core Clinical & Safety Modules', () => {
  it('assess: ป้าแดง (หญิง 66, ลุก-นั่ง 13) ได้ระดับ 2 (15 นาที/วัน · 70 นาที/สัปดาห์)', () => {
    const r = assess(sampleInput());
    assert.equal(r.status, 'ok');
    assert.equal(r.tier, 2);
    assert.equal(r.dailyMin, 15);
    assert.equal(r.weeklyMin, 70);
    assert.equal(bmiOf(152, 56), 24.2);
  });

  it('assess: ไม่ยินยอม → no_consent · PAR-Q+ หน้า 2–3 ตอบใช่และยังไม่ปรึกษา → ระดับ 0', () => {
    assert.equal(assess({ ...sampleInput(), consent: false }).status, 'no_consent');
    const r = assess({ ...sampleInput(), parqFollowUp: 'any_yes', doctorCleared: false });
    assert.equal(r.tier, 0);
  });

  it('assess: เสี่ยงหกล้มสูง WFG (ล้ม 2 ครั้ง) จำกัดเพดานไว้ไม่เกินระดับ 1 แม้ลุก-นั่งเก่ง', () => {
    const inp = sampleInput();
    inp.stayIndependent[0] = true;
    inp.falls = 2;
    inp.activityMin = 180;
    inp.test.chairStand = 20;
    const r = assess(inp);
    assert.equal(r.fall.wfgHigh, true);
    assert.equal(r.tier, 1);
  });

  it('assess: ยังไม่ได้ทดสอบ (skipped) → เริ่มระดับ 1 แบบปลอดภัย ไม่เดาคะแนน', () => {
    const inp = sampleInput();
    inp.test = { skipped: true, skipReason: 'ยังไม่มีผู้ช่วย' };
    const r = assess(inp);
    assert.equal(r.tier, 1);
    assert.equal(r.untested, true);
    assert.equal(siScore(Array(12).fill(false)), 0);
  });

  it('stats: คำนวณ 6 ค่าพลัง (STR/STA/AGI/BAL/MND/SOC) และแถบฝึก 7 วัน', () => {
    const inp = sampleInput();
    const st = bodyStats({ age: inp.age, sex: inp.sex }, inp.test);
    assert.ok(st.STR.level >= 4 && st.STR.level <= 7);
    assert.ok(st.STA.level >= 4 && st.STA.level <= 7);
    assert.equal(balanceLevel([10, 10, 5, 10]).fallRisk, true);
    assert.equal(balanceLevel([10, 10, 5, 10]).level, 3);
    assert.equal(mindStat([{ date: '2026-11-20', accuracy: 1 }, { date: '2026-11-21', accuracy: 0.8 }], '2026-11-21').level, null);
    assert.ok(mindStat([{ date: '2026-11-19', accuracy: 1 }, { date: '2026-11-20', accuracy: 0.8 }, { date: '2026-11-21', accuracy: 0.9 }], '2026-11-21').level >= 8);
    assert.ok(socialStat(5, 4).level >= 6);
    const tr = addTraining([], { type: 'walk', date: '2026-11-21', metGoal: true });
    assert.equal(tr.gained, 5);
    assert.equal(trainingWeek(tr.log, '2026-11-21').STA, 5);
  });

  it('safety: NICE NG232 (หัวกระแทก+ยาต้านการแข็งตัวของเลือด → urgent), ADA (<70 พัก / 70-89+insulin กินคาร์บ), NSCA BP', () => {
    const headAnticoag = readinessCheck({ newFall: true, headStrike: true }, { anticoagulant: true });
    assert.equal(headAnticoag.status, 'urgent');
    assert.ok(headAnticoag.actions.includes('hospital_today'));

    const hypo = readinessCheck({ glucose: 65 }, { diabetes: true, insulinOrSU: true });
    assert.equal(hypo.status, 'rest');
    assert.ok(hypo.actions.includes('carb_first'));

    const preCarb = readinessCheck({ glucose: 82 }, { diabetes: true, insulinOrSU: true });
    assert.equal(preCarb.status, 'go');
    assert.ok(preCarb.actions.includes('carb_first'));

    const bpHigh = readinessCheck({ bpSys: 168, bpDia: 92 }, {});
    assert.equal(bpHigh.status, 'light');
    assert.ok(bpHigh.block.includes('STR'));

    const wheelMods = planModifiers({ aids: ['wheelchair'], conditions: ['osteo'] }, null);
    assert.equal(wheelMods.seatedOnly, true);
    const plan = exercisePlan({ age: 75, sex: 'F', tier: 1, mods: wheelMods, stats: { STR: 5, STA: 5, AGI: 5, BAL: 5 } });
    assert.equal(plan.seatedOnly, true);
  });

  it('gait & sign: แยกการเดินจริงจากการเขย่ามือ และตรวจลายเซ็น HMAC-SHA256 ป้องกันแก้/ส่งซ้ำ/ทับซ้อน', async () => {
    assert.equal(analyze(synth('walk', 200)).ok, true);
    assert.equal(analyze(synth('shake', 200)).ok, false);
    assert.equal(analyze(synth('walk', 60)).reason, 'short');

    const sess = { deviceId: 'clip-001', seq: 1, startedAt: 1700000000000, durationSec: 900, steps: 1620, cadence: 1.8, cv: 0.05, verdict: 'walk' };
    const signed = await signSession(sess, 'demo-key-clip-001');
    assert.equal((await verifySession(signed, 'demo-key-clip-001')).ok, true);
    assert.equal((await verifySession({ ...signed, steps: 9999 }, 'demo-key-clip-001')).ok, false);
    assert.equal((await verifySession(signed, 'demo-key-clip-001', { lastSeq: 1, sessions: [] })).ok, false);
  });

  it('mood & progress & hobby: ท้องฟ้าใจ 2Q, สตรีค, และการกรองคำต้องห้ามในงานอดิเรก', async () => {
    let m = [];
    m = addMood(m, '2026-11-18', 'rain');
    m = addMood(m, '2026-11-19', 'rain');
    m = addMood(m, '2026-11-20', 'rain');
    assert.equal(moodPrompt(m, '2026-11-20', null).offer2Q, true);
    assert.equal(moodPrompt(m, '2026-11-20', '2026-11-15').offer2Q, false);
    const q2 = score2Q([true, false]);
    assert.equal(q2.positive, true);
    assert.equal(familyNotice(q2, false, 'ป้าแดง'), null);
    assert.ok(familyNotice(q2, true, 'ป้าแดง').text.includes('อสม.'));

    const pd = minutesByDay([{ day: '2026-11-19', minutes: 15, counted: true }, { day: '2026-11-20', minutes: 20, counted: true }], ['2026-11-19', '2026-11-20']);
    assert.equal(streak(pd), 2);
    assert.equal(badges({ log: [{ minutes: 20, counted: true }], perDay: pd, togetherCount: 3, feelings: ['fun'], level: 6, stage: 3 }).some((b) => b.id === 'long' && b.got), true);

    const tags = hobbyTags({ tier: 2, aiTags: ['no_ladder', 'no_cooking'] });
    assert.ok(checkOption({ title: 'ปีนบันไดเก็บมะม่วง', category: 'garden', minutes: 10, movement: 2, steps: ['วางบันได', 'ปีนขึ้น'], why: 'สนุก', items: [] }, tags).length > 0);
    const opts = await getHobbyOptions(tags);
    assert.equal(opts.options.length, 3);
  });
});

describe('Node.js Server Integration Tests', () => {
  async function invoke(handler, method, url, bodyObj = null) {
    const raw = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() { if (raw) yield raw; },
    };
    let status = 200;
    let headers = {};
    const chunks = [];
    const res = {
      writeHead(s, h = {}) { status = s; headers = h; },
      end(data) { if (data !== undefined) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
    };
    await handler(req, res);
    const buf = Buffer.concat(chunks);
    return {
      status,
      headers,
      text: () => buf.toString('utf8'),
      json: () => JSON.parse(buf.toString('utf8')),
    };
  }

  it('serves HTML pages, blocks path traversal, and validates /api/health, /api/sessions, /api/hobby', async () => {
    const handler = createHandler({ geminiApiKey: '' });

    // Clean URLs
    const home = await invoke(handler, 'GET', '/');
    assert.equal(home.status, 200);
    assert.ok(home.text().includes('ก้าวรวมใจ'));

    const appPage = await invoke(handler, 'GET', '/app');
    assert.equal(appPage.status, 200);
    assert.ok(appPage.text().includes('js/extras.js'));

    const credits = await invoke(handler, 'GET', '/credits');
    assert.equal(credits.status, 200);

    // Path traversal (raw and percent-encoded) must be blocked
    const trav = await invoke(handler, 'GET', '/../../package.json');
    assert.equal(trav.status, 403);
    const travEnc = await invoke(handler, 'GET', '/%2e%2e/package.json');
    assert.equal(travEnc.status, 403);

    // /api/health
    const health = (await invoke(handler, 'GET', '/api/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.version, '3.1.0');

    // /api/sessions HMAC verification + replay protection
    const sess = { deviceId: 'clip-001', seq: 1, startedAt: Date.now() - 900000, durationSec: 900, steps: 1600, cadence: 1.78, cv: 0.06, verdict: 'walk' };
    const signed = await signSession(sess, 'demo-key-clip-001');
    const r1 = await invoke(handler, 'POST', '/api/sessions', signed);
    assert.equal(r1.status, 200);
    assert.equal(r1.json().ok, true);

    // Replay same seq must be rejected (400)
    const rReplay = await invoke(handler, 'POST', '/api/sessions', signed);
    assert.equal(rReplay.status, 400);
    assert.equal(rReplay.json().ok, false);

    // GET /api/sessions reports stored count
    const list = (await invoke(handler, 'GET', '/api/sessions?deviceId=clip-001')).json();
    assert.equal(list.lastSeq, 1);
    assert.equal(list.count, 1);

    // /api/hobby PDPA sanitized tag-only endpoint (movementMax = 0 when frozen)
    const rHobby = await invoke(handler, 'POST', '/api/hobby', {
      movementMax: 0, maxMinutes: 15, tags: ['no_ladder'],
      allowed: ['music', 'reading', 'mind', 'social', 'brain'],
      secretDisease: 'should-be-stripped',
    });
    assert.equal(rHobby.status, 200);
    const hobbyJson = rHobby.json();
    assert.equal(hobbyJson.options.length, 3);
    for (const o of hobbyJson.options) assert.equal(o.movement, 0);
  });
});
