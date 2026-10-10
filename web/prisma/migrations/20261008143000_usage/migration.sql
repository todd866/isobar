-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "toolCalls" JSONB;
ALTER TABLE "ChatMessage" ADD COLUMN "example" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ChatMessage_example_createdAt_idx" ON "ChatMessage"("example", "createdAt");

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_at_idx" ON "UsageEvent"("at");

-- CreateIndex
CREATE INDEX "UsageEvent_userId_at_idx" ON "UsageEvent"("userId", "at");

-- CreateIndex
CREATE INDEX "UsageEvent_deviceId_at_idx" ON "UsageEvent"("deviceId", "at");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
