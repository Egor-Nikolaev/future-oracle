# Handoff — Future Oracle

Обновлено: 2026-08-17

## Цель
Тестовое задание из набора (второе, после Mood News Grid): краткосрочный крипто-прогнозер
из реальных данных с прозрачным scoring и ЧЕСТНОЙ оценкой собственной точности. Сдаётся
как есть, доработки идут по запросу.

## Статус: рабочее, в проде, сдаётся. Проверено боем.
- Живое демо: https://future-oracle-live.vercel.app (200, данные живые)
- Репо (публичный): https://github.com/Egor-Nikolaev/future-oracle
- Последний коммит: `e1f58d0`, локал == origin, дерево чистое (кроме gitignored .env/.db/history-cache)
- Эвал: `npm run eval` 43/43. Прод-сборка чистая.

## Что это (суть в 3 строки)
8 монет (BTC/ETH/SOL/BNB/XRP/DOGE/ADA/AVAX). Прогноз считается прозрачным scoring из сохранённых
чисел: цены+объёмы (CoinGecko) + новости (Google News по коину, сентимент LLM) + позиционирование
(Binance Futures funding/OI). Главная фишка: честный walk-forward бэктест, который показывает где
edge есть (волатильность), а где нет (направление). Не обещает доходность.

## Что сделано (ключевое)
- Прозрачный scoring: моментум + сентимент новостей (взвешен по свежести) + funding, взвешенное среднее.
- Новости: Google News RSS-поиск ПО КАЖДОМУ коину (~40-60 на монету), дедуп сюжетов, батч-сентимент LLM.
- Честный harness `lib/backtest.js` (`npm run backtest`): 365 дней, out-of-sample, две задачи + бейзлайны + кросс-валидация + ablation.
- Найдено и вынесено честно: направление edge не даёт (~32% vs 41% бейзлайн), волатильность даёт (логрег-модель, lift ~1.4x на CV, P крупного движения на карточке).
- Ablation: funding как фича НЕ помогает (отброшен), внутридневная волатильность ПОМОГАЕТ (1.37→1.46, встроена).
- Serverless на Vercel: эфемерная SQLite в /tmp + seed.json (снимки+новости+бэктест), кэш истории на диск, ретрай на 429 CoinGecko.
- Дизайн через ui-ux-pro-max (data-dense dashboard, Orbitron+JetBrains Mono, шрифты самохостом).
- README: покрывает ТЗ построчно + журнал разработки 18 пунктов (все заходы).

## Файлы в работе (важные пути)
- Ядро прогноза: `lib/predict.js` (scoring, уверенность, риски, драйверы)
- Бэктест-харнесс: `lib/backtest.js` (walk-forward, CV, ablation, логрег волатильности, интрадей)
- Сбор данных: `lib/ingest.js` (цены+funding, новости по коину, сентимент пулом, seed)
- Источники: `lib/coingecko.js` (cgGet с ретраем), `lib/binance.js` (funding/OI + история), `lib/feeds.js` (Google News URL)
- Сентимент: `lib/sentiment.js` (LLM батч + rule-based фолбэк). LLM-клиент: `lib/llm.js`
- API: `app/api/predictions/route.js` (список+бэктест), `app/api/ingest/route.js` (ручной рефреш, maxDuration 60)
- Фронт: `app/page.js`, `app/globals.css`. Шрифты: `app/fonts/*.ttf` (самохост)
- Seed: `data/seed.json` (коммитится). Кэш истории: `data/history-cache.json` (gitignored)
- Скрипты: `scripts/{ingest,eval,backtest,build-seed}.mjs`

## Как запустить / пересобрать
- `npm i && npm run dev` (без ключей работает на rule-based фолбэке)
- `npm run backtest` — отчёт бэктеста (две задачи, CV, ablation), читает кэш истории
- Пересобрать seed: `node --env-file=.env scripts/ingest.mjs` (x1-2), затем `node --env-file=.env scripts/build-seed.mjs`
- Деплой: `npx vercel --prod --token <VERCEL_TOKEN>`, потом перевесить алиас `future-oracle-live.vercel.app` на свежий деплой. Регион зашит `fra1` (vercel.json).

## Что пробовали и НЕ сработало (не повторять)
- **Направление up/down в принципе не предсказуемо** краткосрочно (edge -9% на 365д CV). Не тюнить фичи под направление, это подгонка под шум. Доказано.
- **funding-экстремумы как фича волатильности НЕ помогают** (ablation: lift 1.50 vs 1.59). Отброшено. Не возвращать без нового доказательства.
- **CoinGecko free жёстко лимитит** (429): markets + история бэктеста легко выжигают лимит. Лечится кэшем истории на диск (`history-cache.json`) и прогревом по одному коину с паузами. Не гонять бэктест на каждом холодном старте (берётся из seed).
- **Binance geo-блокирует US-дата-центры Vercel** (451). Функции ОБЯЗАТЕЛЬНО в регионе `fra1` (Франкфурт), иначе funding/OI не тянутся. Зашито в `vercel.json`.
- **next/font/google валит билд Vercel** (не может скачать Orbitron). Решено самохостом (`next/font/local`, файлы в `app/fonts/`).
- **Тикер как подстрока** ловил ложные привязки новостей («Sol» в «Sol Ultrafast» → Solana). Матчим полные имена ci + тикеры только заглавным standalone-токеном.
- **8 одновременных LLM-запросов сентимента** ловят rate-limit → падают в rule-based. Лечится пулом на 3 + батчами по 12.

## Следующий шаг (если продолжаем)
Сок в основном выжат. Осталась одна недоказанная гипотеза с потенциалом: интрадей/GARCH на часовых
данных глубже (сейчас интрадей-фича добавлена, но модель простая). Всё новое гонять через `npm run backtest`
(CV + ablation), иначе это подгонка под шум. Ликвидации Binance и окно 2-3 года заблокированы отсутствием
бесплатных данных.

## Доступы
Секреты в `/Users/user/Cowork/future-oracle/.env` (chmod 600, gitignored). Имена ключей и заметки, в самом .env.
Живой секрет один: `LLM_API_KEY` (Groq, тот же спалённый в чате, работает). Vercel deploy-токен был
короткоживущий (1 день), протух, перевыпускать на vercel.com/account/tokens. GitHub, через `gh` (keyring,
аккаунт Egor-Nikolaev). Коммиты от `Egor Nikolaev <e.nikolaev@apeclix.com>`.

## Сиблинг
Первое тестовое, Mood News Grid: свой репо `github.com/Egor-Nikolaev/mood-news-grid`, свой handoff
`~/Cowork/mood-news-grid/handoff.md`, свой архив `~/Downloads/Клод архив с .md/Mood News Grid/`.
