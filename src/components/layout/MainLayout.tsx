import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

interface Props {
  children: ReactNode;
}

export function MainLayout({ children }: Props) {
  return (
    <div className="flex h-screen w-screen overflow-hidden p-3 gap-3">
      <Sidebar />
      <main className="relative flex-1 overflow-y-auto overflow-x-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,27,41,0.9),rgba(11,18,29,0.94))] shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,rgba(255,135,91,0.14),transparent_65%)]" />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-32 bg-[linear-gradient(90deg,rgba(101,178,255,0.05),transparent)]" />
        <div className="relative">
          {children}
        </div>
      </main>
    </div>
  );
}
