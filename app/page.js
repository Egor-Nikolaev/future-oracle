"use client";

import { useEffect, useState, useCallback } from "react";

const DIR = {
  up: { label: "Рост", arrow: "↑", cls: "up" },
  down: { label: "Падение", arrow: "↓", cls: "down" },
  flat: { label: "Боковик", arrow: "→", cls: "flat" },
};

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 100) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function fmtPct(x) {
  if (x == null) return "—";
  return (x > 0 ? "+" : "") + x.toFixed(2) + "%";
}
function pctCls(x) {
  if (x == null) return "flat";
  return x > 0 ? "up" : x < 0 ? "down" : "flat";
}
function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function Page() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/predictions");
      if (!res.ok) throw new Error("HTTP " + res.status);
      setData(await res.json());
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch("/api/ingest", { method: "POST" });
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const acc = data?.accuracy;

  return (
    <div className="wrap">
      <div className="head">
        <div>
          <h1 className="title">Future <span className="o">Oracle</span></h1>
          <p className="subtitle">
            Краткосрочные крипто-прогнозы из реальных данных: цены (CoinGecko) + новости (RSS).
            Прогноз считается из сохранённых чисел прозрачным scoring, а не выдаётся случайно.
          </p>
          <p className="disclaimer">
            Не финансовый совет. Реальные деньги не подключены, доходность не гарантируется.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn" onClick={refresh} disabled={refreshing || loading}>
          {refreshing ? "Обновляю…" : "Обновить данные"}
        </button>
        {acc && (
          <span className="acc-pill" title="Прогнозы сверяются с фактической ценой на следующем обновлении">
            Точность: {acc.resolved ? <>&nbsp;<b>{Math.round(acc.rate * 100)}%</b>&nbsp;({acc.hits}/{acc.resolved} сверено)</> : <>&nbsp;<b>копится</b>&nbsp;(нужно 2+ обновления)</>}
          </span>
        )}
        {data?.generated_at && <span className="meta">обновлено {fmtTime(data.generated_at)}</span>}
      </div>

      {loading && (
        <div className="state"><div className="spinner" />Тяну свежие цены и новости…</div>
      )}
      {error && !loading && (
        <div className="state">Ошибка загрузки: {error}<br /><button className="btn" onClick={load} style={{ marginTop: 14 }}>Повторить</button></div>
      )}

      {!loading && !error && data && (
        <div className="grid">
          {data.items.map((it) => {
            const d = DIR[it.prediction.direction];
            return (
              <div className="card" key={it.asset.id} onClick={() => setActive(it)}>
                <div className="card-top">
                  <div className="asset">
                    <span className="sym">{it.asset.symbol}</span>
                    <span className="aname">{it.asset.name}</span>
                  </div>
                  <div className="price">
                    <div className="p">{fmtPrice(it.price)}</div>
                    <div className={"chg " + pctCls(it.chg_24h)}>{fmtPct(it.chg_24h)} 24ч</div>
                  </div>
                </div>

                <div className="pred">
                  <div className={"arrow " + d.cls}>{d.arrow}</div>
                  <div className="pred-txt">
                    <div className={"pred-dir " + d.cls}>{d.label}</div>
                    <div className="pred-sub">
                      сигнал {it.prediction.score > 0 ? "+" : ""}{it.prediction.score} · {it.prediction.news_count} новостей
                    </div>
                  </div>
                </div>

                <div className="conf">
                  <div className="bar"><span style={{ width: it.prediction.confidence + "%" }} /></div>
                  <div className="conf-n">увер. {it.prediction.confidence}%</div>
                </div>

                <div className="signals">
                  <span className="s">моментум {it.prediction.momentum > 0 ? "+" : ""}{it.prediction.momentum}</span>
                  <span className="s">
                    сентимент {it.prediction.sentiment == null ? "—" : (it.prediction.sentiment > 0 ? "+" : "") + it.prediction.sentiment}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {active && <Modal it={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function Modal({ it, onClose }) {
  const d = DIR[it.prediction.direction];
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Закрыть">×</button>
        <h2>{it.asset.symbol} · {it.asset.name}</h2>
        <div className="mprice">
          {fmtPrice(it.price)} · <span className={pctCls(it.chg_24h)}>{fmtPct(it.chg_24h)} за 24ч</span> · <span className={pctCls(it.chg_7d)}>{fmtPct(it.chg_7d)} за 7д</span>
        </div>

        <div className="verdict">
          <div className={"arrow " + d.cls} style={{ width: 54, height: 54, fontSize: 26 }}>{d.arrow}</div>
          <div>
            <div className={"big " + d.cls}>{d.label}</div>
            <div className="pred-sub">
              итоговый балл {it.prediction.score > 0 ? "+" : ""}{it.prediction.score} · уверенность {it.prediction.confidence}%
            </div>
          </div>
        </div>

        <div className="section">
          <h3>Что повлияло (цифры)</h3>
          <ul className="list">
            {it.prediction.drivers.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>

        <div className="section">
          <h3>Риски / почему может не сработать</h3>
          <ul className="list risks">
            {it.prediction.risks.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>

        {it.news?.length > 0 && (
          <div className="section">
            <h3>Новости в основе прогноза</h3>
            <div className="news-list">
              {it.news.map((n, i) => (
                <a key={i} href={n.url} target="_blank" rel="noopener noreferrer">
                  {n.title}
                  <div className="nmeta">
                    <span>{n.source}</span>
                    <span className={"tone " + (n.score > 0 ? "up" : n.score < 0 ? "down" : "flat")}>
                      тон {n.score > 0 ? "+" : ""}{Number(n.score).toFixed(2)} ({n.method})
                    </span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="how">
          Прогноз детерминированно считается из сохранённых данных: моментум (динамика цены 24ч/7д) +
          сентимент новостей, взвешенная сумма → направление. Уверенность растёт при согласии сигналов
          и падает при их споре, высокой волатильности или отсутствии новостей. Каждый прогноз сверяется
          с фактической ценой на следующем обновлении (точность вверху).
        </div>
      </div>
    </div>
  );
}
