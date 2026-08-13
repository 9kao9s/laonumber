// ตรวจสอบตัวตนกับ LINE และตัวช่วยกลางของ Edge Functions ทั้งหมด

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function fail(code: string, message: string, status = 200): Response {
  return json({ ok: false, code, message }, status);
}

export type LineUser = {
  userId: string;
  displayName: string;
  picture: string;
};

/**
 * ห้ามเชื่อ userId ที่ส่งมาจากหน้าเว็บ ต้องเอา ID token มาแลกที่นี่เสมอ
 * ถ้าไม่ทำขั้นตอนนี้ ใครก็ยิง userId ของคนอื่นเข้ามาได้
 */
export async function verifyIdToken(
  idToken: string,
  channelId: string,
): Promise<LineUser | null> {
  if (!idToken || !channelId) return null;

  let res: Response;
  try {
    res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  const p = await res.json().catch(() => null);
  if (!p || typeof p.sub !== "string") return null;

  // ตรวจซ้ำอีกชั้น กัน token ที่ออกให้แอปอื่นหลุดเข้ามา
  if (p.iss !== "https://access.line.me") return null;
  if (String(p.aud) !== channelId) return null;
  if (typeof p.exp === "number" && p.exp < Math.floor(Date.now() / 1000) - 60) {
    return null;
  }

  return {
    userId: p.sub,
    displayName: typeof p.name === "string" ? p.name.slice(0, 40) : "",
    picture: typeof p.picture === "string" ? p.picture : "",
  };
}

export function twoDigit(v: unknown): string | null {
  const s = String(v ?? "").replace(/\D/g, "");
  return /^[0-9]{2}$/.test(s) ? s : null;
}
