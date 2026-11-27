import { Separator } from "@earendil-works/elanor-react";
import type { ModelInfo, ModelProfile } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { useAbortableAsync } from "../../lib/useAbortableAsync.ts";
import { ModelCatalogSection } from "./models/ModelCatalogSection.tsx";
import {
  createNextIndexedProfile,
  type IndexedProfile,
  ModelProfilesSection,
  wrapProfiles,
} from "./models/ModelProfilesSection.tsx";

export function ModelsTab() {
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [profiles, setProfiles] = useState<IndexedProfile[]>([]);
  const [notes, setNotes] = useState("");
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const { run: runLoad } = useAbortableAsync();
  const { run: runRefresh } = useAbortableAsync();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const res = await runLoad((signal) =>
        Promise.all([api.listModels({ signal }), api.getModelProfiles(signal)]),
      );
      if (!res) return;
      const [modelsRes, profilesRes] = res;
      setAllModels(modelsRes.models);
      setProfiles(wrapProfiles(profilesRes.profiles));
      setNotes(profilesRes.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshCatalog = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      const done = await runRefresh(async (signal) => {
        await api.refreshModels({ force: true }, signal);
        await load();
        return true;
      });
      if (!done) return;
      setRefreshing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRefreshing(false);
    }
  };

  const addProfile = () => {
    setProfiles((prev) => [...prev, createNextIndexedProfile(allModels, prev.length)]);
    setSavedNotice(false);
  };

  const updateProfile = (uid: number, next: ModelProfile) => {
    setProfiles((prev) =>
      prev.map((item) => (item.uid === uid ? { ...item, profile: next } : item)),
    );
    setSavedNotice(false);
  };

  const removeProfile = (uid: number) => {
    setProfiles((prev) => prev.filter((item) => item.uid !== uid));
    setSavedNotice(false);
  };

  const saveProfiles = async () => {
    setSavingProfiles(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const res = await api.putModelProfiles({
        profiles: profiles.map((item) => item.profile),
        ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
      });
      setProfiles(wrapProfiles(res.profiles));
      setNotes(res.notes ?? "");
      setSavedNotice(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProfiles(false);
    }
  };

  return (
    <div className="ev-settings-section" style={{ gap: 22 }}>
      {error && <div className="ev-error-banner">{error}</div>}

      <ModelProfilesSection
        allModels={allModels}
        profiles={profiles}
        notes={notes}
        saving={savingProfiles}
        savedNotice={savedNotice}
        onAddProfile={addProfile}
        onUpdateProfile={updateProfile}
        onRemoveProfile={removeProfile}
        onNotesChange={(value) => {
          setNotes(value);
          setSavedNotice(false);
        }}
        onSave={() => void saveProfiles()}
      />

      <Separator />

      <ModelCatalogSection
        allModels={allModels}
        refreshing={refreshing}
        onRefresh={() => void refreshCatalog()}
      />
    </div>
  );
}
