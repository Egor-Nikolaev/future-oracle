import "./globals.css";
import localFont from "next/font/local";

// Шрифты самохостятся (файлы в app/fonts), чтобы сборка не зависела от сети —
// next/font/google иногда не может скачать шрифт на билде Vercel и валит деплой.
// JetBrains Mono — данные/текст (табличные цифры, кириллица). Orbitron — латинский
// вордмарк «Future Oracle» (HUD-подача; кириллицу Orbitron не покрывает).
const mono = localFont({
  src: "./fonts/JetBrainsMono.ttf",
  weight: "400 700",
  variable: "--font-mono",
  display: "swap",
});
const orbitron = localFont({
  src: "./fonts/Orbitron.ttf",
  weight: "700 900",
  variable: "--font-display",
  display: "swap",
});

export const metadata = {
  title: "Future Oracle — крипто-прогнозы",
  description:
    "Краткосрочные прогнозы по крипте из реальных данных: цены (CoinGecko) + новости (RSS). " +
    "Прозрачный scoring, уверенность, риск, сверка прогнозов постфактум.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru" className={`${mono.variable} ${orbitron.variable}`}>
      <body>{children}</body>
    </html>
  );
}
