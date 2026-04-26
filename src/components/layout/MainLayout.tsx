import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

interface Props {
  children: ReactNode;
}

export function MainLayout({ children }: Props) {
  return (
    <div className="flex h-screen w-screen gap-4 overflow-hidden p-4">
      <Sidebar />
      <main className="relative flex-1 overflow-y-auto overflow-x-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(16,27,42,0.92),rgba(10,17,28,0.94))] shadow-[0_28px_90px_rgba(0,0,0,0.42)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(circle_at_top,rgba(87,208,255,0.18),transparent_68%)]" />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-36 bg-[linear-gradient(90deg,rgba(115,183,255,0.08),transparent)]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(180deg,transparent,rgba(248,191,101,0.04))]" />
        <div className="relative h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
