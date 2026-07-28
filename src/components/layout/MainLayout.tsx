import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

interface Props {
  children: ReactNode;
}

export function MainLayout({ children }: Props) {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main
        className="relative flex-1 overflow-y-auto overflow-x-hidden"
        style={{
          backgroundImage:
            "radial-gradient(1100px 720px at 100% -8%, rgba(59, 91, 219, 0.06), transparent 58%)," +
            "radial-gradient(920px 620px at -6% 108%, rgba(59, 91, 219, 0.05), transparent 55%)",
        }}
      >
        {children}
      </main>
    </div>
  );
}
