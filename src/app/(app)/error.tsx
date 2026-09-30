"use client";

import { FaultScreen } from "@/components/layout/FaultScreen";

/** The organisation shell's safety net. See `FaultScreen` for what it does first. */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <FaultScreen {...props} home="/dashboard" homeLabel="Back to the dashboard" />;
}
