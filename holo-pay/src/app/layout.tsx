import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Holo", description: "Marketplace de cartas coleccionables en Panamá" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <header className="top">
          <div className="wrap">
            <a className="brand" href="/">Holo</a>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
