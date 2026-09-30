/*
  Warnings:

  - You are about to drop the column `footerHtml` on the `LetterTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `headerHtml` on the `LetterTemplate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LetterTemplate" DROP COLUMN "footerHtml",
DROP COLUMN "headerHtml",
ADD COLUMN     "footerText" TEXT,
ADD COLUMN     "headerText" TEXT;
