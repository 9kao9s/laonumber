// Edge Function : play
// จุดเดียวที่เขียนข้อมูลการแทงลง Supabase ได้
// ทุก action ต้องแนบ id_token ของ LINE มาด้วยเสมอ
//
// action:
//   check    ตรวจสิทธิ์ + เลขว่าง ก่อนเปิดหน้ายืนยัน
//   submit   จองเลขจริง
//   receipt  ดึงสลิปล่าสุดของตัวเองในงวดนี้
//   slip     อัปโหลดภาพสลิปขึ้น Storage เพื่อส่งเข้าแชท LINE

import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, fail, json, twoDigit, verifyIdToken } from "../_shared/line.ts";

const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("METHOD", "รองรับเฉพาะ POST", 405);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  const user = await verifyIdToken(String(body.id_token ?? ""), CHANNEL_ID);
  if (!user) return fail("AUTH", "ยืนยันตัวตนกับ LINE ไม่สำเร็จ", 401);

  // จำผู้ใช้ไว้ทุกครั้งที่เข้ามา ใช้ดูใน CRM หลังบ้าน
  await db.from("line_users").upsert({
    line_user_id: user.userId,
    display_name: user.displayName,
    picture_url: user.picture,
    last_seen: new Date().toISOString(),
  }, { onConflict: "line_user_id" });

  switch (action) {
    case "check":
      return await handleCheck(body, user.userId);
    case "submit":
      return await handleSubmit(body, user);
    case "receipt":
      return await handleReceipt(user.userId);
    case "slip":
      return await handleSlip(body, user.userId);
    default:
      return fail("ACTION", "ไม่รู้จักคำสั่งนี้");
  }
});

async function openDraw() {
  await db.rpc("ensure_today_draw");
  const { data } = await db.rpc("current_draw");
  return data ?? null;
}

async function handleCheck(body: Record<string, unknown>, userId: string) {
  const top = twoDigit(body.top);
  const bottom = twoDigit(body.bottom);
  if (!top || !bottom) return fail("BAD_NUMBER", "กรุณาเลือกเลขบนและเลขล่าง");

  const draw = await openDraw();
  if (!draw) {
    const { data: s } = await db.from("app_settings")
      .select("value").eq("key", "closed_message").maybeSingle();
    return fail("CLOSED", s?.value ?? "ยังไม่ถึงเวลาเปิดรับเลข");
  }

  const { data: u } = await db.from("line_users")
    .select("blocked").eq("line_user_id", userId).maybeSingle();
  if (u?.blocked) return fail("BLOCKED", "บัญชีนี้ถูกระงับสิทธิ์ ติดต่อแอดมิน");

  const { data: mine } = await db.from("entries")
    .select("id").eq("draw_id", draw.id).eq("line_user_id", userId)
    .eq("source", "liff").maybeSingle();
  if (mine) return fail("ALREADY_PLAYED", "บัญชี LINE นี้ใช้สิทธิ์ของวันนี้แล้ว");

  const { data: taken } = await db.from("entries")
    .select("top_number,bottom_number")
    .eq("draw_id", draw.id)
    .or(`top_number.eq.${top},bottom_number.eq.${bottom}`);

  for (const t of taken ?? []) {
    if (t.top_number === top) {
      return fail("TOP_TAKEN", `2 ตัวบน ${top} มีคนเลือกไปแล้ว`);
    }
    if (t.bottom_number === bottom) {
      return fail("BOTTOM_TAKEN", `2 ตัวล่าง ${bottom} มีคนเลือกไปแล้ว`);
    }
  }

  return json({ ok: true, draw });
}

async function handleSubmit(
  body: Record<string, unknown>,
  user: { userId: string; displayName: string },
) {
  const top = twoDigit(body.top);
  const bottom = twoDigit(body.bottom);
  if (!top || !bottom) return fail("BAD_NUMBER", "กรุณาเลือกเลขบนและเลขล่าง");

  const name = String(body.name ?? "").trim() || user.displayName || "ผู้ร่วมสนุก";

  // เงื่อนไขทั้งหมดถูกตัดสินในฐานข้อมูลแบบ atomic
  // ถ้าสองคนกดพร้อมกัน unique index จะกันให้เอง
  const { data, error } = await db.rpc("claim_entry", {
    p_line_user_id: user.userId,
    p_display_name: name.slice(0, 40),
    p_top: top,
    p_bottom: bottom,
    p_ref: String(body.ref ?? "").slice(0, 80) || null,
    p_invite: String(body.invite ?? "").slice(0, 40) || null,
  });

  if (error) return fail("DB", "บันทึกไม่สำเร็จ กรุณาลองใหม่");
  return json(data);
}

async function handleReceipt(userId: string) {
  const { data: draw } = await db.rpc("current_draw");
  const drawId = draw?.id;
  if (!drawId) return fail("CLOSED", "ยังไม่มีงวดที่เปิดอยู่");

  const { data } = await db.from("entries")
    .select("id,display_name,top_number,bottom_number,created_at")
    .eq("draw_id", drawId).eq("line_user_id", userId)
    .order("id", { ascending: false }).limit(1).maybeSingle();

  if (!data) return fail("NOT_FOUND", "ยังไม่พบสลิปของงวดนี้");
  return json({ ok: true, entry: data, draw });
}

// รับภาพ JPEG แบบ base64 แล้วเก็บลง Storage
// เพราะ liff.shareTargetPicker ส่งได้เฉพาะรูปที่เป็น URL https เท่านั้น
async function handleSlip(body: Record<string, unknown>, userId: string) {
  const raw = String(body.image ?? "");
  const m = raw.match(/^data:image\/jpe?g;base64,(.+)$/);
  if (!m) return fail("BAD_IMAGE", "รูปแบบภาพไม่ถูกต้อง");

  const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  if (bytes.length < 1000 || bytes.length > 3_000_000) {
    return fail("BAD_IMAGE", "ขนาดภาพไม่ถูกต้อง");
  }
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) {
    return fail("BAD_IMAGE", "ไฟล์ไม่ใช่ JPEG");
  }

  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId + "|" + (body.entry_id ?? "")),
  );
  const name = Array.from(new Uint8Array(hash).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const path = `${new Date().toISOString().slice(0, 10)}/${name}.jpg`;

  const { error } = await db.storage.from("slips")
    .upload(path, bytes, { contentType: "image/jpeg", upsert: true });

  if (error) return fail("STORAGE", "อัปโหลดภาพไม่สำเร็จ");

  const { data } = db.storage.from("slips").getPublicUrl(path);
  return json({ ok: true, url: data.publicUrl });
}
