"use client";

import { ActionSwapText, type ActionSwapTextProps } from "./action-swap";

export type ActionSwapRollTextProps = Omit<ActionSwapTextProps, "animation">;

export function ActionSwapRollText(props: ActionSwapRollTextProps) {
  return <ActionSwapText {...props} animation="roll" />;
}
