-- AlterTable
ALTER TABLE "User" ADD COLUMN "clusterId" TEXT;

-- CreateIndex
CREATE INDEX "User_clusterId_idx" ON "User"("clusterId");

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "deviceHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "lane" TEXT NOT NULL DEFAULT 'fast',
    "context" JSONB,
    "model" TEXT,
    "effort" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "latencyMs" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "grade" TEXT,
    "gradeReason" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatStanding" (
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'opus',
    "pinnedTier" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatStanding_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AnonChatQuota" (
    "deviceHash" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnonChatQuota_pkey" PRIMARY KEY ("deviceHash","day")
);

-- CreateTable
CREATE TABLE "ChatCluster" (
    "id" TEXT NOT NULL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "blockDay" TEXT,
    "blockCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLink" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatNotice" (
    "id" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatThread_userId_updatedAt_idx" ON "ChatThread"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatThread_deviceHash_idx" ON "ChatThread"("deviceHash");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_status_lane_idx" ON "ChatMessage"("status", "lane");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatLink_kind_hash_key" ON "ChatLink"("kind", "hash");

-- CreateIndex
CREATE INDEX "ChatLink_clusterId_idx" ON "ChatLink"("clusterId");

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatStanding" ADD CONSTRAINT "ChatStanding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
