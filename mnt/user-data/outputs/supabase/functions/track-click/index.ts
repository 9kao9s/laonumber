// Edge Function : track-click
// บันทึกทุกครั้งที่มีคนเปิดลิงก์ ก่อนที่จะรู้ว่าเขาเป็นใครด้วยซ้ำ
// ถ้าล็อกอิน LINE แล้วค่อยส่ง id_token ตามมาเพื่อผูกคลิกเข้ากับบัญชี
// ทำให้หลังบ้านคำนวณได้ว่า "ลิงก์ไหนพาคนมาแทงจริงกี่คน"

import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS, json, verifyIdToken } from "../_shared/line.ts";

const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const body = await req.json().catch(() => ({}));

  let lineUserId: string | null = null;
  if (body.id_token) {
    const u = await verifyIdToken(String(body.id_token), CHANNEL_ID);
    lineUserId = u?.userId ?? null;
  }

  const clean = (v: unknown, n: number) =>
    v ? String(v).slice(0, n) : null;

  await db.from("link_clicks").insert({
    ref_code: clean(body.ref, 80),
    invite_token: clean(body.invite, 40),
    line_user_id: lineUserId,
    referrer: clean(body.referrer, 300),
    user_agent: clean(req.headers.get("user-agent"), 300),
    in_line_app: body.in_line === true,
  });

  // ตอบสั้น ๆ หน้าเว็บไม่ต้องรอผล
  return json({ ok: true });
});
