/**
 * Mobile unit tests — pure logic only (attachment validation, sizing math,
 * MIME resolution). Expo-native behavior (pickers, UploadTask, manipulator)
 * is covered by the manual smoke path on a device, not simulated here.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
