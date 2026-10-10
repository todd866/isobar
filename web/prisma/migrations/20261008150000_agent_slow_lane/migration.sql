-- Owner applies separately; no data or secrets belong in this migration.
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AgentToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentToken_scope_check" CHECK ("scope" IN ('owner', 'user'))
);
CREATE UNIQUE INDEX "AgentToken_hashedToken_key" ON "AgentToken"("hashedToken");
CREATE INDEX "AgentToken_userId_idx" ON "AgentToken"("userId");
ALTER TABLE "AgentToken" ADD CONSTRAINT "AgentToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD COLUMN "leaseId" TEXT,
    ADD COLUMN "leaseUntil" TIMESTAMPTZ(3),
    ADD COLUMN "agentTokenId" TEXT,
    ADD COLUMN "toolsUsed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "images" JSONB;
CREATE INDEX "ChatMessage_agentTokenId_idx" ON "ChatMessage"("agentTokenId");
CREATE INDEX "ChatMessage_status_leaseUntil_idx" ON "ChatMessage"("status", "leaseUntil");
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_agentTokenId_fkey" FOREIGN KEY ("agentTokenId") REFERENCES "AgentToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
