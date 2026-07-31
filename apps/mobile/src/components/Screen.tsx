import type { ReactNode } from "react";
import { View } from "react-native";
import type { ViewStyle } from "react-native";
import { colors } from "../theme/theme";

/**
 * App-background container. Safe-area handling is done by the navigation stack
 * headers and by ScrollView/FlatList `contentInsetAdjustmentBehavior`, so this
 * is just the themed backdrop (CLAUDE.md §7 dark-first).
 */
export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ flex: 1, backgroundColor: colors.app }, style]}>{children}</View>
  );
}
