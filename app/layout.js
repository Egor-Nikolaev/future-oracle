import "./globals.css";
import { JetBrains_Mono, Orbitron } from "next/font/google";

// JetBrains Mono — данные/текст (табличные цифры, кириллица). Orbitron — только
// латинский вордмарк «Future Oracle» (HUD-подача; кириллицу Orbitron не покрывает).
const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});
const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["700", "900"],
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
