import {
  deleteUser,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  EmailAuthProvider,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth';
import { doc, deleteDoc, getDoc } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseDb } from './firebaseConfig';
import { listProjects, loadProject, deleteProjectStorage } from './projectsService';
import type { Project } from '../../types';

// Everything here runs as the signed-in user with their own credentials. The existing
// Firestore and Storage rules already allow a user to read and delete their own data, so
// none of this needs the Admin SDK or a server round-trip.

export interface AccountExport {
  exportedAt: string;
  profile: Record<string, unknown> | null;
  account: {
    uid: string;
    email: string | null;
    displayName: string | null;
    emailVerified: boolean;
    providers: string[];
    createdAt: string | null;
    lastSignInAt: string | null;
  };
  projects: Array<{ id: string; name: string; updatedAt: string | null; project: Project | null }>;
}

const requireUser = (): User => {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('You are not signed in.');
  return user;
};

/** Everything we hold about the signed-in user, as one JSON-serialisable object. */
export const buildAccountExport = async (
  onProgress?: (done: number, total: number) => void,
): Promise<AccountExport> => {
  const user = requireUser();

  const profileSnap = await getDoc(doc(getFirebaseDb(), 'users', user.uid));
  const summaries = await listProjects(user.uid);

  const projects: AccountExport['projects'] = [];
  for (const [index, summary] of summaries.entries()) {
    let project: Project | null = null;
    try {
      project = await loadProject(summary.id);
    } catch (error) {
      // One unreadable project must not cost the user the rest of their export.
      console.warn(`Skipping project ${summary.id} in export:`, error);
    }
    projects.push({
      id: summary.id,
      name: summary.name,
      updatedAt: summary.updatedAt ? summary.updatedAt.toISOString() : null,
      project,
    });
    onProgress?.(index + 1, summaries.length);
  }

  return {
    exportedAt: new Date().toISOString(),
    profile: profileSnap.exists() ? (profileSnap.data() as Record<string, unknown>) : null,
    account: {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      providers: user.providerData.map(entry => entry.providerId),
      createdAt: user.metadata.creationTime ?? null,
      lastSignInAt: user.metadata.lastSignInTime ?? null,
    },
    projects,
  };
};

/** Triggers a browser download of the export. Revokes the object URL once handed over. */
export const downloadAccountExport = (data: AccountExport): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `archai-account-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const usesPasswordSignIn = (user: User): boolean =>
  user.providerData.some(entry => entry.providerId === EmailAuthProvider.PROVIDER_ID);

/**
 * Firebase refuses to delete an account whose sign-in is more than a few minutes old, which
 * is the failure mode that breaks most delete-account implementations. Password users
 * re-enter their password; Google users go back through the popup.
 */
export const reauthenticate = async (password?: string): Promise<void> => {
  const user = requireUser();
  if (usesPasswordSignIn(user)) {
    if (!user.email) throw new Error('This account has no email address to re-authenticate with.');
    if (!password) throw new Error('Enter your password to confirm.');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    return;
  }
  await reauthenticateWithPopup(user, new GoogleAuthProvider());
};

/**
 * Deletes the user's projects (documents and Storage objects), their profile row, and
 * finally the auth account. Ordered so that a failure part-way through never leaves an
 * account that exists but can no longer reach its own data: the auth user goes last.
 */
export const deleteAccount = async (
  onProgress?: (message: string) => void,
): Promise<void> => {
  const user = requireUser();

  onProgress?.('Removing saved projects…');
  const summaries = await listProjects(user.uid);
  for (const summary of summaries) {
    await deleteProjectStorage(user.uid, summary.id);
    await deleteDoc(doc(getFirebaseDb(), 'projects', summary.id));
  }

  onProgress?.('Removing your profile…');
  await deleteDoc(doc(getFirebaseDb(), 'users', user.uid));

  onProgress?.('Closing your account…');
  await deleteUser(user);
};
