"use client";

import { FaultScreen } from "@/components/layout/FaultScreen";

/**
 * The platform console had no boundary at all: a throw fell through to Next's
 * bare "Application error" page with no shell and no way back.
 */
export default function PlatformError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <FaultScreen {...props} home="/platform" homeLabel="Back to the console" />;
}
