// Firebase: login (Auth), shared cloud storage with offline support (Firestore), usage events (Analytics).
//
// Data layout (many businesses, users managed by the admin):
//   meta/setup                    → { done } — exists once the first admin has been created
//   members/{uid}                 → { email, name, role: 'admin'|'staff', active, businesses: [bizId], ... }
//   shop/{bizId}                  → { name, type, currency, target, categories: [{ id, name, slot }], archived, ... }
//   shop/{bizId}/days/{YYYY-MM-DD}→ { income: { [categoryId]: amount }, expenses, note, updatedAt, updatedBy }
// (The first business keeps the id "main" and may still have older day records saved as { drinks, charging }.)

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAnalytics, isSupported, logEvent } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence, inMemoryPersistence, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp, query, limit,
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

// Testing only: http://localhost:8080/?emulator=1 talks to the local Firebase emulators
// (firebase emulators:start) instead of the real project. Never active on the live site.
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
if (local && new URLSearchParams(location.search).has('emulator')) sessionStorage.setItem('xs-emulator', '1');
export const usingEmulator = local && sessionStorage.getItem('xs-emulator') === '1';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
if (usingEmulator) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
setPersistence(auth, browserLocalPersistence); // stay signed in on this device

// Second, separate Firebase instance used only by the admin to create new accounts,
// so creating a user does not sign the admin out.
const helperApp = initializeApp(firebaseConfig, 'user-creator');
const helperAuth = getAuth(helperApp);
if (usingEmulator) connectAuthEmulator(helperAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
setPersistence(helperAuth, inMemoryPersistence);

// Offline-first: records are cached on the device and sync when the internet comes back.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
if (usingEmulator) connectFirestoreEmulator(db, '127.0.0.1', 8085);

let analytics = null;
isSupported().then(ok => { if (ok) analytics = getAnalytics(app); }).catch(() => {});
export function track(name, params) {
  try { if (analytics) logEvent(analytics, name, params); } catch { /* analytics is optional */ }
}

let user = null;
const setupRef = () => doc(db, 'meta', 'setup');
const memberRef = uid => doc(db, 'members', uid);
const bizRef = id => doc(db, 'shop', id);
const daysCol = bizId => collection(db, 'shop', bizId, 'days');

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
    email: u.email, name: name || '', role: 'admin', active: true, businesses: [],
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
// Admin only: create a login for someone and give them access to some businesses.
export async function addUser({ email, password, name, role, businesses }) {
  const cred = await createUserWithEmailAndPassword(helperAuth, email, password);
  try {
    await setDoc(memberRef(cred.user.uid), {
      email: cred.user.email, name: name || '', role, active: true, businesses: businesses || [],
      createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(),
    });
  } finally {
    await signOut(helperAuth);
  }
  return cred.user.uid;
}
// Admin only: change role, business access, or remove / restore access (active false = cannot use the app).
export const updateMember = (uid, fields) => updateDoc(memberRef(uid), { ...fields, updatedAt: serverTimestamp() });

// ---------- businesses ----------
// Admins see every business; staff see only the ones they were given (one listener each).
export function watchAllBusinesses(cb, onError) {
  return onSnapshot(collection(db, 'shop'), snap => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    cb(list);
  }, onError);
}
export function watchBusiness(id, cb, onError) {
  return onSnapshot(bizRef(id), snap => cb(snap.exists() ? { id, ...snap.data() } : null), onError);
}
export async function hasDays(bizId) {
  const snap = await getDocs(query(daysCol(bizId), limit(1)));
  return !snap.empty;
}
export async function createBusiness(id, fields) {
  await setDoc(bizRef(id), { ...fields, archived: false, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp() });
}
export const updateBusiness = (id, fields) => setDoc(bizRef(id), { ...fields, updatedAt: serverTimestamp() }, { merge: true });

// Permanently delete a business and all of its day records.
export async function deleteBusiness(id) {
  const snap = await getDocs(daysCol(id));
  const refs = snap.docs.map(d => d.ref);
  for (let i = 0; i < refs.length; i += 450) {
    const batch = writeBatch(db);
    refs.slice(i, i + 450).forEach(r => batch.delete(r));
    await batch.commit();
  }
  const batch = writeBatch(db);
  batch.delete(bizRef(id));
  await batch.commit();
}

// ---------- day records ----------
// Older records stored { drinks, charging }; newer ones store { income: { categoryId: amount } }.
export function normalizeDay(v) {
  let income = v.income;
  if (!income || typeof income !== 'object') {
    income = {};
    Object.entries(v).forEach(([k, val]) => {
      if (typeof val === 'number' && !['expenses'].includes(k)) income[k] = val;
    });
  }
  return { income, expenses: v.expenses || 0, note: v.note || '', updatedBy: v.updatedBy || '' };
}

// cb(days, meta) — days: { 'YYYY-MM-DD': {...} }, meta: { fromCache, pending }
export function watchDays(bizId, cb, onError) {
  return onSnapshot(daysCol(bizId), { includeMetadataChanges: true }, snap => {
    const days = {};
    snap.forEach(d => { days[d.id] = normalizeDay(d.data()); });
    cb(days, { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
  }, onError);
}

function dayDoc(rec) {
  const income = {};
  Object.entries(rec.income || {}).forEach(([k, v]) => { const n = Number(v) || 0; if (n) income[k] = n; });
  return {
    income, expenses: Number(rec.expenses) || 0, note: rec.note || '',
    updatedAt: serverTimestamp(), updatedBy: user.email || '',
  };
}
// Writes resolve only when the server confirms, so callers should not wait on them for UI.
export const saveDay = (bizId, date, rec) => setDoc(doc(daysCol(bizId), date), dayDoc(rec));
export const removeDay = (bizId, date) => writeBatch(db).delete(doc(daysCol(bizId), date)).commit();

// Bulk upload (restore backup / move old device records to the cloud). Firestore batches max 500 writes.
export async function uploadDays(bizId, days, replaceAll = false, existing = {}) {
  const ops = [];
  if (replaceAll) Object.keys(existing).filter(d => !(d in days)).forEach(d => ops.push(['del', d]));
  Object.entries(days).forEach(([d, r]) => ops.push(['set', d, r]));
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach(([op, d, r]) => {
      const ref = doc(daysCol(bizId), d);
      if (op === 'del') batch.delete(ref); else batch.set(ref, dayDoc(normalizeDay(r)));
    });
    await batch.commit();
  }
  return ops.length;
}
