"use client";

import { FaultScreen } from "@/components/layout/FaultScreen";

/** A reception screen must never show a raw framework error to a queue. */
export default function KioskError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <FaultScreen {...props} home="/kiosk" homeLabel="Back to the device" />;
}
