-- The authorised signatory, once per organisation instead of once per letter
-- category. Uploading it for one category left the other nine unsigned, and
-- organisation settings -- which already holds the stamp -- had nowhere to put
-- it at all.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "signatureKey" TEXT,
ADD COLUMN     "signatoryName" TEXT,
ADD COLUMN     "signatoryTitle" TEXT;

-- AlterTable
ALTER TABLE "LetterTemplate" ADD COLUMN     "showSignature" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showStamp" BOOLEAN NOT NULL DEFAULT true;
