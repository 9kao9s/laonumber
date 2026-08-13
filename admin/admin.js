import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CFG = window.LUCKY;
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let DRAW = null;          // งวดที่กำลังดูอยู่
let ENTRIES = [];
let CLICKS = [];
let SETTINGS = {};

const fmtDate = (s) => new Intl.DateTimeFormat("th-TH",
  { day: "2-digit", month: "short", year: "2-digit" }).format(new Date(s + "T12:00:00"));
const fmtTime = (s) => new Date(s).toLocaleString("th-TH",
  { hour12: false, timeZone: "Asia/Bangkok", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function msg(el, text, ok = true) {
  $(el).innerHTML = text ? `<div class="msg ${ok ? "ok" : "bad"}">${esc(text)}</div>` : "";
  if (text) setTimeout(() => { $(el).innerHTML = ""; }, 6000);
}

function table(el, cols, rows, render) {
  const t = $(el);
  if (!rows.length) {
    t.innerHTML = `<tr><td><div class="empty">ยังไม่มีข้อมูล</div></td></tr>`;
    return;
  }
  t.innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map(render).join("")}</tbody>`;
}

/* ── ล็อกอินด้วยชื่อผู้ใช้ ────────────────────────────
   Supabase Auth ต้องการอีเมลเสมอ เราจึงต่อโดเมนภายในให้อัตโนมัติ
   คนใช้พิมพ์แค่ wong ระบบจะส่ง wong@laonumber.local ไปให้ Supabase
   โดเมนนี้ไม่มีอยู่จริงและไม่ต้องมี ไม่มีการส่งอีเมลใด ๆ ทั้งสิ้น
   ถ้าจะเปลี่ยนโดเมน ต้องเปลี่ยนที่ Supabase > Authentication ด้วย */
const LOGIN_DOMAIN = "laonumber.local";

function toEmail(input) {
  const v = input.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${LOGIN_DOMAIN}`;
}

function toUsername(email) {
  return String(email ?? "").split("@")[0];
}

/* ── ตรวจสิทธิ์ ──────────────────────────────────────── */
async function gate() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show(false);

  const { data: admin } = await sb.from("admin_users")
    .select("email,role").eq("user_id", session.user.id).maybeSingle();

  if (!admin) {
    await sb.auth.signOut();
    msg("loginMsg", "บัญชีนี้ยังไม่ได้รับสิทธิ์แอดมิน", false);
    return show(false);
  }

  $("whoami").textContent = toUsername(admin.email || session.user.email);
  show(true);
  await boot();
}

function show(loggedIn) {
  $("login").classList.toggle("hide", loggedIn);
  $("app").classList.toggle("hide", !loggedIn);
}

$("btnLogin").onclick = async () => {
  const u = $("email").value.trim();
  if (!u || !$("pass").value) return msg("loginMsg", "กรอกชื่อผู้ใช้และรหัสผ่าน", false);

  $("btnLogin").disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: toEmail(u), password: $("pass").value,
  });
  $("btnLogin").disabled = false;
  if (error) return msg("loginMsg", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", false);
  gate();
};

// กด Enter ในช่องรหัสผ่านแล้วล็อกอินเลย
$("pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnLogin").click();
});

$("btnLogout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ── แท็บ ─────────────────────────────────────────────── */
document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll("main section").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("s-" + b.dataset.t).classList.add("on");
  };
});

/* ── โหลดข้อมูล ───────────────────────────────────────── */
async function boot() {
  const { data: draws } = await sb.from("draws")
    .select("*").order("draw_date", { ascending: false }).limit(31);

  $("drawPick").innerHTML = (draws ?? [])
    .map((d) => `<option value="${d.id}">${fmtDate(d.draw_date)} · ${d.status}</option>`)
    .join("");
  $("drawPick").onchange = () => selectDraw(Number($("drawPick").value));

  await loadSettings();
  await loadHistory();

  if (draws?.length) await selectDraw(draws[0].id);
}

async function selectDraw(id) {
  const { data } = await sb.from("draws").select("*").eq("id", id).single();
  DRAW = data;
  $("drawPick").value = String(id);
  $("rTop").value = DRAW.top_result ?? "";
  $("rBottom").value = DRAW.bottom_result ?? "";

  const { data: n } = await sb.from("draw_notes")
    .select("note").eq("draw_id", id).maybeSingle();
  $("noteBox").value = n?.note ?? "";

  await Promise.all([loadEntries(), loadClicks()]);
  renderKpi();
  renderWinners();
}

