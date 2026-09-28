import { NextResponse } from "next/server";
import { authenticateWithPassword, createSessionCookie, isValidLoginInput } from "@/auth/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недопустимый источник запроса." }, { status: 403 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Некорректный запрос." }, { status: 400 });
  }

  if (!isValidLoginInput(body.email, body.password)) {
    return NextResponse.json({ message: "Проверьте email и пароль." }, { status: 400 });
  }

  const result = await authenticateWithPassword(body.email, body.password as string);
  if (!result.ok) {
    const isLocked = result.reason === "locked";
    return NextResponse.json(
      {
        message: isLocked
          ? "Слишком много попыток. Повторите вход через 15 минут."
          : "Неверный email или пароль.",
      },
      { status: isLocked ? 429 : 401 },
    );
  }

  const response = NextResponse.json({ ok: true, user: result.user });
  response.headers.set("Set-Cookie", createSessionCookie(result.token, new URL(request.url).protocol === "https:"));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
