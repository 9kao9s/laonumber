/* ============================================================
   LUCKY · หน้าลูกค้า
   ------------------------------------------------------------
   หลักการเรื่องความเร็ว
   1. ไม่ import library อะไรตอนเริ่ม ยิง fetch ตรงไปเลย
      supabase-js ถูกโหลดทีหลังเฉพาะตอนจะต่อ realtime
   2. ข้อมูลที่ต้องใช้วาดกระดาน (ค่าตั้งค่า + งวด + เลขที่ถูกจอง)
      รวมเป็น rpc ตัวเดียว board_state() ยิงรอบเดียวจบ
   3. LIFF เริ่มพร้อมกันแบบขนาน ไม่ต้องรอกัน
   4. การถามว่า "เราเคยจองไปแล้วหรือยัง" ไม่ขวางการวาดกระดาน
      เพราะกระดานไม่ได้ต้องรู้เรื่องนั้น
   ============================================================ */

const CFG = window.LUCKY;
const KEY = CFG.SUPABASE_ANON_KEY;
const $ = (id) => document.getElementById(id);

const S = {
  mode: "top",
  top: null,
  bottom: null,
  draw: null,
  open: false,
  settings: {},
  taken: { top: new Map(), bottom: new Map() },
  mine: null,
  ref: "",
  invite: "",
  liff: { ready: false, name: "", canShare: false },
  busy: false,
};

/* ── เรียกเซิร์ฟเวอร์ ─────────────────────────────────── */
async function rpc(name, body) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "apikey": KEY,
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  return await res.json();
}

