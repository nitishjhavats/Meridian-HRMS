-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN     "selfSignupEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "signupSeats" INTEGER NOT NULL DEFAULT 5;
