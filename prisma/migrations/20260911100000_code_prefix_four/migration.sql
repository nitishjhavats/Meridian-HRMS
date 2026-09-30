-- Room for a fourth letter, and a prefix for the platform's own invoices.
--
-- Three letters cannot hold a real company name in a shape its own staff
-- recognise: "Jivonik Ayurveda" is JVNK and "KamaWell" is KMWL, and both lose
-- their shape at three. Widening a VarChar keeps every existing value exactly
-- as it is.
--
-- `invoicePrefix` defaults to BMG, which is the platform issuing the invoice
-- rather than the organisation receiving it. Order numbers already in the
-- table keep the numbers printed on them; the series simply continues under
-- the new prefix from the highest number it has reached.
ALTER TABLE "Organization" ALTER COLUMN "employeeCodePrefix" TYPE VARCHAR(4);

ALTER TABLE "PlatformSetting"
  ADD COLUMN "invoicePrefix" VARCHAR(4) NOT NULL DEFAULT 'BMG';
