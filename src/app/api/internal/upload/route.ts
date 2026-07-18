import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/upload  (multipart: field "file")
// Bot-side logo/creative upload. Same magic-byte sniffing + storage as the
// admin upload — never trust the client MIME, reject SVG (script vector).
// Returns { url: "/api/media/<24hex>.<ext>" }, which passes the LOGO_RE gate.
const MAX = 3 * 1024 * 1024; // 3 MB
const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

function sniff(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";
  return null;
}

export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();

  const len = Number(req.headers.get("content-length") || 0);
  if (len && len > MAX + 4096) {
    return NextResponse.json({ error: "File too large (max 3 MB)" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ error: "File too large (max 3 MB)" }, { status: 413 });

  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = sniff(buf);
  if (!ext) return NextResponse.json({ error: "Only PNG, JPG, WEBP, or GIF images" }, { status: 415 });

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${randomBytes(12).toString("hex")}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), buf);

  return NextResponse.json({ url: `/api/media/${name}` });
}
