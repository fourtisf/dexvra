import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const DIR = path.join(process.cwd(), "data", "uploads");
// Only our own generated names (24 hex + known image ext) — blocks traversal.
const NAME_RE = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  const name = params.name;
  if (!NAME_RE.test(name)) return new NextResponse("Not found", { status: 404 });
  const ext = name.slice(name.lastIndexOf(".") + 1);
  try {
    const buf = await fs.readFile(path.join(DIR, name));
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": MIME[ext],
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
