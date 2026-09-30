-- Codes the platform owner hands out before there is an order.
--
-- A confirmation code already existed, issued against a request already in the
-- queue. This is the other direction: made on the phone for an organisation
-- that has not yet pressed Buy, optionally with a discount, optionally tied to
-- one organisation, spent once. The hash is SHA-256 so the code can be found
-- by value at checkout (bcrypt cannot be looked up); the cipher lets the owner
-- re-read what they handed out.
CREATE TABLE "PaymentCode" (
  "id"               TEXT NOT NULL,
  "codeHash"         TEXT NOT NULL,
  "codeCipher"       TEXT NOT NULL,
  "organizationId"   TEXT,
  "discountPercent"  DECIMAL(5,2),
  "maxDiscountPaise" INTEGER,
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "note"             TEXT,
  "issuedById"       TEXT NOT NULL,
  "issuedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paymentOrderId"   TEXT,
  "appliedAt"        TIMESTAMP(3),
  "usedAt"           TIMESTAMP(3),
  "revokedAt"        TIMESTAMP(3),
  CONSTRAINT "PaymentCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentCode_paymentOrderId_key" ON "PaymentCode"("paymentOrderId");
CREATE INDEX "PaymentCode_codeHash_idx" ON "PaymentCode"("codeHash");
CREATE INDEX "PaymentCode_organizationId_issuedAt_idx" ON "PaymentCode"("organizationId", "issuedAt");
CREATE INDEX "PaymentCode_issuedAt_idx" ON "PaymentCode"("issuedAt");

ALTER TABLE "PaymentCode"
  ADD CONSTRAINT "PaymentCode_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentCode"
  ADD CONSTRAINT "PaymentCode_paymentOrderId_fkey"
  FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
