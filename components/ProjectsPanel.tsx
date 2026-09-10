import React, { useEffect, useState, useCallback } from 'react';
import { X, FolderOpen, Save, Trash2, Loader2, Layers, Clock, Pencil, Check, FilePlus2 } from 'lucide-react';
import type { Project } from '../types';
import {
  saveProject,
  listProjects,
  loadProject,
  deleteProject,
  renameProject,
  type SavedProjectSummary,
} from '../services/firebase/projectsService';
import { renderProjectThumbnail } from '../services/firebase/projectThumbnail';

interface ProjectsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentProject: Project | null;
  /** Document id of the project currently open, or null when it has never been saved. */
  currentProjectId: string | null;
  onLoadProject: (project: Project, projectId: string) => void;
  onProjectSaved: (projectId: string, name: string) => void;
}

const formatDate = (date: Date | null): string => {
  if (!date) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const ProjectsPanel: React.FC<ProjectsPanelProps> = ({ isOpen, onClose, userId, currentProject, currentProjectId, onLoadProject, onProjectSaved }) => {
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const refresh = useCallback(async () => {
    setIsLoadingList(true);
    setError(null);
    try {
      const list = await listProjects(userId);
      setProjects(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load projects.');
    } finally {
      setIsLoadingList(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!isOpen) return;
    refresh();
    // Seed the name field from whatever is open, so Save keeps the project's own name
    // unless the user deliberately changes it.
    setNameDraft(currentProject?.name || '');
    setConfirmingDeleteId(null);
    setRenamingProjectId(null);
  }, [isOpen, refresh, currentProject]);

  if (!isOpen) return null;

  const inputClass = 'w-full px-4 py-3 rounded-2xl border border-slate-200 bg-white text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 transition-colors';

  // `asNew` is the Save As path: it drops the id so a fresh document is created. A plain
  // Save updates the open project in place — before this, every save made a duplicate.
  const handleSave = async (asNew: boolean) => {
    if (!currentProject) return;
    setIsSaving(true);
    setError(null);
    try {
      const savedId = await saveProject(userId, currentProject, {
        projectId: asNew ? undefined : currentProjectId || undefined,
        name: nameDraft,
        thumbnailDataUrl: renderProjectThumbnail(currentProject),
      });
      onProjectSaved(savedId, nameDraft.trim() || currentProject.name || 'Untitled Project');
      setSaveFeedback(true);
      setTimeout(() => setSaveFeedback(false), 2000);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to save project.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoad = async (projectId: string) => {
    setLoadingProjectId(projectId);
    setError(null);
    try {
      const project = await loadProject(projectId);
      onLoadProject(project, projectId);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to load project.');
    } finally {
      setLoadingProjectId(null);
    }
  };

  const handleDelete = async (projectId: string) => {
    setDeletingProjectId(projectId);
    setError(null);
    try {
      await deleteProject(projectId, userId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
      setConfirmingDeleteId(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete project.');
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleRename = async (projectId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await renameProject(projectId, trimmed);
      setProjects(prev => prev.map(p => (p.id === projectId ? { ...p, name: trimmed } : p)));
      if (projectId === currentProjectId) onProjectSaved(projectId, trimmed);
      setRenamingProjectId(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to rename project.');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-900 rounded-xl text-white shadow-lg shadow-slate-300">
              <FolderOpen className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-black text-slate-900 leading-tight">My Projects</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 border-b border-slate-100 bg-slate-50/50 space-y-3">
          <input
            type="text"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            placeholder="Project name"
            disabled={!currentProject}
            className={inputClass}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSave(false)}
              disabled={!currentProject || isSaving}
              className="flex-1 py-3 bg-slate-900 text-white rounded-2xl font-bold text-sm hover:bg-slate-800 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saveFeedback ? 'Saved!' : currentProjectId ? 'Save' : 'Save Project'}
            </button>
            {currentProjectId && (
              <button
                onClick={() => handleSave(true)}
                disabled={!currentProject || isSaving}
                className="px-4 py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                title="Save as a new project instead of updating this one"
              >
                <FilePlus2 className="w-4 h-4" />
                Save As
              </button>
            )}
          </div>
          {!currentProject ? (
            <p className="text-center text-[11px] font-medium text-slate-400">Open or create a project first.</p>
          ) : (
            <p className="text-center text-[11px] font-medium text-slate-400">
              {currentProjectId ? 'Saving updates the project you have open.' : 'This will be saved as a new project.'}
            </p>
          )}
        </div>

        {error && (
          <p className="mx-6 mt-4 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {isLoadingList ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 text-slate-400 px-6">
              <FolderOpen className="w-10 h-10 stroke-[1.5] text-slate-200" />
              <p className="text-xs font-medium leading-relaxed">No saved projects yet. Save your current work to see it here.</p>
            </div>
          ) : (
            projects.map(p => (
              <div
                key={p.id}
                className={`flex items-center gap-3 p-3 rounded-2xl border transition-colors ${
                  p.id === currentProjectId ? 'border-slate-300 bg-slate-50' : 'border-slate-100 hover:bg-slate-50'
                }`}
              >
                {p.thumbnailUrl ? (
                  <img src={p.thumbnailUrl} alt="" className="w-14 h-10 rounded-xl object-cover border border-slate-100 shrink-0" />
                ) : (
                  <div className="w-14 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                    <Layers className="w-4 h-4 text-slate-200" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  {renamingProjectId === p.id ? (
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(p.id);
                        if (e.key === 'Escape') setRenamingProjectId(null);
                      }}
                      className="w-full px-2 py-1 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    />
                  ) : (
                    <h3 className="text-sm font-bold text-slate-800 truncate">{p.name}</h3>
                  )}
                  <div className="flex items-center gap-3 text-[10px] font-medium text-slate-400 mt-0.5">
                    <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{p.elementsCount} elements</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDate(p.updatedAt)}</span>
                  </div>
                </div>

                {confirmingDeleteId === p.id ? (
                  <>
                    <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">Delete?</span>
                    <button
                      onClick={() => handleDelete(p.id)}
                      disabled={deletingProjectId === p.id}
                      className="px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {deletingProjectId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Delete'}
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(null)}
                      className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                      title="Keep this project"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : renamingProjectId === p.id ? (
                  <>
                    <button
                      onClick={() => handleRename(p.id)}
                      className="px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors flex items-center gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setRenamingProjectId(null)}
                      className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleLoad(p.id)}
                      disabled={loadingProjectId === p.id}
                      className="px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {loadingProjectId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Load'}
                    </button>
                    <button
                      onClick={() => { setRenamingProjectId(p.id); setRenameValue(p.name); }}
                      className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                      title="Rename project"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(p.id)}
                      className="p-2 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title="Delete project"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
