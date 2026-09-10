import {
  collection,
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL, deleteObject, listAll } from 'firebase/storage';
import { getFirebaseDb, getFirebaseStorage } from './firebaseConfig';
import type { Project } from '../../types';
import { checkStorageAllowance } from '../billing/balanceClient';

// Firestore documents cap out around 1MB. Small projects are stored inline for a fast,
// single-read load; anything larger is uploaded to Storage as a JSON blob instead, with
// only a pointer + lightweight listing fields kept in Firestore.
const INLINE_SIZE_LIMIT_BYTES = 700_000;

export interface SaveProjectOptions {
  /** Update this document in place. Omit to create a new one ("Save As"). */
  projectId?: string;
  /** Overrides project.name. Lets the panel name a project without mutating editor state. */
  name?: string;
  /** JPEG data URL from renderProjectThumbnail(); uploaded to Storage when present. */
  thumbnailDataUrl?: string | null;
}

export interface SavedProjectSummary {
  id: string;
  name: string;
  mode: Project['mode'];
  elementsCount: number;
  thumbnailUrl?: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

interface ProjectDocBase {
  ownerId: string;
  name: string;
  mode: Project['mode'];
  elementsCount: number;
  thumbnailUrl?: string;
  createdAt: any;
  updatedAt: any;
}

interface InlineProjectDoc extends ProjectDocBase {
  storageMode: 'inline';
  data: string;
}

interface StorageProjectDoc extends ProjectDocBase {
  storageMode: 'storage';
  dataUrl: string;
}

const toDate = (value: Timestamp | undefined): Date | null => (value ? value.toDate() : null);

const projectsCollection = () => collection(getFirebaseDb(), 'projects');

export const projectStoragePrefix = (userId: string, projectId: string) =>
  `users/${userId}/projects/${projectId}`;

// Firebase's own Storage errors ("storage/unauthorized", "storage/retry-limit-exceeded")
// tell a user nothing about what to do. The failures that actually happen here are a
// project too large for Firestore hitting a bucket that isn't reachable, and rules
// rejecting an oversized upload.
const describeStorageError = (error: any, what: string): Error => {
  const code = String(error?.code || '');
  if (code === 'storage/unauthorized' || code === 'storage/unauthenticated') {
    return new Error(`${what} was rejected by Cloud Storage — it may be over the size limit, or the Storage rules may need updating.`);
  }
  if (code === 'storage/quota-exceeded') {
    return new Error(`${what} failed: the Cloud Storage quota for this project is full.`);
  }
  if (code === 'storage/unknown' || code === 'storage/object-not-found') {
    return new Error(`${what} failed: Cloud Storage is not available on this Firebase project.`);
  }
  return new Error(`${what} failed: ${error?.message || String(error)}`);
};

export const saveProject = async (
  userId: string,
  project: Project,
  options: SaveProjectOptions = {},
): Promise<string> => {
  const { projectId: existingProjectId, name, thumbnailDataUrl } = options;
  const serialized = JSON.stringify(project);
  const sizeBytes = new TextEncoder().encode(serialized).length;

  // A new document's id has to be known up front so the Storage payload and thumbnail can
  // be written under it before the document itself exists.
  const projectId = existingProjectId || doc(projectsCollection()).id;

  const base = {
    ownerId: userId,
    name: (name ?? project.name ?? '').trim() || 'Untitled Project',
    mode: project.mode,
    elementsCount: project.elements?.length || 0,
    updatedAt: serverTimestamp(),
  };

  // Only a project too large for Firestore, plus the thumbnail, ever touch Cloud Storage.
  // Ask the server whether there is room before uploading rather than after: a rejected
  // upload part-way through would leave the project half-saved.
  const thumbnailBytes = thumbnailDataUrl ? Math.ceil(thumbnailDataUrl.length * 0.75) : 0;
  const storageBytesNeeded = (sizeBytes > INLINE_SIZE_LIMIT_BYTES ? sizeBytes : 0) + thumbnailBytes;
  if (storageBytesNeeded > 0) {
    const allowance = await checkStorageAllowance(storageBytesNeeded);
    if (!allowance.allowed) {
      throw new Error(allowance.message || 'You have run out of storage. Free up space or add more storage.');
    }
  }

  let payload: Partial<InlineProjectDoc> | Partial<StorageProjectDoc>;
  if (sizeBytes <= INLINE_SIZE_LIMIT_BYTES) {
    payload = { ...base, storageMode: 'inline', data: serialized };
  } else {
    const storageRef = ref(getFirebaseStorage(), `${projectStoragePrefix(userId, projectId)}/project.json`);
    try {
      await uploadString(storageRef, serialized, 'raw', { contentType: 'application/json' });
      const dataUrl = await getDownloadURL(storageRef);
      payload = { ...base, storageMode: 'storage', dataUrl };
    } catch (error) {
      throw describeStorageError(error, `Saving this project (${Math.round(sizeBytes / 1024)} KB, too large to store in Firestore)`);
    }
  }

  // A thumbnail is a nicety — never fail a save because the preview upload didn't work.
  if (thumbnailDataUrl) {
    try {
      const thumbRef = ref(getFirebaseStorage(), `${projectStoragePrefix(userId, projectId)}/thumbnail.jpg`);
      await uploadString(thumbRef, stripDataUrlPrefix(thumbnailDataUrl), 'base64', { contentType: 'image/jpeg' });
      (payload as ProjectDocBase).thumbnailUrl = await getDownloadURL(thumbRef);
    } catch (error) {
      console.warn('Project thumbnail upload failed; saving without one.', error);
    }
  }

  const target = doc(projectsCollection(), projectId);
  if (existingProjectId) {
    await setDoc(target, payload, { merge: true });
  } else {
    await setDoc(target, { ...payload, createdAt: serverTimestamp() });
  }
  return projectId;
};

export const renameProject = async (projectId: string, name: string): Promise<void> => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name cannot be empty.');
  await updateDoc(doc(projectsCollection(), projectId), { name: trimmed, updatedAt: serverTimestamp() });
};

