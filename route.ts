import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });
    }

    const body = await request.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const language = typeof body.language === "string" ? body.language : "ru";

    const languageNames: Record<string, string> = {
      ru: "Russian",
      en: "English",
      kk: "Kazakh"
    };

    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `You are Pinsk, a helpful AI assistant. Reply in ${languageNames[language] || "Russian"} unless the user explicitly asks for another language. Be clear, friendly, and accurate.`
        },
        ...messages
          .filter((m: { role?: string; content?: string }) =>
            (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
          )
          .slice(-30)
          .map((m: { role: "user" | "assistant"; content: string }) => ({
            role: m.role,
            content: m.content.slice(0, 12000)
          }))
      ],
      temperature: 0.7
    });

    return NextResponse.json({
      answer: completion.choices[0]?.message?.content ?? ""
    });
  } catch (error) {
    console.error("Pinsk chat error:", error);
    return NextResponse.json({ error: "AI request failed" }, { status: 500 });
  }
}