async function callFn(name, payload) {
  const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${KEY}` },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

function idToken() {
  try { return liff.getIDToken() ?? ""; } catch { return ""; }
}

/* ── ตัวช่วย ──────────────────────────────────────────── */
const pad = (n) => String(n).padStart(2, "0");
const thDate = (d) => new Intl.DateTimeFormat("th-TH", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
}).format(d);

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* ── ลิงก์แนะนำ ───────────────────────────────────────── */
function readLink() {
  const q = new URLSearchParams(location.search);
  S.ref = (q.get("ref") || sessionStorage.getItem("lucky_ref") || "").slice(0, 80);
  S.invite = (q.get("i") || sessionStorage.getItem("lucky_invite") || "").slice(0, 40);
  if (S.ref) sessionStorage.setItem("lucky_ref", S.ref);
  if (S.invite) sessionStorage.setItem("lucky_invite", S.invite);
}

function trackClick() {
  if (sessionStorage.getItem("lucky_tracked")) return;
  sessionStorage.setItem("lucky_tracked", "1");

  // LINE ไม่บอกว่ามาจาก OA ตัวไหน แต่บอกได้ว่าเปิดจากแชทแบบไหน
  let ctx = {};
  try {
    if (typeof liff !== "undefined" && liff.isInClient()) {
      const c = liff.getContext() ?? {};
      ctx = { ctx_type: c.type ?? null, ctx_id: c.utouId ?? c.groupId ?? c.roomId ?? null };
    }
  } catch {}

  callFn("track-click", {
    ref: S.ref, invite: S.invite, referrer: document.referrer,
    in_line: S.liff.ready, id_token: idToken(), ...ctx,
  }).catch(() => {});
}

/* ── LINE ─────────────────────────────────────────────── */
async function initLiff() {
  if (!CFG.LIFF_ID || typeof liff === "undefined") return;
  try {
    await liff.init({ liffId: CFG.LIFF_ID });
  } catch {
    return;
  }
  if (!liff.isLoggedIn()) {
    if (liff.isInClient()) liff.login({ redirectUri: location.href });
    return;                                   // นอกแอป LINE = ดูอย่างเดียว
  }
  S.liff.ready = true;
  try { S.liff.canShare = liff.isApiAvailable("shareTargetPicker"); } catch {}
  try {
    const p = await liff.getProfile();
    S.liff.name = p.displayName ?? "";
    if (!$("playerName").value) $("playerName").value = S.liff.name.slice(0, 28);
  } catch {}
}

/* ── ข้อมูลกระดาน : รอบเดียวจบ ────────────────────────── */
async function loadBoard() {
  const d = await rpc("board_state");
  if (!d) return;

  S.settings = d.settings ?? {};
  $("heroText").textContent = S.settings.hero_text ?? "";
  document.title = (S.settings.receipt_title ?? "LUCKY") + " · จองเลขนำโชค";

  S.draw = d.draw ?? null;
  const now = Date.now();
  S.open = !!S.draw && S.draw.status === "open" &&
    (!S.draw.opens_at || now >= Date.parse(S.draw.opens_at)) &&
    (!S.draw.closes_at || now <= Date.parse(S.draw.closes_at));

  S.taken.top.clear();
  S.taken.bottom.clear();
  for (const e of d.entries ?? []) {
    S.taken.top.set(e.t, e.n);
    S.taken.bottom.set(e.b, e.n);
  }

  renderDrawTag();
  renderCounts();

  // เลขที่เลือกไว้โดนคนอื่นตัดหน้าไปแล้ว ต้องปล่อย
  if (S.top && S.taken.top.has(S.top)) S.top = null;
  if (S.bottom && S.taken.bottom.has(S.bottom)) S.bottom = null;

  renderStub(false);
  renderGrid();
  updateCta();
}

function renderDrawTag() {
  const tag = $("drawTag");
  if (!S.draw) {
    $("stubDate").textContent = "—";
    tag.textContent = "วันนี้ไม่มีงวด";
    tag.classList.remove("live");
    return;
  }
  const d = new Date(S.draw.draw_date + "T12:00:00");
  $("stubDate").textContent = new Intl.DateTimeFormat("th-TH",
    { day: "2-digit", month: "short", year: "2-digit" }).format(d);

  const now = Date.now();
  if (S.open) tag.textContent = "เปิดรับเลข";
  else if (S.draw.opens_at && now < Date.parse(S.draw.opens_at)) {
    tag.textContent = "เปิด " + new Date(S.draw.opens_at).toLocaleTimeString("th-TH",
      { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });
  } else tag.textContent = "ปิดรับแล้ว";
  tag.classList.toggle("live", S.open);
}

function renderCounts() {
  // บอกจำนวนที่ "ยังว่าง" ไม่ใช่จำนวนที่ถูกจองไปแล้ว
  $("cntTop").textContent = `ว่าง ${100 - S.taken.top.size}`;
  $("cntBottom").textContent = `ว่าง ${100 - S.taken.bottom.size}`;
}

/* ── กระดาน ───────────────────────────────────────────── */
function renderGrid() {
  const g = $("grid");
  g.classList.remove("skeleton");
  const taken = S.taken[S.mode];
  const picked = S[S.mode];
  const mineNum = S.mine
    ? (S.mode === "top" ? S.mine.top_number : S.mine.bottom_number)
    : null;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 100; i++) {
    const v = pad(i);
    const owner = taken.get(v);
    const b = document.createElement("button");
    b.type = "button";

    if (owner && v === mineNum) b.className = "cell mine";
    else if (owner) b.className = "cell taken";
    else if (v === picked) b.className = "cell picked";
    else b.className = "cell free";

    b.innerHTML = `<span class="n">${v}</span>` +
      (owner ? `<span class="who">${escapeHtml(owner)}</span>` : "");

    if (owner) {
      b.setAttribute("aria-label", `${v} จองแล้วโดย ${owner}`);
      b.onclick = () => toast(`${v} · ${owner} จองไปแล้ว`);
    } else {
      b.onclick = () => pick(v);
    }
    frag.appendChild(b);
  }
  g.replaceChildren(frag);
}

function pick(v) {
  S[S.mode] = S[S.mode] === v ? null : v;
  renderStub(true);
  renderGrid();
  // เลือกบนเสร็จแล้วพาไปฝั่งล่างให้เลย ลดการกดหนึ่งครั้ง
  if (S.mode === "top" && S.top && !S.bottom) setMode("bottom");
  else updateCta();
}

function setMode(m) {
  S.mode = m;
  $("tabTop").setAttribute("aria-selected", String(m === "top"));
  $("tabBottom").setAttribute("aria-selected", String(m === "bottom"));
  renderStub(false);
  renderGrid();
  updateCta();
}

function renderStub(animate) {
  for (const k of ["top", "bottom"]) {
    const el = $(k === "top" ? "valTop" : "valBottom");
    const slot = $(k === "top" ? "slotTop" : "slotBottom");
    const v = S[k];
    el.textContent = v ?? "--";
    el.classList.toggle("empty", !v);
    slot.classList.toggle("filled", !!v);
    slot.classList.toggle("active", S.mode === k && !v);
    if (animate && v) {
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  }
}

function updateCta() {
  const btn = $("ctaMain");
  btn.className = "cta";
  btn.disabled = false;

  if (S.mine) {
    btn.textContent = "เปิดใบจองของฉัน";
    btn.onclick = () => showSlip(S.mine);
    return;
  }
  if (!S.draw || !S.open) {
    btn.className = "cta warn";
    btn.textContent = S.settings.closed_message ?? "ยังไม่ถึงเวลาเปิดรับเลข";
    btn.disabled = true;
    return;
  }
  if (!S.liff.ready) {
    btn.className = "cta warn";
    btn.textContent = "เปิดหน้านี้ในแอป LINE เพื่อจองเลข";
    btn.disabled = true;
    return;
  }
  if (!S.top || !S.bottom) {
    btn.className = "cta ghost";
    btn.textContent = !S.top && !S.bottom
      ? "เลือกเลขบนและเลขล่าง"
      : (!S.top ? "ยังไม่ได้เลือก 2 ตัวบน" : "ยังไม่ได้เลือก 2 ตัวล่าง");
    btn.onclick = () => setMode(!S.top ? "top" : "bottom");
    return;
  }
  btn.textContent = "ดูใบจองก่อนยืนยัน";
  btn.onclick = openConfirm;
}

/* ── ยืนยัน ───────────────────────────────────────────── */
async function openConfirm() {
  const name = $("playerName").value.trim();
  if (!name) { toast("ใส่ชื่อที่จะแสดงบนกระดานก่อน"); $("playerName").focus(); return; }
  if (S.busy) return;

  S.busy = true;
  const btn = $("ctaMain");
  const label = btn.textContent;
  btn.textContent = "กำลังตรวจสิทธิ์...";
  btn.disabled = true;

  try {
    const r = await callFn("play", {
      action: "check", id_token: idToken(), top: S.top, bottom: S.bottom,
    });
    if (!r.ok) {
      toast(r.message ?? "ตรวจสอบไม่สำเร็จ");
      await loadBoard();
      return;
    }
    $("pvName").textContent = name;
    $("pvTop").textContent = S.top;
    $("pvBottom").textContent = S.bottom;
    $("pvDraw").textContent = $("stubDate").textContent;
    $("confirmErr").textContent = "";
    $("sheetConfirm").classList.add("show");
  } catch {
    toast("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง");
  } finally {
    S.busy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function submit() {
  if (S.busy) return;
  S.busy = true;
  const btn = $("btnSubmit");
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";
  $("confirmErr").textContent = "";

  try {
    const r = await callFn("play", {
      action: "submit",
      id_token: idToken(),
      name: $("playerName").value.trim(),
      top: S.top, bottom: S.bottom,
      ref: S.ref, invite: S.invite,
    });

    if (!r.ok) {
      $("confirmErr").textContent = r.message ?? "บันทึกไม่สำเร็จ";
      await loadBoard();
      return;
    }

    S.mine = r.entry;
    S.top = null;
    S.bottom = null;
    $("sheetConfirm").classList.remove("show");
    await loadBoard();
    showSlip(r.entry);
  } catch {
    $("confirmErr").textContent = "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง";
  } finally {
    S.busy = false;
    btn.disabled = false;
    btn.textContent = "ยืนยันจองเลข";
  }
}

/* ── ใบจอง (canvas) ───────────────────────────────────── */
function drawSlip(entry) {
  const c = $("slipCanvas");
  const x = c.getContext("2d");
  const W = c.width, H = c.height;

  x.fillStyle = "#F4EBD9"; x.fillRect(0, 0, W, H);

  x.strokeStyle = "#C8102E"; x.lineWidth = 8;
  x.strokeRect(26, 26, W - 52, H - 52);
  x.strokeStyle = "#C9A227"; x.lineWidth = 2;
  x.strokeRect(42, 42, W - 84, H - 84);

  const cx = W / 2;
  x.textAlign = "center"; x.fillStyle = "#23100E";

  x.font = "700 62px 'Chakra Petch', sans-serif";
  x.fillText(S.settings.receipt_title ?? "LUCKY", cx, 140);

  x.font = "400 24px 'IBM Plex Sans Thai', sans-serif";
  x.fillStyle = "#6D5540";
  wrap(x, S.settings.receipt_subtitle ?? "", cx, 182, W - 160, 30);

  x.strokeStyle = "#D8C8AA"; x.lineWidth = 2;
  x.beginPath(); x.moveTo(80, 232); x.lineTo(W - 80, 232); x.stroke();

  x.fillStyle = "#8A6F52"; x.font = "500 20px 'IBM Plex Sans Thai', sans-serif";
  x.fillText("ผู้ร่วมสนุก", cx, 278);
  x.fillStyle = "#23100E"; x.font = "600 40px 'IBM Plex Sans Thai', sans-serif";
  x.fillText(clip(entry.display_name, 22), cx, 326);

  const boxY = 380, boxH = 250, boxW = 320, gap = 36;
  const left = cx - boxW - gap / 2;
  numberBox(x, left, boxY, boxW, boxH, "2 ตัวบน", entry.top_number);
  numberBox(x, cx + gap / 2, boxY, boxW, boxH, "2 ตัวล่าง", entry.bottom_number);

  const d = entry.created_at ? new Date(entry.created_at) : new Date();
  x.fillStyle = "#6D5540"; x.font = "400 24px 'IBM Plex Sans Thai', sans-serif";
  x.fillText("งวดวันที่ " + thDate(d), cx, 700);

  x.fillStyle = "#8A6F52"; x.font = "400 20px 'IBM Plex Mono', monospace";
  x.fillText(
    "NO." + String(entry.id).padStart(6, "0") + "   " +
    d.toLocaleString("th-TH", { hour12: false, timeZone: "Asia/Bangkok" }),
    cx, 742,
  );

  x.setLineDash([10, 10]); x.strokeStyle = "#C3B091"; x.lineWidth = 2;
  x.beginPath(); x.moveTo(70, 800); x.lineTo(W - 70, 800); x.stroke();
  x.setLineDash([]);

  x.fillStyle = "#23100E"; x.font = "600 26px 'IBM Plex Sans Thai', sans-serif";
  x.fillText("ใบยืนยันการร่วมสนุก", cx, 858);
  x.fillStyle = "#6D5540"; x.font = "400 22px 'IBM Plex Sans Thai', sans-serif";
  wrap(x, "ส่งภาพนี้ให้แอดมินเพื่อยืนยันสิทธิ์ ใบจองนี้ใช้ได้เฉพาะงวดที่ระบุ",
    cx, 900, W - 200, 30);

  x.save();
  x.translate(W - 175, H - 155); x.rotate(-0.28);
  x.strokeStyle = "rgba(200,16,46,.5)"; x.lineWidth = 4;
  x.strokeRect(-95, -38, 190, 76);
  x.fillStyle = "rgba(200,16,46,.5)";
  x.font = "700 34px 'Chakra Petch', sans-serif";
  x.fillText("ยืนยันแล้ว", 0, 12);
  x.restore();
}

function numberBox(x, bx, by, bw, bh, label, value) {
  x.fillStyle = "#FFFFFF"; x.fillRect(bx, by, bw, bh);
  x.strokeStyle = "#23100E"; x.lineWidth = 3; x.strokeRect(bx, by, bw, bh);
  x.fillStyle = "#8A6F52"; x.font = "500 22px 'IBM Plex Sans Thai', sans-serif";
  x.fillText(label, bx + bw / 2, by + 46);
  x.fillStyle = "#C8102E"; x.font = "700 130px 'Chakra Petch', sans-serif";
  x.fillText(value, bx + bw / 2, by + 178);
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function wrap(x, text, cx, y, maxW, lh) {
  const words = String(text).split(" ");
  let line = "", yy = y;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (x.measureText(t).width > maxW && line) {
      x.fillText(line, cx, yy); line = w; yy += lh;
    } else line = t;
  }
  if (line) x.fillText(line, cx, yy);
}

async function showSlip(entry) {
  await document.fonts.ready.catch(() => {});
  drawSlip(entry);
  $("sheetSlip").classList.add("show");
}

async function shareSlip() {
  const btn = $("btnShare");
  const label = btn.textContent;
  const blob = await new Promise((r) => $("slipCanvas").toBlob(r, "image/jpeg", 0.9));
  if (!blob) return;

  if (S.liff.ready && S.liff.canShare) {
    btn.disabled = true;
    btn.textContent = "กำลังเตรียม...";
    try {
      const dataUrl = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(blob);
      });
      const up = await callFn("play", {
        action: "slip", id_token: idToken(),
        entry_id: S.mine?.id, image: dataUrl,
      });
      if (up.ok && up.url) {
        await liff.shareTargetPicker(
          [{ type: "image", originalContentUrl: up.url, previewImageUrl: up.url }],
          { isMultiple: false },
        );
        return;
      }
      toast(up.message ?? "ส่งไม่สำเร็จ กำลังดาวน์โหลดแทน");
    } catch (e) {
      if (e?.code === "CANCEL") return;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  const file = new File([blob], "lucky-slip.jpg", { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch { return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "lucky-slip.jpg"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── ป๊อปอัปวิธีเล่น ──────────────────────────────────── */
// รูปแบบค่าใน app_settings คือ  หัวข้อ|คำอธิบาย
// แก้ข้อความได้จากหลังบ้าน แท็บตั้งค่า โดยไม่ต้องแตะโค้ด
const HOWTO_SEEN = "LUCKY_HOWTO_V1";
const HOWTO_FALLBACK = [
  "เลือกเลขนำโชค|เลือก 2 ตัวบน 1 เลข และ 2 ตัวล่าง 1 เลข",
  "ยืนยันและส่งใบจอง|กดยืนยัน แล้วแชร์ภาพใบจองให้แอดมิน",
  "รอผลหวยลาว|ผลออกเวลา 20.30 น. ของวันเดียวกัน",
  "ถูกรางวัลทักแอดมิน|ติดต่อรับรางวัลก่อน 21.00 น.",
];

function renderHowto() {
  $("howtoTitle").textContent = S.settings.howto_title ?? "วิธีร่วมสนุก";

  const steps = [1, 2, 3, 4]
    .map((i, k) => S.settings["howto_" + i] || HOWTO_FALLBACK[k])
    .filter(Boolean);

  $("howtoSteps").innerHTML = steps.map((line) => {
    const [head, desc = ""] = String(line).split("|");
    return `<li><div><b>${escapeHtml(head.trim())}</b>` +
      (desc.trim() ? `<span>${escapeHtml(desc.trim())}</span>` : "") + `</div></li>`;
  }).join("");

  const foot = S.settings.howto_footer ?? "";
  $("howtoFoot").textContent = foot;
  $("howtoFoot").style.display = foot ? "" : "none";
}

function openHowto() {
  renderHowto();
  $("sheetHowto").classList.add("show");
}

function closeHowto() {
  $("sheetHowto").classList.remove("show");
  try { localStorage.setItem(HOWTO_SEEN, "1"); } catch {}
}

/* เปิดป๊อปอัปหรือไม่ ขึ้นกับค่า howto_mode ในหลังบ้าน
     always  เปิดทุกครั้งที่เข้าหน้านี้ รวมถึงเข้าผ่านลิงก์ ref ทุกเส้น
     once    เปิดเฉพาะคนที่ยังไม่เคยเห็น
     off     ไม่เปิดอัตโนมัติเลย กดปุ่ม ? เอาเอง
   ลิงก์ ref ทุกเส้นชี้มาที่หน้าเดียวกัน จึงใช้กติกาเดียวกันทั้งหมด */
function maybeShowHowto() {
  const mode = S.settings.howto_mode ?? "always";
  if (mode === "off") return;

  if (mode === "once") {
    let seen = false;
    try { seen = localStorage.getItem(HOWTO_SEEN) === "1"; } catch {}
    if (seen) return;
  }
  openHowto();
}

/* ── ใบจองของเรา ──────────────────────────────────────── */
async function loadMine() {
  if (!S.liff.ready) return;
  const r = await callFn("play", { action: "receipt", id_token: idToken() })
    .catch(() => null);
  if (r?.ok) {
    S.mine = r.entry;
    renderGrid();
    updateCta();
  }
}

/* ── realtime : โหลด library ทีหลัง ไม่ให้ขวางหน้าแรก ─── */
async function subscribeBoard() {
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(CFG.SUPABASE_URL, KEY, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 3 } },
    });
    sb.channel("board")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "entries" },
        () => loadBoard())
      .subscribe();
  } catch {
    // ต่อ realtime ไม่ได้ก็ไม่เป็นไร ยังมี poll สำรองอยู่
  }
}

/* ── เริ่มทำงาน ───────────────────────────────────────── */
(function start() {
  $("tabTop").onclick = () => setMode("top");
  $("tabBottom").onclick = () => setMode("bottom");
  $("btnBack").onclick = () => $("sheetConfirm").classList.remove("show");
  $("btnSubmit").onclick = submit;
  $("btnCloseSlip").onclick = () => $("sheetSlip").classList.remove("show");
  $("btnShare").onclick = shareSlip;
  $("btnHelp").onclick = openHowto;
  $("btnHowtoClose").onclick = closeHowto;
  $("sheetHowto").onclick = (e) => { if (e.target.id === "sheetHowto") closeHowto(); };
  $("ctaRecover").onclick = async () => {
    await loadMine();
    if (S.mine) showSlip(S.mine);
    else toast("ยังไม่พบใบจองของคุณในงวดนี้");
  };

  readLink();

  // ยิงพร้อมกันทั้งคู่ ไม่รอกัน
  const board = loadBoard();
  const line = initLiff();

  board.then(() => {
    maybeShowHowto();      // รอให้ค่าตั้งค่ามาก่อน ข้อความจะได้ตรง
    // กระดานขึ้นแล้ว ที่เหลือค่อยตามมาทีหลังโดยไม่ขวางอะไร
    line.then(() => {
      updateCta();
      trackClick();
      loadMine();
    });
    subscribeBoard();
  });

  setInterval(loadBoard, 45000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadBoard();
  });
})();
