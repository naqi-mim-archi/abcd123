import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseDb } from './firebaseConfig';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Browsers (and privacy extensions) routinely block the Google sign-in popup. When that
// happens there is nothing the user can fix in the app, so fall back to the full-page
// redirect flow, which no popup blocker can stop.
const POPUP_FALLBACK_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/web-storage-unsupported',
]);

const upsertUserProfile = async (user: User) => {
  const db = getFirebaseDb();
  await setDoc(
    doc(db, 'users', user.uid),
    {
      email: user.email || null,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      lastSignInAt: serverTimestamp(),
    },
    { merge: true },
  );
};

export const signUpWithEmail = async (email: string, password: string, displayName?: string): Promise<User> => {
  const auth = getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(credential.user, { displayName });
  }
  await upsertUserProfile(credential.user);
  // Nothing is gated on verification yet — this just gets the address confirmed early so
  // password recovery works when someone needs it a year from now.
  sendEmailVerification(credential.user).catch(err => console.warn('Verification email failed to send:', err));
  return credential.user;
};

export const signInWithEmail = async (email: string, password: string): Promise<User> => {
  const auth = getFirebaseAuth();
  const credential = await signInWithEmailAndPassword(auth, email, password);
  await upsertUserProfile(credential.user);
  return credential.user;
};

/**
 * Returns the signed-in user, or `null` when the popup was blocked and the browser is
 * being sent to Google's redirect flow instead — in that case the page navigates away and
 * `completeGoogleRedirectSignIn` finishes the job when it comes back.
 */
export const signInWithGoogle = async (): Promise<User | null> => {
  const auth = getFirebaseAuth();
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    await upsertUserProfile(credential.user);
    return credential.user;
  } catch (error: any) {
    if (!POPUP_FALLBACK_CODES.has(String(error?.code || ''))) throw error;
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
};

/** Call once on app start so a redirect sign-in that just returned gets its profile row. */
export const completeGoogleRedirectSignIn = async (): Promise<User | null> => {
  const auth = getFirebaseAuth();
  const credential = await getRedirectResult(auth);
  if (!credential) return null;
  await upsertUserProfile(credential.user);
  return credential.user;
};

export const signOut = async (): Promise<void> => {
  const auth = getFirebaseAuth();
  await firebaseSignOut(auth);
};

export const watchAuthState = (callback: (user: User | null) => void): (() => void) => {
  const auth = getFirebaseAuth();
  return onAuthStateChanged(auth, callback);
};

/** Sends the reset link. Deliberately does not reveal whether the address has an account. */
export const sendPasswordReset = async (email: string): Promise<void> => {
  await sendPasswordResetEmail(getFirebaseAuth(), email);
};

export const resendEmailVerification = async (): Promise<void> => {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('You are not signed in.');
  if (user.emailVerified) return;
  await sendEmailVerification(user);
};

export const updateDisplayName = async (displayName: string): Promise<void> => {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('You are not signed in.');
  const trimmed = displayName.trim();
  await updateProfile(user, { displayName: trimmed || null });
  await upsertUserProfile(user);
};

export const getFirebaseAuthErrorMessage = (error: any): string => {
  const code = String(error?.code || '');
  switch (code) {
    case 'auth/email-already-in-use':
      return 'That email is already registered — try signing in instead.';
    case 'auth/invalid-email':
      return 'That email address looks invalid.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in window. Allow popups for this site, or try again to continue in the same tab.';
    case 'auth/unauthorized-domain':
      return 'This domain is not authorised for Google sign-in yet. Add it under Firebase Console → Authentication → Settings → Authorized domains.';
    case 'auth/network-request-failed':
      return 'Network error — check your connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts — please wait a moment and try again.';
    case 'auth/missing-email':
      return 'Enter your email address first.';
    case 'auth/requires-recent-login':
      return 'For security, sign in again before making this change.';
    case 'auth/user-mismatch':
      return 'That account does not match the one you are signed in as.';
    default:
      return error?.message || 'Something went wrong. Please try again.';
  }
};
