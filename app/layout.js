import "./globals.css";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
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
    <html lang="ru" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