async function loadEntries() {
  const { data } = await sb.from("entries").select("*")
    .eq("draw_id", DRAW.id).order("id", { ascending: false });
  ENTRIES = data ?? [];
  renderEntries();
}

async function loadClicks() {
  const from = new Date(DRAW.draw_date + "T00:00:00+07:00").toISOString();
  const to = new Date(DRAW.draw_date + "T23:59:59+07:00").toISOString();
  const { data } = await sb.from("link_clicks").select("*")
    .gte("created_at", from).lte("created_at", to)
    .order("created_at", { ascending: false }).limit(500);
  CLICKS = data ?? [];
  renderRefs();
  renderClicks();
}

async function loadSettings() {
  const { data } = await sb.from("app_settings").select("*").order("key");
  SETTINGS = {};
  const labels = {
    site_title: "ชื่อหัวเว็บ", site_subtitle: "ข้อความใต้หัวเว็บ",
    hero_text: "แถบรางวัลบนใบจอง", receipt_title: "ชื่อหัวสลิป",
    receipt_subtitle: "ข้อความใต้หัวสลิป", prize_per_number: "เงินรางวัลต่อเลข (บาท)",
    open_time: "เวลาเปิดรับ (HH:MM)", close_time: "เวลาปิดรับ (HH:MM)",
    open_days: "วันที่เปิด (1=จันทร์ ถึง 7=อาทิตย์)",
    admin_line_url: "ลิงก์ทักแอดมิน", result_url: "ลิงก์ตรวจผล",
    closed_message: "ข้อความตอนปิดรับ",
  };
  $("settingsForm").innerHTML = (data ?? []).map((r) => {
    SETTINGS[r.key] = r.value;
    return `<div><label>${esc(labels[r.key] ?? r.key)}
      <span class="mono" style="opacity:.5">${esc(r.key)}</span></label>
      <input data-k="${esc(r.key)}" value="${esc(r.value)}"></div>`;
  }).join("");
}

async function loadHistory() {
  const { data } = await sb.from("v_draw_summary").select("*").limit(31);
  const rows = data ?? [];

  table("tblDraws",
    ["วันที่", "สถานะ", "ผู้เล่น", "รายการ", "เลขเหลือ", "ถูกรางวัล", "จ่ายไป", "บันทึก"],
    rows,
    (d) => `<tr>
      <td class="n">${fmtDate(d.draw_date)}</td>
      <td><span class="tag">${esc(d.status)}</span></td>
      <td class="n">${d.player_count}</td>
      <td class="n">${d.entry_count}</td>
      <td class="n">${d.numbers_left}</td>
      <td class="n">${d.winner_count}</td>
      <td class="n">${Number(d.total_payout).toLocaleString("th-TH")}</td>
      <td style="max-width:220px;font-size:12px;color:var(--sub)">${esc(d.note ?? "")}</td>
    </tr>`);

  const last = rows.slice(0, 14).reverse();
  const max = Math.max(1, ...last.map((r) => Number(r.player_count)));
  $("chart").innerHTML = last.map((r) =>
    `<div style="height:${Math.round(Number(r.player_count) / max * 100)}%"
       title="${fmtDate(r.draw_date)} · ${r.player_count} คน"></div>`).join("");
}

/* ── ภาพรวม ───────────────────────────────────────────── */
function renderKpi() {
  const players = new Set(ENTRIES.map((e) => e.line_user_id ?? "a" + e.id)).size;
  const clicks = CLICKS.length;
  const conv = clicks ? Math.round(ENTRIES.length / clicks * 100) : 0;
  const payout = ENTRIES.reduce((s, e) => s + Number(e.payout), 0);

  $("kpi").innerHTML = `
    <div class="card"><b>ผู้ร่วมสนุก</b><div class="v">${players}</div></div>
    <div class="card"><b>เลขที่ถูกจอง</b><div class="v">${ENTRIES.length * 2}<small>/200</small></div></div>
    <div class="card"><b>เลขว่าง</b><div class="v">${200 - ENTRIES.length * 2}</div></div>
    <div class="card"><b>คนกดลิงก์</b><div class="v">${clicks}</div></div>
    <div class="card hi"><b>กดแล้วจองจริง</b><div class="v">${conv}<small>%</small></div></div>
    <div class="card"><b>ยอดจ่าย</b><div class="v">${payout.toLocaleString("th-TH")}</div></div>`;
}

