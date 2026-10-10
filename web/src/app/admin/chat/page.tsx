import { notFound } from 'next/navigation';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { chatEnv } from '@/lib/chat/handler';
import { ownerAllowed, shapeAdmin } from '@/lib/chat/admin-view';
import { PUBLIC_CAPS, SIGNED_IN_TOTAL_USD, USER_CAP_USD } from '@/lib/chat/budgets';
import { LINES } from '@/lib/chat/types';
import { monthStart } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

const usd = (value: number) => `$${value.toFixed(2)}`;

export default async function AdminChatPage() {
  const session = await auth();
  const env = chatEnv();
  if (!ownerAllowed(session?.user?.email, env.ownerEmail)) notFound();
  const now = new Date();
  const since = monthStart(now);
  const [users, clusters, grades, blocked, spend] = await Promise.all([
    db().user.findMany({
      select: { id: true, email: true, clusterId: true, chatStanding: { select: { tier: true, pinnedTier: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db().chatCluster.findMany(),
    db().chatMessage.findMany({
      where: { grade: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { grade: true, gradeReason: true, createdAt: true, thread: { select: { userId: true } } },
    }),
    db().chatMessage.findMany({
      where: { role: 'user', thread: { messages: { some: { content: LINES.blocked } } } },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: { content: true, thread: { select: { user: { select: { clusterId: true } } } } },
    }),
    db().chatMessage.findMany({
      where: { createdAt: { gte: since, lt: now }, model: { not: null } },
      select: { model: true, costUsd: true, createdAt: true, thread: { select: { userId: true, user: { select: { email: true } } } } },
    }),
  ]);
  const view = shapeAdmin({
    now,
    userCap: env.userCap || USER_CAP_USD,
    publicCaps: env.publicCaps || PUBLIC_CAPS,
    signedInCap: env.signedInTotal || SIGNED_IN_TOTAL_USD,
    users: users.map((user) => ({
      id: user.id, email: user.email, clusterId: user.clusterId,
      tier: user.chatStanding?.tier ?? null, pinnedTier: user.chatStanding?.pinnedTier ?? null,
    })),
    clusters,
    grades: grades.flatMap((grade) => grade.thread.userId && grade.grade ? [{
      userId: grade.thread.userId, grade: grade.grade, reason: grade.gradeReason, at: grade.createdAt,
    }] : []),
    blocked: blocked.map((message) => ({ clusterId: message.thread.user?.clusterId ?? null, content: message.content })),
    spend: spend.map((row) => ({
      userId: row.thread.userId, model: row.model, costUsd: row.costUsd, createdAt: row.createdAt,
      owner: ownerAllowed(row.thread.user?.email, env.ownerEmail),
    })),
  });
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 text-[13px] text-[var(--md-on-surface)]">
      <p className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums" aria-label="This month">
        <span title="Signed-in spend this month">Signed-in {usd(view.signedInUsd)} of {usd(view.signedInCap)}</span>
        <span title="Opus, public pool">Opus {usd(view.models.opus)} · {usd(view.publicPools.opus.leftToday)} left of {usd(view.publicPools.opus.allowanceToday)}</span>
        <span title="Sonnet, public pool">Sonnet {usd(view.models.sonnet)} · {usd(view.publicPools.sonnet.leftToday)} left of {usd(view.publicPools.sonnet.allowanceToday)}</span>
        <span title="Haiku, public pool">Haiku {usd(view.models.haiku)} · {usd(view.publicPools.haiku.leftToday)} left of {usd(view.publicPools.haiku.allowanceToday)}</span>
      </p>
      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr className="h-8 text-left text-[var(--md-on-surface-variant)]">
            <th className="font-medium">User</th>
            <th className="font-medium">Cluster</th>
            <th className="font-medium">Tier</th>
            <th className="font-medium">Pin</th>
            <th className="font-medium">Month</th>
            <th className="font-medium">Today left</th>
            <th className="font-medium">Grades</th>
          </tr>
        </thead>
        <tbody>
          {view.users.map((user) => (
            <tr key={user.id} className="h-10 border-t border-[var(--md-outline-soft)] align-middle" data-admin-user={user.id}>
              <td className="max-w-48 truncate pr-2" title={user.email ?? user.id}>{user.email ?? user.id}</td>
              <td className="pr-2 font-mono text-[11px]">{user.clusterId?.slice(0, 8) ?? '—'}</td>
              <td className="pr-2">{user.tier}</td>
              <td className="pr-2">
                <form action="/api/admin/chat" method="post" className="flex items-center gap-1">
                  <input type="hidden" name="action" value="pin" />
                  <input type="hidden" name="userId" value={user.id} />
                  <select name="pinnedTier" defaultValue={user.pinnedTier ?? ''} aria-label={`Pin ${user.email ?? user.id}`} className="h-8 rounded-md border border-[var(--md-outline-soft)] bg-[var(--md-surface)] px-1">
                    <option value="">—</option>
                    <option value="opus">Opus</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="haiku">Haiku</option>
                    <option value="off">Off</option>
                  </select>
                  <button type="submit" className="h-8 rounded-md px-2 font-medium text-[var(--md-primary)]">Pin</button>
                </form>
              </td>
              <td className="pr-2">{usd(user.monthUsd)}</td>
              <td className="pr-2" title={`Today ${usd(user.todayUsd)} of ${usd(user.todayAllowance)}`}>{usd(user.todayLeft)}</td>
              <td className="max-w-72">
                {user.grades.length === 0 ? '—' : user.grades.map((grade, index) => (
                  <span key={`${grade.at}-${index}`} className="mr-2 inline-block" title={grade.reason ?? grade.grade}>{grade.grade}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.suspensions.map((cluster) => (
        <div key={cluster.clusterId} className="flex flex-wrap items-center gap-2 border-t border-[var(--md-outline-soft)] py-2" data-admin-suspension={cluster.clusterId}>
          <span className="font-mono text-[11px]" title="Suspended cluster">{cluster.clusterId.slice(0, 8)}</span>
          <span title="Blocks today">{cluster.blockCount}</span>
          {cluster.messages.map((message, index) => <span key={index} className="max-w-md truncate text-[var(--md-on-surface-variant)]" title={message}>{message}</span>)}
          <form action="/api/admin/chat" method="post">
            <input type="hidden" name="action" value="lift" />
            <input type="hidden" name="clusterId" value={cluster.clusterId} />
            <button type="submit" className="h-8 rounded-md bg-[var(--md-primary)] px-3 font-medium text-[var(--md-on-primary)]">Lift</button>
          </form>
        </div>
      ))}
    </main>
  );
}