export const listProjects = async (userId: string): Promise<SavedProjectSummary[]> => {
  const q = query(projectsCollection(), where('ownerId', '==', userId), orderBy('updatedAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(docSnap => {
    const data = docSnap.data() as InlineProjectDoc | StorageProjectDoc;
    return {
      id: docSnap.id,
      name: data.name,
      mode: data.mode,
      elementsCount: data.elementsCount,
      thumbnailUrl: data.thumbnailUrl,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
    };
  });
};

export const loadProject = async (projectId: string): Promise<Project> => {
  const docSnap = await getDoc(doc(projectsCollection(), projectId));
  if (!docSnap.exists()) throw new Error('Project not found.');
  const data = docSnap.data() as InlineProjectDoc | StorageProjectDoc;

  if (data.storageMode === 'inline') {
    return JSON.parse(data.data) as Project;
  }

  const response = await fetch(data.dataUrl);
  if (!response.ok) throw new Error('Failed to download project data.');
  return (await response.json()) as Project;
};

/**
 * Removes the project document and everything it wrote to Storage. Without the Storage
 * sweep, a deleted project keeps costing money on a Blaze-plan bucket indefinitely.
 */
export const deleteProject = async (projectId: string, userId?: string): Promise<void> => {
  if (userId) await deleteProjectStorage(userId, projectId);
  await deleteDoc(doc(projectsCollection(), projectId));
};

/** Best-effort removal of a project's Storage folder. Never throws. */
export const deleteProjectStorage = async (userId: string, projectId: string): Promise<void> => {
  try {
    const folder = ref(getFirebaseStorage(), projectStoragePrefix(userId, projectId));
    const listing = await listAll(folder);
    await Promise.all([
      ...listing.items.map(item => deleteObject(item).catch(() => undefined)),
      ...listing.prefixes.map(async prefix => {
        const nested = await listAll(prefix);
        await Promise.all(nested.items.map(item => deleteObject(item).catch(() => undefined)));
      }),
    ]);
  } catch (error) {
    // Nothing stored under this project, or Storage unreachable. The document still goes.
    console.warn('Could not clean up Cloud Storage for this project.', error);
  }
};

// Generic helper for attaching a generated image (floorplan render, AI-render output, etc.)
// to a project. Not yet wired into every generation flow — call this from wherever a
// result should be persisted once that flow is ready to save automatically.
const stripDataUrlPrefix = (value: string): string => value.replace(/^data:image\/\w+;base64,/, '');

export const uploadProjectImage = async (
  userId: string,
  projectId: string,
  image: { base64?: string; blob?: Blob; label: string },
): Promise<string> => {
  const fileName = `${Date.now()}-${image.label.replace(/[^a-z0-9-_]/gi, '_')}.jpg`;
  const storageRef = ref(getFirebaseStorage(), `${projectStoragePrefix(userId, projectId)}/images/${fileName}`);
  if (image.base64) {
    await uploadString(storageRef, stripDataUrlPrefix(image.base64), 'base64', { contentType: 'image/jpeg' });
  } else if (image.blob) {
    await uploadBytes(storageRef, image.blob, { contentType: image.blob.type || 'image/jpeg' });
  } else {
    throw new Error('uploadProjectImage requires base64 or blob.');
  }
  return getDownloadURL(storageRef);
};
