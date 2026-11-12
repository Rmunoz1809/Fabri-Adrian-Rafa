import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "@/lib/admin/basic-auth";

/** Basic protection for the admin panel and its API (ADMIN_USER / ADMIN_PASSWORD). */
export function proxy(req: NextRequest) {
  if (checkBasicAuth(req.headers.get("authorization"), process.env.ADMIN_USER, process.env.ADMIN_PASSWORD)) {
    return NextResponse.next();
  }
  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Holo admin", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
