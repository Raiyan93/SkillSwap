#!/usr/bin/env node

const { admin, getDb, deleteDocs } = require('./lib/admin');

const DEFAULT_TEACHER = {
  uid: 'THITqZognOYdwpQ1PQPOihQ3nG92',
  name: 'Haris Khan'
};

const DEFAULT_STUDENTS = [
  { uid: 'koYkjafndgUdJSqbY4WYYIGCdvy2', name: 'Raiyan Chougle' },
  { uid: 'xpcC103B5iRTrNZEcT0D6FD2quH2', name: 'soham mayekar' }
];

const SEED_KEY = 'human-verification-demo-haris-khan-v1';
const SESSION_BLUEPRINTS = [
  {
    topic: 'MongoDB Basics',
    studentIndex: 0,
    rating: 5,
    feedback: 'Very clear teaching and good pacing.'
  },
  {
    topic: 'MongoDB CRUD Operations',
    studentIndex: 1,
    rating: 5,
    feedback: 'Explained MongoDB queries really well.'
  },
  {
    topic: 'MongoDB Aggregation Pipeline',
    studentIndex: 0,
    rating: 4,
    feedback: 'Helpful session with strong examples.'
  },
  {
    topic: 'MongoDB Indexing and Performance',
    studentIndex: 1,
    rating: 5,
    feedback: ''
  },
  {
    topic: 'MongoDB Schema Design',
    studentIndex: 0,
    rating: 5,
    feedback: ''
  }
];

async function assertUserExists(db, uid, expectedName) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    throw new Error(`User not found: ${uid}`);
  }
  const data = snap.data() || {};
  const actualName = data.fullName || [data.firstName, data.lastName].filter(Boolean).join(' ') || data.firstName || '';
  if (expectedName && actualName && actualName.toLowerCase() !== expectedName.toLowerCase()) {
    console.log(`Warning: user ${uid} exists but name is "${actualName}", not "${expectedName}". Proceeding anyway.`);
  }
  return { uid, ...data };
}

function mergeTeachSkills(existingSkills, requiredSkill) {
  const list = Array.isArray(existingSkills) ? existingSkills.slice() : [];
  const alreadyPresent = list.some(item => {
    const name = typeof item === 'string' ? item : item && item.name;
    return String(name || '').trim().toLowerCase() === requiredSkill.name.toLowerCase();
  });
  if (!alreadyPresent) list.unshift(requiredSkill);
  return list;
}

function buildTeacherReputation() {
  return {
    completedTeachingSessions: 5,
    completedDemoSessions: 5,
    completedPaidSessions: 0,
    writtenLearnerFeedbackCount: 3,
    averageRating: 4.8,
    totalRatings: 5,
    noShowCount: 0,
    disputeCount: 0,
    badgeTier: 'none',
    eligibleForHumanReview: true,
    requirementProgress: {
      aiVerified: true,
      teachSkillsCount: 1,
      sessionsCompleted: 5,
      sessionsRequired: 5,
      averageRating: 4.8,
      ratingRequired: 4,
      writtenFeedbackCount: 3,
      feedbackRequired: 2
    }
  };
}

function buildSessionPayload(teacher, student, index, blueprint) {
  const startDate = new Date(Date.now() - ((index + 2) * 24 * 60 * 60 * 1000));
  startDate.setHours(17 + (index % 2), 0, 0, 0);
  const completedDate = new Date(startDate.getTime() + (60 * 60 * 1000));
  const ratedAt = new Date(completedDate.getTime() + (5 * 60 * 1000));
  return {
    teacherUid: teacher.uid,
    studentUid: student.uid,
    participants: [teacher.uid, student.uid],
    teacherName: teacher.name,
    studentName: student.name,
    partnerName: student.name,
    topic: blueprint.topic,
    title: `Session with ${student.name}`,
    status: 'completed',
    sessionType: 'demo',
    durationMinutes: 60,
    creditsAgreed: 0,
    creditsTransferred: false,
    skillRequested: 'MongoDB',
    skillKey: 'mongodb',
    requestId: null,
    meetUrl: null,
    calendarUrl: null,
    calendarEventId: null,
    scheduledByUid: teacher.uid,
    completedBy: student.uid,
    startAt: admin.firestore.Timestamp.fromDate(startDate),
    completedAt: admin.firestore.Timestamp.fromDate(completedDate),
    createdAt: admin.firestore.Timestamp.fromDate(startDate),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ratings: {
      [student.uid]: {
        rating: blueprint.rating,
        feedback: blueprint.feedback,
        ratedAt: admin.firestore.Timestamp.fromDate(ratedAt)
      }
    },
    seedKey: SEED_KEY
  };
}

