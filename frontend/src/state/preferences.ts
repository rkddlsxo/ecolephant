import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Mode } from '@ecolephant/ai';
interface Preferences {
  mode: Mode;
  muted: boolean;
  cardOrder: string[];
  setMode: (mode: Mode) => void;
  setMuted: (value: boolean) => void;
  setCardOrder: (order: string[]) => void;
}
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      mode: 'combined',
      muted: false,
      cardOrder: ['valid', 'range', 'alerts'],
      setMode: (mode) => set({ mode }),
      setMuted: (muted) => set({ muted }),
      setCardOrder: (cardOrder) => set({ cardOrder }),
    }),
    { name: 'ecolephant-preferences-v1' },
  ),
);