/* ── รายการจอง ────────────────────────────────────────── */
function renderEntries() {
  const q = $("qEntries").value.trim().toLowerCase();
  const rows = ENTRIES.filter((e) =>
    !q || e.display_name.toLowerCase().includes(q) ||
    e.top_number.includes(q) || e.bottom_number.includes(q));

  table("tblEntries",
    ["#", "เวลา", "ชื่อ", "บน", "ล่าง", "ที่มา", "ลิงก์", "ผล"],
    rows,
    (e) => `<tr>
      <td class="n">${e.id}</td>
      <td class="n" style="font-size:12px">${fmtTime(e.created_at)}</td>
      <td>${esc(e.display_name)}${e.admin_note
        ? `<div style="font-size:11px;color:var(--sub)">${esc(e.admin_note)}</div>` : ""}</td>
      <td class="n">${e.top_number}</td>
      <td class="n">${e.bottom_number}</td>
      <td><span class="tag ${e.source === "admin" ? "adm" : ""}">${e.source}</span></td>
      <td class="mono" style="font-size:11px;color:var(--sub)">${esc(e.ref_code ?? "-")}</td>
      <td>${e.won_top || e.won_bottom
        ? `<span class="tag win">+${Number(e.payout).toLocaleString("th-TH")}</span>` : ""}</td>
    </tr>`);
}
$("qEntries").oninput = renderEntries;

$("btnCsv").onclick = () => {
  const head = ["id", "created_at", "display_name", "top", "bottom", "source",
    "ref_code", "invite_token", "payout", "line_user_id"];
  const body = ENTRIES.map((e) => [e.id, e.created_at, e.display_name, e.top_number,
    e.bottom_number, e.source, e.ref_code ?? "", e.invite_token ?? "", e.payout,
    e.line_user_id ?? ""]);
  const csv = "\uFEFF" + [head, ...body]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `lucky-${DRAW.draw_date}.csv`;
  a.click();
};

/* ── ลิงก์ ────────────────────────────────────────────── */
function renderRefs() {
  const map = new Map();
  for (const c of CLICKS) {
    const k = c.ref_code || "(ไม่มีรหัส)";
    const r = map.get(k) ?? { clicks: 0, users: new Set(), conv: 0 };
    r.clicks++;
    if (c.line_user_id) r.users.add(c.line_user_id);
    if (c.entry_id) r.conv++;
    map.set(k, r);
  }
  const rows = [...map.entries()].sort((a, b) => b[1].clicks - a[1].clicks);

  table("tblRefs", ["รหัสลิงก์", "คลิก", "คนไม่ซ้ำ", "จองจริง", "อัตราแปลง"], rows,
    ([k, r]) => `<tr>
      <td class="mono">${esc(k)}</td>
      <td class="n">${r.clicks}</td>
      <td class="n">${r.users.size}</td>
      <td class="n">${r.conv}</td>
      <td class="n">${r.clicks ? Math.round(r.conv / r.clicks * 100) : 0}%</td>
    </tr>`);
}

