#!/usr/bin/env node

const { admin, getDb } = require('./lib/admin');

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCreditSnapshot(user) {
  return {
    available: Math.max(0, Number(user?.creditBalance || 0)),
    held: Math.max(0, Number(user?.heldCreditBalance || 0))
  };
}

function isPaidSession(session) {
  return session && session.sessionType !== 'demo' && Number(session.creditsAgreed || 0) > 0;
}

async function openReviewCase(db, sessionRef, session, caseType, issueReason) {
  if (session.creditReviewCaseId) {
    await sessionRef.set({
      settlementStatus: 'review_pending',
      creditStatus: 'manual',
      migrationIssue: issueReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return session.creditReviewCaseId;
  }

  const caseRef = db.collection('creditReviewCases').doc();
  const batch = db.batch();
  batch.set(caseRef, {
    sessionId: sessionRef.id,
    teacherUid: session.teacherUid || null,
    studentUid: session.studentUid || null,
    teacherName: session.teacherName || '',
    studentName: session.studentName || '',
    topic: session.topic || session.title || 'Scheduled session',
    caseType,
    status: 'pending',
    creditsHeld: 0,
    issueReason,
    openedByUid: 'migration-script',
    openedByRole: 'system',
    openedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewNotes: 'Created automatically during escrow migration.'
  });
  batch.set(sessionRef, {
    creditReviewCaseId: caseRef.id,
    settlementStatus: 'review_pending',
    creditStatus: 'manual',
    migrationIssue: issueReason,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();
  return caseRef.id;
}

async function migrateSessionToEscrow(db, sessionRef, session) {
  const amount = Math.max(0, Number(session.creditsAgreed || 0));
  if (!session.studentUid || !session.teacherUid || !amount) {
    await openReviewCase(db, sessionRef, session, 'legacy_session_inconsistency', 'Session is missing teacher, learner, or paid-credit metadata.');
    return 'review';
  }

  const learnerRef = db.collection('users').doc(session.studentUid);
  return db.runTransaction(async tx => {
    const learnerSnap = await tx.get(learnerRef);
    if (!learnerSnap.exists) {
      throw new Error('missing-learner');
    }
    const learner = learnerSnap.data() || {};
    const credits = getCreditSnapshot(learner);
    if (credits.available < amount) {
      throw new Error('insufficient-credits');
    }

    const nextAvailable = credits.available - amount;
    const nextHeld = credits.held + amount;
    tx.set(learnerRef, {
      creditBalance: nextAvailable,
      heldCreditBalance: nextHeld,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(sessionRef, {
      heldCredits: amount,
      releasedCredits: Number(session.releasedCredits || 0),
      refundedCredits: Number(session.refundedCredits || 0),
      creditStatus: 'held',
      settlementStatus: session.status === 'awaiting_learner' ? 'awaiting_learner' : (session.settlementStatus || 'scheduled'),
      teacherAction: session.teacherAction || 'pending',
      studentAction: session.studentAction || 'pending',
      migrationEscrowProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(db.collection('transactions').doc(), {
      uid: session.studentUid,
      type: 'hold',
      amount,
      description: `Reserved ${amount} credits for legacy scheduled session ${session.topic || session.title || sessionRef.id}`,
      category: 'session',
      relatedSessionId: sessionRef.id,
      relatedUserId: session.teacherUid,
      balanceAfter: nextAvailable,
      heldBalanceAfter: nextHeld,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }).then(() => 'migrated');
}

async function main() {
  const db = getDb();
  const now = Date.now();
  const snap = await db.collection('sessions').get();
  let migrated = 0;
  let skipped = 0;
  let sentToReview = 0;

  for (const docSnap of snap.docs) {
    const session = { id: docSnap.id, ...docSnap.data() };
    const startDate = toDate(session.startAt);
    if (!isPaidSession(session) || !startDate || startDate.getTime() <= now) {
      skipped += 1;
      continue;
    }
    if (['released', 'refunded', 'split', 'manual', 'held'].includes(session.creditStatus) || Number(session.heldCredits || 0) > 0) {
      skipped += 1;
      continue;
    }
    if (['completed', 'cancelled', 'no-show'].includes(session.status)) {
      skipped += 1;
      continue;
    }

    try {
      const outcome = await migrateSessionToEscrow(db, docSnap.ref, session);
      if (outcome === 'migrated') migrated += 1;
      else sentToReview += 1;
    } catch (err) {
      if (err && (err.message === 'insufficient-credits' || err.message === 'missing-learner')) {
        const reason = err.message === 'insufficient-credits'
          ? 'Learner no longer has enough available credits to reserve escrow for this future paid session.'
          : 'Learner profile could not be found during escrow migration.';
        await openReviewCase(db, docSnap.ref, session, err.message === 'insufficient-credits' ? 'legacy_payment_shortfall' : 'legacy_session_inconsistency', reason);
        sentToReview += 1;
      } else {
        throw err;
      }
    }
  }

  console.log('Future paid-session escrow migration complete.');
  console.log(`Migrated sessions to held escrow: ${migrated}`);
  console.log(`Sent to reviewer credit queue: ${sentToReview}`);
  console.log(`Skipped sessions: ${skipped}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
