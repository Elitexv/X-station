// Firebase: login (Auth), shared cloud storage with offline support (Firestore), usage events (Analytics).
//
// Data layout (one shared shop, users managed by the admin):
//   meta/setup                 → { done } — exists once the first admin has been created
//   members/{uid}              → { email, name, role: 'admin'|'staff', active, createdAt, createdBy, updatedAt }
//   shop/main                  → { settings: { shopName, currency, target } }
//   shop/main/days/{YYYY-MM-DD}→ { drinks, charging, expenses, note, updatedAt, updatedBy }

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAnalytics, isSupported, logEvent } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence, inMemoryPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyB933cAyDECn0LJDmHHdjdtSrZBQgv2U34',
  authDomain: 'x-station-c1a03.firebaseapp.com',
  projectId: 'x-station-c1a03',
  storageBucket: 'x-station-c1a03.firebasestorage.app',
  messagingSenderId: '869621099746',
  appId: '1:869621099746:web:b1d1148c6fbe478db7c2bb',
  measurementId: 'G-R6PWJPPM7W',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence); // stay signed in on this device

// Second, separate Firebase instance used only by the admin to create new accounts,
// so creating a user does not sign the admin out.
const helperApp = initializeApp(firebaseConfig, 'user-creator');
const helperAuth = getAuth(helperApp);
setPersistence(helperAuth, inMemoryPersistence);

// Offline-first: records are cached on the device and sync when the internet comes back.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

let analytics = null;
isSupported().then(ok => { if (ok) analytics = getAnalytics(app); }).catch(() => {});
export function track(name, params) {
  try { if (analytics) logEvent(analytics, name, params); } catch { /* analytics is optional */ }
}

let user = null;
const setupRef = () => doc(db, 'meta', 'setup');
const memberRef = uid => doc(db, 'members', uid);
const shopRef = () => doc(db, 'shop', 'main');
const daysCol = () => collection(db, 'shop', 'main', 'days');

// ---------- auth ----------
export function onUser(cb) { return onAuthStateChanged(auth, u => { user = u; cb(u); }); }
export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const logOut = () => signOut(auth);
export const currentUser = () => user;

// Has the first admin been created? (readable without signing in)
export async function isSetupDone() {
  const snap = await getDoc(setupRef());
  return snap.exists();
}

// First-time setup: create the admin account, or turn the signed-in account into the admin.
export async function createFirstAdmin(email, pw, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, pw);
  await claimAdmin(name, cred.user);
}
export async function claimAdmin(name, u = user) {
  const batch = writeBatch(db);
  batch.set(memberRef(u.uid), {
    email: u.email, name: name || '', role: 'admin', active: true,
    createdAt: serverTimestamp(), createdBy: u.uid, updatedAt: serverTimestamp(),
  });
  batch.set(setupRef(), { done: true });
  await batch.commit();
}

// ---------- members (users of the app) ----------
export function watchMe(cb, onError) {
  return onSnapshot(memberRef(user.uid), snap => cb(snap.exists() ? snap.data() : null), onError);
}
export function watchMembers(cb, onError) {
  return onSnapshot(collection(db, 'members'), snap => {
    const list = [];
    snap.forEach(d => list.push({ uid: d.id, ...d.data() }));
    cb(list);
  }, onError);
}
// Admin only: create a login for someone and give them access.
export async function addUser({ email, password, name, role }) {
  const cred = await createUserWithEmailAndPassword(helperAuth, email, password);
  try {
    await setDoc(memberRef(cred.user.uid), {
      email: cred.user.email, name: name || '', role, active: true,
      createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(),
    });
  } finally {
    await signOut(helperAuth);
  }
  return cred.user.uid;
}
// Admin only: change role, or remove / restore access (active false = cannot use the app).
export const updateMember = (uid, fields) => updateDoc(memberRef(uid), { ...fields, updatedAt: serverTimestamp() });

// ---------- shop data ----------
// cb(days, meta) — days: { 'YYYY-MM-DD': {...} }, meta: { fromCache, pending }
export function watchDays(cb, onError) {
  return onSnapshot(daysCol(), { includeMetadataChanges: true }, snap => {
    const days = {};
    snap.forEach(d => {
      const v = d.data();
      days[d.id] = { drinks: v.drinks || 0, charging: v.charging || 0, expenses: v.expenses || 0, note: v.note || '', updatedBy: v.updatedBy || '' };
    });
    cb(days, { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
  }, onError);
}
export function watchSettings(cb, onError) {
  return onSnapshot(shopRef(), snap => cb(snap.exists() ? snap.data().settings || {} : null), onError);
}

function dayDoc(rec) {
  return {
    drinks: Number(rec.drinks) || 0, charging: Number(rec.charging) || 0, expenses: Number(rec.expenses) || 0,
    note: rec.note || '', updatedAt: serverTimestamp(), updatedBy: user.email || '',
  };
}
// Writes resolve only when the server confirms, so callers should not wait on them for UI.
export const saveDay = (date, rec) => setDoc(doc(daysCol(), date), dayDoc(rec));
export const removeDay = date => writeBatch(db).delete(doc(daysCol(), date)).commit();
export const saveSettings = settings => setDoc(shopRef(), { settings }, { merge: true });

// Bulk upload (restore backup / move old device records to the cloud). Firestore batches max 500 writes.
export async function uploadDays(days, replaceAll = false, existing = {}) {
  const ops = [];
  if (replaceAll) Object.keys(existing).filter(d => !(d in days)).forEach(d => ops.push(['del', d]));
  Object.entries(days).forEach(([d, r]) => ops.push(['set', d, r]));
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach(([op, d, r]) => {
      const ref = doc(daysCol(), d);
      if (op === 'del') batch.delete(ref); else batch.set(ref, dayDoc(r));
    });
    await batch.commit();
  }
  return ops.length;
}
