ALTER TABLE "ChatMessage" ADD COLUMN "claimedBy" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "deliveredAt" TIMESTAMPTZ(3);

CREATE TABLE "AgentHeartbeat" (
  "id" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "runtime" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "lastSeen" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentHeartbeat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentHeartbeat_host_tokenId_key" ON "AgentHeartbeat"("host", "tokenId");
CREATE INDEX "AgentHeartbeat_lastSeen_idx" ON "AgentHeartbeat"("lastSeen");
CREATE INDEX "AgentHeartbeat_tokenId_idx" ON "AgentHeartbeat"("tokenId");
ALTER TABLE "AgentHeartbeat" ADD CONSTRAINT "AgentHeartbeat_tokenId_fkey"
  FOREIGN KEY ("tokenId") REFERENCES "AgentToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiAccessBlock" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "until" TIMESTAMPTZ(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "liftedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AiAccessBlock_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiAccessBlock_scope_liftedAt_until_idx" ON "AiAccessBlock"("scope", "liftedAt", "until");

CREATE INDEX "ChatMessage_status_createdAt_idx" ON "ChatMessage"("status", "createdAt");

CREATE INDEX "AiAccessBlock_liftedAt_until_idx" ON "AiAccessBlock"("liftedAt", "until");
CREATE INDEX "ChatMessage_lane_deliveredAt_idx" ON "ChatMessage"("lane", "deliveredAt");
