-- Additive report queue. No existing tables or user data are rewritten.

CREATE TABLE "ReportSubscription" (
    "id" TEXT NOT NULL,
    CONSTRAINT "ReportSubscription_pkey" PRIMARY KEY ("id"),
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'recurring',
    "schedule" TEXT,
    "timezone" TEXT NOT NULL,
    "places" JSONB NOT NULL,
    "instructions" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "complexity" TEXT NOT NULL DEFAULT 'simple',
    "status" TEXT NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMPTZ(3),
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "threadId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ReportSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReportSubscription_status_nextRunAt_idx" ON "ReportSubscription"("status", "nextRunAt");

CREATE INDEX "ReportSubscription_userId_status_idx" ON "ReportSubscription"("userId", "status");

CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id"),
    "subscriptionId" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "html" TEXT,
    "text" TEXT,
    "ownerNotifiedAt" TIMESTAMPTZ(3),
    "sendAfterAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "claimedBy" TEXT,
    "agentTokenId" TEXT,
    "generationAttempts" INTEGER NOT NULL DEFAULT 0,
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMPTZ(3),
    "deliveryPayload" JSONB,
    "deliveryEmail" TEXT,
    "dispatchAt" TIMESTAMPTZ(3),
    "providerId" TEXT,
    "messageId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "failureNotifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportRun_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ReportSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReportRun_messageId_key" ON "ReportRun"("messageId");

CREATE UNIQUE INDEX "ReportRun_subscriptionId_dueAt_key" ON "ReportRun"("subscriptionId", "dueAt");

CREATE INDEX "ReportRun_status_dueAt_idx" ON "ReportRun"("status", "dueAt");

CREATE INDEX "ReportRun_status_leaseUntil_idx" ON "ReportRun"("status", "leaseUntil");

CREATE INDEX "ReportRun_sentAt_idx" ON "ReportRun"("sentAt");

CREATE INDEX "ReportRun_dispatchAt_idx" ON "ReportRun"("dispatchAt");

CREATE TABLE "ReportInbound" (
    "id" TEXT NOT NULL,
    CONSTRAINT "ReportInbound_pkey" PRIMARY KEY ("id"),
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'accepted'
);

CREATE INDEX "ReportInbound_userId_createdAt_idx" ON "ReportInbound"("userId", "createdAt");

CREATE INDEX "ReportInbound_createdAt_idx" ON "ReportInbound"("createdAt");

ALTER TABLE "ReportSubscription"
  ADD CONSTRAINT "ReportSubscription_kind_check" CHECK ("kind" IN ('once','recurring')),
  ADD CONSTRAINT "ReportSubscription_status_check" CHECK ("status" IN ('active','paused','cancelled')),
  ADD CONSTRAINT "ReportSubscription_tier_check" CHECK ("tier" IN ('free','paid')),
  ADD CONSTRAINT "ReportSubscription_complexity_check" CHECK ("complexity" IN ('simple','complex')),
  ADD CONSTRAINT "ReportSubscription_schedule_check" CHECK (("kind" = 'once' AND "schedule" IS NULL) OR ("kind" = 'recurring' AND "schedule" IS NOT NULL));
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_status_check" CHECK ("status" IN ('queued','generating','awaiting-owner','held','sent','failed'));