function renderClicks() {
  table("tblClicks", ["เวลา", "รหัสลิงก์", "invite", "ในแอป LINE", "จองต่อ", "ที่มา"],
    CLICKS.slice(0, 100),
    (c) => `<tr>
      <td class="n" style="font-size:12px">${fmtTime(c.created_at)}</td>
      <td class="mono">${esc(c.ref_code ?? "-")}</td>
      <td class="mono" style="font-size:11px">${esc(c.invite_token ?? "-")}</td>
      <td>${c.in_line_app ? "ใช่" : "ไม่"}</td>
      <td>${c.entry_id ? `<span class="tag win">#${c.entry_id}</span>` : ""}</td>
      <td style="font-size:11px;color:var(--sub);max-width:200px;overflow:hidden">
        ${esc(c.referrer ?? "-")}</td>
    </tr>`);
}

/* ── เพิ่มให้ลูกค้า ────────────────────────────────────── */
$("btnAdd").onclick = async () => {
  const name = $("aName").value.trim();
  const top = $("aTop").value.replace(/\D/g, "");
  const bottom = $("aBottom").value.replace(/\D/g, "");

  if (!name) return msg("addMsg", "ใส่ชื่อลูกค้าก่อน", false);
  if (!/^\d{2}$/.test(top) || !/^\d{2}$/.test(bottom)) {
    return msg("addMsg", "เลขบนและล่างต้องเป็นตัวเลข 2 หลัก", false);
  }

  const { data: { session } } = await sb.auth.getSession();
  const { error } = await sb.from("entries").insert({
    draw_id: DRAW.id, display_name: name, top_number: top, bottom_number: bottom,
    source: "admin", admin_note: $("aNote").value.trim() || null,
    created_by: session.user.id,
  });

  if (error) {
    // unique index จะเด้งตรงนี้ถ้าเลขมีเจ้าของแล้ว
    return msg("addMsg", error.code === "23505"
      ? "เลขนี้มีเจ้าของแล้วในงวดนี้" : error.message, false);
  }

  await sb.from("admin_logs").insert({
    actor: session.user.id, action: "ADD_ENTRY",
    details: { draw_id: DRAW.id, name, top, bottom },
  });

  $("aName").value = $("aTop").value = $("aBottom").value = $("aNote").value = "";
  msg("addMsg", `เพิ่มให้ ${name} แล้ว · บน ${top} ล่าง ${bottom}`);
  await loadEntries();
  renderKpi();
};

/* ── ประกาศผล ─────────────────────────────────────────── */
$("btnSettle").onclick = async () => {
  const top = $("rTop").value.replace(/\D/g, "");
  const bottom = $("rBottom").value.replace(/\D/g, "");
  if (!/^\d{2}$/.test(top) || !/^\d{2}$/.test(bottom)) {
    return msg("resultMsg", "กรอกผลให้ครบทั้งบนและล่าง", false);
  }
  if (!confirm(`ยืนยันผลงวด ${fmtDate(DRAW.draw_date)}\nบน ${top} · ล่าง ${bottom}\nงวดนี้จะถูกปิดถาวร`)) return;

  const { data, error } = await sb.rpc("settle_draw",
    { p_draw_id: DRAW.id, p_top: top, p_bottom: bottom });

  if (error) return msg("resultMsg", error.message, false);
  msg("resultMsg", `บันทึกผลแล้ว ตรวจ ${data.updated} รายการ`);
  await selectDraw(DRAW.id);
  await loadHistory();
};

function renderWinners() {
  const w = ENTRIES.filter((e) => e.won_top || e.won_bottom);
  table("tblWinners", ["#", "ชื่อ", "ถูกบน", "ถูกล่าง", "รางวัล"], w,
    (e) => `<tr>
      <td class="n">${e.id}</td>
      <td>${esc(e.display_name)}</td>
      <td class="n">${e.won_top ? e.top_number : "-"}</td>
      <td class="n">${e.won_bottom ? e.bottom_number : "-"}</td>
      <td class="n">${Number(e.payout).toLocaleString("th-TH")}</td>
    </tr>`);
}

$("btnNote").onclick = async () => {
  const { error } = await sb.from("draw_notes").upsert({
    draw_id: DRAW.id, note: $("noteBox").value, updated_at: new Date().toISOString(),
  }, { onConflict: "draw_id" });
  msg("noteMsg", error ? error.message : "บันทึกแล้ว", !error);
  if (!error) loadHistory();
};

/* ── ผู้เล่น ──────────────────────────────────────────── */
async function loadUsers() {
  const q = $("qUsers").value.trim();
  let query = sb.from("line_users").select("*")
    .order("last_seen", { ascending: false }).limit(200);
  if (q) query = query.ilike("display_name", `%${q}%`);

  const { data } = await query;
  table("tblUsers", ["ชื่อ LINE", "เล่นไปแล้ว", "เห็นครั้งแรก", "ล่าสุด", "สถานะ", ""],
    data ?? [],
    (u) => `<tr>
      <td>${esc(u.display_name ?? "-")}</td>
      <td class="n">${u.play_count}</td>
      <td class="n" style="font-size:12px">${fmtTime(u.first_seen)}</td>
      <td class="n" style="font-size:12px">${fmtTime(u.last_seen)}</td>
      <td>${u.blocked ? '<span class="tag" style="border-color:#C8102E;color:#C8102E">ระงับ</span>' : ""}</td>
      <td><button class="btn ghost" data-block="${esc(u.line_user_id)}"
        data-now="${u.blocked}">${u.blocked ? "ปลดระงับ" : "ระงับ"}</button></td>
    </tr>`);

  document.querySelectorAll("[data-block]").forEach((b) => {
    b.onclick = async () => {
      await sb.from("line_users")
        .update({ blocked: b.dataset.now !== "true" })
        .eq("line_user_id", b.dataset.block);
      loadUsers();
    };
  });
}
$("qUsers").oninput = () => loadUsers();
document.querySelector('nav [data-t="users"]').addEventListener("click", loadUsers);

/* ── ตั้งค่า ──────────────────────────────────────────── */
$("btnSaveSettings").onclick = async () => {
  const rows = [...document.querySelectorAll("#settingsForm input")].map((i) => ({
    key: i.dataset.k, value: i.value, updated_at: new Date().toISOString(),
  }));
  const { error } = await sb.from("app_settings").upsert(rows, { onConflict: "key" });
  msg("setMsg", error ? error.message : "บันทึกการตั้งค่าแล้ว", !error);
};

gate();
