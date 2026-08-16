"use client";

import { useEffect, useState, useCallback } from "react";

const DIR = {
  up: { label: "Рост", cls: "up" },
  down: { label: "Падение", cls: "down" },
  flat: { label: "Боковик", cls: "flat" },
};

const RISK = {
  high: { label: "высокий", cls: "down" },
  medium: { label: "средний", cls: "gold" },
  low: { label: "низкий", cls: "up" },
};

// SVG-иконки направления (не emoji — по гайдлайну дизайн-системы)
function DirIcon({ dir }) {
  if (dir === "up")
    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 15l7-7 7 7" /></svg>);
  if (dir === "down")
    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 9l7 7 7-7" /></svg>);
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h16" /></svg>);
}

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 100) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function fmtPct(x) {
  if (x == null) return "—";
  return (x > 0 ? "+" : "") + x.toFixed(2) + "%";
}
function fmtVol(x) {
  if (x == null) return "—";
  if (x >= 1e9) return "$" + (x / 1e9).toFixed(1) + "B";
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(0) + "M";
  return "$" + Math.round(x);
}
function fmtFunding(x) {
  if (x == null) return null;
  return (x > 0 ? "+" : "") + (x * 100).toFixed(3) + "%";
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

  const bt = data?.backtest;

  return (
    <div className="wrap">
      <header className="head">
        <h1 className="title">Future <span className="o">Oracle</span></h1>
        <p className="subtitle">
          Краткосрочные крипто-прогнозы из реальных данных: цены и объёмы (CoinGecko) + новости (RSS).
          Прогноз считается из сохранённых чисел прозрачным scoring, а не выдаётся случайно.
        </p>
        <p className="disclaimer">Не финансовый совет. Реальные деньги не подключены, доходность не гарантируется.</p>
      </header>

      <div className="toolbar">
        <button className="btn" onClick={refresh} disabled={refreshing || loading}>
          <span className={"dot" + (refreshing ? " spin" : "")} />
          {refreshing ? "Обновляю…" : "Обновить данные"}
        </button>
        {bt?.direction && (
          <span
            className="acc-pill warn"
            title={`Walk-forward бэктест на ${bt.days}д, out-of-sample (${bt.direction.n} дней). Направление краткосрочно ≈ случайно.`}
          >
            Направление:&nbsp;<b>{Math.round(bt.direction.accuracy * 100)}%</b>&nbsp;vs база {Math.round(bt.direction.baseline * 100)}% (edge нет)
          </span>
        )}
        {bt?.volatility?.lift && (
          <span
            className="acc-pill ok"
            title={`Реальный edge: в дни высокой волатильности крупные движения (>3%) случаются в ${Math.round(bt.volatility.high_risk_rate * 100)}% против ${Math.round(bt.volatility.base_rate * 100)}% базовых.`}
          >
            Волатильность:&nbsp;<b>{bt.volatility.lift.toFixed(1)}x</b>&nbsp;lift (реальный сигнал)
          </span>
        )}
        {data?.generated_at && <span className="meta">обновлено {fmtTime(data.generated_at)}</span>}
      </div>

      {loading && <div className="state"><div className="spinner" />Тяну свежие цены и новости…</div>}
      {error && !loading && (
        <div className="state">Ошибка загрузки: {error}<br /><button className="btn" onClick={load} style={{ marginTop: 14 }}>Повторить</button></div>
      )}

      {!loading && !error && data && (
        <div className="grid">
          {data.items.map((it) => {
            const d = DIR[it.prediction.direction];
            return (
              <div
                className={"card " + d.cls}
                key={it.asset.id}
                role="button"
                tabIndex={0}
                aria-label={`${it.asset.name}: прогноз ${d.label}, уверенность ${it.prediction.confidence}%`}
                onClick={() => setActive(it)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setActive(it))}
              >
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
                  <div className={"arrow " + d.cls} aria-hidden="true"><DirIcon dir={it.prediction.direction} /></div>
                  <div className="pred-txt">
                    <div className={"pred-dir " + d.cls}>{d.label}</div>
                    <div className="pred-sub">сигнал {it.prediction.score > 0 ? "+" : ""}{it.prediction.score} · {it.prediction.news_count} новостей</div>
                  </div>
                </div>

                <div className="conf">
                  <div className="bar"><span style={{ width: it.prediction.confidence + "%" }} /></div>
                  <div className="conf-n">увер. <b>{it.prediction.confidence}%</b></div>
                </div>

                {it.risk?.risk && RISK[it.risk.risk] && (
                  <div className="riskrow">
                    <span className={"risk-badge " + RISK[it.risk.risk].cls}>
                      риск-режим: <b>{RISK[it.risk.risk].label}</b>
                    </span>
                    {it.risk.big_move_expected && <span className="risk-note">ждём крупное движение</span>}
                  </div>
                )}

                <div className="signals">
                  <span className="s">моментум <b>{it.prediction.momentum > 0 ? "+" : ""}{it.prediction.momentum}</b></span>
                  <span className="s">сентимент <b>{it.prediction.sentiment == null ? "—" : (it.prediction.sentiment > 0 ? "+" : "") + it.prediction.sentiment}</b></span>
                  <span className="s">объём <b>{fmtVol(it.volume)}</b></span>
                  {it.funding != null && <span className="s">funding <b className={it.funding > 0 ? "up" : it.funding < 0 ? "down" : ""}>{fmtFunding(it.funding)}</b></span>}
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
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Прогноз ${it.asset.name}`}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Закрыть">×</button>
        <h2>{it.asset.symbol} · {it.asset.name}</h2>
        <div className="mprice">
          {fmtPrice(it.price)} · <span className={pctCls(it.chg_24h)}>{fmtPct(it.chg_24h)} 24ч</span> · <span className={pctCls(it.chg_7d)}>{fmtPct(it.chg_7d)} 7д</span> · объём {fmtVol(it.volume)}
        </div>

        <div className="verdict">
          <div className={"arrow " + d.cls} style={{ width: 52, height: 52 }} aria-hidden="true"><DirIcon dir={it.prediction.direction} /></div>
          <div>
            <div className={"big " + d.cls}>{d.label}</div>
            <div className="pred-sub">итоговый балл {it.prediction.score > 0 ? "+" : ""}{it.prediction.score} · уверенность {it.prediction.confidence}%</div>
          </div>
        </div>

        <div className="section">
          <h3>Что повлияло (цифры)</h3>
          <ul className="list">{it.prediction.drivers.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>

        <div className="section">
          <h3>Риски / почему может не сработать</h3>
          <ul className="list risks">{it.prediction.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
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
                    <span className={n.score > 0 ? "up" : n.score < 0 ? "down" : "flat"}>
                      тон {n.score > 0 ? "+" : ""}{Number(n.score).toFixed(2)} ({n.method})
                    </span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="how">
          Направление считается из сохранённых данных (моментум, сентимент новостей, funding, объём —
          взвешенное среднее). <b>Честно: на walk-forward бэктесте направление не бьёт наивный бейзлайн</b>
          {" "}(edge нет) — краткосрочно оно близко к случайному, поэтому модель по умолчанию молчит
          («боковик») и зовёт направление только на сильном сигнале.
          {it.risk?.risk && (
            <> Где edge реально есть — <b>риск-режим волатильности</b>: в дни высокой недавней волатильности
            крупные движения случаются в 2+ раза чаще базовой частоты (проверено на истории). Текущий режим
            этого актива — <b>{RISK[it.risk.risk]?.label}</b>{it.risk.realized_vol != null ? ` (недельная волатильность ${it.risk.realized_vol}%)` : ""}.</>
          )}
          {" "}Доходность не обещается.
        </div>
      </div>
    </div>
  );
}
