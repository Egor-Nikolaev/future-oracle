/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 — нативный модуль, не тащим его в бандл серверных компонентов
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
