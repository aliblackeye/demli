import { cn } from "../lib/cn";
import { USER_AVATAR_PX, UserAvatar, type UserAvatarSize } from "./user-avatar";

export interface AvatarGroupMember {
  id: string;
  name: string;
  src: string | null | undefined;
}

export interface AvatarGroupProps {
  members: readonly AvatarGroupMember[];
  size?: Exclude<UserAvatarSize, "lg">;
  /** Show at most this many avatars; the rest collapse into a "+N" chip. */
  max?: number;
  /**
   * Accessible summary of the whole stack (e.g. "Baran, Ece and 2 others").
   * The individual avatars are decorative, so this is what is announced.
   */
  label: string;
  className?: string;
}

/**
 * Overlapping stack of avatars (−30% overlap). Each avatar keeps its 2px
 * surface-coloured ring, which is what separates one face from the next.
 */
export function AvatarGroup({
  members,
  size = "sm",
  max = 4,
  label,
  className,
}: AvatarGroupProps): JSX.Element {
  const px = USER_AVATAR_PX[size];
  const shown = members.slice(0, max);
  const hidden = members.length - shown.length;
  const overlap = -Math.round(px * 0.3);

  return (
    <span role="img" aria-label={label} className={cn("inline-flex items-center", className)}>
      {shown.map((member, index) => (
        <UserAvatar
          key={member.id}
          name={member.name}
          colorSeed={member.id}
          src={member.src}
          size={size}
          style={index > 0 ? { marginLeft: overlap } : undefined}
        />
      ))}
      {hidden > 0 && (
        <span
          aria-hidden
          className="flex items-center justify-center rounded-full bg-raised font-medium text-fg-muted shadow-[0_0_0_2px_var(--avatar-ring,var(--color-app))]"
          style={{
            width: px,
            height: px,
            marginLeft: overlap,
            fontSize: Math.max(9, Math.round(px * 0.34)),
          }}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}
