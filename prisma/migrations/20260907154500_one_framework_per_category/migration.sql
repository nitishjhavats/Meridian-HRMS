-- One letter framework per category.
--
-- The product offers a default for every letter type and an organisation edits
-- it; two rows for the same category would make "restore to default" ambiguous
-- about which one it restored. Safe to add: nothing has ever created a
-- LetterTemplate but the seed, which writes one row per category.
CREATE UNIQUE INDEX "LetterTemplate_organizationId_category_key"
  ON "LetterTemplate"("organizationId", "category");
