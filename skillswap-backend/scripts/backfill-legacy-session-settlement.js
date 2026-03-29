#!/usr/bin/env node

const { admin, getDb } = require('./lib/admin');

function isPaidSession(session) {
  return session && session.sessionType !== 'demo' && Number(session.creditsAgreed || 0) > 0;
}

function sumAmounts(items) {
  return items.reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);
}

function getTeacherAction(session) {
  if (session.status === 'no-show') {
    return session.noShowType === 'student' ? 'student_no_show' : 'teacher_no_show';
  }
  if (session.status === 'cancelled') return 'teacher_cancelled';
  return session.completedBy === session.teacherUid ? 'delivered' : 'delivered';
}

function getStudentAction(session) {
  if (session.status === 'no-show') {
    return session.noShowType === 'student' ? 'student_no_show' : 'teacher_no_show';
  }
  if (session.status === 'cancelled') return 'student_cancelled';
  return session.completedBy === session.studentUid ? 'completed' : 'auto_released';
}

function deriveCreditStatus(session, released, refunded) {
  if (session.status === 'completed' && released > 0 && refunded === 0) return 'released';
  if (refunded > 0 && released === 0) return 'refunded';
  if (released > 0 && refunded > 0) return 'split';
  if (released > 0) return 'manual';
  return 'manual';
}

async function main() {
  const db = getDb();
  const [sessionsSnap, transactionsSnap] = await Promise.all([
    db.collection('sessions').get(),
    db.collection('transactions').get()
  ]);

  const transactionsBySession = new Map();
  transactionsSnap.forEach(docSnap => {
    const tx = { id: docSnap.id, ...docSnap.data() };
    if (!tx.relatedSessionId) return;
    if (!transactionsBySession.has(tx.relatedSessionId)) transactionsBySession.set(tx.relatedSessionId, []);
    transactionsBySession.get(tx.relatedSessionId).push(tx);
  });

  let updatedSessions = 0;
  let updatedTransactions = 0;
  let batch = db.batch();
  let ops = 0;

  for (const docSnap of sessionsSnap.docs) {
    const session = { id: docSnap.id, ...docSnap.data() };
    if (!isPaidSession(session)) continue;
    if (session.creditStatus && session.settlementStatus && session.teacherAction && session.studentAction && session.heldCredits != null) {
      continue;
    }

    const sessionTransactions = transactionsBySession.get(session.id) || [];
    const released = sumAmounts(sessionTransactions.filter(tx => tx.uid === session.teacherUid && tx.type === 'earn'));
    const refunded = sumAmounts(sessionTransactions.filter(tx => tx.uid === session.studentUid && tx.type === 'refund'));
    const heldCredits = Math.max(0, released + refunded || Number(session.creditsAgreed || 0));
    const creditStatus = deriveCreditStatus(session, released, refunded);
    const patch = {
      sessionType: session.sessionType || 'credit',
      heldCredits,
      releasedCredits: released,
      refundedCredits: refunded,
      creditStatus,
      settlementStatus: 'settled',
      teacherAction: session.teacherAction || getTeacherAction(session),
      studentAction: session.studentAction || getStudentAction(session),
      migrationIssue: creditStatus === 'manual' ? 'Legacy session was settled before escrow rollout.' : admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    batch.set(docSnap.ref, patch, { merge: true });
    updatedSessions += 1;
    ops += 1;

    for (const tx of sessionTransactions) {
      if (tx.heldBalanceAfter != null && Number(tx.balanceAfter || 0) >= 0) continue;
      batch.set(db.collection('transactions').doc(tx.id), {
        heldBalanceAfter: tx.heldBalanceAfter != null ? tx.heldBalanceAfter : 0,
        balanceAfter: Math.max(0, Number(tx.balanceAfter || 0))
      }, { merge: true });
      updatedTransactions += 1;
      ops += 1;
      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops >= 350) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log('Legacy session settlement backfill complete.');
  console.log(`Sessions updated: ${updatedSessions}`);
  console.log(`Transactions updated: ${updatedTransactions}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
