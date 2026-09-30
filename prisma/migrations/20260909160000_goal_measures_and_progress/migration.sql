-- Goals that can say how far along they are.
--
-- `targetValue` and `currentValue` have been free text since the model was
-- written, and are null on every goal in production -- the three that exist say
-- what they are worth in their title. Nothing computed a percentage because
-- there was nothing to compute one from.
--
-- All nullable. A goal with no numbers keeps working and shows a status; one
-- with them shows a bar. Nothing is migrated, because migrating a title into a
-- target is guessing.
ALTER TABLE "Goal" ADD COLUMN     "unit" "RecognitionUnit";
ALTER TABLE "Goal" ADD COLUMN     "targetNumber" DECIMAL(14,2);
ALTER TABLE "Goal" ADD COLUMN     "currentNumber" DECIMAL(14,2);

-- One update to how far along a goal is. A log rather than a column: "kitna
-- hua" is asked repeatedly, and overwriting a single number throws away the
-- shape of the answer every time it is asked.
CREATE TABLE "GoalProgress" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalProgress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GoalProgress_goalId_createdAt_idx" ON "GoalProgress"("goalId", "createdAt");
CREATE INDEX "GoalProgress_organizationId_idx" ON "GoalProgress"("organizationId");

ALTER TABLE "GoalProgress" ADD CONSTRAINT "GoalProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalProgress" ADD CONSTRAINT "GoalProgress_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
