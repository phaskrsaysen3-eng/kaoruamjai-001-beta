// ชุดเทสต์อัตโนมัติสำหรับโหมดพักฟื้น v3.1 (Privacy-First) — ครอบคลุมทุกเคส T01–T25 จากการจำลองผู้สูงอายุ 300 ราย
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startFreeze, upgradeFreezeReason, endFreeze, recoveryWeek, updateStack, canDoStrength,
  detectAbsence, applyRetroactiveFreeze, shouldPromptFreeze, recoveryStatus,
} from '../web/js/core/plan-progress.js';
import { planModifiers, pretestGate } from '../web/js/core/safety.js';
import { exercisePlan } from '../web/js/core/exercises.js';
import { teamScore, adjustDailyGoal } from '../web/js/core/score.js';
import { hobbyTags, getHobbyOptions } from '../web/js/core/hobby.js';
import { analyzeRecoveryWalk } from '../web/js/core/gait.js';
import { compareRetest } from '../web/js/core/stats.js';

const PARQ_CLEAR = Array(7).fill(false);

describe('โหมดพักฟื้น v3.1 (Privacy-First Clinical Transition-of-Care Engine)', () => {
  it('T01: Tier 0 กดพัก (sick) 3 วันแล้วกลับมาผ่าน PAR-Q+ → ต้องยังเป็น Tier 0 ห้ามดีดเป็น 1', () => {
    const s0 = startFreeze({ tier: 0, stack: 2, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    assert.equal(s0.freeze.tierBefore, 0);
    const out = endFreeze(s0, { date: '2026-11-04', screen: { parq: PARQ_CLEAR } });
    assert.equal(out.result, 'resumed');
    assert.equal(out.state.tier, 0);
    assert.equal(out.state.recovery, null);
    assert.equal(out.effectiveTarget, 0);
  });

  it('T02: Tier 4 ขั้น D หยุด 10 วัน (sick · โซน 2) → กลับมาได้ Tier 1 + stageCap A + holdSupport + disableWeights', () => {
    const s0 = startFreeze({ tier: 4, stack: 6, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const out = endFreeze(s0, { date: '2026-11-11', screen: { parq: PARQ_CLEAR }, currentStage: 'D' });
    assert.equal(out.result, 'resumed');
    assert.equal(out.zone, 2);
    assert.equal(out.state.tier, 1);
    assert.equal(out.state.recovery.stageCap, 'A');
    assert.equal(out.state.recovery.holdSupport, true);
    assert.equal(out.state.recovery.disableWeights, true);
    assert.equal(out.state.recovery.targetTier, 4);
  });

  it('T03: exercisePlan ขณะมี recovery stageCap A (เดิมทุกค่า L9) → ทุกหมวดรวม STA (march) และ STR arm ถูกจำกัดขั้น A และไม่มีถุงทราย', () => {
    const rec = { zone: 2, stageCap: 'A', holdSupport: true, disableWeights: true, week1: true };
    const mods = planModifiers({ conditions: [], aids: [], surgery: [], meds: [] }, null, rec);
    const plan = exercisePlan({
      age: 64, sex: 'M', tier: 1, mods,
      stats: { STR: 9, STA: 9, AGI: 9, BAL: 9 },
      strParts: { chair: 9, arm: 9 },
    });
    for (const g of plan.groups) {
      assert.equal(g.stage, 'A', `หมวด ${g.stat} ต้องถูกจำกัดที่ขั้น A`);
      for (const ex of g.exercises) {
        assert.equal(ex.stage, 'A', `ท่า ${ex.id} ต้องอยู่ขั้น A`);
        assert.ok(!ex.dose.includes('ถุงทราย'), `ท่า ${ex.id} ห้ามมีถุงทรายช่วงพักฟื้น`);
      }
    }
    const strGroup = plan.groups.find((g) => g.stat === 'STR');
    assert.deepEqual(strGroup.split, { legs: 'A', arms: 'A' });
  });

  it('T04: recoveryWeek ทำ 0 วัน หรือ 1 วัน (ไม่ป่วย ไม่เหนื่อย) → ห้ามดันระดับขึ้น', () => {
    const s0 = startFreeze({ tier: 4, stack: 5, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const resumed = endFreeze(s0, { date: '2026-11-11', screen: { parq: PARQ_CLEAR } }).state;
    const w0 = recoveryWeek(resumed, { activeDays: 0, tiredDays: 0, unwell: false });
    assert.equal(w0.changed, false);
    assert.equal(w0.state.tier, 1);
    const w1 = recoveryWeek(w0.state, { activeDays: 1, tiredDays: 0, unwell: false });
    assert.equal(w1.changed, false);
    assert.equal(w1.state.tier, 1);
  });

  it('T05: recoveryWeek ทำครบ 2 วัน ไม่ป่วย เหนื่อย 1 วัน → ขยับ tier +1 และคลาย stageCap A → B', () => {
    const s0 = startFreeze({ tier: 4, stack: 5, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const resumed = endFreeze(s0, { date: '2026-11-11', screen: { parq: PARQ_CLEAR } }).state;
    const w1 = recoveryWeek(resumed, { activeDays: 2, tiredDays: 1, unwell: false });
    assert.equal(w1.changed, true);
    assert.equal(w1.state.tier, 2);
    assert.equal(w1.state.recovery.stageCap, 'B');
    assert.equal(w1.state.recovery.holdSupport, false);
  });

  it('T06: recoveryWeek มี newFall หรือ urgent ระหว่างฟื้นตัว → Auto-Relapse เข้า FROZEN ทันทีและล้าง recovery', () => {
    const s0 = startFreeze({ tier: 3, stack: 4, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const resumed = endFreeze(s0, { date: '2026-11-10', screen: { parq: PARQ_CLEAR } }).state;
    const rel = recoveryWeek(resumed, { activeDays: 2, newFall: true, date: '2026-11-15' });
    assert.equal(rel.relapsed, true);
    assert.equal(rel.state.recovery, null);
    assert.equal(rel.state.freeze.reason, 'fall');
    assert.equal(rel.state.freeze.needDoctor, true);
    assert.equal(recoveryStatus(rel.state), 'FROZEN');
  });

  it('T07: startFreeze ซ้อนขณะอยู่ recovery → ล้าง recovery เป็น null (ห้ามมี freeze และ recovery พร้อมกัน)', () => {
    const s0 = startFreeze({ tier: 3, stack: 4, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const resumed = endFreeze(s0, { date: '2026-11-10', screen: { parq: PARQ_CLEAR } }).state;
    assert.ok(resumed.recovery);
    const reFrozen = startFreeze(resumed, { date: '2026-11-13', reason: 'pain' });
    assert.equal(reFrozen.recovery, null);
    assert.ok(reFrozen.freeze);
  });

  it('T08: startFreeze วันที่ 1 sick → วันที่ 3 อัปเกรดเป็น hospital → คง since วันที่ 1, needDoctor true, เก็บทั้งสองเหตุผล', () => {
    const s1 = startFreeze({ tier: 3, stack: 4, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    assert.equal(s1.freeze.needDoctor, false);
    const s2 = upgradeFreezeReason(s1, { date: '2026-11-03', reason: 'hospital' });
    assert.equal(s2.freeze.since, '2026-11-01');
    assert.equal(s2.freeze.reason, 'hospital');
    assert.equal(s2.freeze.needDoctor, true);
    assert.deepEqual(s2.freeze.reasons, ['sick', 'hospital']);
  });

  it('T09: หยุดด้วยเหตุผล pain 3 วัน vs 10 วัน → 10 วันยกระดับคำแนะนำส่งต่อ อสม./แพทย์', () => {
    const pShort = startFreeze({ tier: 2, stack: 3, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'pain' });
    const r3 = endFreeze(pShort, { date: '2026-11-04', screen: { parq: PARQ_CLEAR } });
    assert.equal(r3.chronicPain, false);
    assert.equal(r3.painAdvice, null);

    const r10 = endFreeze(pShort, { date: '2026-11-11', screen: { parq: PARQ_CLEAR } });
    assert.equal(r10.chronicPain, true);
    assert.ok(r10.painAdvice && r10.painAdvice.includes('7 วัน'));
  });

  it('T10: เดิม Tier 4 กลับมาจาก fall (เข้าเกณฑ์ WFG เสี่ยงสูง cap = 1) → effectiveTarget = 1, requireRetest = true', () => {
    const s0 = startFreeze({ tier: 4, stack: 7, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'fall' });
    const out = endFreeze(s0, {
      date: '2026-11-06',
      screen: { parq: PARQ_CLEAR, doctorCleared: true },
      currentSafetyCap: 1,
    });
    assert.equal(out.result, 'resumed');
    assert.equal(out.zone, 3);
    assert.equal(out.effectiveTarget, 1);
    assert.equal(out.requireRetest, true);
    assert.equal(out.state.tier, 1);
    assert.equal(out.state.recovery.targetTier, 1);
  });

  it('T11: หยุดยาว 35 วัน (≥ 28 วัน) แม้เหตุผล other → โซน 3 เริ่ม Tier 1 ขั้น A และบังคับแนะนำทดสอบซ้ำหลังปรับตัว', () => {
    const s0 = startFreeze({ tier: 4, stack: 8, zeroWeeks: 0 }, { date: '2026-10-01', reason: 'other' });
    const out = endFreeze(s0, { date: '2026-11-05', screen: { parq: PARQ_CLEAR } });
    assert.equal(out.zone, 3);
    assert.equal(out.requireRetest, true);
    assert.equal(out.state.tier, 1);
    assert.equal(out.state.recovery.stageCap, 'A');
    const w1 = recoveryWeek(out.state, { activeDays: 3, tiredDays: 0, unwell: false });
    assert.equal(w1.state.tier, 1); // ห้ามไต่กลับไป Tier 4 อัตโนมัติ!
    assert.equal(w1.requireRetest, true);
    assert.equal(w1.state.needRetest, true);
  });

  it('T12: ด่านที่ 2 Privacy-First (แบบสอบถามยืนยันตนเอง) กลับมาจาก surgery ยังไม่ได้รับอนุญาต → WAITING_CLEARANCE ล็อก Tier 0', () => {
    const s0 = startFreeze({ tier: 3, stack: 5, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'surgery' });
    const out = endFreeze(s0, { date: '2026-11-15', screen: { parq: PARQ_CLEAR, doctorCleared: false } });
    assert.equal(out.result, 'need_doctor');
    assert.equal(out.effectiveTier, 0);
    assert.equal(out.waitingClearance, true);
    assert.equal(out.state.tier, 0);
    assert.equal(recoveryStatus(out.state), 'WAITING_CLEARANCE');
  });

  it('T13: กลับมาจาก hospital หรือหยุด ≥ 7 วัน → คืนธง needMedAidReview === true', () => {
    const h = startFreeze({ tier: 2, stack: 3, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'hospital' });
    const rHosp = endFreeze(h, { date: '2026-11-04', screen: { parq: PARQ_CLEAR, doctorCleared: true } });
    assert.equal(rHosp.needMedAidReview, true);

    const s7 = startFreeze({ tier: 2, stack: 3, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const r7 = endFreeze(s7, { date: '2026-11-08', screen: { parq: PARQ_CLEAR } });
    assert.equal(r7.needMedAidReview, true);

    const r3 = endFreeze(s7, { date: '2026-11-04', screen: { parq: PARQ_CLEAR } });
    assert.equal(r3.needMedAidReview, false);
  });

  it('T14: detectAbsence หายไป 6 วัน vs 7 วัน + applyRetroactiveFreeze คืนสแตกให้คงเดิม', () => {
    assert.equal(detectAbsence('2026-11-10', '2026-11-16').absent, false);
    const ab = detectAbsence('2026-11-10', '2026-11-17');
    assert.equal(ab.absent, true);
    assert.equal(ab.days, 7);
    const restored = applyRetroactiveFreeze({ tier: 3, stack: 4, zeroWeeks: 1 }, { since: '2026-11-10', reason: 'sick', restoreStack: 6 });
    assert.equal(restored.stack, 6);
    assert.equal(restored.zeroWeeks, 0);
    assert.equal(restored.freeze.retroactive, true);
  });

  it('T15: updateStack สัปดาห์เปลี่ยนผ่าน (transition: true, ทำ 0–1 วัน) → delta === 0 ห้ามหักสแตก', () => {
    const r0 = updateStack({ stack: 5, zeroWeeks: 1 }, { activeDays: 0, transition: true });
    assert.equal(r0.delta, 0);
    assert.equal(r0.stack, 5);
    assert.equal(r0.zeroWeeks, 0);
    const r3 = updateStack({ stack: 5, zeroWeeks: 0 }, { activeDays: 3, transition: true });
    assert.equal(r3.delta, 1);
    assert.equal(r3.stack, 6);
  });

  it('T16: canDoStrength ในสัปดาห์แรกของโหมดฟื้นตัว จำกัดสูงสุด 2 วัน/สัปดาห์', () => {
    const dates = ['2026-11-10', '2026-11-12'];
    assert.equal(canDoStrength(dates, '2026-11-14', { inRecoveryWeek1: false }).ok, true);
    assert.equal(canDoStrength(dates, '2026-11-14', { inRecoveryWeek1: true }).ok, false);
  });

  it('T17: recoveryWeek ชะงัก 2 สัปดาห์ติด (tiredDays ≥ 2 สองสัปดาห์ซ้อน) → stallWeeks === 2, suggestConsult === true', () => {
    const s0 = startFreeze({ tier: 3, stack: 4, zeroWeeks: 0 }, { date: '2026-11-01', reason: 'sick' });
    const resumed = endFreeze(s0, { date: '2026-11-11', screen: { parq: PARQ_CLEAR } }).state;
    const w1 = recoveryWeek(resumed, { activeDays: 3, tiredDays: 2, unwell: false });
    assert.equal(w1.stallWeeks, 1);
    assert.equal(w1.suggestConsult, false);
    const w2 = recoveryWeek(w1.state, { activeDays: 3, tiredDays: 3, unwell: false });
    assert.equal(w2.stallWeeks, 2);
    assert.equal(w2.suggestConsult, true);
  });

  it('T18: teamScore กรองสมาชิกที่ frozen ออกจากการหารเฉลี่ย (และคืน null หากพักทุกคน)', () => {
    const score = teamScore([
      { minutes: 70, goal: 70, frozen: false },
      { minutes: 50, goal: 50, frozen: false },
      { minutes: 50, goal: 50, frozen: false },
      { minutes: 0, goal: 70, frozen: true },
    ]);
    assert.equal(score, 100);
    assert.equal(teamScore([{ minutes: 0, goal: 50, frozen: true }]), null);
  });

  it('T19: adjustDailyGoal(5, ["tired", "tired"]) สำหรับ Tier 0 → คงไว้ 5 นาที ห้ามดีดเป็น 8', () => {
    assert.equal(adjustDailyGoal(5, ['tired', 'tired']), 5);
    assert.equal(adjustDailyGoal(6, ['tired', 'tired']), 5);
    assert.equal(adjustDailyGoal(15, ['tired', 'tired']), 13);
    assert.equal(adjustDailyGoal(15, ['fun', 'tired']), 15);
  });

  it('T20: hobbyTags เมื่อ frozen หรือ waitingClearance (เดิม Tier 4) → ล็อก movementMax === 0 และไม่ส่งเหตุผลการป่วย', async () => {
    const t = hobbyTags({ tier: 4, aiTags: ['no_ladder'] }, { frozen: true });
    assert.equal(t.movementMax, 0);
    assert.ok(!t.allowed.includes('cooking'));
    assert.ok(!t.tags.some((x) => /sick|fall|hospital|surgery|frozen/i.test(x)));
    const res = await getHobbyOptions(t);
    assert.equal(res.options.length, 3);
    for (const o of res.options) assert.equal(o.movement, 0);
  });

  it('T21: analyzeRecoveryWalk ผ่อนปรนเกณฑ์เดินช้าช่วงพักฟื้น (≥ 1 นาที + Talk Test)', () => {
    const ok = analyzeRecoveryWalk({ durationSec: 120, talkTestOk: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.relaxed, true);
    assert.equal(ok.talkWarn, false);
    const short = analyzeRecoveryWalk({ durationSec: 40, talkTestOk: true });
    assert.equal(short.ok, false);
    assert.equal(short.reason, 'short');
  });

  it('T22: shouldPromptFreeze แนะนำกดพักเมื่อตอบไม่สบาย/ข้อบวมติดกัน 3 วัน', () => {
    assert.equal(shouldPromptFreeze(['2026-11-19', '2026-11-20'], '2026-11-20').suggest, false);
    const p3 = shouldPromptFreeze(['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-20');
    assert.equal(p3.suggest, true);
    assert.equal(p3.days, 3);
  });

  it('T23: pretestGate จัดกลุ่มผู้เพิ่งผ่าตัดหรือนอน รพ. เข้า helper_required จนกว่าจะมีผู้ช่วย', () => {
    const base = { parq: PARQ_CLEAR, surgery: ['joint'], aids: [], conditions: [], falls: 0 };
    const noHelper = pretestGate(base, { unwell: false, chest: false, helper: false });
    assert.equal(noHelper.status, 'helper_required');
    assert.equal(noHelper.canTest, false);
    const withHelper = pretestGate(base, { unwell: false, chest: false, helper: true });
    assert.equal(withHelper.status, 'ok');
    assert.equal(withHelper.canTest, true);
  });

  it('T24: endFreeze กันกรณีวันที่เครื่องย้อนหลัง (days < 0) ไม่ให้ติดลบ', () => {
    const s0 = startFreeze({ tier: 3, stack: 4, zeroWeeks: 0 }, { date: '2026-11-15', reason: 'sick' });
    const out = endFreeze(s0, { date: '2026-11-10', screen: { parq: PARQ_CLEAR } });
    assert.equal(out.result, 'resumed');
    assert.equal(out.days, 0);
    assert.equal(out.zone, 1);
  });

  it('T25: compareRetest ไม่ซ้ำเติมเมื่อสมรรถภาพลดลงหลังป่วย คงสถิติสูงสุดไว้เสมอ', () => {
    const cmp = compareRetest({ STR: { level: 7, best: 8 }, BAL: { level: 6 } }, { STR: { level: 5 }, BAL: { level: 7 } });
    assert.equal(cmp.STR.best, 8);
    assert.equal(cmp.STR.trend, -1);
    assert.ok(cmp.STR.label.includes('ช่วงพักฟื้น'));
    assert.equal(cmp.BAL.best, 7);
    assert.equal(cmp.BAL.trend, 1);
  });
});
