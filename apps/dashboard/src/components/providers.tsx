"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { RouterProvider } from "react-aria-components";
import { AuthProvider } from "./auth-provider";
import { ToastProvider } from "./ui";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    // React Aria links navigate through the Next router, not a full page load.
    <RouterProvider navigate={(href) => router.push(href)}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </RouterProvider>
  );
}
