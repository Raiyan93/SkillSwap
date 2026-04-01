#!/usr/bin/env node

const { admin, getDb, toMillis } = require('./lib/admin');

function getTeachSkills(user) {
  return Array.isArray(user?.skills?.toTeach) ? user.skills.toTeach : [];
}

function isPaidSession(session) {
  return session && session.sessionType !== 'demo' && Number(session.creditsAgreed || 0) > 0;
}

function getBadgeTier(completedPaidSessions) {
  if (completedPaidSessions >= 20) return 'gold';
  if (completedPaidSessions >= 10) return 'silver';
  if (completedPaidSessions >= 5) return 'bronze';
  return 'none';
}

function getLatestRequest(requests) {
  if (!requests.length) return null;
  return requests.slice().sort((a, b) => Math.max(toMillis(b.updatedAt), toMillis(b.reviewedAt), toMillis(b.requestedAt)) - Math.max(toMillis(a.updatedAt), toMillis(a.reviewedAt), toMillis(a.requestedAt)))[0];
}

function buildHumanVerificationMirror(user, requests) {
  const existing = user?.humanVerification || {};
  const latest = getLatestRequest(requests);
  if (latest) {
    return {
      status: latest.status || 'pending',
      requestId: latest.id,
      requestedAt: latest.requestedAt || null,
      reviewedAt: latest.reviewedAt || null,
      reviewedBy: latest.reviewedBy || '',
      reviewedByName: latest.reviewedByName || '',
      reviewNotes: latest.reviewNotes || ''
    };
  }
  if (existing.status && existing.status !== 'not-requested') {
    return {
      status: existing.status,
      requestId: existing.requestId || null,
      requestedAt: existing.requestedAt || null,
      reviewedAt: existing.reviewedAt || null,
      reviewedBy: existing.reviewedBy || '',
      reviewedByName: existing.reviewedByName || '',
      reviewNotes: existing.reviewNotes || ''
    };
  }
  return { status: 'not-requested' };
}

function isSettledCompletedSession(session) {
  if (!session || session.status !== 'completed') return false;
  const settlement = String(session.settlementStatus || '').toLowerCase();
  return !settlement || settlement === 'settled' || settlement === 'completed';
}

