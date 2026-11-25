// ก้าวรวมใจ — ลูกเล่นของหน้าเว็บไซต์ (หน้าแรก · เครดิต)
// เน้นความนิ่ง สบายตา เหมาะสำหรับผู้สูงอายุ · ปิดการเคลื่อนไหวเองเมื่อเครื่องตั้งลดการเคลื่อนไหว
import { confetti } from './ui.js';
import { initPwa } from './pwa.js';

const root = document.documentElement;
const moving = () => root.dataset.motion !== 'off';
const $ = (s) => document.querySelector(s);

/* ---------- เผยเนื้อหาอย่างนุ่มนวลเมื่อเลื่อนถึง ---------- */
const anims = document.querySelectorAll('[data-anim]');
if (!moving() || !('IntersectionObserver' in window)) anims.forEach((el) => el.classList.add('in'));
else {
  const io = new IntersectionObserver((list) => {
    for (const e of list) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      e.target.querySelectorAll('[data-count]').forEach(countUp);
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -2% 0px', threshold: 0.05 });
  anims.forEach((el) => io.observe(el));
}

/* ---------- ตัวเลขนับขึ้น ---------- */
function countUp(el) {
  if (el.dataset.done) return; el.dataset.done = '1';
  const to = Number(el.dataset.count), dec = Number(el.dataset.dec || 0), suf = el.dataset.suffix || '';
  const fmt = (v) => v.toLocaleString('th-TH', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
  if (!moving()) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(to * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- แตะตัวละครแล้วทักทาย ---------- */
const LINES = ['ไปเดินกันเถอะ!', 'วันนี้เดินครบยัง?', 'เขย่ามือไม่นับนะ', 'ชวนเพื่อนมาด้วยสิ', '+40 แต้ม!'];
const POSES = ['happy', 'cute', 'main', 'greet'];
const buddy = $('#buddy'), say = $('#say');
let n = 0, sayTimer;
if (buddy) {
  buddy.addEventListener('click', () => {
    n += 1;
    const img = buddy.querySelector('img');
    img.src = `assets/character/${POSES[n % POSES.length]}.png`;
    buddy.classList.remove('jump'); void buddy.offsetWidth; buddy.classList.add('jump');
    if (say) {
      say.textContent = LINES[(n - 1) % LINES.length];
      say.classList.add('on');
      clearTimeout(sayTimer); sayTimer = setTimeout(() => say.classList.remove('on'), 2800);
    }
    const scene = $('#scene');
    if (scene) {
      scene.classList.add('played');
      if (moving()) confetti(scene, 18);
    }
    try { navigator.vibrate?.(30); } catch { /* ไม่เป็นไร */ }
  });
}

/* ---------- แถบรอยเท้าบอกว่าเลื่อนไปถึงไหน + เงาหัวเว็บ ---------- */
const trail = $('#trail'), head = $('#head');
const onScroll = () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  if (trail) trail.style.width = `${max > 0 ? (scrollY / max) * 100 : 0}%`;
  if (head) head.classList.toggle('lifted', scrollY > 8);
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();

initPwa();