async function main() {
  const db = getDb();
  const teacher = DEFAULT_TEACHER;
  const students = DEFAULT_STUDENTS;

  console.log(`Preparing human-verification demo seed for ${teacher.name} (${teacher.uid})`);
  await assertUserExists(db, teacher.uid, teacher.name);
  for (const student of students) {
    await assertUserExists(db, student.uid, student.name);
  }

  const teacherRef = db.collection('users').doc(teacher.uid);
  const teacherSnap = await teacherRef.get();
  const teacherData = teacherSnap.data() || {};
  const existingTeachSkills = teacherData.skills && teacherData.skills.toTeach;
  const mergedTeachSkills = mergeTeachSkills(existingTeachSkills, { name: 'MongoDB', level: 'Expert' });
  const teacherReputation = buildTeacherReputation();

  const existingSeedSessions = await db.collection('sessions').where('seedKey', '==', SEED_KEY).get();
  const deletedSeedSessions = await deleteDocs(existingSeedSessions);

  const oldReviewRequests = await db.collection('humanVerificationRequests').where('uid', '==', teacher.uid).get();
  const deletedReviewRequests = await deleteDocs(oldReviewRequests);

  await teacherRef.set({
    fullName: teacherData.fullName || teacher.name,
    verification: {
      status: 'verified',
      score: 85
    },
    skills: {
      toTeach: mergedTeachSkills,
      toLearn: Array.isArray(teacherData.skills && teacherData.skills.toLearn) ? teacherData.skills.toLearn : [],
      teaching: {
        style: (teacherData.skills && teacherData.skills.teaching && teacherData.skills.teaching.style) || 'Practical',
        language: (teacherData.skills && teacherData.skills.teaching && teacherData.skills.teaching.language) || 'English',
        statement: (teacherData.skills && teacherData.skills.teaching && teacherData.skills.teaching.statement) || 'I teach MongoDB clearly from basics to advanced.'
      }
    },
    teachingProfile: {
      demoOptIn: true,
      visibleAsTeacher: true
    },
    stats: {
      averageRating: 4.8,
      totalRatings: 5,
      sessionsCompleted: 5,
      sessionsTaught: 5
    },
    teacherReputation,
    'humanVerification.status': 'not-requested',
    'humanVerification.requestId': admin.firestore.FieldValue.delete(),
    'humanVerification.requestedAt': admin.firestore.FieldValue.delete(),
    'humanVerification.reviewedAt': admin.firestore.FieldValue.delete(),
    'humanVerification.reviewedBy': admin.firestore.FieldValue.delete(),
    'humanVerification.reviewedByName': admin.firestore.FieldValue.delete(),
    'humanVerification.reviewNotes': admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  for (let index = 0; index < SESSION_BLUEPRINTS.length; index += 1) {
    const blueprint = SESSION_BLUEPRINTS[index];
    const student = students[blueprint.studentIndex];
    const payload = buildSessionPayload(teacher, student, index, blueprint);
    await db.collection('sessions').add(payload);
  }

  console.log(`Deleted ${deletedSeedSessions} old seeded sessions.`);
  console.log(`Deleted ${deletedReviewRequests} old human verification requests.`);
  console.log('Created 5 completed demo sessions for Haris Khan.');
  console.log('Haris Khan should now be eligible to click "Request Review".');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
