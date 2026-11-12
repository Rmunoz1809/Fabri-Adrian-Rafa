import type { ReactNode } from "react";

export const metadata = { title: "Holo", description: "Marketplace de cartas coleccionables en Panamá" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
