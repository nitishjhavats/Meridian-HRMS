-- AlterTable
ALTER TABLE "AiConfig" ALTER COLUMN "model" SET DEFAULT 'z-ai/glm-5.3-flash';

-- AlterTable
ALTER TABLE "PlatformSetting" ALTER COLUMN "defaultAiModel" SET DEFAULT 'z-ai/glm-5.3-flash';
