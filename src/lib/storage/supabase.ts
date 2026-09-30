import { createHash } from "node:crypto";
import { ValidationError } from "../errors";
import { assertSafeKey, type StorageAdapter, type StoredFile } from "./keys";

/**
 * Supabase Storage, over plain HTTP.
 *
 * No SDK. `@supabase/supabase-js` exists to give you auth, realtime, PostgREST
 * and storage behind one client; this app uses exactly one of those and already
 * has its own authentication. Four fetches against a documented REST API are
 * less to carry, and less to keep current, than a client library in the
 * dependency tree of a payroll system.
 *
 * The bucket is **private**. Nothing here mints a public or signed URL — every
 * read still goes through `src/app/api/files/[...key]/route.ts`, which checks
 * the session and the tenant prefix first. A signed URL is an unauthenticated
 * bearer token living in a query string, and it would route around the one
 * place multi-tenancy is enforced.
 *
 * The service-role key bypasses row-level security by design, which is exactly
 * why it is read here, on the server, and never sent to a browser.
 *
 * ## Why the `FileObject` row survives
 *
 * `StorageAdapter` is not the only thing that reads `FileObject`.
 * `src/services/attendance/retention.ts` queries it directly in three places —
 * the storage report, the freed-bytes tally, and `purgeOrphanFiles`, which
 * finds abandoned uploads by selecting *from this table*. If the bytes moved
 * to a bucket and the row went with them, the orphan sweep would return zero
 * for ever and failed uploads would accumulate in the bucket permanently, while
 * the maintenance job cheerfully reported "0 files, 0.0 MB".
 *
 * So the row stays as an index, with `data` null. Every existing caller keeps
 * working, unchanged.
 */

const REQUEST_TIMEOUT_MS = 15_000;

interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

export class SupabaseStorage implements StorageAdapter {
  private readonly base: string;

  constructor(private readonly config: SupabaseStorageConfig) {
    this.base = `${config.url.replace(/\/+$/, "")}/storage/v1/object`;
  }

  private endpoint(key: string): string {
    assertSafeKey(key);
    // Each segment is encoded separately: the slashes in
    // `org/<id>/<kind>/<file>` are path structure and must survive; anything
    // else in a segment must not. Keys are generated, so this is defensive.
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return `${this.base}/${this.config.bucket}/${encoded}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      // Kong matches its route on this header as well as the bearer token.
      apikey: this.config.serviceRoleKey,
      ...extra,
    };
  }

  /** Every call is bounded: a hung storage API must not wedge a check-in. */
  private request(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  async put(
    key: string,
    data: Buffer,
    mimeType: string,
    meta: { organizationId?: string | null; kind?: string } = {},
  ): Promise<StoredFile> {
    const url = this.endpoint(key);
    const body = new Uint8Array(data);
    const headers = this.headers({
      "Content-Type": mimeType,
      // Keys are random and never reused, so an object that already exists is a
      // retry rather than a collision. Overwriting is the kinder behaviour.
      "x-upsert": "true",
    });

    // One retry, because `put` sits on the attendance check-in path: somebody
    // standing at a gate should not lose their selfie to a single dropped
    // packet. Only once — beyond that the error belongs on screen.
    let response = await this.request(url, { method: "POST", headers, body }).catch(() => null);
    if (!response || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await this.request(url, { method: "POST", headers, body });
    }

    if (!response.ok) {
      throw new Error(
        `Supabase Storage refused the upload (${response.status}): ${await safeBody(response)}`,
      );
    }

    const checksum = createHash("sha256").update(data).digest("hex");
    await this.indexRow(key, { mimeType, sizeBytes: data.length, checksum, meta });

    return { key, size: data.length, mimeType, checksum };
  }

  async get(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const response = await this.request(this.endpoint(key), { headers: this.headers() });

    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) {
      throw new Error(
        `Supabase Storage refused the read (${response.status}): ${await safeBody(response)}`,
      );
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(this.endpoint(key), {
      method: "DELETE",
      headers: this.headers(),
    });

    // A file that is already gone is the state the caller wanted. The retention
    // sweep depends on this: a missing object counts as purged, not as an error
    // that stops the run.
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Supabase Storage refused the delete (${response.status}): ${await safeBody(response)}`,
      );
    }

    const { prisma } = await import("../db/prisma");
    await prisma.fileObject.deleteMany({ where: { key } });
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    // The index row, not an HTTP round trip. Both callers are asking "is the
    // cached PDF still there" while rendering a list, and a request per row
    // would turn one page into fifty. The trade is that a file deleted straight
    // out of the bucket, behind the app's back, goes unnoticed until `get`
    // returns null — which every caller already handles.
    const { prisma } = await import("../db/prisma");
    const row = await prisma.fileObject.findUnique({ where: { key }, select: { id: true } });
    return row != null;
  }

  /** The metadata row: everything except the bytes. */
  private async indexRow(
    key: string,
    input: {
      mimeType: string;
      sizeBytes: number;
      checksum: string;
      meta: { organizationId?: string | null; kind?: string };
    },
  ): Promise<void> {
    const { prisma } = await import("../db/prisma");
    const kind = input.meta.kind ?? key.split("/").at(-2) ?? "other";

    await prisma.fileObject.upsert({
      where: { key },
      create: {
        key,
        organizationId: input.meta.organizationId ?? null,
        kind,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
        data: null,
      },
      update: {
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
        data: null,
      },
    });
  }
}

/** Reads the configuration, failing loudly rather than half-working. */
export function supabaseStorageFromEnv(): SupabaseStorage {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "hrms-files";

  if (!url || !serviceRoleKey) {
    throw new ValidationError(
      'STORAGE_DRIVER is "supabase" but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set.',
    );
  }

  return new SupabaseStorage({ url, serviceRoleKey, bucket });
}

/**
 * An error body, truncated, and never letting a failure to read the body mask
 * the failure that actually matters.
 */
async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}
