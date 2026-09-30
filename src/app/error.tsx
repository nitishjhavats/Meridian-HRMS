"use client";

import { FaultScreen } from "@/components/layout/FaultScreen";

/** Everything outside the shells: the front door, sign-in, legal pages, the tenant door. */
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <FaultScreen {...props} home="/" homeLabel="Back to the front page" />;
}
