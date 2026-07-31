import { eq } from "drizzle-orm";
import type { DevicePreference, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toDevicePreference } from "../mappers.js";
import { devicePreferences } from "../schema.js";

export function devicePreferencesRepo(db: Db) {
  return {
    async get(userId: UserId): Promise<DevicePreference | null> {
      const [row] = await db
        .select()
        .from(devicePreferences)
        .where(eq(devicePreferences.userId, userId))
        .limit(1);
      return row ? toDevicePreference(row) : null;
    },

    async upsert(pref: DevicePreference): Promise<DevicePreference> {
      const [row] = await db
        .insert(devicePreferences)
        .values(pref)
        .onConflictDoUpdate({
          target: devicePreferences.userId,
          set: {
            inputDeviceId: pref.inputDeviceId,
            outputDeviceId: pref.outputDeviceId,
            inputVolume: pref.inputVolume,
            outputVolume: pref.outputVolume,
          },
        })
        .returning();
      if (!row) throw new Error("upsert device_preferences returned no row");
      return toDevicePreference(row);
    },
  };
}

export type DevicePreferencesRepo = ReturnType<typeof devicePreferencesRepo>;
