const admin = require('firebase-admin');
const serviceAccount = require('./service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function cleanupDatabase() {
  console.log('Starting database cleanup...');

  // Delete all groups except "PGE Lunch Bunch"
  const groupsSnapshot = await db.collection('groups').get();
  let pgelunchBunchId = null;

  for (const doc of groupsSnapshot.docs) {
    const data = doc.data();
    if (data.name === 'PGE Lunch Bunch') {
      pgelunchBunchId = doc.id;
      console.log(`Keeping group: ${data.name} (${doc.id})`);
    } else {
      console.log(`Deleting group: ${data.name || doc.id} (${doc.id})`);
      
      // Delete subcollections
      const subcollections = ['members', 'pendingMembers', 'votes', 'notificationLog'];
      for (const subcol of subcollections) {
        const subSnapshot = await db.collection('groups').doc(doc.id).collection(subcol).get();
        for (const subDoc of subSnapshot.docs) {
          await subDoc.ref.delete();
        }
      }
      
      // Delete the group
      await doc.ref.delete();
    }
  }

  // Delete all users except johntfosterjr@gmail.com
  const usersSnapshot = await db.collection('users').get();

  for (const doc of usersSnapshot.docs) {
    const data = doc.data();
    if (data.email === 'johntfosterjr@gmail.com') {
      console.log(`Keeping user: ${data.email} (${doc.id})`);
    } else {
      console.log(`Deleting user: ${data.email || doc.id} (${doc.id})`);
      await doc.ref.delete();
    }
  }

  console.log('Database cleanup complete!');
  process.exit(0);
}

cleanupDatabase().catch(error => {
  console.error('Error during cleanup:', error);
  process.exit(1);
});