function normalizeRatingFeedback(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getCanonicalOrDerivedRatingEntry(session, raterUid) {
  if (!session || !raterUid) return null;
  const direct = session?.ratings?.[raterUid];
  if (direct) {
    const directRating = Number(direct.rating || 0);
    const directFeedback = normalizeRatingFeedback(direct.feedback);
    if (directRating > 0 || directFeedback) {
      return {
        rating: directRating > 0 ? directRating : 0,
        feedback: directFeedback,
        ratedAt: direct.ratedAt || null
      };
    }
  }
  if (!isSettledCompletedSession(session)) return null;
  const response = raterUid === session.teacherUid
    ? session.teacherResponse
    : (raterUid === session.studentUid ? session.studentResponse : null);
  if (!response) return null;
  const responseRating = Number(response.rating || 0);
  const responseFeedback = normalizeRatingFeedback(response.feedback || response.note || '');
  if (!(responseRating > 0 || responseFeedback)) return null;
  return {
    rating: responseRating > 0 ? responseRating : 0,
    feedback: responseFeedback,
    ratedAt: response.submittedAt || session.completedAt || null
  };
}

function buildRecoveredRatingsPayload(session) {
  const recoveredRatings = {};
  const update = {};
  [session?.teacherUid, session?.studentUid].forEach((raterUid) => {
    if (!raterUid || session?.ratings?.[raterUid]) return;
    const derived = getCanonicalOrDerivedRatingEntry(session, raterUid);
    if (!derived) return;
    const entry = {
      rating: Number(derived.rating || 0),
      feedback: derived.feedback || '',
      ratedAt: derived.ratedAt || session.completedAt || null
    };
    recoveredRatings[raterUid] = entry;
    update[`ratings.${raterUid}`] = {
      ...entry,
      ratedAt: entry.ratedAt || admin.firestore.FieldValue.serverTimestamp()
    };
  });
  return {
    update,
    recoveredCount: Object.keys(recoveredRatings).length,
    session: Object.keys(recoveredRatings).length
      ? { ...session, ratings: { ...(session.ratings || {}), ...recoveredRatings } }
      : session
  };
}

function buildUserStats(user, sessions, uid) {
  let sessionsCompleted = 0;
  let sessionsTaught = 0;
  let totalRatings = 0;
  let ratingTotal = 0;

  sessions.forEach((session) => {
    if (!isSettledCompletedSession(session)) return;
    if (session.teacherUid === uid || session.studentUid === uid) {
      sessionsCompleted += 1;
    }
    if (session.teacherUid === uid) {
      sessionsTaught += 1;
    }
    const counterpartUid = session.teacherUid === uid
      ? session.studentUid
      : (session.studentUid === uid ? session.teacherUid : null);
    const receivedRating = getCanonicalOrDerivedRatingEntry(session, counterpartUid);
    const ratingValue = Number(receivedRating?.rating || 0);
    if (ratingValue > 0) {
      totalRatings += 1;
      ratingTotal += ratingValue;
    }
  });

  return {
    averageRating: totalRatings ? ratingTotal / totalRatings : Number(user?.stats?.averageRating || 0),
    totalRatings,
    sessionsCompleted,
    sessionsTaught
  };
}

function buildTeacherReputation(user, sessions) {
  const completedSessions = sessions.filter(isSettledCompletedSession);
  const teachSkills = getTeachSkills(user);
  let completedDemoSessions = 0;
  let completedPaidSessions = 0;
  let writtenLearnerFeedbackCount = 0;
  let totalRatings = 0;
  let ratingTotal = 0;
  let noShowCount = 0;
  let disputeCount = 0;

  completedSessions.forEach(session => {
    if (isPaidSession(session)) completedPaidSessions += 1;
    else completedDemoSessions += 1;

    const learnerRating = getCanonicalOrDerivedRatingEntry(session, session.studentUid);
    const ratingValue = Number(learnerRating?.rating || 0);
    if (ratingValue > 0) {
      totalRatings += 1;
      ratingTotal += ratingValue;
    }
    const learnerFeedback = normalizeRatingFeedback(learnerRating?.feedback);
    if (learnerFeedback) {
      writtenLearnerFeedbackCount += 1;
    }
  });

  sessions.forEach(session => {
    if (session.status === 'disputed' || session.settlementStatus === 'review_pending' || session.creditReviewCaseId) {
      disputeCount += 1;
    }
    if (session.status === 'no-show' && session.noShowType === 'teacher') {
      noShowCount += 1;
    }
  });

  const completedTeachingSessions = completedSessions.length;
  const averageRating = totalRatings ? ratingTotal / totalRatings : Number(user?.stats?.averageRating || 0);
  const eligibleForHumanReview = (
    user?.verification?.status === 'verified'
    && teachSkills.length > 0
    && completedTeachingSessions >= 5
  );

  return {
    completedTeachingSessions,
    completedDemoSessions,
    completedPaidSessions,
    writtenLearnerFeedbackCount,
    averageRating,
    totalRatings,
    noShowCount,
    disputeCount,
    badgeTier: getBadgeTier(completedPaidSessions),
    eligibleForHumanReview,
    requirementProgress: {
      aiVerified: user?.verification?.status === 'verified',
      teachSkillsCount: teachSkills.length,
      sessionsCompleted: completedTeachingSessions,
      sessionsRequired: 5
    }
  };
}

async function main() {
  const db = getDb();
  const [usersSnap, sessionsSnap, requestsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('sessions').get(),
    db.collection('humanVerificationRequests').get()
  ]);

  const sessions = sessionsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  const normalizedSessions = [];
  const requestsByUid = new Map();

  requestsSnap.forEach(docSnap => {
    const request = { id: docSnap.id, ...docSnap.data() };
    if (!request.uid) return;
    if (!requestsByUid.has(request.uid)) requestsByUid.set(request.uid, []);
    requestsByUid.get(request.uid).push(request);
  });

  let batch = db.batch();
  let ops = 0;

  async function queueUpdate(ref, payload) {
    batch.update(ref, payload);
    ops += 1;
    if (ops >= 350) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  let backfilledSessionRatings = 0;
  for (const docSnap of sessionsSnap.docs) {
    const session = { id: docSnap.id, ...docSnap.data() };
    const recovered = buildRecoveredRatingsPayload(session);
    normalizedSessions.push(recovered.session);
    if (Object.keys(recovered.update).length) {
      await queueUpdate(docSnap.ref, recovered.update);
      backfilledSessionRatings += recovered.recoveredCount;
    }
  }

  let updatedUsers = 0;
  let addedTeacherReputation = 0;
  let normalizedHeldBalance = 0;
  let deletedLegacyStats = 0;

  for (const docSnap of usersSnap.docs) {
    const uid = docSnap.id;
    const user = docSnap.data() || {};
    const participantSessions = normalizedSessions.filter(session => session.teacherUid === uid || session.studentUid === uid);
    const teacherSessions = normalizedSessions.filter(session => session.teacherUid === uid);
    const hasTeacherData = getTeachSkills(user).length > 0 || teacherSessions.length > 0 || !!user.teacherReputation;
    const stats = buildUserStats(user, participantSessions, uid);
    const payload = {
      creditBalance: Math.max(0, Number(user.creditBalance || 0)),
      heldCreditBalance: Math.max(0, Number(user.heldCreditBalance || 0)),
      humanVerification: buildHumanVerificationMirror(user, requestsByUid.get(uid) || []),
      teacherReputation: hasTeacherData ? buildTeacherReputation(user, teacherSessions) : admin.firestore.FieldValue.delete(),
      'stats.averageRating': stats.averageRating,
      'stats.totalRatings': stats.totalRatings,
      'stats.sessionsCompleted': stats.sessionsCompleted,
      'stats.sessionsTaught': stats.sessionsTaught,
      'stats.completionRate': admin.firestore.FieldValue.delete(),
      'stats.ratingsBreakdown': admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (user.heldCreditBalance == null) normalizedHeldBalance += 1;
    if (user?.stats?.completionRate != null || user?.stats?.ratingsBreakdown) deletedLegacyStats += 1;
    if (hasTeacherData) addedTeacherReputation += 1;

    await queueUpdate(docSnap.ref, payload);
    updatedUsers += 1;
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log('Firestore normalization complete.');
  console.log(`Users updated: ${updatedUsers}`);
  console.log(`Users normalized with heldCreditBalance: ${normalizedHeldBalance}`);
  console.log(`Users synced with teacherReputation: ${addedTeacherReputation}`);
  console.log(`Sessions backfilled with canonical ratings: ${backfilledSessionRatings}`);
  console.log(`Users cleaned of legacy stats fields: ${deletedLegacyStats}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
