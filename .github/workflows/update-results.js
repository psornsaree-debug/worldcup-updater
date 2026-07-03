// update-results.js
// ดึงผลบอล + เวลาเตะ + สถานะ จาก football-data.org แล้วเขียนลง Firestore อัตโนมัติ
// รันครั้งเดียว:   node update-results.js
// รันวนทุก 90 วิ:  node update-results.js --watch
// ต้องมี Node 18+ และติดตั้ง dependency ก่อน: npm install

import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

// ── 1) Firebase config (ชุดเดียวกับใน index.html) ────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyA1DIpl0ZD-ox-SDRFmNPAsHdlYctEx4nA",
  authDomain: "wtf-fifa-2026.firebaseapp.com",
  projectId: "wtf-fifa-2026",
  storageBucket: "wtf-fifa-2026.firebasestorage.app",
  messagingSenderId: "162163945307",
  appId: "1:162163945307:web:010519882adecfbf0a747e",
};

// ── 2) ตั้งค่า API ───────────────────────────────────────────────────────────
// สมัครคีย์ฟรีที่ https://www.football-data.org/client/register
// ใส่ผ่าน environment variable FD_API_KEY (บน GitHub ให้ใส่เป็น repo secret)
const API_KEY = process.env.FD_API_KEY || "PASTE_FOOTBALL_DATA_API_KEY";
const COMPETITION = process.env.FD_COMPETITION || "WC"; // WC = ฟุตบอลโลก
const POLL_MS = 90 * 1000;
const WATCH = process.argv.includes("--watch");

// ── 3) แปลงชื่อทีมจาก API → ชื่อทีมในเว็บ (แก้เพิ่มตามจริง) ───────────────────
const TEAM_MAP = {
  "USA": "United States",
  "United States": "United States",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Cape Verde Islands": "Cape Verde",
  "Cabo Verde": "Cape Verde",
  "Côte d'Ivoire": "Ivory Coast",
  "Congo DR": "DR Congo",
  "Korea Republic": "South Korea",
  // เพิ่มบรรทัดใหม่ได้เรื่อยๆ ถ้าเจอชื่อไม่ตรง
};

// ── 4) สายบอล ต้องตรงกับ index.html เป๊ะ ─────────────────────────────────────
const LEFT_PAIRS = [
  ["Germany", "Paraguay"], ["France", "Sweden"],
  ["South Africa", "Canada"], ["Netherlands", "Morocco"],
  ["Portugal", "Croatia"], ["Spain", "Austria"],
  ["United States", "Bosnia & Herzegovina"], ["Belgium", "Senegal"],
];
const RIGHT_PAIRS = [
  ["Brazil", "Japan"], ["Ivory Coast", "Norway"],
  ["Mexico", "Ecuador"], ["England", "DR Congo"],
  ["Argentina", "Cape Verde"], ["Australia", "Egypt"],
  ["Switzerland", "Algeria"], ["Colombia", "Ghana"],
];

// ── logic ────────────────────────────────────────────────────────────────────
const norm = (name) => (name ? (TEAM_MAP[name] || name) : null);
const pairKey = (a, b) => [a, b].sort().join(" | ");

function enumerateSlots(actual) {
  const slots = [];
  for (const side of ["left", "right"]) {
    const pairs = side === "left" ? LEFT_PAIRS : RIGHT_PAIRS;
    pairs.forEach(([a, b], i) => slots.push({ key: `${side}-0-${i}`, team1: a, team2: b }));
    let prev = pairs.map((_, i) => actual[`${side}-0-${i}`] || null);
    for (let r = 1; r < 4; r++) {
      const cur = [];
      for (let i = 0; i < prev.length / 2; i++) {
        cur.push({ key: `${side}-${r}-${i}`, team1: prev[2 * i] || null, team2: prev[2 * i + 1] || null });
      }
      slots.push(...cur);
      prev = cur.map((s) => actual[s.key] || null);
    }
  }
  slots.push({ key: "final", team1: actual["left-3-0"] || null, team2: actual["right-3-0"] || null });
  return slots;
}

// จับคู่แมทช์จาก API กับ slot ด้วย "คู่ทีม" แล้วอัปเดตทั้งผู้ชนะ + เวลาเตะ + สถานะ
function applyAll(matches, actual, fixtures, statuses) {
  let changed = false;
  for (let pass = 0; pass < 6; pass++) {
    const slots = enumerateSlots(actual);
    const lookup = {};
    slots.forEach((s) => { if (s.team1 && s.team2) lookup[pairKey(s.team1, s.team2)] = s; });
    let advanced = false;
    for (const m of matches) {
      const s = lookup[pairKey(m.home, m.away)];
      if (!s) continue;
      if (m.kickoff && fixtures[s.key] !== m.kickoff) { fixtures[s.key] = m.kickoff; changed = true; }
      if (m.status && statuses[s.key] !== m.status) { statuses[s.key] = m.status; changed = true; }
      if (m.winner && actual[s.key] !== m.winner) { actual[s.key] = m.winner; changed = true; advanced = true; }
    }
    if (!advanced) break;
  }
  return changed;
}

async function fetchMatches() {
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION}/matches`;
  const res = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.matches || [])
    .map((m) => {
      const home = norm(m.homeTeam?.name);
      const away = norm(m.awayTeam?.name);
      let winner = null;
      if (m.score?.winner === "HOME_TEAM") winner = home;
      else if (m.score?.winner === "AWAY_TEAM") winner = away;
      return { home, away, winner, status: m.status || null, kickoff: m.utcDate || null };
    })
    .filter((m) => m.home && m.away);
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

async function runOnce() {
  const ref = doc(db, "meta", "actual");
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const actual = { ...(data.selections || {}) };
  const fixtures = { ...(data.fixtures || {}) };
  const statuses = { ...(data.statuses || {}) };
  const matches = await fetchMatches();
  const changed = applyAll(matches, actual, fixtures, statuses);
  const stamp = new Date().toISOString();
  if (changed) {
    await setDoc(ref, { selections: actual, fixtures, statuses, updatedAt: Date.now(), editedBy: "auto (API)" }, { merge: true });
    console.log(`${stamp}  ✔ อัปเดตแล้ว · ผล ${Object.keys(actual).length} · เวลา/สถานะ ${Object.keys(fixtures).length} คู่`);
  } else {
    console.log(`${stamp}  – ไม่มีอะไรเปลี่ยน (ดึงมา ${matches.length} แมทช์)`);
  }
}

(async () => {
  await signInAnonymously(auth);
  await runOnce();
  if (WATCH) {
    console.log(`กำลังเฝ้าดูทุก ${POLL_MS / 1000} วินาที… (Ctrl+C เพื่อหยุด)`);
    setInterval(() => runOnce().catch((e) => console.error("ผิดพลาด:", e.message)), POLL_MS);
  } else {
    process.exit(0);
  }
})().catch((e) => { console.error("ผิดพลาด:", e.message); process.exit(1); });
