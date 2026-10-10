CREATE TABLE "Entitlement" (
    "userId" TEXT NOT NULL,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'none',
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "billingAnchor" TIMESTAMPTZ(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "checkoutSessionId" TEXT,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "deleting" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "Entitlement_plan_check" CHECK ("plan" IS NULL OR "plan" IN ('monthly', 'yearly')),
    CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Entitlement_stripeCustomerId_key" ON "Entitlement"("stripeCustomerId");
CREATE UNIQUE INDEX "Entitlement_stripeSubscriptionId_key" ON "Entitlement"("stripeSubscriptionId");
CREATE INDEX "Entitlement_status_currentPeriodEnd_idx" ON "Entitlement"("status", "currentPeriodEnd");
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);
