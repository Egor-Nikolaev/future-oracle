import { refreshAll } from "../../../lib/ingest.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Ручной живой рефреш: тянет свежие цены и новости, сверяет прошлые прогнозы,
// строит новые. Вызывается кнопкой «Обновить» и скриптом npm run ingest.
export async function POST() {
  try {
    const res = await refreshAll();
    return Response.json({ ok: true, ...res });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
