-- The addresses an organisation used to live at.
--
-- `/o/<slug>` is printed on emails, bookmarked, and baked into the start URL of
-- every installed PWA. Renaming one stranded all three at once: the old address
-- still loaded, but it resolved to nobody, so it served the product's own name
-- and icon instead of the company's and a signed-in employee arriving there was
-- told they were signed in somewhere else.
--
-- Rows rather than an array, so the unique index is real: a slug any company has
-- ever used cannot be taken by another, or one address would point at two.
CREATE TABLE "OrganizationSlug" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationSlug_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationSlug_slug_key" ON "OrganizationSlug"("slug");
CREATE INDEX "OrganizationSlug_organizationId_idx" ON "OrganizationSlug"("organizationId");

ALTER TABLE "OrganizationSlug"
  ADD CONSTRAINT "OrganizationSlug_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The one rename that has already happened. Without this row the address in
-- circulation stays broken, which is the whole reason the table exists.
INSERT INTO "OrganizationSlug" ("id", "organizationId", "slug")
SELECT 'orgslug_jivonik_noida', "id", 'jivonik-ayurveda-noida'
FROM "Organization" WHERE "slug" = 'jivonik-ayurveda'
ON CONFLICT DO NOTHING;
