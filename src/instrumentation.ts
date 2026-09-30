/**
 * Work done once, when the server starts.
 *
 * Next calls `register` on boot, in the Node runtime only.
 */
export async function register(): Promise<void> {
  // The edge runtime has no filesystem and no native modules; only the Node
  // server should try any of this.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  /**
   * Load the face models before anybody needs them.
   *
   * Nothing called `warmFaceEngine` except `getEnrolmentStatus`, so the first
   * check-in after every deploy paid a cold start: roughly a second of ONNX
   * session setup and about 38 MB of resident memory, on whoever happened to
   * arrive first. On a kiosk that is the first employee through the door in the
   * morning, standing in front of a queue.
   *
   * Deliberately not awaited into the boot path. A missing model file is a
   * degraded state the product already handles — `evaluateFaceMatch` treats an
   * unavailable engine as never blocking, because it is the server's fault and
   * not the employee's — so a warm-up failure must not stop the server from
   * starting. It is logged and ignored.
   */
  try {
    const { warmFaceEngine } = await import("@/lib/face/engine");
    const ready = await warmFaceEngine();
    if (!ready) {
      console.warn("[boot] face models not loaded — selfies will be stored but not verified");
    }
  } catch (error) {
    console.warn("[boot] face engine warm-up failed", error);
  }
}
